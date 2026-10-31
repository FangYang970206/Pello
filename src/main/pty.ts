import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { app } from 'electron'
import * as pty from 'node-pty'
import type { EnvVar, ProcState, PtyStateEvent, ShellKind } from '../shared/types'
import { cmdline, PRESETS } from '../shared/types'
import { db } from './store'
import {
  bashRc,
  pwshProfile,
  remoteBootstrap,
  resolveLocalShell,
  shellForHost,
  sshArgs
} from './platform'

const execFileP = promisify(execFile)
const MARK = '\x1b]777;awb;prompt;'

export interface SessionInfo {
  id: string
  state: ProcState
  exitCode: number | null
  startedAt: number | null
  shell: ShellKind
  kind: string
}

type Send = (event: { type: 'data'; id: string; data: string } | PtyStateEvent) => void

class OscStrip {
  private pending = ''

  push(chunk: string): { text: string; codes: number[] } {
    this.pending += chunk
    let text = ''
    const codes: number[] = []
    while (this.pending.length) {
      const at = this.pending.indexOf(MARK)
      if (at === -1) {
        const esc = this.pending.lastIndexOf('\x1b')
        if (esc >= 0 && this.pending.length - esc < MARK.length + 12) {
          text += this.pending.slice(0, esc)
          this.pending = this.pending.slice(esc)
        } else {
          text += this.pending
          this.pending = ''
        }
        break
      }
      text += this.pending.slice(0, at)
      const rest = this.pending.slice(at + MARK.length)
      const bel = rest.indexOf('\x07')
      const st = rest.indexOf('\x1b\\')
      let end = -1
      let skip = 0
      if (bel !== -1 && (st === -1 || bel < st)) {
        end = bel
        skip = 1
      } else if (st !== -1) {
        end = st
        skip = 2
      }
      if (end === -1) {
        this.pending = this.pending.slice(at)
        break
      }
      const num = Number(rest.slice(0, end).trim())
      if (!Number.isNaN(num)) codes.push(num)
      this.pending = rest.slice(end + skip)
    }
    return { text, codes }
  }
}

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

async function killChildren(pid: number): Promise<boolean> {
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

function shellFiles(): { bash: string; pwsh: string } {
  const dir = path.join(app.getPath('userData'), 'shell')
  fs.mkdirSync(dir, { recursive: true })
  const bash = path.join(dir, 'bashrc.sh')
  const pwsh = path.join(dir, 'profile.ps1')
  fs.writeFileSync(bash, bashRc())
  fs.writeFileSync(pwsh, pwshProfile())
  return { bash, pwsh }
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
  private proc: pty.IPty | null = null
  private osc = new OscStrip()
  private phase: 'starting' | 'armed' | 'command' | 'prompt' | 'dead' = 'starting'
  private lastC = 0
  private exitAnnounced = false
  private restartPending = false
  private override: { state: ProcState; code: number; reason: 'kill' | 'ctrlc' } | null = null
  private commandSentAt = 0
  private skipPrompt = false
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
    this.env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', AWB_CWD: opts.cwd }
    for (const item of opts.env) {
      if (item.k) this.env[item.k] = item.v
    }
    this.hostId = opts.hostId
  }

  hostId: string

  info(): SessionInfo {
    return { id: this.id, state: this.state, exitCode: this.exitCode, startedAt: this.startedAt, shell: this.shell, kind: this.kind }
  }

  spawn(): void {
    const draft = db()
    const host = draft.hosts.find((h) => h.id === this.hostId) || draft.hosts[0]
    const files = shellFiles()
    this.phase = 'starting'
    this.osc = new OscStrip()
    let proc: pty.IPty
    if (!host || host.id === 'local') {
      const spec = resolveLocalShell(this.shell, this.shell === 'pwsh' ? files.pwsh : files.bash)
      this.shell = spec.shell
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
      proc = pty.spawn('ssh', sshArgs(host, boot), {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: process.cwd(),
        env: this.env
      })
    }
    this.proc = proc
    proc.onData((data) => {
      if (process.env.AWB_DEBUG) console.log(`[pty ${this.id}]`, JSON.stringify(data).slice(0, 300))
      this.onData(data)
    })
    setTimeout(() => {
      if (this.phase === 'starting') {
        this.skipPrompt = true
        this.phase = 'armed'
        this.armLaunch()
      }
    }, 1200)
    proc.onExit((result) => {
      const code = typeof result === 'number' ? result : (result?.exitCode ?? 1)
      this.phase = 'dead'
      const state: ProcState = code === 0 ? 'exited' : 'failed'
      this.apply(state, code, !this.exitAnnounced, 'exit')
    })
  }

  write(data: string): void {
    if (!this.proc || this.phase === 'dead') return
    if ((data.includes('\r') || data.includes('\n')) && this.phase === 'prompt' && this.state !== 'running') {
      this.phase = 'command'
      this.state = 'running'
      this.startedAt = Date.now()
      this.exitCode = null
      this.exitAnnounced = false
      this.commandSentAt = Date.now()
      this.emit(false)
    }
    this.proc.write(data)
  }

  resize(cols: number, rows: number): void {
    if (!this.proc || cols < 2 || rows < 2) return
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
      this.override = { state: 'exited', code: 0, reason: 'ctrlc' }
      const killed = await killChildren(this.proc.pid)
      if (!killed) this.proc.write('\x03')
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
    if (!this.command) {
      if (this.phase === 'dead') this.spawn()
      return
    }
    if (this.phase === 'dead' || !this.proc) {
      this.spawn()
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

  dispose(): void {
    try {
      this.proc?.kill()
    } catch {
      /* ignore */
    }
    this.phase = 'dead'
  }

  private launchLine(): string {
    if (this.shell === 'cmd' && this.command) return `${this.command} & echo AWB_EC:!ERRORLEVEL!`
    return this.command
  }

  private beginCommand(): void {
    if (!this.proc || this.phase === 'dead') return
    this.phase = 'command'
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

  private onData(chunk: string): void {
    const parsed = this.osc.push(chunk)
    const marked = stripMarker(parsed.text)
    if (marked.text) this.send({ type: 'data', id: this.id, data: marked.text })
    const code = marked.code ?? (parsed.codes.length ? parsed.codes[parsed.codes.length - 1] : null)
    if (this.phase === 'starting' && parsed.codes.length) {
      this.phase = 'armed'
      setTimeout(() => this.armLaunch(), 80)
      return
    }
    if (this.phase === 'armed') return
    if (code === null) return
    if (this.skipPrompt) {
      this.skipPrompt = false
      return
    }
    if (this.restartPending) {
      this.restartPending = false
      this.beginCommand()
      return
    }
    if (this.override) {
      const pending = this.override
      this.override = null
      this.phase = 'prompt'
      this.apply(pending.state, pending.code, true, pending.reason)
      return
    }
    if (this.phase !== 'command') return
    if (this.kind === 'shell') {
      this.phase = 'prompt'
      this.state = 'idle'
      this.exitCode = null
      this.startedAt = null
      this.emit(false)
      return
    }
    this.phase = 'prompt'
    this.apply(code === 0 ? 'exited' : 'failed', code, true, 'exit')
  }

  private apply(state: ProcState, code: number | null, announce: boolean, reason?: PtyStateEvent['reason']): void {
    this.state = state
    this.exitCode = code
    if (announce) this.exitAnnounced = true
    this.emit(announce, reason)
  }

  private emit(announce: boolean, reason?: PtyStateEvent['reason']): void {
    this.send({
      type: 'state',
      id: this.id,
      state: this.state,
      exitCode: this.exitCode,
      startedAt: this.startedAt,
      announce,
      reason
    })
  }
}

const sessions = new Map<string, Session>()

export function createSession(
  send: Send,
  opts: { id: string; projectId: string; kind: string; shell: ShellKind }
): SessionInfo {
  const draft = db()
  const project = draft.projects.find((p) => p.id === opts.projectId)
  if (!project) throw new Error('项目不存在')
  const host = draft.hosts.find((h) => h.id === project.host)
  if (host && host.id !== 'local' && !host.on) throw new Error('这台机器未连接')
  const agent = agentCommand(opts.kind)
  const shell = shellForHost(host?.platform || (process.platform === 'win32' ? 'windows' : 'linux'), opts.shell)
  const existing = sessions.get(opts.id)
  existing?.dispose()
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
  session.spawn()
  return session.info()
}

export function writeSession(id: string, data: string): void {
  sessions.get(id)?.write(data)
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

export function closeSession(id: string): void {
  const session = sessions.get(id)
  if (!session) return
  session.dispose()
  sessions.delete(id)
}

export function closeAllSessions(): void {
  for (const session of sessions.values()) session.dispose()
  sessions.clear()
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
