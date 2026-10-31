import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { OsKind, ShellKind } from '../shared/types'

export const execFileP = promisify(execFile)

export function hostPlatform(): OsKind {
  return process.platform === 'win32' ? 'windows' : 'linux'
}

export function osLabel(): string {
  if (process.platform === 'win32') {
    const build = Number(os.release().split('.')[2] || 0)
    if (build >= 22000) return 'Windows 11'
    if (build >= 10240) return 'Windows 10'
    return 'Windows'
  }
  if (process.platform === 'darwin') return 'macOS'
  try {
    const text = fs.readFileSync('/etc/os-release', 'utf8')
    const name = /(?:^|\n)NAME="([^"]+)"/.exec(text)?.[1]
    const ver = /VERSION_ID="([^"]+)"/.exec(text)?.[1]
    if (name && ver) return `${name} ${ver}`
    if (name) return name
  } catch {
    /* fall through */
  }
  return 'Linux'
}

export function isAbsPath(value: string, platform: OsKind): boolean {
  if (platform === 'windows') return /^[a-zA-Z]:\\/.test(value)
  return value.startsWith('/')
}

export function pathExample(platform: OsKind): string {
  return platform === 'windows' ? 'C:\\dev\\app' : '/home/user/app'
}

export function pathInvalidMessage(platform: OsKind): string {
  return platform === 'windows'
    ? '请输入 Windows 绝对路径，例如 C:\\dev\\app'
    : '请输入绝对路径，例如 /home/user/app'
}

export function bashQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

export function cmdQuote(value: string): string {
  if (!/[&|<>^%]/.test(value) && !value.includes('"')) return value
  return `"${value.replace(/"/g, '""')}"`
}

export interface ShellLaunch {
  file: string
  args: string[]
  shell: ShellKind
  label: string
}

function commandExistsSync(file: string): boolean {
  const pathEnv = process.env.PATH || ''
  const sep = process.platform === 'win32' ? ';' : ':'
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : ['']
  for (const dir of pathEnv.split(sep)) {
    if (!dir) continue
    for (const ext of exts) {
      const candidate = path.join(dir, file.includes('.') || !ext ? file : file + ext)
      try {
        fs.accessSync(candidate, fs.constants.X_OK)
        return true
      } catch {
        try {
          if (process.platform === 'win32' && fs.existsSync(candidate)) return true
        } catch {
          /* ignore */
        }
      }
    }
  }
  return false
}

export async function commandExists(cmd: string): Promise<boolean> {
  if (!cmd.trim()) return false
  const checker = process.platform === 'win32' ? 'where.exe' : 'which'
  try {
    await execFileP(checker, [cmd], { timeout: 4000, windowsHide: true })
    return true
  } catch {
    return false
  }
}

/** Resolve the real shell binary. On non-Windows the UI's PowerShell/CMD choice degrades to bash. */
export function resolveLocalShell(pref: ShellKind, rcFile: string): ShellLaunch {
  if (process.platform === 'win32') {
    if (pref === 'cmd') {
      return {
        file: process.env.ComSpec || 'cmd.exe',
        args: ['/Q', '/V:ON'],
        shell: 'cmd',
        label: 'CMD'
      }
    }
    const file = commandExistsSync('pwsh.exe') || commandExistsSync('pwsh') ? 'pwsh.exe' : 'powershell.exe'
    return {
      file,
      args: ['-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', rcFile],
      shell: 'pwsh',
      label: 'PowerShell'
    }
  }
  return {
    file: fs.existsSync('/bin/bash') ? '/bin/bash' : 'bash',
    args: ['--noprofile', '--rcfile', rcFile, '-i'],
    shell: 'bash',
    label: 'bash'
  }
}

export function shellForHost(platform: OsKind, pref: ShellKind): ShellKind {
  if (platform === 'linux') return 'bash'
  return pref === 'cmd' ? 'cmd' : 'pwsh'
}

export function bashRc(): string {
  return `unset HISTFILE
PS1='\\w\\$ '
__awb_prompt() {
  local c=$?
  printf '\\033]777;awb;prompt;%s\\007' "$c"
}
PROMPT_COMMAND=__awb_prompt
if [ -n "$AWB_CWD" ] && [ -d "$AWB_CWD" ]; then
  cd "$AWB_CWD" || true
fi
`
}

export function pwshProfile(): string {
  return `$Global:__awb_ready = $true
function prompt {
  $ec = $global:LASTEXITCODE
  if ($null -eq $ec) { $ec = 0 }
  $e = [char]27
  [Console]::Out.Write("$e]777;awb;prompt;$ec$([char]7)")
  "PS $($executionContext.SessionState.Path.CurrentLocation)> "
}
if ($env:AWB_CWD -and (Test-Path -LiteralPath $env:AWB_CWD)) {
  Set-Location -LiteralPath $env:AWB_CWD
}
`
}

export function sshArgs(host: { user: string; addr: string; port: number; auth: 'key' | 'agent' }, extra: string[]): string[] {
  const args = [
    '-tt',
    '-p',
    String(host.port || 22),
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'ConnectTimeout=8',
    '-o',
    'ServerAliveInterval=15'
  ]
  if (host.auth === 'key') {
    const key = path.join(os.homedir(), '.ssh', 'id_ed25519')
    if (fs.existsSync(key)) {
      args.push('-o', 'IdentitiesOnly=yes', '-i', key)
    }
  }
  args.push(`${host.user}@${host.addr}`)
  args.push(...extra)
  return args
}

export function sshBatchArgs(host: { user: string; addr: string; port: number; auth: 'key' | 'agent' }, remote: string[]): string[] {
  return ['-T', '-o', 'BatchMode=yes', ...sshArgs(host, remote).filter((a) => a !== '-tt')]
}

export function remoteBootstrap(platform: OsKind, cwd: string): string[] {
  if (platform === 'linux') {
    const script = `export AWB_CWD=${bashQuote(cwd)}; exec bash --noprofile --rcfile <(cat << 'AWB_RC'
unset HISTFILE
PS1='\\w\\$ '
__awb_prompt() {
  local c=$?
  printf '\\033]777;awb;prompt;%s\\007' "$c"
}
PROMPT_COMMAND=__awb_prompt
if [ -n "$AWB_CWD" ] && [ -d "$AWB_CWD" ]; then
  cd "$AWB_CWD" || true
fi
AWB_RC
) -i`
    return ['bash', '-lc', script]
  }
  const script = `
$Global:__awb_ready = $true
function prompt {
  $ec = $global:LASTEXITCODE
  if ($null -eq $ec) { $ec = 0 }
  $e = [char]27
  [Console]::Out.Write("$e]777;awb;prompt;$ec$([char]7)")
  "PS $($executionContext.SessionState.Path.CurrentLocation)> "
}
if (Test-Path -LiteralPath ${psQuote(cwd)}) { Set-Location -LiteralPath ${psQuote(cwd)} }
`
  return ['powershell.exe', '-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-Command', script]
}

export function joinPath(platform: OsKind, base: string, name: string): string {
  if (platform === 'windows') {
    const sep = base.endsWith('\\') ? '' : '\\'
    return base + sep + name
  }
  return (base.endsWith('/') ? base.slice(0, -1) : base) + '/' + name
}

export function parentPath(platform: OsKind, value: string): string | null {
  if (platform === 'windows') {
    const norm = value.replace(/[\\/]+$/, '')
    const idx = norm.lastIndexOf('\\')
    if (idx <= 2) return norm.slice(0, 3)
    return norm.slice(0, idx)
  }
  if (value === '/') return null
  const norm = value.replace(/\/+$/, '') || '/'
  const idx = norm.lastIndexOf('/')
  if (idx <= 0) return '/'
  return norm.slice(0, idx)
}

export function baseName(value: string): string {
  const parts = value.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || value
}
