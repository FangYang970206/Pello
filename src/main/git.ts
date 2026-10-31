import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { DirListing, FileDiff, GitFile, GitPanel, Host, OsKind, PathCheck, TreeNode } from '../shared/types'
import { bashQuote, hostPlatform, isAbsPath, joinPath, parentPath, psQuote, sshBatchArgs } from './platform'

const exec = promisify(execFile)
const IGNORE = new Set(['.git', 'node_modules', 'dist', 'out', '.next', '__pycache__', '.cache'])
const MAX_DIFF = 250_000
const MAX_TREE = 2000

interface Target {
  platform: OsKind
  cwd: string
  host: Host | null
}

function localTarget(cwd: string): Target {
  return { platform: hostPlatform(), cwd, host: null }
}

async function run(target: Target, command: string): Promise<string> {
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
  const args = sshBatchArgs(
    { user: target.host.user, addr: target.host.addr, port: target.host.port, auth: target.host.auth },
    remote
  )
  const { stdout } = await exec('ssh', args, { timeout: 20000, maxBuffer: 12_000_000, windowsHide: true })
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
  let status = ''
  try {
    status = await git(target, ['status', '--porcelain=v1', '-uall', '-b'])
  } catch {
    return { isRepo: false, branch: '', files: [], flags: {} }
  }
  if (!status.trim() && !(await isRepo(target))) return { isRepo: false, branch: '', files: [], flags: {} }
  const parsed = parseStatus(status)
  let nums = new Map<string, [number, number]>()
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
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel))
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

async function readLocal(cwd: string, rel: string): Promise<{ text: string; binary: boolean; missing: boolean }> {
  const abs = path.resolve(cwd, rel)
  if (!inside(cwd, abs)) return { text: '', binary: false, missing: true }
  try {
    const buf = fs.readFileSync(abs)
    if (looksBinary(buf)) return { text: '', binary: true, missing: false }
    return { text: buf.toString('utf8'), binary: false, missing: false }
  } catch {
    return { text: '', binary: false, missing: true }
  }
}

async function readRemote(target: Target, rel: string): Promise<{ text: string; binary: boolean; missing: boolean }> {
  const abs = joinPath(target.platform, target.cwd, rel)
  const q = target.platform === 'windows' ? psQuote(abs) : bashQuote(abs)
  try {
    const b64 =
      target.platform === 'windows'
        ? `[Convert]::ToBase64String([IO.File]::ReadAllBytes(${q}))`
        : `base64 -w 0 ${q} 2>/dev/null || base64 ${q}`
    const out = (await run(target, b64)).trim()
    if (!out) return { text: '', binary: false, missing: false }
    const buf = Buffer.from(out, 'base64')
    if (looksBinary(buf)) return { text: '', binary: true, missing: false }
    return { text: buf.toString('utf8'), binary: false, missing: false }
  } catch {
    return { text: '', binary: false, missing: true }
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

function walkLocal(dir: string, root: string, depth: number, budget: { n: number }): TreeNode[] {
  if (depth > 5 || budget.n > MAX_TREE) return []
  let entries: fs.Dirent[] = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const nodes: TreeNode[] = []
  for (const ent of entries) {
    if (IGNORE.has(ent.name)) continue
    if (budget.n++ > MAX_TREE) break
    const abs = path.join(dir, ent.name)
    const rel = path.relative(root, abs).split(path.sep).join('/')
    if (ent.isDirectory()) {
      nodes.push({ name: ent.name, path: rel, dir: true, children: walkLocal(abs, root, depth + 1, budget) })
    } else if (ent.isFile()) {
      nodes.push({ name: ent.name, path: rel, dir: false })
    }
  }
  return sortNodes(nodes)
}

export async function fileTree(target: Target): Promise<TreeNode[]> {
  if (!target.host || target.host.id === 'local') return walkLocal(target.cwd, target.cwd, 0, { n: 0 })
  const cmd =
    target.platform === 'windows'
      ? `Get-ChildItem -LiteralPath ${psQuote(target.cwd)} -Recurse -Depth 4 -Name | Select-Object -First ${MAX_TREE}`
      : `cd ${bashQuote(target.cwd)} && find . -mindepth 1 -maxdepth 5 \\( -name .git -o -name node_modules -o -name dist -o -name out -o -name .next -o -name __pycache__ \\) -prune -o -print | head -n ${MAX_TREE}`
  let text = ''
  try {
    text = await run(target, cmd)
  } catch {
    return []
  }
  const root: TreeNode[] = []
  const dirs = new Map<string, TreeNode>()
  const ensureDir = (rel: string, name: string, parent: TreeNode[] | undefined): TreeNode => {
    let node = dirs.get(rel)
    if (!node) {
      node = { name, path: rel, dir: true, children: [] }
      dirs.set(rel, node)
      ;(parent || root).push(node)
    }
    return node
  }
  for (const raw of text.split(/\r?\n/)) {
    let rel = raw.trim().replace(/^\.\//, '').replace(/\\/g, '/')
    if (!rel || rel === '.') continue
    const parts = rel.split('/').filter(Boolean)
    if (parts.some((p) => IGNORE.has(p))) continue
    let parentList: TreeNode[] | undefined
    let acc = ''
    for (let i = 0; i < parts.length; i++) {
      acc = acc ? acc + '/' + parts[i] : parts[i]
      const last = i === parts.length - 1
      const knownDir = dirs.get(acc)
      if (!last) {
        const node = knownDir || ensureDir(acc, parts[i], parentList)
        parentList = node.children
      } else if (!knownDir) {
        ;(parentList || root).push({ name: parts[i], path: acc, dir: false })
      }
    }
  }
  return sortNodes(root)
}

export async function readFile(target: Target, rel: string): Promise<{ text: string; binary: boolean; missing: boolean }> {
  if (!target.host || target.host.id === 'local') return readLocal(target.cwd, rel)
  return readRemote(target, rel)
}

export async function checkPath(target: Target, input: string): Promise<PathCheck> {
  const value = input.trim()
  if (!value) return { kind: 'empty' }
  if (!isAbsPath(value, target.platform)) return { kind: 'invalid' }
  target = { ...target, cwd: value }
  let exists = false
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
  let branch = ''
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
