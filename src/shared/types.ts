export type ThemeName = 'dark' | 'light'
export type ShellKind = 'pwsh' | 'cmd' | 'bash' | 'zsh'
export type OsKind = 'windows' | 'linux'
export type ProcState = 'running' | 'idle' | 'exited' | 'failed'
export type SettingsSection = 'general' | 'look' | 'agents' | 'hosts' | 'plugins' | 'keys'
export type ChangeStatus = 'M' | 'A' | 'D'

export interface EnvVar {
  k: string
  v: string
  secret: boolean
}

export interface Settings {
  theme: ThemeName
  fontSize: number
  defShell: ShellKind
  defAgent: string
  restore: boolean
  confirmKill: boolean
}

export interface Executor {
  id: string
  name: string
  cmd: string
  args: string
  letter: string
  color: string
  shell: 'pwsh' | 'cmd'
  env: EnvVar[]
}

export interface Host {
  id: string
  name: string
  addr: string
  user: string
  os: string
  on: boolean
  port: number
  platform: OsKind
  auth: 'key' | 'agent' | 'password'
  /** Supplied only while editing; removed before saving workbench.json. */
  password?: string
  hasPassword?: boolean
}

export interface Plugin {
  id: string
  name: string
  desc: string
  url: string
  on: boolean
}

export interface Project {
  id: string
  name: string
  host: string
  path: string
  branch: string
  agent: string
}

export interface SavedTerm {
  id: string
  kind: string
  shell: ShellKind
}

export interface Database {
  settings: Settings
  custom: Executor[]
  hosts: Host[]
  plugins: Plugin[]
  projects: Project[]
  sessions: Record<string, SavedTerm[]>
  activeTab: Record<string, string>
}

export interface Preset {
  id: string
  name: string
  cmd: string
  args: string
  letter: string
  color: string
}

export interface AgentInfo {
  id: string
  name: string
  cmd: string
  args: string
  letter: string
  color: string
  installed: boolean
  shell?: 'pwsh' | 'cmd'
  env?: EnvVar[]
  custom?: boolean
}

export const PRESETS: Preset[] = [
  { id: 'claude', name: 'Claude Code', cmd: 'claude', args: '', letter: 'C', color: '#e0a27c' },
  { id: 'codex', name: 'Codex CLI', cmd: 'codex', args: '', letter: 'X', color: '#a9c3df' },
  { id: 'opencode', name: 'OpenCode', cmd: 'opencode', args: '', letter: 'O', color: '#dcc07f' },
  { id: 'pi', name: 'Pi', cmd: 'pi', args: '', letter: 'π', color: '#c4aedb' }
]

export const SHELL_AGENT: AgentInfo = {
  id: 'shell',
  name: 'Shell',
  cmd: '',
  args: '',
  letter: '>_',
  color: '#8fa3cc',
  installed: true
}

export const EXEC_COLORS = ['#c4aedb', '#a9c3df', '#95cfaa', '#dcc07f', '#e39e9c', '#cdd0d6']

export const DEFAULT_PLUGINS: Plugin[] = [
  { id: 'repo', name: '内部代码仓', desc: '仓库检索、分支与合并请求', url: 'https://git.intranet', on: true },
  { id: 'issues', name: '问题系统', desc: '问题检索与状态回写', url: 'https://issues.intranet', on: true },
  { id: 'build', name: '构建流水线', desc: '触发构建、读取日志', url: 'https://build.intranet', on: false }
]

export interface GitFile {
  path: string
  st: ChangeStatus
  add: number
  del: number
}

export interface GitPanel {
  isRepo: boolean
  branch: string
  files: GitFile[]
}

export interface FileDiff {
  path: string
  st: ChangeStatus
  before: string
  after: string
  binary: boolean
  tooBig: boolean
}

export interface TreeNode {
  name: string
  path: string
  dir: boolean
  children?: TreeNode[]
}

export interface PathCheck {
  kind: 'empty' | 'invalid' | 'missing' | 'git' | 'plain' | 'error'
  branch?: string
  detail?: string
}

export interface DirListing {
  path: string
  parent: string | null
  dirs: { name: string; path: string }[]
  error?: string
}

export interface HostTest {
  ok: boolean
  os?: string
  platform?: OsKind
  error?: string
}

export interface PtyStateEvent {
  type: 'state'
  id: string
  state: ProcState
  exitCode: number | null
  startedAt: number | null
  inputReady: boolean
  announce: boolean
  reason?: 'exit' | 'kill' | 'ctrlc'
}

export interface PtyDataEvent {
  type: 'data'
  id: string
  data: string
}

export type PtyEvent = PtyStateEvent | PtyDataEvent

export interface PtyCreateRequest {
  id: string
  projectId: string
  kind: string
  shell: ShellKind
}

export interface TestExecRequest {
  cmd: string
  args: string
  shell: 'pwsh' | 'cmd' | 'bash'
  env: EnvVar[]
  cwd?: string
}

export interface TestExecResult {
  prompt: string
  command: string
  text: string
  code: number | null
  envLine: string
}

export function uid(prefix: string): string {
  return prefix + Math.random().toString(36).slice(2, 7)
}

export function cmdline(a: { cmd?: string; args?: string }): string {
  return [a.cmd, a.args].filter(Boolean).join(' ')
}

export function resolveAgent(id: string, custom: Executor[], installed: Record<string, boolean>): AgentInfo {
  if (id === 'shell') return SHELL_AGENT
  const preset = PRESETS.find((p) => p.id === id)
  if (preset) return { ...preset, installed: !!installed[preset.cmd] }
  const own = custom.find((c) => c.id === id)
  if (own) return { ...own, installed: true, custom: true }
  return SHELL_AGENT
}

export function shellLabel(shell: ShellKind): string {
  if (shell === 'cmd') return 'CMD'
  if (shell === 'bash') return 'bash'
  if (shell === 'zsh') return 'zsh'
  return 'PowerShell'
}

export function shellChoices(platform: OsKind): { id: ShellKind; label: string }[] {
  if (platform === 'linux') {
    return [
      { id: 'bash', label: 'bash' },
      { id: 'zsh', label: 'zsh' }
    ]
  }
  return [
    { id: 'pwsh', label: 'PowerShell' },
    { id: 'cmd', label: 'CMD' }
  ]
}

export function hostShellName(platform: OsKind): string {
  return platform === 'linux' ? 'bash' : 'PowerShell'
}

export function hostLine(host: Host): string {
  const shell = hostShellName(host.platform)
  if (host.id === 'local') return `${host.os} · ${shell}`
  const who = host.user ? `${host.user}@${host.name}` : host.name
  return `${who} · SSH · ${shell}`
}

export function preferredAgent(preferred: string, list: { id: string; installed?: boolean }[]): string {
  const hit = list.find((item) => item.id === preferred)
  if (hit && hit.installed !== false) return hit.id
  const first = list.find((item) => item.id !== 'shell' && item.installed !== false)
  return first?.id || 'shell'
}

export function shellLetter(shell: ShellKind): string {
  return shell === 'cmd' ? 'C:' : '>_'
}

export function fmtElapsed(ms: number): string {
  const t = Math.max(0, (ms / 1000) | 0)
  const hh = (t / 3600) | 0
  const mm = ((t / 60) | 0) % 60
  const ss = t % 60
  const min = String(mm).padStart(hh ? 2 : 1, '0')
  const sec = String(ss).padStart(2, '0')
  return (hh ? hh + ':' : '') + min + ':' + sec
}

export const STATE_LABEL: Record<ProcState, string> = {
  running: '运行中',
  idle: '空闲',
  exited: '已退出',
  failed: '失败'
}
