import type { Host } from '../shared/types'
import { openRemoteStream } from './ssh'

// Paths and document contents travel through stdin, never through shell interpolation.
export const TEMPORARY_LINUX_SCRIPT = `import json, os, sys, shutil
p = json.load(sys.stdin)
os.makedirs(p['root'], exist_ok=True)
base = os.path.realpath(p['root'])
if not os.path.isdir(base): raise ValueError(p['folderError'])
directory = base
if p.get('id'):
 directory = os.path.join(base, p['id'])
 os.mkdir(directory)
 try:
  with open(os.path.join(directory, 'AGENTS.md'), 'x', encoding='utf-8') as f: f.write(p['instructions'].replace('{{DIRECTORY}}', directory))
  with open(os.path.join(directory, 'CLAUDE.md'), 'x', encoding='utf-8') as f: f.write('@AGENTS.md\\n')
 except BaseException:
  shutil.rmtree(directory)
  raise
print(json.dumps(directory, ensure_ascii=False))
`

export const TEMPORARY_WINDOWS_SCRIPT = `$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$p=[Console]::In.ReadToEnd() | ConvertFrom-Json
$base=[IO.Directory]::CreateDirectory($p.root).FullName
if (-not [IO.Directory]::Exists($base)) { throw $p.folderError }
$directory=$base
if ($p.id) {
 $directory=[IO.Path]::Combine($base,$p.id)
 # New-Item without Force refuses an existing UUID directory.
 $null=New-Item -ItemType Directory -Path $directory
 try {
  $utf8=[Text.UTF8Encoding]::new($false)
  [IO.File]::WriteAllText([IO.Path]::Combine($directory,'AGENTS.md'),$p.instructions.Replace('{{DIRECTORY}}',$directory),$utf8)
  [IO.File]::WriteAllText([IO.Path]::Combine($directory,'CLAUDE.md'),"@AGENTS.md\n",$utf8)
 } catch {
  [IO.Directory]::Delete($directory,$true)
  throw
 }
}
ConvertTo-Json -InputObject $directory -Compress
`

export async function prepareRemoteTemporaryDirectory(host: Host, root: string, folderError: string, id?: string, instructions?: string): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20000)
  try {
    const args = host.platform === 'windows' ? ['powershell.exe', '-NoProfile', '-Command', TEMPORARY_WINDOWS_SCRIPT] : ['python3', '-c', TEMPORARY_LINUX_SCRIPT]
    const stream = await openRemoteStream(host, args, controller.signal)
    let output = ''
    stream.stdout.setEncoding('utf8')
    stream.stdout.on('data', (chunk: string) => { output += chunk; if (output.length > 65536) controller.abort() })
    stream.stdin.on('error', () => controller.abort())
    stream.stdin.end(JSON.stringify({ root, id, instructions, folderError }))
    await stream.completion
    const directory: unknown = JSON.parse(output.trim())
    if (typeof directory !== 'string' || !directory || directory.includes('\0')) throw new Error(folderError)
    return directory
  } finally { clearTimeout(timer) }
}
