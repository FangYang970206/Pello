import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { isUtf8 } from 'node:buffer'
import type { DirListing, FileContent, FileDiff, GitFile, GitPanel, Host, OsKind, PathCheck, TreeNode } from '../shared/types'
import { bashQuote, hostPlatform, isAbsPath, joinPath, parentPath, psQuote, sshBatchArgs } from './platform'
import { remoteCommand, runPasswordCommand } from './ssh'

const exec = promisify(execFile)
const IGNORE = new Set(['.git', 'node_modules', 'dist', 'out', '.next', '__pycache__', '.cache'])
const MAX_DIFF = 250_000

interface Target {
  platform: OsKind
  cwd: string
  host: Host | null
}

function localTarget(cwd: string): Target {
  return { platform: hostPlatform(), cwd, host: null }
}

async function run(target: Target, command: string, input?: string): Promise<string> {
  if (!target.host || target.host.id === 'local') {
    const file = target.platform === 'windows' ? 'powershell.exe' : 'bash'
    const args = target.platform === 'windows' ? ['-NoProfile', '-Command', command] : ['-lc', command]
    const { stdout } = await exec(file, args, {
      timeout: 20000,
      maxBuffer: 12_000_000,
      windowsHide: true,
      cwd: target.platform === 'windows' ? undefined : target.cwd
    })
    return stdout
  }
  const remote =
    target.platform === 'windows'
      ? ['powershell.exe', '-NoProfile', '-Command', command]
      : ['bash', '-lc', command]
  if (target.host.auth === 'password') return runPasswordCommand(target.host, remoteCommand(target.host, remote), input)
  const args = sshBatchArgs(target.host, [remoteCommand(target.host, remote)])
  const operation = exec('ssh', args, { timeout: 20000, maxBuffer: 12_000_000, windowsHide: true })
  if (input !== undefined) operation.child.stdin?.end(input)
  const { stdout } = await operation
  return stdout
}

function gitBin(target: Target, args: string[]): string {
  const quoted = args.map((a) => (target.platform === 'windows' ? psQuote(a) : bashQuote(a))).join(' ')
  const cwd = target.platform === 'windows' ? psQuote(target.cwd) : bashQuote(target.cwd)
  return `git -C ${cwd} ${quoted}`
}

async function git(target: Target, args: string[]): Promise<string> {
  try {
    return await run(target, gitBin(target, args))
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string }
    const stdout = e.stdout || ''
    if (stdout) return stdout
    throw err
  }
}

function parseBranch(status: string): string {
  const line = status.split(/\r?\n/).find((l) => l.startsWith('## '))
  if (!line) return ''
  const body = line.slice(3)
  if (body.startsWith('No commits yet on ')) return body.slice('No commits yet on '.length).split('...')[0]
  if (body.startsWith('HEAD (no branch)')) return 'HEAD'
  return body.split('...')[0].trim()
}

function parseStatus(text: string): { branch: string; files: { path: string; st: GitFile['st']; untracked: boolean }[] } {
  const files: { path: string; st: GitFile['st']; untracked: boolean }[] = []
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('## ')) continue
    if (line.length < 4) continue
    const xy = line.slice(0, 2)
    let file = line.slice(3)
    const arrow = file.indexOf(' -> ')
    if (arrow !== -1) file = file.slice(arrow + 4)
    if (xy === '??') files.push({ path: file, st: 'A', untracked: true })
    else if (xy.includes('D')) files.push({ path: file, st: 'D', untracked: false })
    else if (xy.includes('A')) files.push({ path: file, st: 'A', untracked: false })
    else files.push({ path: file, st: 'M', untracked: false })
  }
  return { branch: parseBranch(text), files }
}

function parseNumstat(text: string): Map<string, [number, number]> {
  const map = new Map<string, [number, number]>()
  for (const line of text.split(/\r?\n/)) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line)
    if (!m) continue
    const add = m[1] === '-' ? 0 : Number(m[1])
    const del = m[2] === '-' ? 0 : Number(m[2])
    map.set(m[3], [add, del])
  }
  return map
}

async function countLines(target: Target, rel: string): Promise<number> {
  try {
    if (!target.host || target.host.id === 'local') {
      const abs = path.resolve(target.cwd, rel)
      if (!inside(target.cwd, abs)) return 0
      const buf = fs.readFileSync(abs)
      if (buf.includes(0)) return 0
      if (buf.length === 0) return 0
      let n = 0
      for (const b of buf) if (b === 10) n++
      if (buf[buf.length - 1] !== 10) n++
      return n
    }
    const abs = joinPath(target.platform, target.cwd, rel)
    const q = target.platform === 'windows' ? psQuote(abs) : bashQuote(abs)
    const cmd = target.platform === 'windows' ? `(Get-Content -LiteralPath ${q} | Measure-Object -Line).Lines` : `wc -l < ${q}`
    const out = await run(target, cmd)
    return Number(String(out).trim()) || 0
  } catch {
    return 0
  }
}

export async function gitStatus(target: Target): Promise<GitPanel & { flags: Record<string, boolean> }> {
  let status: string
  try {
    status = await git(target, ['status', '--porcelain=v1', '-uall', '-b'])
  } catch {
    return { isRepo: false, branch: '', files: [], flags: {} }
  }
  if (!status.trim() && !(await isRepo(target))) return { isRepo: false, branch: '', files: [], flags: {} }
  const parsed = parseStatus(status)
  let nums: Map<string, [number, number]>
  try {
    nums = parseNumstat(await git(target, ['diff', '--numstat', 'HEAD']))
  } catch {
    try {
      nums = parseNumstat(await git(target, ['diff', '--numstat']))
    } catch {
      nums = new Map()
    }
  }
  const flags: Record<string, boolean> = {}
  const files: GitFile[] = []
  for (const f of parsed.files) {
    flags[f.path] = f.untracked
    let add = 0
    let del = 0
    const stat = nums.get(f.path)
    if (stat) [add, del] = stat
    else if (f.untracked) add = await countLines(target, f.path)
    else if (f.st === 'D') del = stat?.[1] || 0
    files.push({ path: f.path, st: f.st, add, del })
  }
  return { isRepo: true, branch: parsed.branch, files, flags }
}

async function isRepo(target: Target): Promise<boolean> {
  try {
    const out = (await git(target, ['rev-parse', '--is-inside-work-tree'])).trim()
    return out === 'true'
  } catch {
    return false
  }
}

function inside(root: string, abs: string): boolean {
  const rel = path.relative(root, abs)
  return rel === '' || (!!rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

const versionOf = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex')
const missingFile = (): FileContent => ({ text: '', binary: false, missing: true, version: null })
function decodeFile(buf: Buffer): FileContent {
  const binary = looksBinary(buf) || !isUtf8(buf)
  return { text: binary ? '' : buf.toString('utf8'), binary, missing: false, version: versionOf(buf), tooBig: buf.length > 2_000_000 }
}

async function readLocal(cwd: string, rel: string): Promise<FileContent> {
  try {
    return decodeFile(fs.readFileSync(localPath(cwd, rel)))
  } catch {
    return missingFile()
  }
}

async function readRemote(target: Target, rel: string): Promise<FileContent> {
  rel = cleanRelative(rel)
  const abs = joinPath(target.platform, target.cwd, rel)
  const q = target.platform === 'windows' ? psQuote(abs) : bashQuote(abs)
  try {
    const b64 =
      target.platform === 'windows'
        ? `[Convert]::ToBase64String([IO.File]::ReadAllBytes(${q}))`
        : `base64 -w 0 ${q} 2>/dev/null || base64 ${q}`
    const out = (await run(target, b64)).trim()
    const buf = Buffer.from(out, 'base64')
    return decodeFile(buf)
  } catch {
    return missingFile()
  }
}

async function showHead(target: Target, rel: string): Promise<string> {
  try {
    return await git(target, ['show', `HEAD:${rel}`])
  } catch {
    return ''
  }
}

export async function gitDiff(target: Target, rel: string, untracked: boolean): Promise<FileDiff> {
  const st: GitFile['st'] = untracked ? 'A' : 'M'
  const head = untracked ? '' : await showHead(target, rel)
  const work = !target.host || target.host.id === 'local' ? await readLocal(target.cwd, rel) : await readRemote(target, rel)
  if (work.binary) return { path: rel, st, before: '', after: '', binary: true, tooBig: false }
  const before = head
  const after = work.missing ? '' : work.text
  const fileSt: GitFile['st'] = work.missing && !untracked ? 'D' : untracked ? 'A' : 'M'
  if (before.length + after.length > MAX_DIFF) {
    return { path: rel, st: fileSt, before: '', after: '', binary: false, tooBig: true }
  }
  return { path: rel, st: fileSt, before, after, binary: false, tooBig: false }
}

export async function gitDiscard(target: Target, rel: string, untracked: boolean): Promise<void> {
  if (rel.includes('\0')) throw new Error('非法路径')
  if (untracked) {
    await git(target, ['clean', '-f', '--', rel])
    return
  }
  try {
    await git(target, ['restore', '--source=HEAD', '--worktree', '--staged', '--', rel])
  } catch {
    await git(target, ['checkout', 'HEAD', '--', rel])
  }
}

function sortNodes(nodes: TreeNode[]): TreeNode[] {
  nodes.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
  for (const n of nodes) if (n.children) sortNodes(n.children)
  return nodes
}

function cleanRelative(rel: string): string {
  if (rel.includes('\0') || /^[a-z]:|^[\\/]/i.test(rel) || rel.split(/[\\/]/).includes('..')) throw new Error('非法文件路径')
  return rel.replace(/\\/g, '/').split('/').filter((part) => part && part !== '.').join('/')
}

function localPath(cwd: string, rel: string): string {
  const root = fs.realpathSync(cwd)
  const abs = fs.realpathSync(path.resolve(root, cleanRelative(rel)))
  if (!inside(root, abs)) throw new Error('路径超出项目目录')
  return abs
}

/** List one level on demand. Directory depth no longer truncates the tree. */
export async function fileTree(target: Target, rel = ''): Promise<TreeNode[]> {
  rel = cleanRelative(rel)
  let entries: { name: string; dir: boolean }[]
  if (!target.host || target.host.id === 'local') {
    entries = fs.readdirSync(localPath(target.cwd, rel), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isFile())
      .map((entry) => ({ name: entry.name, dir: entry.isDirectory() }))
  } else {
    const abs = rel ? joinPath(target.platform, target.cwd, rel) : target.cwd
    const q = target.platform === 'windows' ? psQuote(abs) : bashQuote(abs)
    if (target.platform === 'windows') {
      const text = await run(target, `@(Get-ChildItem -LiteralPath ${q} -Force -ErrorAction Stop | Where-Object { -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) } | ForEach-Object { @{ name=$_.Name; dir=$_.PSIsContainer } }) | ConvertTo-Json -Compress`)
      const parsed = JSON.parse(text.trim() || '[]')
      entries = Array.isArray(parsed) ? parsed : [parsed]
    } else {
      const text = await run(target, `for f in ${q}/* ${q}/.[!.]* ${q}/..?*; do [ -L "$f" ] && continue; [ -e "$f" ] || continue; if [ -d "$f" ]; then printf 'd%s\\0' "\${f##*/}"; elif [ -f "$f" ]; then printf 'f%s\\0' "\${f##*/}"; fi; done`)
      entries = text.split('\0').filter(Boolean).map((entry) => ({ name: entry.slice(1), dir: entry[0] === 'd' }))
    }
  }
  return sortNodes(entries.filter((entry) => !IGNORE.has(entry.name)).map((entry) => ({
    name: entry.name, dir: entry.dir, path: rel ? `${rel}/${entry.name}` : entry.name
  })))
}

export async function readFile(target: Target, rel: string): Promise<FileContent> {
  if (!target.host || target.host.id === 'local') return readLocal(target.cwd, rel)
  return readRemote(target, rel)
}

/** Read preview assets through the same project boundary as the editor. */
export async function readAsset(target: Target, rel: string): Promise<Buffer> {
  rel = cleanRelative(rel)
  if (!rel) throw new Error('文件路径不能为空')
  if (!target.host || target.host.id === 'local') {
    const abs = localPath(target.cwd, rel)
    if (fs.statSync(abs).size > 12_000_000) throw new Error('预览资源超过 12 MB')
    return fs.readFileSync(abs)
  }
  const abs = joinPath(target.platform, target.cwd, rel)
  const q = target.platform === 'windows' ? psQuote(abs) : bashQuote(abs)
  const command = target.platform === 'windows'
    ? `$root=(Resolve-Path -LiteralPath ${psQuote(target.cwd)} -ErrorAction Stop).Path.TrimEnd('\\')+'\\'; $file=[IO.Path]::GetFullPath(${q}); if (-not $file.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)) { throw '非法路径' }; $walk=$root; foreach ($part in $file.Substring($root.Length).Split('\\')) { $walk=Join-Path $walk $part; if ((Get-Item -LiteralPath $walk -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '符号链接不可预览' } }; [Convert]::ToBase64String([IO.File]::ReadAllBytes($file))`
    : `root=$(cd -P -- ${bashQuote(target.cwd)} && pwd); file=${q}; [ ! -L "$file" ] || exit 1; parent=$(cd -P -- "$(dirname -- "$file")" && pwd) || exit 1; root=\${root%/}; case "$parent/" in "$root/"*) base64 "$file" ;; *) exit 1;; esac`
  return Buffer.from((await run(target, command)).trim(), 'base64')
}

export async function writeFile(target: Target, rel: string, text: string, version: string): Promise<FileContent> {
  rel = cleanRelative(rel)
  if (!rel || !/^[a-f0-9]{64}$/.test(version)) throw new Error('请先读取文件再保存')
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length > 2_000_000) throw new Error('文件超过 2 MB，无法在内置编辑器中保存')
  const conflict = () => new Error('文件已被其他程序修改，请重新读取后合并更改')
  if (!target.host || target.host.id === 'local') {
    const abs = localPath(target.cwd, rel)
    const current = fs.readFileSync(abs)
    if (versionOf(current) !== version) throw conflict()
    if (looksBinary(current) || !isUtf8(current)) throw new Error('只能编辑 UTF-8 文本文件')
    const temp = `${abs}.awb-${randomUUID()}.tmp`
    try {
      fs.writeFileSync(temp, bytes, { flag: 'wx', mode: fs.statSync(abs).mode })
      if (versionOf(fs.readFileSync(abs)) !== version) throw conflict()
      fs.renameSync(temp, abs)
    } finally {
      if (fs.existsSync(temp)) fs.unlinkSync(temp)
    }
    return readLocal(target.cwd, rel)
  }
  const before = await readRemote(target, rel)
  if (before.missing) throw new Error('文件不存在')
  if (before.version !== version) throw conflict()
  if (before.binary) throw new Error('只能编辑 UTF-8 文本文件')
  const abs = joinPath(target.platform, target.cwd, rel)
  let command: string
  if (target.platform === 'windows') {
    command = `$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath(${psQuote(target.cwd)}).TrimEnd('\\')+'\\'
$file=[IO.Path]::GetFullPath(${psQuote(abs)})
if (-not $file.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)) { throw 'AWB_UNSAFE_PATH' }
$walk=$root
foreach ($part in $file.Substring($root.Length).Split('\\')) {
  $walk=Join-Path $walk $part
  if ((Get-Item -LiteralPath $walk -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'AWB_UNSAFE_PATH' }
}
function FileHash { ([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([IO.File]::ReadAllBytes($file)))).Replace('-','').ToLowerInvariant() }
if ((FileHash) -ne '${version}') { throw 'AWB_CONFLICT' }
$payload=[Convert]::FromBase64String([Console]::In.ReadToEnd())
$temp=$file+'.awb-'+[Guid]::NewGuid().ToString('N')+'.tmp'
try {
  [IO.File]::WriteAllBytes($temp,$payload)
  if ((FileHash) -ne '${version}') { throw 'AWB_CONFLICT' }
  [IO.File]::Replace($temp,$file,[NullString]::Value)
} finally { if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force } }
'saved'`
  } else {
    command = `set -e
root=$(cd -P -- ${bashQuote(target.cwd)} && pwd)
file=${bashQuote(abs)}
[ ! -L "$file" ] || { echo AWB_UNSAFE_PATH >&2; exit 1; }
parent=$(cd -P -- "$(dirname -- "$file")" && pwd)
root=\${root%/}
case "$parent/" in "$root/"*) ;; *) echo AWB_UNSAFE_PATH >&2; exit 1;; esac
file="$parent/$(basename -- "$file")"
file_hash() { (sha256sum < "$file" 2>/dev/null || shasum -a 256 < "$file") | cut -d ' ' -f 1; }
[ "$(file_hash)" = '${version}' ] || { echo AWB_CONFLICT >&2; exit 1; }
temp=$(mktemp "$parent/.awb-XXXXXX")
trap 'rm -f -- "$temp"' EXIT
cp -p -- "$file" "$temp"
base64 -d > "$temp"
[ "$(file_hash)" = '${version}' ] || { echo AWB_CONFLICT >&2; exit 1; }
mv -f -- "$temp" "$file"
printf saved`
  }
  try { await run(target, command, bytes.toString('base64')) } catch (error) {
    const detail = String((error as { stderr?: string }).stderr || error)
    if (detail.includes('AWB_CONFLICT')) throw conflict()
    if (detail.includes('AWB_UNSAFE_PATH')) throw new Error('无法保存项目目录外的文件或符号链接', { cause: error })
    throw error
  }
  return readRemote(target, rel)
}

export async function checkPath(target: Target, input: string): Promise<PathCheck> {
  const value = input.trim()
  if (!value) return { kind: 'empty' }
  if (!isAbsPath(value, target.platform)) return { kind: 'invalid' }
  target = { ...target, cwd: value }
  let exists: boolean
  try {
    if (!target.host || target.host.id === 'local') {
      exists = fs.existsSync(value) && fs.statSync(value).isDirectory()
    } else {
      const q = target.platform === 'windows' ? psQuote(value) : bashQuote(value)
      const cmd = target.platform === 'windows' ? `if (Test-Path -LiteralPath ${q} -PathType Container) { 'yes' }` : `if [ -d ${q} ]; then echo yes; fi`
      exists = (await run(target, cmd)).trim() === 'yes'
    }
  } catch (err) {
    return { kind: 'error', detail: err instanceof Error ? err.message : String(err) }
  }
  if (!exists) return { kind: 'missing' }
  const repo = await isRepo(target)
  if (!repo) return { kind: 'plain' }
  let branch: string
  try {
    branch = (await git(target, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  } catch {
    branch = ''
  }
  return { kind: 'git', branch }
}

export async function listDir(target: Target, input: string): Promise<DirListing> {
  let current = input.trim()
  if (!current) {
    if (!target.host || target.host.id === 'local') current = os.homedir()
    else {
      try {
        const cmd = target.platform === 'windows' ? '[Environment]::GetFolderPath("UserProfile")' : 'printf %s "$HOME"'
        current = (await run({ ...target, cwd: '/' }, cmd)).trim() || '/'
      } catch {
        current = target.platform === 'windows' ? 'C:\\' : '/'
      }
    }
  }
  const dirs: { name: string; path: string }[] = []
  try {
    if (!target.host || target.host.id === 'local') {
      for (const ent of fs.readdirSync(current, { withFileTypes: true })) {
        if (!ent.isDirectory() || IGNORE.has(ent.name)) continue
        dirs.push({ name: ent.name, path: path.join(current, ent.name) })
      }
    } else {
      const q = target.platform === 'windows' ? psQuote(current) : bashQuote(current)
      const cmd =
        target.platform === 'windows'
          ? `Get-ChildItem -LiteralPath ${q} -Directory | ForEach-Object { $_.Name }`
          : `find ${q} -mindepth 1 -maxdepth 1 -type d -printf '%f\\n'`
      const text = await run(target, cmd)
      for (const name of text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
        if (IGNORE.has(name)) continue
        dirs.push({ name, path: joinPath(target.platform, current, name) })
      }
    }
  } catch (err) {
    return { path: current, parent: parentPath(target.platform, current), dirs: [], error: err instanceof Error ? err.message : String(err) }
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name))
  return { path: current, parent: parentPath(target.platform, current), dirs }
}

export function targetFor(cwd: string, host: Host | null): Target {
  if (!host || host.id === 'local') return localTarget(cwd)
  return { platform: host.platform, cwd, host }
}

export type { Target }
