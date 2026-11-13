import { t } from '../shared/i18n'
import { mediaKind } from '../shared/media'
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
import { LINUX_CREATE_SCRIPT, LINUX_RENAME_SCRIPT } from './linux-rename'

const exec = promisify(execFile)
export const TREE_DEFAULT_IGNORE = ['.git', 'node_modules', 'dist', 'out', '.next', '__pycache__', '.cache']
const IGNORE = new Set(TREE_DEFAULT_IGNORE)
const MAX_DIFF = 250_000

interface Target {
  platform: OsKind
  cwd: string
  host: Host | null
}

function localTarget(cwd: string): Target {
  return { platform: hostPlatform(), cwd, host: null }
}

async function run(target: Target, command: string, input?: string, maxBuffer = 12_000_000): Promise<string> {
  if (!target.host || target.host.id === 'local') {
    const file = target.platform === 'windows' ? 'powershell.exe' : 'bash'
    const args = target.platform === 'windows' ? ['-NoProfile', '-Command', command] : ['-lc', command]
    const { stdout } = await exec(file, args, {
      timeout: 20000,
      maxBuffer,
      windowsHide: true,
      cwd: target.platform === 'windows' ? undefined : target.cwd
    })
    return stdout
  }
  const remote =
    target.platform === 'windows'
      ? ['powershell.exe', '-NoProfile', '-Command', command]
      : ['bash', '-lc', command]
  if (target.host.auth === 'password') return runPasswordCommand(target.host, remoteCommand(target.host, remote), input, maxBuffer)
  const args = sshBatchArgs(target.host, [remoteCommand(target.host, remote)])
  const operation = exec('ssh', args, { timeout: 20000, maxBuffer, windowsHide: true })
  if (input !== undefined) operation.child.stdin?.end(input)
  const { stdout } = await operation
  return stdout
}

function gitBin(target: Target, args: string[]): string {
  const quoted = args.map((a) => (target.platform === 'windows' ? psQuote(a) : bashQuote(a))).join(' ')
  const cwd = target.platform === 'windows' ? psQuote(target.cwd) : bashQuote(target.cwd)
  return `${target.platform === 'windows' ? '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); ' : ''}git -C ${cwd} -c core.quotepath=false ${quoted}`
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
  const line = status.split(/\r?\n|\0/).find((l) => l.startsWith('## '))
  if (!line) return ''
  const body = line.slice(3)
  if (body.startsWith('No commits yet on ')) return body.slice('No commits yet on '.length).split('...')[0]
  if (body.startsWith('HEAD (no branch)')) return 'HEAD'
  return body.split('...')[0].trim()
}

function parseStatus(text: string): { branch: string; files: { path: string; st: GitFile['st']; untracked: boolean }[] } {
  const files: { path: string; st: GitFile['st']; untracked: boolean }[] = []
  const nul = text.includes('\0'), entries = nul ? text.split('\0') : text.split(/\r?\n/)
  for (let index = 0; index < entries.length; index++) {
    const line = entries[index]
    if (!line || line.startsWith('## ')) continue
    if (line.length < 4) continue
    const xy = line.slice(0, 2)
    let file = line.slice(3)
    if (nul && /[RC]/.test(xy)) index++ // In -z format the new name comes first, followed by the old name.
    if (!nul) { const arrow = file.indexOf(' -> '); if (arrow !== -1) file = file.slice(arrow + 4) }
    if (xy === '??') files.push({ path: file, st: 'A', untracked: true })
    else if (xy.includes('D')) files.push({ path: file, st: 'D', untracked: false })
    else if (xy.includes('A')) files.push({ path: file, st: 'A', untracked: false })
    else files.push({ path: file, st: 'M', untracked: false })
  }
  return { branch: parseBranch(text), files }
}

function parseNumstat(text: string): Map<string, [number, number]> {
  const map = new Map<string, [number, number]>()
  const nul = text.includes('\0'), entries = nul ? text.split('\0') : text.split(/\r?\n/)
  for (let index = 0; index < entries.length; index++) {
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(entries[index])
    if (!m) continue
    const add = m[1] === '-' ? 0 : Number(m[1])
    const del = m[2] === '-' ? 0 : Number(m[2])
    let name = m[3]
    if (nul && !name) { index++; name = entries[++index] }
    if (name) map.set(name, [add, del])
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

async function singleGitStatus(target: Target): Promise<GitPanel & { flags: Record<string, boolean> }> {
  let status: string
  try {
    status = await git(target, ['status', '--porcelain=v1', '-z', '-uall', '-b', '--', '.'])
  } catch {
    return { isRepo: false, branch: '', files: [], flags: {} }
  }
  if (!status.trim() && !(await isRepo(target))) return { isRepo: false, branch: '', files: [], flags: {} }
  const parsed = parseStatus(status)
  const prefix = (await git(target, ['rev-parse', '--show-prefix'])).trim()
  if (prefix) parsed.files = parsed.files.filter((file) => file.path.startsWith(prefix)).map((file) => ({ ...file, path: file.path.slice(prefix.length) }))
  let nums: Map<string, [number, number]>
  try {
    nums = parseNumstat(await git(target, ['diff', '--relative', '--numstat', '-z', 'HEAD', '--', '.']))
  } catch {
    try {
      nums = parseNumstat(await git(target, ['diff', '--relative', '--numstat', '-z', '--', '.']))
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

type Discovery = { roots: string[]; errors: string[] }
const discoveries = new Map<string, { at: number; value: Promise<Discovery> }>()
const statusRequests = new Map<string, Promise<GitPanel & { flags: Record<string, boolean> }>>()
const targetKey = (target: Target) => `${target.host?.id || 'local'}:${target.platform}:${target.cwd}`

async function discoverRepositories(target: Target): Promise<Discovery> {
  const key = targetKey(target), cached = discoveries.get(key)
  if (cached && Date.now() - cached.at < 30000) return cached.value
  const value = (async (): Promise<Discovery> => {
    const roots: string[] = [], errors: string[] = []
    if (!target.host || target.host.id === 'local') {
      const queue = [fs.realpathSync(target.cwd)]
      for (let index = 0; index < queue.length; index++) {
        const folder = queue[index]
        try {
          const entries = await fs.promises.readdir(folder, { withFileTypes: true })
          if (entries.some((entry) => entry.name === '.git')) { roots.push(folder); continue }
          for (const entry of entries) if (entry.isDirectory() && !entry.isSymbolicLink() && !IGNORE.has(entry.name)) queue.push(path.join(folder, entry.name))
        } catch (error) { errors.push(t("{{0}}：{{1}}", path.relative(target.cwd, folder) || '.', (error as NodeJS.ErrnoException).code || t("无法读取"))) }
      }
    } else if (target.platform === 'linux') {
      const excluded = [...IGNORE].filter((name) => name !== '.git').map((name) => `-name ${bashQuote(name)}`).join(' -o ')
      const command = `find ${bashQuote(target.cwd)} -type d \\( ${excluded} \\) -prune -o -name .git -print0 -prune`
      try { roots.push(...(await run(target, command)).split('\0').filter(Boolean).map((name) => path.posix.dirname(name))) }
      catch (error) {
        const failure = error as { stdout?: string }
        if (failure.stdout) roots.push(...failure.stdout.split('\0').filter(Boolean).map((name) => path.posix.dirname(name)))
        errors.push(t("部分远程目录无法读取，请检查目录权限或连接后重试"))
      }
    } else {
      const command = `$q=[Collections.Generic.Queue[string]]::new();$q.Enqueue(${psQuote(target.cwd)});$r=@();$e=@();while($q.Count){$p=$q.Dequeue();try{$d=@(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop);if($d.Name -contains '.git'){$r+=$p;continue};foreach($x in $d){if($x.PSIsContainer -and -not ($x.Attributes -band [IO.FileAttributes]::ReparsePoint) -and $x.Name -notin @(${[...IGNORE].map(psQuote).join(',')})){$q.Enqueue($x.FullName)}}}catch{$e+=$p}};@{roots=@($r);errors=@($e)}|ConvertTo-Json -Compress`
      const result = JSON.parse(await run(target, command)) as Discovery
      roots.push(...result.roots); errors.push(...result.errors.map((folder) => t("{{0}}：无法读取目录", folder)))
    }
    const api = target.platform === 'windows' ? path.win32 : path.posix
    const unique = [...new Set(roots)].sort()
    return { roots: unique.filter((root) => !unique.some((parent) => parent !== root && !api.relative(parent, root).startsWith('..') && !api.isAbsolute(api.relative(parent, root)))), errors }
  })()
  discoveries.set(key, { at: Date.now(), value })
  try { return await value } catch (error) { discoveries.delete(key); throw error }
}

/** A workspace may be a repository or a directory containing independent repositories. */
export async function gitStatus(target: Target, rescan = false): Promise<GitPanel & { flags: Record<string, boolean> }> {
  const key = targetKey(target)
  if (rescan) { await statusRequests.get(key)?.catch(() => undefined); discoveries.delete(key) }
  const pending = statusRequests.get(key)
  if (pending) return pending
  const request = (async () => {
    const root = await singleGitStatus(target)
    if (root.isRepo) return root
    const { roots, errors } = await discoverRepositories(target)
    const panel: GitPanel & { flags: Record<string, boolean> } = { ...root, repositories: [], errors: [...errors], files: [], flags: {} }
    const api = target.platform === 'windows' ? path.win32 : path.posix
    // Bound native Git processes while allowing large workspaces to remain responsive.
    let next = 0
    await Promise.all(Array.from({ length: Math.min(4, roots.length) }, async () => {
      while (next < roots.length) {
        const cwd = roots[next++], prefix = api.relative(target.cwd, cwd).replace(/\\/g, '/')
        let repo: Awaited<ReturnType<typeof singleGitStatus>>
        try { repo = await singleGitStatus({ ...target, cwd }) }
        catch { panel.errors!.push(t("{{0}}：无法读取 Git 状态", prefix)); continue }
        if (!repo.isRepo) { panel.errors!.push(t("{{0}}：无法读取 Git 状态", prefix)); continue }
        panel.repositories!.push({ path: prefix, branch: repo.branch, count: repo.files.length })
        for (const file of repo.files) {
          const rel = `${prefix}/${file.path}`
          panel.files.push({ ...file, path: rel, repository: prefix }); panel.flags[rel] = !!repo.flags[file.path]
        }
      }
    }))
    panel.repositories!.sort((a, b) => a.path.localeCompare(b.path))
    panel.files.sort((a, b) => a.path.localeCompare(b.path))
    return panel
  })()
  statusRequests.set(key, request)
  try { return await request } finally { statusRequests.delete(key) }
}

async function owningRepository(target: Target, rel: string): Promise<{ target: Target; relative: string }> {
  rel = cleanRelative(rel)
  const api = target.platform === 'windows' ? path.win32 : path.posix
  const absolute = api.resolve(target.cwd, rel)
  let parent = api.dirname(absolute)
  while (true) {
    if (!target.host || target.host.id === 'local') {
      if (fs.existsSync(parent) && !inside(fs.realpathSync(target.cwd), fs.realpathSync(parent))) throw new Error(t("路径超出项目目录"))
    }
    try {
      const root = (await git({ ...target, cwd: parent }, ['rev-parse', '--show-toplevel'])).trim()
      const relative = api.relative(root, absolute).replace(/\\/g, '/')
      if (!relative || relative === '..' || relative.startsWith('../') || api.isAbsolute(relative)) throw new Error(t("路径超出 Git 仓库"))
      return { target: { ...target, cwd: root }, relative }
    } catch (error) {
      if (parent === target.cwd || api.relative(target.cwd, parent).startsWith('..')) throw error
      parent = api.dirname(parent)
    }
  }
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
  rel = cleanRelative(rel)
  const owner = await owningRepository(target, rel)
  const st: GitFile['st'] = untracked ? 'A' : 'M'
  const head = untracked ? '' : await showHead(owner.target, owner.relative)
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
  const owner = await owningRepository(target, rel)
  target = owner.target; rel = owner.relative
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
  if (rel.includes('\0') || /^[a-z]:|^[\\/]/i.test(rel) || rel.split(/[\\/]/).includes('..')) throw new Error(t("非法文件路径"))
  return rel.replace(/\\/g, '/').split('/').filter((part) => part && part !== '.').join('/')
}

function localPath(cwd: string, rel: string): string {
  const root = fs.realpathSync(cwd)
  const abs = fs.realpathSync(path.resolve(root, cleanRelative(rel)))
  if (!inside(root, abs)) throw new Error(t("路径超出项目目录"))
  return abs
}

export function validateEntryName(name: string, platform: OsKind): void {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[\0/\\]/.test(name)) throw new Error(t("名称无效"))
  if (platform === 'windows' && (/[<>:"|?*]/.test(name) || [...name].some((char) => char.charCodeAt(0) < 32) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))) throw new Error(t("Windows 名称无效"))
}

/** Resolve a tree path in the main process before exposing it to native actions. */
export function treePath(target: Target, rel: string): { full: string; relative: string } {
  const relative = cleanRelative(rel)
  if (target.platform === 'windows' && relative.split('/').some((part) => part.includes(':'))) throw new Error(t("非法文件路径"))
  if (!target.host || target.host.id === 'local') return { full: localPath(target.cwd, relative), relative: relative || '.' }
  const paths = target.platform === 'windows' ? path.win32 : path.posix
  const root = paths.resolve(target.cwd)
  const full = paths.resolve(root, relative)
  const within = paths.relative(root, full)
  if (within === '..' || within.startsWith(`..${paths.sep}`) || paths.isAbsolute(within)) throw new Error(t("路径超出项目目录"))
  return { full, relative: relative || '.' }
}

/** Create a single child without replacing an existing file or directory. */
export async function createTreeEntry(target: Target, parent: string, name: string, directory: boolean): Promise<string> {
  parent = cleanRelative(parent)
  validateEntryName(name, target.platform)
  const rel = parent ? `${parent}/${name}` : name
  if (!target.host || target.host.id === 'local') {
    const base = localPath(target.cwd, parent)
    if (!fs.statSync(base).isDirectory()) throw new Error(t("目标不是目录"))
    const destination = path.join(base, name)
    if (directory) fs.mkdirSync(destination)
    else fs.closeSync(fs.openSync(destination, 'wx'))
    return rel
  }
  const abs = joinPath(target.platform, target.cwd, rel)
  const parentAbs = parent ? joinPath(target.platform, target.cwd, parent) : target.cwd
  if (target.platform === 'windows') {
    const command = `$root=(Resolve-Path -LiteralPath ${psQuote(target.cwd)} -ErrorAction Stop).Path.TrimEnd('\\'); $parent=[IO.Path]::GetFullPath(${psQuote(parentAbs)}).TrimEnd('\\'); if ($parent -ne $root -and -not $parent.StartsWith($root+'\\',[StringComparison]::OrdinalIgnoreCase)) { throw ${psQuote(t("非法路径"))} }; $walk=$root; if ($parent -ne $root) { foreach ($part in $parent.Substring($root.Length+1).Split('\\')) { $walk=Join-Path $walk $part; if ((Get-Item -LiteralPath $walk -Force -ErrorAction Stop).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw ${psQuote(t("不支持链接目录"))} } } }; $dest=${psQuote(abs)}; ${directory ? 'New-Item -ItemType Directory -Path $dest -ErrorAction Stop | Out-Null' : '$f=[IO.File]::Open($dest,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None); $f.Dispose()'}`
    await run(target, command)
  } else {
    const command = `python3 -c ${bashQuote(LINUX_CREATE_SCRIPT)} ${bashQuote(target.cwd)} ${bashQuote(parent)} ${bashQuote(name)} ${directory ? '1' : '0'}`
    await run(target, command)
  }
  return rel
}

/** Rename without replacing an existing destination. */
export async function renameTreeEntry(target: Target, rel: string, name: string, directory: boolean): Promise<string> {
  const clean = cleanRelative(rel)
  return relocateTreeEntry(target, clean, clean.split('/').slice(0, -1).join('/'), name, directory)
}

export async function moveTreeEntry(target: Target, rel: string, destinationParent: string, directory: boolean): Promise<string> {
  const clean = cleanRelative(rel)
  return relocateTreeEntry(target, clean, destinationParent, clean.split('/').pop() || '', directory)
}

async function relocateTreeEntry(target: Target, rel: string, destinationParent: string, name: string, directory: boolean): Promise<string> {
  rel = cleanRelative(rel)
  if (!rel) throw new Error(t("不能重命名项目根目录"))
  destinationParent = cleanRelative(destinationParent)
  validateEntryName(name, target.platform)
  const parts = rel.split('/')
  const oldName = parts.pop()!
  const nextRel = [destinationParent, name].filter(Boolean).join('/')
  const comparable = (value: string) => target.platform === 'windows' ? value.toLowerCase() : value
  if (directory && (comparable(destinationParent) === comparable(rel) || comparable(destinationParent).startsWith(`${comparable(rel)}/`))) throw new Error(t("不能移入自身或子目录"))
  if (rel === nextRel) return rel
  if (target.platform === 'linux') {
    await run(target, `python3 -c ${bashQuote(LINUX_RENAME_SCRIPT())} ${bashQuote(target.cwd)} ${bashQuote(rel)} ${bashQuote(name)} ${directory ? '1' : '0'} ${bashQuote(destinationParent)}`)
    return nextRel
  }
  const walk = [...parts, oldName].map((part) => `$walk=Join-Path $walk ${psQuote(part)}; $item=Get-Item -LiteralPath $walk -Force -ErrorAction Stop; if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw ${psQuote(t("不支持通过符号链接重命名"))} }`).join('; ')
  const targetWalk = destinationParent ? destinationParent.split('/').map((part) => `$parent=Join-Path $parent ${psQuote(part)}; $parentItem=Get-Item -LiteralPath $parent -Force -ErrorAction Stop; if (($parentItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $parentItem.PSIsContainer) { throw ${psQuote(t("目标不是安全目录"))} }`).join('; ') : ''
  const move = directory ? '[IO.Directory]::Move' : '[IO.File]::Move'
  const temporary = `.awb-rename-${randomUUID()}`
  const command = `$ErrorActionPreference='Stop'; $root=(Resolve-Path -LiteralPath ${psQuote(target.cwd)} -ErrorAction Stop).Path; $walk=$root; ${walk}; if ($item.PSIsContainer -ne $${directory ? 'true' : 'false'}) { throw ${psQuote(t("文件类型已更改"))} }; $parent=$root; ${targetWalk ? `${targetWalk}; ` : ''}$dest=Join-Path $parent ${psQuote(name)}; if ([String]::Equals($walk,$dest,[StringComparison]::OrdinalIgnoreCase)) { $temp=Join-Path $parent ${psQuote(temporary)}; ${move}($walk,$temp); try { ${move}($temp,$dest) } catch { try { ${move}($temp,$walk) } catch { throw (${psQuote(t("重命名失败，原对象保留于 "))}+$temp) }; throw } } else { ${move}($walk,$dest) }`
  await run(target, command)
  return nextRel
}

/** Permanently remove a remote descendant after checking every path component. */
export async function removeRemoteEntry(target: Target, rel: string, directory: boolean): Promise<void> {
  if (!target.host || target.host.id === 'local') throw new Error(t("此操作仅适用于远程项目"))
  rel = cleanRelative(rel)
  if (!rel) throw new Error(t("不能删除项目根目录"))
  const parts = rel.split('/')
  if (target.platform === 'windows') {
    if (parts.some((part) => part.includes(':'))) throw new Error(t("非法文件路径"))
    const walk = parts.map((part) => `$walk=Join-Path $walk ${psQuote(part)}; $item=Get-Item -LiteralPath $walk -Force -ErrorAction Stop; if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw ${psQuote(t("不支持删除符号链接"))} }`).join('; ')
    const command = `$ErrorActionPreference='Stop'; $walk=(Resolve-Path -LiteralPath ${psQuote(target.cwd)} -ErrorAction Stop).Path; ${walk}; if ($item.PSIsContainer -ne $${directory ? 'true' : 'false'}) { throw ${psQuote(t("文件类型已更改"))} }; ${directory ? `Get-ChildItem -LiteralPath $walk -Force -Recurse | ForEach-Object { if ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw ${psQuote(t("目录包含符号链接"))} } }; Remove-Item -LiteralPath $walk -Recurse -Force -ErrorAction Stop` : 'Remove-Item -LiteralPath $walk -Force -ErrorAction Stop'}`
    await run(target, command)
  } else {
    const walk = parts.map((part) => `p="$p"/${bashQuote(part)}; [ ! -L "$p" ] || { echo ${bashQuote(t("不支持删除符号链接"))} >&2; exit 1; }`).join('; ')
    const command = `p=$(cd -P -- ${bashQuote(target.cwd)} && pwd) || exit 1; ${walk}; ${directory ? '[ -d "$p" ]' : '[ -f "$p" ]'} || { echo ${bashQuote(t("文件类型已更改"))} >&2; exit 1; }; ${directory ? 'rm -rf -- "$p"' : 'rm -f -- "$p"'}`
    await run(target, command)
  }
}

/** List one level on demand. Directory depth no longer truncates the tree. */
export async function fileTree(target: Target, rel = '', ignored: ReadonlySet<string> = IGNORE): Promise<TreeNode[]> {
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
      const text = await run(target, `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); @(Get-ChildItem -LiteralPath ${q} -Force -ErrorAction Stop | Where-Object { -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) } | ForEach-Object { @{ name=$_.Name; dir=$_.PSIsContainer } }) | ConvertTo-Json -Compress`)
      const parsed = JSON.parse(text.trim() || '[]')
      entries = Array.isArray(parsed) ? parsed : [parsed]
    } else {
      const text = await run(target, `for f in ${q}/* ${q}/.[!.]* ${q}/..?*; do [ -L "$f" ] && continue; [ -e "$f" ] || continue; if [ -d "$f" ]; then printf 'd%s\\0' "\${f##*/}"; elif [ -f "$f" ]; then printf 'f%s\\0' "\${f##*/}"; fi; done`)
      entries = text.split('\0').filter(Boolean).map((entry) => ({ name: entry.slice(1), dir: entry[0] === 'd' }))
    }
  }
  return sortNodes(entries.filter((entry) => !entry.dir || !ignored.has(entry.name)).map((entry) => ({
    name: entry.name, dir: entry.dir, path: rel ? `${rel}/${entry.name}` : entry.name
  })))
}

export async function readFile(target: Target, rel: string): Promise<FileContent> {
  if (mediaKind(rel)) {
    try {
      const bytes = await readAsset(target, rel)
      return { text: '', binary: true, missing: false, version: versionOf(bytes) }
    } catch { return missingFile() }
  }
  if (!target.host || target.host.id === 'local') return readLocal(target.cwd, rel)
  return readRemote(target, rel)
}

/** Read preview assets through the same project boundary as the editor. */
export async function readAsset(target: Target, rel: string): Promise<Buffer> {
  rel = cleanRelative(rel)
  if (!rel) throw new Error(t("文件路径不能为空"))
  if (!target.host || target.host.id === 'local') {
    const abs = localPath(target.cwd, rel)
    if (fs.statSync(abs).size > 12_000_000) throw new Error(t("预览资源超过 12 MB"))
    return fs.readFileSync(abs)
  }
  const abs = joinPath(target.platform, target.cwd, rel)
  const q = target.platform === 'windows' ? psQuote(abs) : bashQuote(abs)
  const command = target.platform === 'windows'
    ? `$ErrorActionPreference='Stop'; $root=(Resolve-Path -LiteralPath ${psQuote(target.cwd)} -ErrorAction Stop).Path.TrimEnd('\\')+'\\'; $file=[IO.Path]::GetFullPath(${q}); if (-not $file.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)) { throw ${psQuote(t("非法路径"))} }; $walk=$root; foreach ($part in $file.Substring($root.Length).Split('\\')) { $walk=Join-Path $walk $part; if ((Get-Item -LiteralPath $walk -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw ${psQuote(t("符号链接不可预览"))} } }; if ((Get-Item -LiteralPath $file).Length -gt 12000000) { throw ${psQuote(t("预览资源超过 12 MB"))} }; [Convert]::ToBase64String([IO.File]::ReadAllBytes($file))`
    : `root=$(cd -P -- ${bashQuote(target.cwd)} && pwd); file=${q}; [ ! -L "$file" ] || exit 1; parent=$(cd -P -- "$(dirname -- "$file")" && pwd) || exit 1; root=\${root%/}; case "$parent/" in "$root/"*) if [ "$(wc -c < "$file")" -gt 12000000 ]; then printf '%s' ${bashQuote(t("预览资源超过 12 MB"))} >&2; exit 1; fi; base64 "$file" ;; *) exit 1;; esac`
  const bytes = Buffer.from((await run(target, command, undefined, 17_000_000)).trim(), 'base64')
  if (bytes.length > 12_000_000) throw new Error(t("预览资源超过 12 MB"))
  return bytes
}

async function createMissingFile(target: Target, rel: string, bytes: Buffer): Promise<FileContent> {
  const parts = rel.split('/'), name = parts.pop()!, parent = parts.join('/')
  validateEntryName(name, target.platform)
  if (!target.host || target.host.id === 'local') {
    const base = localPath(target.cwd, parent), destination = path.join(base, name)
    const temporary = path.join(base, `.awb-${randomUUID()}.tmp`)
    try {
      fs.writeFileSync(temporary, bytes, { flag: 'wx' })
      // Publish only if the missing destination is still absent. rename() can
      // replace another writer's newly created file on POSIX, link() cannot.
      fs.linkSync(temporary, destination)
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary) }
    return readLocal(target.cwd, rel)
  }
  if (target.platform === 'windows') {
    const command = `$ErrorActionPreference='Stop'
$root=(Resolve-Path -LiteralPath ${psQuote(target.cwd)} -ErrorAction Stop).Path
$parent=$root
${parts.map((part) => `$parent=Join-Path $parent ${psQuote(part)}; $item=Get-Item -LiteralPath $parent -Force -ErrorAction Stop; if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw ${psQuote(t("不支持链接目录"))} }`).join('\n')}
$dest=Join-Path $parent ${psQuote(name)}
$temp=Join-Path $parent ('.awb-'+[Guid]::NewGuid().ToString('N')+'.tmp')
try { [IO.File]::WriteAllBytes($temp,[Convert]::FromBase64String([Console]::In.ReadToEnd())); [IO.File]::Move($temp,$dest) }
finally { if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force } }`
    await run(target, command, bytes.toString('base64'))
  } else {
    const program = `import os,sys,uuid,base64
root,parent,name=sys.argv[1:]
fd=os.open(os.path.realpath(root),os.O_RDONLY|os.O_DIRECTORY)
temp='.awb-'+uuid.uuid4().hex+'.tmp'
try:
 for part in filter(None,parent.split('/')):
  child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
  os.close(fd); fd=child
 out=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600,dir_fd=fd)
 with os.fdopen(out,'wb') as stream: stream.write(base64.b64decode(sys.stdin.buffer.read()))
 os.link(temp,name,src_dir_fd=fd,dst_dir_fd=fd,follow_symlinks=False)
finally:
 try: os.unlink(temp,dir_fd=fd)
 except FileNotFoundError: pass
 os.close(fd)
`
    await run(target, `python3 -c ${bashQuote(program)} ${bashQuote(target.cwd)} ${bashQuote(parent)} ${bashQuote(name)}`, bytes.toString('base64'))
  }
  return readRemote(target, rel)
}

export async function writeFile(target: Target, rel: string, text: string, version: string | null): Promise<FileContent> {
  rel = cleanRelative(rel)
  if (!rel || (version !== null && !/^[a-f0-9]{64}$/.test(version))) throw new Error(t("请先读取文件再保存"))
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length > 2_000_000) throw new Error(t("文件超过 2 MB，无法在内置编辑器中保存"))
  if (version === null) return createMissingFile(target, rel, bytes)
  const conflict = () => new Error(t("文件已被其他程序修改，请重新读取后合并更改"))
  if (!target.host || target.host.id === 'local') {
    const abs = localPath(target.cwd, rel)
    const current = fs.readFileSync(abs)
    if (versionOf(current) !== version) throw conflict()
    if (looksBinary(current) || !isUtf8(current)) throw new Error(t("只能编辑 UTF-8 文本文件"))
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
  if (before.missing) throw new Error(t("文件不存在"))
  if (before.version !== version) throw conflict()
  if (before.binary) throw new Error(t("只能编辑 UTF-8 文本文件"))
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
    if (detail.includes('AWB_UNSAFE_PATH')) throw new Error(t("无法保存项目目录外的文件或符号链接"), { cause: error })
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
          ? `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $dir=Get-Item -LiteralPath ${q} -Force; if (-not $dir.PSIsContainer) { throw ${psQuote(t("目录不存在"))} }; @{ path=$dir.FullName; dirs=@(Get-ChildItem -LiteralPath $dir.FullName -Directory -Force -ErrorAction Stop | ForEach-Object { $_.Name }) } | ConvertTo-Json -Compress`
          : `cd -P -- ${q} || exit 1; printf '%s\\0' "$PWD"; for dir in ./* ./.[!.]* ./..?*; do [ -d "$dir" ] || continue; printf '%s\\0' "\${dir#./}"; done`
      const text = await run(target, cmd)
      let names: string[]
      if (target.platform === 'windows') { const parsed = JSON.parse(text) as { path: string; dirs: string[] }; current = parsed.path; names = parsed.dirs }
      else { const parts = text.split('\0'); current = parts.shift() || current; names = parts.filter(Boolean) }
      for (const name of names) {
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
