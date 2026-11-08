import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { app } from 'electron'
import * as pty from 'node-pty'
import type { EnvVar, ProcState, PtyStateEvent, ShellKind } from '../shared/types'
import { cmdline, PRESETS } from '../shared/types'
import { db } from './store'
import { discoverLocalShells } from './local-shells'
import { OscStrip } from './osc'
import { ProgramStatus } from './program-status'
import { replyProgramStatus } from './windows-status'
import { claudeLifecycle, nativeAgent, submittedAgent } from './agent-lifecycle'
import { passwordTerminal, remoteCommand, type TerminalProcess } from './ssh'
import {
  bashRc,
  bashQuote,
  psQuote,
  ompInstallDirectory,
  pwshProfile,
  remoteBootstrap,
  resolveLocalShell,
  shellForHost,
  sshArgs,
  zshRc
} from './platform'

const execFileP = promisify(execFile)

function waitFor<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    void promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) }
    )
  })
}

export interface SessionInfo {
  id: string
  state: ProcState
  exitCode: number | null
  startedAt: number | null
  inputReady: boolean
  shell: ShellKind
  kind: string
  agentKind: string | null
}

type Send = (event: { type: 'data'; id: string; data: string } | PtyStateEvent) => void

function stripMarker(text: string): { text: string; code: number | null } {
  const match = text.match(/AWB_EC:(-?\d+)/)
  if (!match) return { text, code: null }
  return { text: text.replace(/\r?\n?AWB_EC:-?\d+\r?\n?/g, ''), code: Number(match[1]) }
}

async function childPids(pid: number): Promise<number[]> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileP(
        'powershell.exe',
        ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}").ProcessId -join " "`],
        { timeout: 5000, windowsHide: true }
      )
      return stdout.split(/\s+/).map(Number).filter((n) => n > 0)
    }
    const { stdout } = await execFileP('ps', ['-o', 'pid=', '--ppid', String(pid)], { timeout: 3000, windowsHide: true })
    return stdout
      .split('\n')
      .map((s) => Number(s.trim()))
      .filter((n) => n > 0)
  } catch {
    return []
  }
}

async function killChildren(pid: number | null): Promise<boolean> {
  if (pid === null) return false
  const kids = await childPids(pid)
  if (!kids.length) return false
  const killOne = async (child: number) => {
    const nested = await childPids(child)
    await Promise.all(nested.map((n) => killOne(n)))
    if (process.platform === 'win32') {
      await execFileP('taskkill', ['/F', '/T', '/PID', String(child)], { timeout: 4000, windowsHide: true }).catch(() => undefined)
    } else {
      try {
        process.kill(child, 'SIGKILL')
      } catch {
        /* already gone */
      }
    }
  }
  await Promise.all(kids.map((k) => killOne(k)))
  return true
}

/**
 * Snapshot the process table once and return every descendant of the given
 * PTY roots, leaves before parents. `taskkill /T` can lose children when the
 * root exits first, especially while many trees are terminated together.
 */
async function windowsDescendants(roots: number[]): Promise<number[]> {
  if (!roots.length) return []
  const { stdout } = await execFileP(
    'powershell.exe',
    ['-NoProfile', '-Command', "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress"],
    { timeout: 8000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }
  )
  const parsed = JSON.parse(stdout || '[]')
  const rows: { ProcessId?: number; ParentProcessId?: number }[] = Array.isArray(parsed) ? parsed : [parsed]
  const children = new Map<number, number[]>()
  for (const row of rows) {
    const pid = Number(row.ProcessId)
    const parent = Number(row.ParentProcessId)
    if (!(pid > 0) || !(parent > 0)) continue
    const list = children.get(parent)
    if (list) list.push(pid)
    else children.set(parent, [pid])
  }
  const rootSet = new Set(roots)
  const result: number[] = []
  const visit = (pid: number) => {
    for (const child of children.get(pid) || []) {
      if (rootSet.has(child)) continue
      visit(child)
      result.push(child)
    }
  }
  for (const root of roots) visit(root)
  return result
}

function shellFiles(): { bash: string; pwsh: string; zsh: string } {
  const dir = path.join(app.getPath('userData'), 'shell')
  fs.mkdirSync(dir, { recursive: true })
  const bash = path.join(dir, 'bashrc.sh')
  const pwsh = path.join(dir, 'profile.ps1')
  const zsh = path.join(dir, '.zshrc')
  for (const [file, content] of [[bash, bashRc()], [pwsh, pwshProfile()], [zsh, zshRc()]]) {
    let current: string | undefined
    try { current = fs.readFileSync(file, 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    // PowerShell can hold a profile open during startup. Other terminals must
    // reuse its unchanged contents rather than race with that read on Windows.
    if (current !== content) fs.writeFileSync(file, content)
  }
  return { bash, pwsh, zsh }
}

function agentCommand(kind: string): { command: string; env: EnvVar[] } {
  if (kind === 'shell') return { command: '', env: [] }
  const preset = PRESETS.find((p) => p.id === kind)
  if (preset) return { command: cmdline(preset), env: [] }
  const custom = db().custom.find((c) => c.id === kind)
  if (custom) return { command: cmdline(custom), env: custom.env || [] }
  return { command: '', env: [] }
}

class Session {
  readonly id: string
  readonly projectId: string
  kind: string
  shell: ShellKind
  cwd: string
  command: string
  state: ProcState = 'idle'
  exitCode: number | null = null
  startedAt: number | null = null
  private proc: TerminalProcess | null = null
  private cols = 80
  private rows = 24
  private remoteAbort: AbortController | null = null
  private osc = new OscStrip()
  private programStatus = new ProgramStatus()
  private programWaiting = false
  private activeAgent: string | null = null
  private nativeStatus = false
  private shellInput = ''
  private lifecycle: Awaited<ReturnType<typeof claudeLifecycle>> | null = null
  private lifecycleFile = ''
  private outputQueue: Promise<void> = Promise.resolve()
  private statusAbort = new AbortController()
  private phase: 'starting' | 'armed' | 'command' | 'prompt' | 'dead' = 'starting'
  private lastC = 0
  private exitAnnounced = false
  private restartPending = false
  private override: { state: ProcState; code: number; reason: 'kill' | 'ctrlc' } | null = null
  private commandSentAt = 0
  private skipPrompt = false
  private disposed = false
  private procExited = false
  private processExit: Promise<void> | null = null
  private disposal: Promise<void> | null = null
  private treeKill: Promise<boolean> | null = null
  private disposeStarted = false
  private env: NodeJS.ProcessEnv

  constructor(
    private send: Send,
    opts: { id: string; projectId: string; kind: string; shell: ShellKind; cwd: string; command: string; env: EnvVar[]; hostId: string }
  ) {
    this.id = opts.id
    this.projectId = opts.projectId
    this.kind = opts.kind
    this.shell = opts.shell
    this.cwd = opts.cwd
    this.command = opts.command
    // ConPTY omits the final position of a hidden hardware cursor. Pi's native
    // cursor mode keeps its IME anchor at the editor caret, including when Pi
    // is started manually from a Shell terminal. Custom executor env can opt out.
    this.env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', AWB_CWD: opts.cwd, PI_PROGRAM_STATUS: '1',
      ...(process.platform === 'win32' ? { PI_HARDWARE_CURSOR: '1' } : {}) }
    const ompDirectory = ompInstallDirectory()
    if (fs.existsSync(ompDirectory)) {
      const pathKey = Object.keys(this.env).find((key) => key.toLowerCase() === 'path') || 'PATH'
      this.env[pathKey] = [ompDirectory, this.env[pathKey] || ''].join(path.delimiter)
    }
    for (const item of opts.env) {
      if (item.k) this.env[item.k] = item.v
    }
    this.hostId = opts.hostId
  }

  hostId: string

  info(): SessionInfo {
    return { id: this.id, state: this.state, exitCode: this.exitCode, startedAt: this.startedAt, inputReady: this.phase === 'prompt' || this.programWaiting, shell: this.shell, kind: this.kind, agentKind: this.activeAgent }
  }

  async spawn(): Promise<void> {
    if (this.disposed) return
    this.procExited = false
    const draft = db()
    const host = draft.hosts.find((h) => h.id === this.hostId) || draft.hosts[0]
    const files = shellFiles()
    this.phase = 'starting'
    this.osc = new OscStrip()
    this.programStatus = new ProgramStatus()
    this.programWaiting = false
    this.activeAgent = null
    this.nativeStatus = false
    this.shellInput = ''
    this.statusAbort = new AbortController()
    let proc: TerminalProcess
    if (!host || host.id === 'local') {
      if (!this.lifecycle && ['claude', 'shell'].includes(this.kind)) {
        const lifecycle = await claudeLifecycle((state) => {
          if (this.disposed || this.phase !== 'command' || this.activeAgent !== 'claude') return
          if (state === 'clear') this.activeAgent = null
          this.nativeStatus = state !== 'clear'
          this.programWaiting = state === 'waiting'
          this.emit(false)
        })
        if (this.disposed) { lifecycle.dispose(); return }
        this.lifecycle = lifecycle
        this.lifecycleFile = path.join(app.getPath('userData'), `claude-status-${randomUUID()}.json`)
        fs.writeFileSync(this.lifecycleFile, JSON.stringify(this.lifecycle.settings))
      }
      await discoverLocalShells()
      if (this.disposed) return
      const rc = this.shell === 'pwsh' ? files.pwsh : this.shell === 'zsh' ? files.zsh : files.bash
      const spec = resolveLocalShell(this.shell, rc, this.env)
      this.shell = spec.shell
      if (spec.env) Object.assign(this.env, spec.env)
      if (process.platform === 'win32' && spec.env?.PATH) for (const key of Object.keys(this.env)) { if (key.toLowerCase() === 'path' && key !== 'PATH') delete this.env[key] }
      if (process.platform === 'win32' && spec.shell === 'bash') this.env.AWB_CWD = this.cwd.replaceAll('\\', '/')
      proc = pty.spawn(spec.file, spec.args, {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: this.cwd,
        env: this.env
      })
    } else {
      this.shell = shellForHost(host.platform, this.shell)
      const boot = remoteBootstrap(host.platform, this.cwd)
      this.remoteAbort = new AbortController()
      proc = host.auth === 'password' ? await passwordTerminal(host, boot, this.remoteAbort.signal) : pty.spawn('ssh', sshArgs(host, [remoteCommand(host, boot)]), {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: process.cwd(),
        env: this.env
      })
    }
    if (this.disposed) { proc.kill(); return }
    this.proc = proc
    let finishExit: () => void = () => undefined
    this.processExit = new Promise<void>((resolve) => { finishExit = resolve })
    proc.resize(this.cols, this.rows)
    proc.onData((data) => {
      if (this.disposed) return
      if (process.env.AWB_DEBUG) console.log(`[pty ${this.id}]`, JSON.stringify(data).slice(0, 300))
      this.outputQueue = this.outputQueue.then(() => this.onData(data)).catch((error) => { if (!this.disposed) console.error('Terminal status reply failed', error) })
    })
    setTimeout(() => {
      if (this.phase === 'starting') {
        this.skipPrompt = true
        this.phase = 'armed'
        this.armLaunch()
      }
    }, 1200)
    proc.onExit((result) => {
      this.procExited = true
      finishExit()
      this.statusAbort.abort()
      this.outputQueue = this.outputQueue.then(() => {
        if (this.disposed) return
        const code = typeof result === 'number' ? result : (result?.exitCode ?? 1)
        this.phase = 'dead'
        this.programWaiting = false
        const state: ProcState = code === 0 ? 'exited' : 'failed'
        this.apply(state, code, !this.exitAnnounced, 'exit')
      })
    })
  }

  write(data: string, binary = false): void {
    if (!this.proc || this.phase === 'dead') return
    if (!binary && (data.includes('\r') || data.includes('\n')) && this.phase === 'prompt' && this.state !== 'running') {
      const command = this.shellInput + data.split(/[\r\n]/)[0]
      this.activeAgent = submittedAgent(command) || null
      this.nativeStatus = false
      if (this.activeAgent === 'claude' && this.lifecycleFile && !command.includes('--settings')) data = data.replace(/[\r\n]/, (enter) => ` --settings ${this.quoteLifecycleFile()}${enter}`)
      this.shellInput = ''
      this.programWaiting = !!this.activeAgent
      this.phase = 'command'
      this.state = 'running'
      this.startedAt = Date.now()
      this.exitCode = null
      this.exitAnnounced = false
      this.commandSentAt = Date.now()
      this.emit(false)
    } else if (!binary && this.phase === 'prompt') {
      for (const char of data) {
        if (char === '\x7f' || char === '\b') this.shellInput = this.shellInput.slice(0, -1)
        else if (char === '\x03' || char === '\x15') this.shellInput = ''
        else if (char >= ' ' && this.shellInput.length < 8192) this.shellInput += char
      }
    }
    this.proc.write(binary ? Buffer.from(data, 'latin1') : data)
  }

  resize(cols: number, rows: number): void {
    if (cols < 2 || rows < 2) return
    this.cols = cols
    this.rows = rows
    if (!this.proc || this.disposed || this.procExited) return
    try {
      this.proc.resize(cols, rows)
    } catch {
      /* pty already closed */
    }
  }

  async interrupt(): Promise<'hint' | 'exit' | 'signal'> {
    if (!this.proc || this.phase === 'dead') return 'signal'
    const now = Date.now()
    if (this.state === 'running' && this.lastC && now - this.lastC < 4000) {
      this.lastC = 0
      const killed = await killChildren(this.proc.pid)
      if (!killed) this.proc.write('\x03')
      if (this.kind === 'shell') {
        this.phase = 'prompt'
        this.state = 'idle'
        this.exitCode = null
        this.startedAt = null
        this.exitAnnounced = false
        this.emit(false)
        return 'exit'
      }
      this.override = { state: 'exited', code: 0, reason: 'ctrlc' }
      setTimeout(() => this.flushOverride(), 350)
      return 'exit'
    }
    if (this.state === 'running') {
      this.lastC = now
      this.proc.write('\x03')
      return 'hint'
    }
    this.proc.write('\x03')
    return 'signal'
  }

  async forceKill(): Promise<void> {
    if (!this.proc || this.phase === 'dead') return
    this.override = { state: 'failed', code: 1, reason: 'kill' }
    const killed = await killChildren(this.proc.pid)
    if (!killed) {
      try {
        this.proc.kill()
      } catch {
        /* ignore */
      }
    }
    setTimeout(() => this.flushOverride(), 400)
  }

  async restart(): Promise<void> {
    if (this.disposed) return
    if (!this.command) {
      if (this.phase === 'dead') await this.spawn()
      return
    }
    if (this.phase === 'dead' || !this.proc) {
      await this.spawn()
      return
    }
    this.restartPending = true
    this.override = null
    const killed = await killChildren(this.proc.pid)
    if (!killed) {
      this.restartPending = false
      this.beginCommand()
      return
    }
    setTimeout(() => {
      if (this.restartPending) {
        this.restartPending = false
        this.beginCommand()
      }
    }, 450)
  }

  private beginDispose(killTree = true): void {
    if (this.disposeStarted) return
    this.disposeStarted = true
    this.disposed = true
    this.statusAbort.abort()
    this.lifecycle?.dispose()
    this.lifecycle = null
    if (this.lifecycleFile) { try { fs.unlinkSync(this.lifecycleFile) } catch { /* Already removed. */ } }
    this.phase = 'dead'
    this.restartPending = false
    this.override = null
    if (!this.proc) this.remoteAbort?.abort()
    this.treeKill = killTree ? this.stopProcessTree() : Promise.resolve(false)
  }

  private async stopProcessTree(): Promise<boolean> {
    const proc = this.proc
    if (!proc || this.procExited || proc.pid === null) return false
    const pid = proc.pid
    // ConPTY only knows processes attached to its console. Kill the tree
    // before closing that console, while parent IDs still identify children.
    if (process.platform === 'win32') {
      await execFileP('taskkill', ['/F', '/T', '/PID', String(pid)], { timeout: 10000, windowsHide: true }).catch((error) => {
        try { process.kill(pid, 0) } catch { return }
        throw error
      })
      return true
    }
    await killChildren(pid)
    return false
  }

  /** Release the native PTY after its tree has stopped. */
  finishDispose(): Promise<void> {
    if (this.disposal) return this.disposal
    this.beginDispose()
    const proc = this.proc
    this.disposal = (async () => {
      if (!proc) return
      let windowsTreeStopped = false
      let treeError: unknown = null
      try {
        windowsTreeStopped = (await this.treeKill) ?? false
      } catch (error) {
        treeError = error
      }
      try {
        // Windows tree termination already triggers node-pty's exit cleanup.
        // Killing that ConPTY again can end Electron before other trees finish.
        if (!this.procExited && !windowsTreeStopped) {
          try { proc.kill() } catch { /* already exited */ }
        }
      } finally {
        if (proc.pid !== null && this.processExit && !this.procExited) {
          // taskkill completion precedes ConPTY's asynchronous output/exit cleanup.
          // Keep Electron alive until the native exit callback has released this PTY.
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('等待终端退出超时')), 10000)
            void this.processExit!.then(() => { clearTimeout(timer); resolve() })
          })
        }
        this.proc = null
      }
      if (treeError) throw treeError
    })().catch((error) => {
      this.disposal = null
      throw error
    })
    return this.disposal
  }

  dispose(): Promise<void> {
    const disposal = this.finishDispose()
    return disposal
  }

  /**
   * Shutdown-only fast path. Callers must already have terminated every
   * descendant; this kills only the root and waits for node-pty to release it,
   * avoiding one taskkill process per terminal.
   */
  disposeRoot(): Promise<void> {
    this.beginDispose(false)
    if (this.disposal) return this.disposal
    const proc = this.proc
    this.disposal = (async () => {
      if (!proc) return
      if (!this.procExited) {
        try { proc.kill() } catch { /* already exited */ }
      }
      if (this.processExit && !this.procExited) {
        try {
          await waitFor(this.processExit, 1500, '等待终端退出超时')
        } catch {
          if (!this.procExited && proc.pid !== null) {
            await execFileP('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { timeout: 4000, windowsHide: true }).catch(() => undefined)
          }
          await waitFor(this.processExit, 8000, '等待终端退出超时')
        }
      }
      this.proc = null
    })().catch((error) => {
      this.disposal = null
      throw error
    })
    return this.disposal
  }

  rootPid(): number | null {
    return this.proc && !this.procExited ? this.proc.pid : null
  }

  private launchLine(): string {
    const command = this.command + (this.kind === 'claude' && this.lifecycleFile ? ` --settings ${this.quoteLifecycleFile()}` : '')
    if (this.shell === 'cmd' && command) return `${command} & echo AWB_EC:!ERRORLEVEL!`
    return command
  }

  private quoteLifecycleFile(): string {
    if (this.shell === 'pwsh') return psQuote(this.lifecycleFile)
    if (this.shell === 'cmd') return `"${this.lifecycleFile.replaceAll('%', '%%')}"`
    return bashQuote(process.platform === 'win32' ? this.lifecycleFile.replaceAll('\\', '/') : this.lifecycleFile)
  }

  private beginCommand(): void {
    if (!this.proc || this.phase === 'dead') return
    this.phase = 'command'
    this.activeAgent = this.kind === 'shell' ? null : this.kind
    this.nativeStatus = false
    this.programWaiting = !!nativeAgent(this.kind)
    this.state = 'running'
    this.startedAt = Date.now()
    this.exitCode = null
    this.exitAnnounced = false
    this.commandSentAt = Date.now()
    this.emit(false)
    this.proc.write(this.launchLine() + '\r')
  }

  private armLaunch(): void {
    if (this.phase !== 'armed') return
    if (this.command) this.beginCommand()
    else {
      this.phase = 'prompt'
      this.state = 'idle'
      this.startedAt = null
      this.exitCode = null
      this.emit(false)
    }
  }

  private flushOverride(): void {
    if (!this.override || this.phase === 'dead') return
    const pending = this.override
    this.override = null
    this.phase = 'prompt'
    this.apply(pending.state, pending.code, true, pending.reason)
  }

  private emitData(data: string): void {
    if (data) this.send({ type: 'data', id: this.id, data })
  }

  private async onData(chunk: string): Promise<void> {
    if (this.disposed) return
    const activity = this.programStatus.push(chunk)
    // Reply in the main process before xterm can answer the following DA query.
    for (let index = 0; index < activity.queries; index++) {
      try {
        if (process.platform === 'win32' && this.proc?.pid) await replyProgramStatus(this.proc.pid, this.statusAbort.signal)
        else this.proc?.write('\x1b]7501;?\x1b\\')
      } catch (error) { if (!this.disposed && !this.procExited) console.error('Native status capability reply unavailable', error) }
    }
    if (this.disposed) return
    for (const report of activity.reports) {
      if (report.protocol === 'progress' && this.nativeStatus) continue
      if (report.protocol === 'program') this.nativeStatus = true
      const agent = nativeAgent(report.app)
      if (agent && report.state !== 'clear') {
        this.activeAgent = agent
        // Native identity is authoritative even if a user starts the CLI while
        // the shell's initial prompt/arming transaction is still completing.
        this.phase = 'command'
        this.state = 'running'
        this.startedAt ??= Date.now()
        this.exitCode = null
      }
      if (report.state === 'clear') { this.activeAgent = null; this.nativeStatus = false }
      this.programWaiting = report.state === 'waiting'
      this.emit(false)
    }
    const parsed = this.osc.push(activity.text)
    const head = stripMarker(parsed.text).text
    const tail = stripMarker(parsed.tail).text
    const code = parsed.codes.length ? parsed.codes[parsed.codes.length - 1] : null
    // Design exit() prints the exit line and only then the next prompt.
    // The shell writes that prompt in the same chunk, after the marker.
    const announceThenPrompt = (state: ProcState, exitCode: number, reason: PtyStateEvent['reason']) => {
      this.phase = 'prompt'
      this.activeAgent = null
      this.nativeStatus = false
      this.emitData(head)
      this.apply(state, exitCode, true, reason)
      this.emitData(tail)
    }
    if (this.phase === 'starting' && parsed.codes.length) {
      this.emitData(head + tail)
      this.phase = 'armed'
      setTimeout(() => this.armLaunch(), 80)
      return
    }
    if (this.phase === 'armed') {
      this.emitData(head + tail)
      return
    }
    if (code === null) {
      this.emitData(head + tail)
      return
    }
    if (this.skipPrompt) {
      this.emitData(head + tail)
      this.skipPrompt = false
      return
    }
    if (this.restartPending) {
      this.emitData(head + tail)
      this.restartPending = false
      this.beginCommand()
      return
    }
    if (this.override) {
      const pending = this.override
      this.override = null
      announceThenPrompt(pending.state, pending.code, pending.reason)
      return
    }
    if (this.phase !== 'command') {
      this.emitData(head + tail)
      return
    }
    if (this.kind === 'shell') {
      this.phase = 'prompt'
      this.activeAgent = null
      this.shellInput = ''
      this.state = 'idle'
      this.exitCode = null
      this.startedAt = null
      this.emit(false)
      this.emitData(head + tail)
      return
    }
    announceThenPrompt(code === 0 ? 'exited' : 'failed', code, 'exit')
  }

  private apply(state: ProcState, code: number | null, announce: boolean, reason?: PtyStateEvent['reason']): void {
    this.state = state
    this.exitCode = code
    if (announce) this.exitAnnounced = true
    this.emit(announce, reason)
  }

  private emit(announce: boolean, reason?: PtyStateEvent['reason']): void {
    if (this.disposed) return
    this.send({
      type: 'state',
      id: this.id,
      state: this.state,
      exitCode: this.exitCode,
      startedAt: this.startedAt,
      inputReady: this.phase === 'prompt' || this.programWaiting,
      agentKind: this.activeAgent,
      announce,
      reason
    })
  }
}

const sessions = new Map<string, Session>()

export async function createSession(
  send: Send,
  opts: { id: string; projectId: string; kind: string; shell: ShellKind }
): Promise<SessionInfo> {
  const draft = db()
  const project = draft.projects.find((p) => p.id === opts.projectId)
  if (!project) throw new Error('项目不存在')
  const host = draft.hosts.find((h) => h.id === project.host)
  if (host && host.id !== 'local' && !host.on) throw new Error('这台机器未连接')
  const agent = agentCommand(opts.kind)
  const shell = (!host || host.id === 'local') && process.platform === 'win32' && opts.shell === 'bash' ? 'bash' : shellForHost(host?.platform || (process.platform === 'win32' ? 'windows' : 'linux'), opts.shell)
  const existing = sessions.get(opts.id)
  await existing?.dispose()
  const session = new Session(send, {
    id: opts.id,
    projectId: opts.projectId,
    kind: opts.kind,
    shell,
    cwd: project.path,
    command: agent.command,
    env: agent.env,
    hostId: project.host
  })
  sessions.set(opts.id, session)
  try {
    await session.spawn()
  } catch (error) {
    if (sessions.get(opts.id) === session) sessions.delete(opts.id)
    await session.dispose()
    throw error
  }
  return session.info()
}

export function writeSession(id: string, data: string, binary = false): void {
  sessions.get(id)?.write(data, binary)
}

export function resizeSession(id: string, cols: number, rows: number): void {
  sessions.get(id)?.resize(cols, rows)
}

export function interruptSession(id: string): Promise<'hint' | 'exit' | 'signal'> {
  const session = sessions.get(id)
  if (!session) return Promise.resolve('signal')
  return session.interrupt()
}

export function killSession(id: string): Promise<void> {
  const session = sessions.get(id)
  if (!session) return Promise.resolve()
  return session.forceKill()
}

export function restartSession(id: string): Promise<void> {
  const session = sessions.get(id)
  if (!session) return Promise.resolve()
  return session.restart()
}

export async function closeSession(id: string): Promise<void> {
  const session = sessions.get(id)
  if (!session) return
  await session.dispose()
  if (sessions.get(id) === session) sessions.delete(id)
}

export async function closeAllSessions(): Promise<void> {
  const results: PromiseSettledResult<void>[] = []
  if (process.platform === 'win32') {
    const closing = [...sessions.entries()]
    const roots = closing.map(([, session]) => session.rootPid()).filter((pid): pid is number => pid !== null)
    let descendantsCleared = true
    if (roots.length) {
      // Kill descendants before their roots so taskkill cannot lose a
      // reparented Agent subtree while the root console is going away.
      await windowsDescendants(roots).then((pids) => {
        for (const pid of pids) {
          try { process.kill(pid) } catch { /* already exited */ }
        }
      }).catch((error) => {
        descendantsCleared = false
        console.error('Failed to snapshot shutdown process tree', error)
      })
    }
    for (const [id, session] of closing) {
      // The bundled ConPTY addon mutates native handles from exit threads;
      // keep root termination and native teardown strictly sequential. The
      // descendant cleanup above removed the process trees, so killing only
      // the root is enough and avoids a slow taskkill process per terminal.
      // If the snapshot failed, fall back to taskkill /T so no child escapes.
      results.push(...await Promise.allSettled([descendantsCleared ? session.disposeRoot() : session.dispose()]))
      if (sessions.get(id) === session) sessions.delete(id)
    }
  } else results.push(...await Promise.allSettled([...sessions.keys()].map(closeSession)))
  const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (errors.length) throw new AggregateError(errors.map((result) => result.reason), 'Failed to close terminal sessions')
}

export async function testExecutor(opts: {
  cmd: string
  args: string
  shell: ShellKind
  env: EnvVar[]
  cwd: string
}): Promise<{ text: string; code: number | null }> {
  const command = cmdline(opts)
  if (!command.trim()) return { text: '请先填写命令。', code: null }
  const env: NodeJS.ProcessEnv = { ...process.env, TERM: 'xterm-256color' }
  for (const item of opts.env) if (item.k) env[item.k] = item.v
  const cwd = opts.cwd && fs.existsSync(opts.cwd) ? opts.cwd : process.cwd()
  let file = 'bash'
  let args: string[] = ['-lc', command]
  if (process.platform === 'win32') {
    if (opts.shell === 'cmd') {
      file = process.env.ComSpec || 'cmd.exe'
      args = ['/Q', '/V:ON', '/C', command]
    } else {
      file = 'powershell.exe'
      args = ['-NoLogo', '-NoProfile', '-Command', command]
    }
  }
  return await new Promise((resolve) => {
    let buf = ''
    let settled = false
    const proc = pty.spawn(file, args, { name: 'xterm-256color', cols: 100, rows: 30, cwd, env })
    const finish = (code: number | null) => {
      if (settled) return
      settled = true
      resolve({ text: buf.slice(0, 12000), code })
    }
    const timer = setTimeout(() => {
      try {
        proc.kill()
      } catch {
        /* ignore */
      }
      finish(null)
    }, 2500)
    proc.onData((data) => {
      buf += data
    })
    proc.onExit((result) => {
      clearTimeout(timer)
      const code = typeof result === 'number' ? result : (result?.exitCode ?? 1)
      finish(code)
    })
  })
}
