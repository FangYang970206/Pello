import { t } from '../shared/i18n'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { app } from 'electron'
import * as pty from 'node-pty'
import type { EnvVar, Executor, ProcState, PtyStateEvent, ShellKind } from '../shared/types'
import { cmdline, PRESETS } from '../shared/types'
import { effectiveExecutor, executorTemplate, isConfiguredLaunch, submittedCustomAgent } from '../shared/executor'
import { db } from './store'
import { discoverLocalShells } from './local-shells'
import { OscStrip } from './osc'
import { TerminalContextTracker } from './terminal-context'
import type { TerminalContext } from '../shared/types'
import { ProgramStatus } from './program-status'
import { replyProgramStatus } from './windows-status'
import { claudeLifecycle, nativeAgent, submittedAgent } from './agent-lifecycle'
import { agentResumeCommand, customResumeCommand, validAgentSession, terminalSessionKey } from './agent-resume'
import { createCodexThread } from './codex-session'
import { encodeRemoteEnv, ExecutorLogRedactor, packExecutorEnv, receiveRemoteEnv, redactExecutorOutput, REMOTE_ENV_APPLIED, REMOTE_ENV_READY } from './executor-env'
import { machine } from './executor-templates'
import { flushTerminalRecording, loadTerminalHistory, recordTerminalOutput } from './terminal-history'
import { legacyConversations, matchLegacyConversation } from './legacy-agent-session'
import { needsSshClient, passwordTerminal, remoteCommand, type TerminalProcess } from './ssh'
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
  agentSessionId: string | null
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

type TerminalLaunch = { command: string; env: EnvVar[]; session?: Executor['session']; shell?: ShellKind; custom?: boolean }
function agentCommand(kind: string, hostId: string): TerminalLaunch {
  const draft = db(), template = executorTemplate(draft, hostId, kind)
  const preset = PRESETS.find((p) => p.id === kind)
  const custom = draft.custom.find((c) => c.id === kind)
  const config = custom && effectiveExecutor(custom, hostId, template)
  return { command: cmdline(preset || config || {}), env: template?.env || config?.env || [], session: config?.session, shell: config?.shell, custom: !!custom }
}

class Session {
  recordHistory = true
  private closing = false

  /** Freeze foreground identity before Windows terminates descendants and returns to the parent shell. */
  prepareShutdown(): void { this.closing = true }
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
  private pendingInput: { data: string; binary: boolean; offset: number }[] = []
  private inputTimer?: ReturnType<typeof setTimeout>
  private cols = 80
  private rows = 24
  private remoteAbort: AbortController | null = null
  private osc = new OscStrip()
  private contextTracker: TerminalContextTracker | undefined
  private context: TerminalContext | null = null
  private contextToken = randomUUID()
  private programStatus = new ProgramStatus()
  private programWaiting = false
  private activeAgent: string | null = null
  private agentSessionId: string | null = null
  private savedAgentSessionId: string | null
  private readonly terminalOptions: TerminalLaunch
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
  private logRedactor = new ExecutorLogRedactor()
  private environmentTransfer?: { payload: string; seen: string; sent: boolean; timer: ReturnType<typeof setTimeout> }

  constructor(
    private send: Send,
    opts: { id: string; projectId: string; kind: string; shell: ShellKind; cwd: string; command: string; env: EnvVar[]; hostId: string; agentSessionId?: string },
    private onProcessExit?: (code: number) => void
  ) {
    this.id = opts.id
    this.projectId = opts.projectId
    this.kind = opts.kind
    this.shell = opts.shell
    this.cwd = opts.cwd
    this.command = opts.command
    this.terminalOptions = { command: opts.command, env: opts.env }
    this.agentSessionId = validAgentSession(opts.agentSessionId)
    // ConPTY omits the final position of a hidden hardware cursor. Pi's native
    // cursor mode keeps its IME anchor at the editor caret, including when Pi
    // is started manually from a Shell terminal. Custom executor env can opt out.
    this.env = {}
    this.hostId = opts.hostId
    this.savedAgentSessionId = this.agentSessionId
  }

  private localEnvironment(env: EnvVar[]): NodeJS.ProcessEnv {
    const result: NodeJS.ProcessEnv = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', AWB_CWD: this.cwd, PI_PROGRAM_STATUS: '1',
      ...(process.platform === 'win32' ? { PI_HARDWARE_CURSOR: '1' } : {}) }
    const ompDirectory = ompInstallDirectory()
    if (fs.existsSync(ompDirectory)) {
      const pathKey = Object.keys(result).find((key) => key.toLowerCase() === 'path') || 'PATH'
      result[pathKey] = [ompDirectory, result[pathKey] || ''].join(path.delimiter)
    }
    for (const item of env) {
      if (item.k) result[item.k] = item.v
    }
    return result
  }

  private transferEnvironment(rows: EnvVar[], startup: boolean) {
    this.environmentTransfer = { payload: encodeRemoteEnv(rows).replaceAll('\n', '\r'), seen: '', sent: false,
      timer: setTimeout(() => {
        this.environmentTransfer = undefined
        if (startup) this.proc?.kill()
        else this.proc?.write('\x03')
      }, 15000) }
  }

  private receiveEnvironment(data: string, proc: TerminalProcess): string {
    const transfer = this.environmentTransfer
    if (!transfer) return data
    transfer.seen = (transfer.seen + data).slice(-4096)
    const marker = transfer.sent ? REMOTE_ENV_APPLIED : REMOTE_ENV_READY
    const at = transfer.seen.indexOf(marker)
    if (at < 0) return ''
    const tail = transfer.seen.slice(at + marker.length)
    if (transfer.sent) {
      clearTimeout(transfer.timer)
      this.environmentTransfer = undefined
      return tail
    }
    transfer.sent = true
    transfer.seen = ''
    proc.write(transfer.payload)
    transfer.payload = ''
    return ''
  }

  hostId: string

  info(): SessionInfo {
    return { id: this.id, state: this.state, exitCode: this.exitCode, startedAt: this.startedAt, inputReady: this.phase === 'prompt' || this.programWaiting, shell: this.shell, kind: this.kind, agentKind: this.activeAgent, agentSessionId: this.agentSessionId }
  }

  redactHistory(text: string): string { return this.logRedactor.complete(text) }
  private record(data: string, flush = false) {
    if (!this.recordHistory || !db().settings.restore) return
    const text = this.logRedactor.push(data) + (flush ? this.logRedactor.flush() : '')
    try { if (text) recordTerminalOutput(this.id, text) }
    catch (error) { console.error('Unable to persist terminal output', error) }
  }

  async spawn(): Promise<void> {
    if (this.disposed) return
    this.procExited = false
    const host = machine(db(), this.hostId, true)
    const launchConfig = this.kind === '__executor_test__' ? this.terminalOptions : agentCommand(this.kind, this.hostId)
    const { env } = launchConfig
    this.logRedactor.track(env)
    this.env = this.localEnvironment(host.id === 'local' ? env : [])
    const sessionConfig = launchConfig.session
    this.contextTracker?.dispose()
    this.contextTracker = host.id !== 'local' && host.platform === 'linux' ? new TerminalContextTracker(this.contextToken, this.id, this.projectId, host, this.cwd.replace(/\/+$/, '') || '/') : undefined
    this.context = null
    const files = shellFiles()
    this.phase = 'starting'
    this.osc = new OscStrip()
    this.programStatus = new ProgramStatus()
    this.programWaiting = false
    this.activeAgent = null
    this.agentSessionId = validAgentSession(this.savedAgentSessionId)
    this.nativeStatus = false
    this.shellInput = ''
    this.statusAbort = new AbortController()
    // The system ConPTY can spend seconds decoding a large paste. Use the
    // OpenConsole backend bundled with node-pty for Windows console processes.
    const windowsPtyOptions = process.platform === 'win32' ? { useConptyDll: true } : {}
    if (!this.agentSessionId && host && host.id !== 'local' && ['claude', 'codex', 'opencode', 'pi', 'omp'].includes(this.kind) && loadTerminalHistory(this.id)) {
      throw new Error(t("旧远程 Agent 会话缺少原生 ID，原终端历史已保留；未创建空白对话"))
    }
    if (!this.agentSessionId && (!host || host.id === 'local') && ['claude', 'codex', 'opencode', 'pi', 'omp'].includes(this.kind)) {
      const history = loadTerminalHistory(this.id)
      if (history) {
        const candidates = await legacyConversations(this.kind, this.cwd, this.env)
        if (this.disposed) return
        const match = matchLegacyConversation(history, candidates)
        if (!match) throw new Error(t("无法唯一定位旧 Agent 对话，原终端历史已保留；未创建空白对话"))
        if (match) {
          if (this.kind === 'pi' || this.kind === 'omp') {
            const directory = path.join(app.getPath('userData'), 'agent-sessions', terminalSessionKey(this.id))
            fs.mkdirSync(directory, { recursive: true })
            const destination = path.join(directory, path.basename(match.file))
            if (!fs.existsSync(destination)) fs.copyFileSync(match.file, destination, fs.constants.COPYFILE_EXCL)
            this.agentSessionId = 'pello:directory'
          } else this.agentSessionId = match.id
        }
      }
    }
    if (this.kind === 'codex' && !this.agentSessionId) {
      this.agentSessionId = await createCodexThread(this.cwd, host, this.statusAbort.signal, env)
      if (this.disposed) return
    }
    const quote = (text: string) => this.shell === 'pwsh' ? psQuote(text) : this.shell === 'cmd' ? `"${text.replaceAll('%', '%%')}"` : bashQuote(text.replaceAll('\\', '/'))
    const key = terminalSessionKey(this.id)
    const directory = !host || host.id === 'local'
      ? quote(path.join(app.getPath('userData'), 'agent-sessions', key))
      : host.platform === 'windows' ? `(Join-Path $HOME '.pello/sessions/${key}')` : `"$HOME/.local/state/pello/sessions/${key}"`
    if (sessionConfig && !this.agentSessionId && loadTerminalHistory(this.id)) throw new Error(t("旧自定义 Agent 会话缺少原生 ID，原终端历史已保留；未创建空白对话"))
    if (launchConfig.custom && this.agentSessionId && !sessionConfig) throw new Error(t("当前执行器模板缺少会话恢复参数，已保留终端历史"))
    const launch = sessionConfig
      ? customResumeCommand(launchConfig.command, this.agentSessionId, sessionConfig, quote)
      : agentResumeCommand(this.kind, launchConfig.command, this.agentSessionId || undefined, directory, quote)
    this.command = launch.command
    this.agentSessionId = launch.session || this.agentSessionId
    this.savedAgentSessionId = this.agentSessionId
    let proc: TerminalProcess
    const remoteEnvironment = host.id !== 'local' && !!env.length
    if (!host || host.id === 'local') {
      if (!this.lifecycle && ['claude', 'shell'].includes(this.kind)) {
        const lifecycle = await claudeLifecycle((report) => {
          if (this.disposed || this.phase !== 'command' || this.activeAgent !== 'claude') return
          if (report.state === 'clear') this.activeAgent = null
          if (report.sessionId && validAgentSession(report.sessionId)) this.savedAgentSessionId = this.agentSessionId = report.sessionId
          this.nativeStatus = report.state !== 'clear'
          this.programWaiting = report.state === 'waiting'
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
      if (env.length && this.shell !== 'cmd') this.env.PELLO_STARTUP_ENV = packExecutorEnv(env)
      if (spec.env) Object.assign(this.env, spec.env)
      if (process.platform === 'win32' && spec.env?.PATH) for (const key of Object.keys(this.env)) { if (key.toLowerCase() === 'path' && key !== 'PATH') delete this.env[key] }
      if (process.platform === 'win32' && spec.shell === 'bash') this.env.AWB_CWD = this.cwd.replaceAll('\\', '/')
      proc = pty.spawn(spec.file, spec.args, {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: this.cwd,
        env: this.env,
        ...windowsPtyOptions
      })
    } else {
      this.shell = shellForHost(host.platform, this.shell)
      const boot = remoteBootstrap(host.platform, this.cwd, this.contextToken, remoteEnvironment)
      this.remoteAbort = new AbortController()
      proc = needsSshClient(host) ? await passwordTerminal(host, boot, this.remoteAbort.signal) : pty.spawn('ssh', sshArgs(host, [remoteCommand(host, boot)]), {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: process.cwd(),
        env: this.env,
        ...windowsPtyOptions
      })
    }
    if (this.disposed) { proc.kill(); return }
    this.proc = proc
    let finishExit: () => void = () => undefined
    this.processExit = new Promise<void>((resolve) => { finishExit = resolve })
    proc.resize(this.cols, this.rows)
    if (remoteEnvironment) this.transferEnvironment(env, true)
    proc.onData((data) => {
      if (this.disposed) return
      data = this.receiveEnvironment(data, proc)
      if (!data) return
      if (process.env.AWB_DEBUG && !this.logRedactor.hasValues) console.log(`[pty ${this.id}]`, JSON.stringify(data).slice(0, 300))
      this.outputQueue = this.outputQueue.then(() => this.onData(data)).catch((error) => { if (!this.disposed) console.error('Terminal status reply failed', error) })
    })
    setTimeout(() => {
      if (!this.environmentTransfer && this.phase === 'starting') {
        this.skipPrompt = true
        this.phase = 'armed'
        this.armLaunch()
      }
    }, 1200)
    proc.onExit((result) => {
      if (this.environmentTransfer) { clearTimeout(this.environmentTransfer.timer); this.environmentTransfer = undefined }
      this.procExited = true
      finishExit()
      this.statusAbort.abort()
      this.outputQueue = this.outputQueue.then(() => {
        if (this.disposed) return
        this.record('', true)
        const code = typeof result === 'number' ? result : (result?.exitCode ?? 1)
        this.phase = 'dead'
        this.programWaiting = false
        const state: ProcState = code === 0 ? 'exited' : 'failed'
        this.apply(state, code, !this.exitAnnounced, 'exit')
        this.onProcessExit?.(code)
      })
    })
  }

  write(data: string, binary = false): void {
    if (!this.proc || this.phase === 'dead' || this.environmentTransfer) return
    const bracketed = !binary && data.startsWith('\x1b[200~') && data.endsWith('\x1b[201~')
    const submitted = !binary && !bracketed && (data.includes('\r') || data.includes('\n'))
    if (submitted && this.phase === 'prompt' && this.state !== 'running') {
      const command = this.shellInput + data.slice(0, data.search(/[\r\n]/))
      const draft = db()
      const custom = submittedCustomAgent(command, draft.custom, this.hostId)
      const config = custom && effectiveExecutor(custom, this.hostId, executorTemplate(draft, this.hostId, custom.id))
      this.activeAgent = custom?.id || submittedAgent(command) || null
      if (custom && config && isConfiguredLaunch(command, custom, this.hostId)) {
        const quote = (text: string) => this.shell === 'pwsh' ? psQuote(text) : this.shell === 'cmd' ? `"${text}"` : bashQuote(text)
        const launch = customResumeCommand(command, null, config.session, quote)
        this.logRedactor.track(config.env || [])
        // Only extend a simple, newly typed launch. Shell history/editing is not reinterpreted.
        if (config.env?.length) {
          const bash = this.shell === 'bash' || this.shell === 'zsh'
          const script = receiveRemoteEnv('windows', true) + `\ncmd.exe /d /c ${psQuote(launch.command)}`
          const wrapper = bash ? `__pello_with_env ${bashQuote(launch.command)}` :
            this.shell === 'pwsh' ? `__pello_with_env { ${launch.command} }` :
              `powershell.exe -NoProfile -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`
          const clear = this.shellInput ? (bash ? '\x15' : '\x1b') : ''
          data = clear + wrapper + data.slice(data.search(/[\r\n]/))
          this.transferEnvironment(config.env, false)
        } else {
          const suffix = launch.command.slice(command.length)
          data = data.replace(/[\r\n]/, (enter) => suffix + enter)
        }
        this.savedAgentSessionId = this.agentSessionId = launch.session || null
      }
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
      const input = bracketed ? data.slice(6, -6) : data
      const multilinePaste = bracketed && /[\r\n]/.test(input)
      if (multilinePaste) this.shellInput = ''
      for (const char of (multilinePaste ? '' : input.slice(0, 8192))) {
        if (char === '\x7f' || char === '\b') this.shellInput = this.shellInput.slice(0, -1)
        else if (char === '\x03' || char === '\x15') this.shellInput = ''
        else if (char >= ' ' && this.shellInput.length < 8192) this.shellInput += char
      }
    }
    if (!this.pendingInput.length && data.length <= 8192) {
      this.proc.write(binary ? Buffer.from(data, 'latin1') : data)
      return
    }
    this.pendingInput.push({ data, binary, offset: 0 })
    if (!this.inputTimer) this.flushInput(this.proc)
  }

  private flushInput(proc: TerminalProcess): void {
    this.inputTimer = undefined
    if (this.proc !== proc || this.disposed || this.procExited) {
      this.pendingInput = []
      return
    }
    const entry = this.pendingInput[0]
    if (!entry) return
    let end = Math.min(entry.offset + 8192, entry.data.length)
    if (!entry.binary && end < entry.data.length) {
      const code = entry.data.charCodeAt(end - 1)
      if (code >= 0xD800 && code <= 0xDBFF) end--
    }
    const chunk = entry.data.slice(entry.offset, end)
    proc.write(entry.binary ? Buffer.from(chunk, 'latin1') : chunk)
    entry.offset = end
    if (end === entry.data.length) this.pendingInput.shift()
    if (this.pendingInput.length) this.inputTimer = setTimeout(() => this.flushInput(proc), 0)
  }

  private cancelPendingInput(proc: TerminalProcess): void {
    clearTimeout(this.inputTimer)
    this.inputTimer = undefined
    const entry = this.pendingInput[0]
    this.pendingInput = []
    if (entry?.offset && !entry.binary && entry.data.startsWith('\x1b[200~') && entry.data.endsWith('\x1b[201~')) {
      const markerStart = entry.data.length - 6
      proc.write(entry.offset > markerStart ? entry.data.slice(entry.offset) : '\x1b[201~')
    }
  }

  writeShiftEnter(): void {
    if (!this.activeAgent) {
      this.write('\r')
      return
    }
    // Native Codex reads console key events on Windows. ConPTY decodes this
    // Win32 input record as VK_RETURN with SHIFT_PRESSED.
    const nativeCodex = this.activeAgent === 'codex' && this.hostId === 'local' && process.platform === 'win32'
    this.write(nativeCodex ? '\x1b[13;28;13;1;16;1_' : '\x1b[13;2u')
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
    this.cancelPendingInput(this.proc)
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
    this.contextTracker?.dispose()
    if (this.disposeStarted) return
    this.disposeStarted = true
    this.record('', true)
    this.disposed = true
    clearTimeout(this.inputTimer)
    this.inputTimer = undefined
    this.pendingInput = []
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
            const timer = setTimeout(() => reject(new Error(t("等待终端退出超时"))), 10000)
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
          await waitFor(this.processExit, 1500, t("等待终端退出超时"))
        } catch {
          if (!this.procExited && proc.pid !== null) {
            await execFileP('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { timeout: 4000, windowsHide: true }).catch(() => undefined)
          }
          await waitFor(this.processExit, 8000, t("等待终端退出超时"))
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
    this.programWaiting = !!this.activeAgent
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
    if (data) {
      this.record(data)
      this.send({ type: 'data', id: this.id, data })
    }
  }

  private async onData(chunk: string): Promise<void> {
    if (this.disposed) return
    if (this.contextTracker) {
      const report = this.contextTracker.push(chunk)
      chunk = report.text
      if (report.context !== undefined) { this.context = report.context; this.emit(false) }
    }
    if (this.closing) {
      // The renderer snapshot was already flushed. Keep the complete journal,
      // but do not turn shutdown-generated prompts into a saved Shell session.
      this.record(chunk)
      return
    }
    const activity = this.programStatus.push(chunk)
    // Reply in the main process before xterm can answer the following DA query.
    for (let index = 0; index < activity.queries; index++) {
      try {
        if (process.platform === 'win32' && this.proc?.pid) await replyProgramStatus(this.proc.pid, this.statusAbort.signal)
        else this.proc?.write('\x1b]7501;?\x1b\\')
      } catch (error) { if (!this.disposed && !this.procExited) console.error('Native status capability reply unavailable', error) }
    }
    if (this.disposed) return
    if (this.closing) {
      this.record(chunk)
      return
    }
    for (const report of activity.reports) {
      if (report.protocol === 'progress' && this.nativeStatus) continue
      if (report.protocol === 'program') this.nativeStatus = true
      const agent = nativeAgent(report.app)
      if (agent && report.state !== 'clear') {
        this.activeAgent = agent
        if (validAgentSession(report.sessionId)) this.savedAgentSessionId = this.agentSessionId = report.sessionId!
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
      if (this.kind === 'shell') this.agentSessionId = null
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
      this.agentSessionId = null
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
    if (this.disposed || this.closing) return
    this.send({
      type: 'state',
      context: this.context,
      id: this.id,
      state: this.state,
      exitCode: this.exitCode,
      startedAt: this.startedAt,
      inputReady: this.phase === 'prompt' || this.programWaiting,
      agentKind: this.activeAgent,
      agentSessionId: this.agentSessionId,
      announce,
      reason
    })
  }
}

const sessions = new Map<string, Session>()

export async function createSession(
  send: Send,
  opts: { id: string; projectId: string; kind: string; shell: ShellKind; agentSessionId?: string }
): Promise<SessionInfo> {
  const draft = db()
  const project = draft.projects.find((p) => p.id === opts.projectId)
  if (!project) throw new Error(t("项目不存在"))
  if (opts.agentSessionId && !validAgentSession(opts.agentSessionId)) throw new Error(t("保存的 Agent 会话 ID 无效，已保留原记录"))
  const host = machine(draft, project.host, true)
  const agent = agentCommand(opts.kind, project.host)
  const requestedShell = agent.shell || opts.shell
  const shell = host.id === 'local' && process.platform === 'win32' && requestedShell === 'bash' ? 'bash' : shellForHost(host.platform, requestedShell)
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
    hostId: project.host,
    agentSessionId: opts.agentSessionId
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

export function redactTerminalHistory(id: string, content: string): string {
  return sessions.get(id)?.redactHistory(content) ?? content
}

export function writeSessionShiftEnter(id: string): void {
  sessions.get(id)?.writeShiftEnter()
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

let terminalCloseQueue = Promise.resolve()
function enqueueTerminalClose(close: () => Promise<void>): Promise<void> {
  if (process.platform !== 'win32') return close()
  // Session/project deletion issues concurrent IPC calls. Share the same fence
  // with window shutdown so taskkill and ConPTY native teardown stay serial.
  const next = terminalCloseQueue.then(close)
  terminalCloseQueue = next.catch(() => undefined)
  return next
}

export async function closeSession(id: string): Promise<void> {
  return enqueueTerminalClose(async () => {
    const session = sessions.get(id)
    if (!session) return
    await session.dispose()
    await flushTerminalRecording(id)
    if (sessions.get(id) === session) sessions.delete(id)
  })
}

export async function closeAllSessions(): Promise<void> {
  return enqueueTerminalClose(closeAllSessionsNow)
}

async function closeAllSessionsNow(): Promise<void> {
  const results: PromiseSettledResult<void>[] = []
  for (const session of sessions.values()) session.prepareShutdown()
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
  results.push(...await Promise.allSettled([flushTerminalRecording()]))
  const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (errors.length) throw new AggregateError(errors.map((result) => result.reason), 'Failed to close terminal sessions')
}

export async function testExecutor(opts: {
  cmd: string
  args: string
  shell: ShellKind
  env: EnvVar[]
  cwd: string
  hostId?: string
  executorId?: string
}): Promise<{ text: string; code: number | null; running?: boolean }> {
  let command = cmdline(opts)
  if (!command.trim()) return { text: t("请先填写命令。"), code: null }
  const hostId = opts.hostId || 'local'
  const template = opts.executorId && executorTemplate(db(), hostId, opts.executorId)
  const env = template ? template.env : opts.env
  const host = db().hosts.find((item) => item.id === hostId)
  if (!host || (hostId !== 'local' && !host.on)) throw new Error(t("这台机器未连接"))
  const local = hostId === 'local'
  const cwd = local ? opts.cwd && fs.existsSync(opts.cwd) ? opts.cwd : process.cwd() : opts.cwd || (host.platform === 'windows' ? 'C:\\' : '/')
  const shell = local && process.platform === 'win32' && opts.shell === 'bash' ? 'bash' : shellForHost(host.platform, opts.shell)
  const id = `executor-test-${randomUUID()}`
  const marker = `\x1b]777;awb;${id};`
  const exitPattern = shell === 'cmd' ? new RegExp(`${id}:(-?\\d+)[\\r\\n]`) : new RegExp(`\\x1b\\]777;awb;${id};(-?\\d+)(?:\\x07|\\x1b\\\\)`)
  if (shell === 'pwsh') {
    command += `; $pelloOk = $?; $pelloCode = if ($pelloOk) { 0 } elseif ($global:LASTEXITCODE) { $global:LASTEXITCODE } else { 1 }; [Console]::Out.Write(([char]27).ToString()+'${marker.slice(1)}'+$pelloCode+([char]7))`
  } else if (shell === 'cmd') command += ` & echo ${id}:!ERRORLEVEL!`
  else command += `; printf '\\033${marker.slice(1)}%s\\007' "$?"`
  let buf = '', finish: (code: number | null) => void = () => undefined
  let settle: ReturnType<typeof setTimeout> | undefined
  const done = new Promise<number | null>((resolve) => { finish = resolve })
  const session = new Session((event) => {
    if (event.type !== 'data') return
    buf = (buf + event.data).slice(-12000)
    // A shell may render additional prompts during startup. Only the command's
    // completion marker or the actual process exit can finish a launch test.
    const match = exitPattern.exec(buf)
    if (match) {
      buf = buf.slice(0, match.index) + buf.slice(match.index + match[0].length)
      // ConPTY can deliver formatted PowerShell output after its console marker.
      settle ??= setTimeout(() => finish(Number(match[1])), 180)
    }
  }, { id, projectId: '', kind: '__executor_test__', shell, cwd, command, env, hostId }, (code) => finish(code))
  session.recordHistory = false
  sessions.set(id, session)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await session.spawn()
    timer = setTimeout(() => finish(null), 8000)
    const code = await done
    return { text: redactExecutorOutput(buf, env), code, ...(code === null ? { running: true } : {}) }
  } catch (error) {
    if (error instanceof Error) {
      error.message = redactExecutorOutput(error.message, env)
      throw error
    }
    return { text: redactExecutorOutput(String(error), env), code: null }
  } finally {
    clearTimeout(timer)
    clearTimeout(settle)
    await session.dispose()
    if (sessions.get(id) === session) sessions.delete(id)
  }
}
