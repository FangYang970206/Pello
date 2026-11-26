import type { EnvVar, OsKind } from '../shared/types'

export const REMOTE_ENV_READY = '\x1b]777;awb;environment\x07'
export const REMOTE_ENV_APPLIED = '\x1b]777;awb;environment-applied\x07'

export function packExecutorEnv(rows: EnvVar[]): string {
  const safe = rows.filter(({ k, v }) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && !v.includes('\0'))
  const text = safe.map(({ k, v }) => `${k}=${v}\0`).join('')
  return Buffer.from(text).toString('base64')
}

export function encodeRemoteEnv(rows: EnvVar[]): string {
  return [...(packExecutorEnv(rows).match(/.{1,512}/g) || []), '.', ''].join('\n')
}

function applyEnvironment(platform: OsKind, scoped = false) {
  if (platform === 'windows') return `
foreach ($entry in [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($pelloEnv)).Split([char]0)) {
  $pos = $entry.IndexOf('=')
  if ($pos -gt 0) {
    $key = $entry.Substring(0,$pos)
    ${scoped ? 'if (!$before.ContainsKey($key)) { $before[$key] = [Environment]::GetEnvironmentVariable($key) }' : ''}
    [Environment]::SetEnvironmentVariable($key,$entry.Substring($pos+1),'Process')
  }
}
Remove-Variable pelloEnv,line,entry,pos,key -ErrorAction SilentlyContinue
`
  return `
while IFS= read -r -d '' __pello_entry; do
  export "$__pello_entry"
done < <(printf %s "$__pello_env" | base64 -d)
unset __pello_env __pello_line __pello_entry
`
}

export function applyStartupEnvironment(platform: OsKind) {
  if (platform === 'windows') return `
if ($env:PELLO_STARTUP_ENV) {
  $pelloEnv = $env:PELLO_STARTUP_ENV
  Remove-Item Env:PELLO_STARTUP_ENV
  ${applyEnvironment(platform)}
}
`
  return `
if [ -n "\${PELLO_STARTUP_ENV-}" ]; then
  __pello_env="$PELLO_STARTUP_ENV"
  unset PELLO_STARTUP_ENV
  ${applyEnvironment(platform)}
fi
`
}

/** Read configuration through the transport, before the interactive prompt or JSON-RPC starts. */
export function receiveRemoteEnv(platform: OsKind, terminal = false, scoped = false): string {
  if (platform === 'windows') {
    return `
${terminal ? '[Console]::Write(([char]27).ToString()+"]777;awb;environment"+([char]7))' : ''}
$pelloEnv = ''
while ($true) {
  ${terminal ? `$secure = Read-Host -AsSecureString
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { $line = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }` : '$line = [Console]::ReadLine()'}
  if ($null -eq $line) { exit 1 }
  if ($line -eq '.') { break }
  $pelloEnv += $line
}
${applyEnvironment(platform, scoped)}
[Console]::Write(([char]27).ToString()+"]777;awb;environment-applied"+([char]7))
`
  }
  return `
${terminal ? "stty -echo; printf '\\033]777;awb;environment\\007'" : ''}
__pello_env=''
while IFS= read -r __pello_line; do
  [ "$__pello_line" = . ] && break
  __pello_env+="$__pello_line"
done
${applyEnvironment(platform)}
${terminal ? 'stty echo' : ''}
printf '\\033]777;awb;environment-applied\\007'
`
}

export function withExecutorEnvironment(platform: OsKind) {
  if (platform === 'linux') return `
__pello_with_env() (
  ${receiveRemoteEnv(platform, true)}
  eval -- "$1"
)
`
  return `
function __pello_with_env([scriptblock]$command) {
  $before = @{}
  try {
    ${receiveRemoteEnv(platform, true, true)}
    & $command
  } finally {
    foreach ($key in $before.Keys) { [Environment]::SetEnvironmentVariable($key,$before[$key],'Process') }
  }
}
`
}

export function redactExecutorOutput(text: string, env: EnvVar[]): string {
  const secrets = [...new Set(env.filter((row) => row.secret && row.v).map((row) => row.v))].sort((a, b) => b.length - a.length)
  for (const value of secrets) text = text.replaceAll(value, '••••')
  return text
}

// Journal records may split an environment value across PTY chunks.
export class ExecutorLogRedactor {
  private values: EnvVar[] = []
  private pattern?: RegExp
  private pending = ''

  track(env: EnvVar[]) {
    const values = new Map([...this.values, ...env.filter((row) => row.secret && row.v)].map((row) => [row.v, row]))
    this.values = [...values.values()].sort((a, b) => b.v.length - a.v.length)
    this.pattern = this.values.length ? new RegExp(this.values.map(({ v }) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g') : undefined
  }

  get hasValues() { return !!this.pattern }
  complete(text: string) { return this.pattern ? text.replace(this.pattern, '••••') : text }

  push(chunk: string): string {
    if (!this.pattern) return chunk
    const text = this.pending + chunk
    let boundary = text.length
    for (const { v } of this.values) {
      const earliest = Math.max(0, text.length - v.length + 1)
      for (let at = text.indexOf(v[0], earliest); at >= 0 && at < boundary; at = text.indexOf(v[0], at + 1)) {
        if (v.startsWith(text.slice(at))) { boundary = at; break }
      }
    }
    let result = '', next = 0
    for (const match of text.matchAll(this.pattern)) {
      if (match.index >= boundary) break
      result += text.slice(next, match.index) + '••••'
      next = match.index + match[0].length
    }
    const end = Math.max(next, boundary)
    this.pending = text.slice(end)
    return result + text.slice(next, end)
  }

  flush() {
    const text = this.complete(this.pending)
    this.pending = ''
    return text
  }
}
