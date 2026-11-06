import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createInterface } from 'node:readline'
import { psQuote } from './platform'
import { openRemoteStream } from './ssh'
import { LINUX_FILE_VERSION, WINDOWS_FILE_VERSION, remoteFileVersion } from './remote-version'
import { createTreeEntry, fileTree, treePath, validateEntryName, type Target } from './git'

const READ_LINUX = `import os, stat, sys
root, relative = sys.argv[1:]
parts = relative.split('/')
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC
parent = os.open(root, flags)
try:
    for part in parts[:-1]:
        new = os.open(part, flags | os.O_NOFOLLOW, dir_fd=parent)
        os.close(parent)
        parent = new
    file = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
    try:
        if not stat.S_ISREG(os.fstat(file).st_mode): raise ValueError('不是普通文件')
        while True:
            data = os.read(file, 262144)
            if not data: break
            sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()
    finally:
        os.close(file)
finally:
    os.close(parent)
`

const WRITE_LINUX = `import hashlib, os, signal, stat, sys
${LINUX_FILE_VERSION}
root, relative, name, expected_text, temporary, expected_version = sys.argv[1:]
expected = int(expected_text)
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC
parent = os.open(root, flags)
def interrupted(signum, frame): raise InterruptedError('传输中断')
signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGHUP, interrupted)
created = False
try:
    for part in relative.split('/') if relative else []:
        new = os.open(part, flags | os.O_NOFOLLOW, dir_fd=parent)
        os.close(parent)
        parent = new
    output = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o600, dir_fd=parent)
    created = True
    try:
        remaining = expected
        while remaining:
            data = os.read(0, min(262144, remaining))
            if not data: raise EOFError('传输不完整')
            view = memoryview(data)
            while view:
                written = os.write(output, view)
                view = view[written:]
            remaining -= len(data)
        if os.read(0, 1) != bytes([1]): raise EOFError('传输未确认')
        if expected_version: os.fchmod(output, int(expected_version.split(':')[5]) & 0o777)
        os.fsync(output)
    finally:
        os.close(output)
    if expected_version:
        current = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK, dir_fd=parent)
        try:
            if file_version(current) != expected_version: raise ValueError('目标文件已更改，请重新检查冲突')
            os.replace(temporary, name, src_dir_fd=parent, dst_dir_fd=parent)
        finally: os.close(current)
    else:
        os.link(temporary, name, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
finally:
    if created:
        try: os.unlink(temporary, dir_fd=parent)
        except FileNotFoundError: pass
    os.close(parent)
`

/** Send one local file via stdin and publish remotely only after explicit stream completion. */
export async function uploadRemoteFile(target: Target, parent: string, name: string, source: string, signal: AbortSignal, progress: (bytes: number, total: number) => void, expectedVersion = ''): Promise<void> {
  if (!target.host || target.host.id === 'local') throw new Error('请选择远程项目')
  validateEntryName(name, target.platform)
  const relative = treePath(target, parent).relative
  const cleanParent = relative === '.' ? '' : relative
  const info = await fsp.lstat(source)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('仅支持上传普通文件')
  const handle = await fsp.open(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  let remote: Awaited<ReturnType<typeof openRemoteStream>> | undefined
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size) throw new Error('来源文件已更改')
    const temporary = `.awb-upload-${randomUUID()}.tmp`
    let args: string[]
    if (target.platform === 'windows') {
      const walk = cleanParent ? cleanParent.split('/').map((part) => `$parent=Join-Path $parent ${psQuote(part)}; $item=Get-Item -LiteralPath $parent -Force -ErrorAction Stop; if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $item.PSIsContainer) { throw '目标不是安全目录' }`).join('; ') : ''
      const publish = expectedVersion ? `${WINDOWS_FILE_VERSION}; if((Get-AwbFileVersion $dest) -ne ${psQuote(expectedVersion)}) { throw '目标文件已更改，请重新检查冲突' }; [IO.File]::Replace($tmp,$dest,[NullString]::Value)` : '[IO.File]::Move($tmp,$dest)'
      const script = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $parent=(Resolve-Path -LiteralPath ${psQuote(target.cwd)} -ErrorAction Stop).Path; ${walk ? `${walk}; ` : ''}$tmp=Join-Path $parent ${psQuote(temporary)}; $dest=Join-Path $parent ${psQuote(name)}; $created=$false; try { $out=[IO.File]::Open($tmp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None); $created=$true; try { $inputStream=[Console]::OpenStandardInput(); $remaining=[long]${opened.size}; $buffer=New-Object byte[] 262144; while($remaining -gt 0) { $read=$inputStream.Read($buffer,0,[int][Math]::Min($buffer.Length,$remaining)); if($read -le 0) { throw '传输不完整' }; $out.Write($buffer,0,$read); $remaining-=$read }; if($inputStream.ReadByte() -ne 1) { throw '传输未确认' }; $out.Flush($true) } finally { $out.Dispose() }; ${publish}; $created=$false } finally { if($created) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue } }`
      args = ['powershell.exe', '-NoProfile', '-OutputFormat', 'Text', '-Command', script]
    } else args = ['python3', '-c', WRITE_LINUX, target.cwd, cleanParent, name, String(opened.size), temporary, expectedVersion]
    remote = await openRemoteStream(target.host, args, signal)
    remote.stdout.resume()
    let bytes = 0
    const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) { bytes += chunk.length; progress(bytes, opened.size); callback(null, chunk) } })
    const input = opened.size ? fs.createReadStream(source, { fd: handle.fd, autoClose: false, start: 0, end: opened.size - 1 }) : Readable.from([])
    const send = async () => {
      await pipeline(input, meter, remote!.stdin, { signal, end: false })
      const current = await handle.stat()
      if (signal.aborted || bytes !== opened.size || current.size !== opened.size || current.mtimeMs !== opened.mtimeMs) throw new Error('来源文件已更改或传输已取消')
      remote!.stdin.end(Buffer.from([1]))
    }
    await Promise.all([send(), remote.completion])
  } catch (error) { remote?.close(); throw error }
  finally { await handle.close() }
}

export type UploadChoice = 'skip' | 'keep' | 'merge' | 'cancel' | 'overwrite'
export type UploadConflict = { source: string; relative: string; mergeable: boolean; replaceable: boolean }

/** Plan all destinations and resolve conflicts before creating any remote object. */
export async function uploadRemoteSources(target: Target, parent: string, sources: string[], signal: AbortSignal, progress: (source: string, bytes: number, total: number) => void, result: (source: string, destination: string, error?: string, skipped?: boolean) => void, decide?: (conflict: UploadConflict) => Promise<UploadChoice>, replace?: (relative: string, operation: () => Promise<void>) => Promise<void>): Promise<void> {
  type Plan = { source: string; parent: string; name: string; relative: string; directory: boolean; merge?: boolean; expectedVersion?: string; skipped?: boolean; error?: string; children: Plan[] }
  const clean = treePath(target, parent).relative
  const destination = clean === '.' ? '' : clean
  const listings = new Map<string, Map<string, { dir: boolean; reserved?: boolean }>>()
  const key = (name: string) => target.platform === 'windows' ? name.toLowerCase() : name
  const check = () => { if (signal.aborted) throw new Error('传输已取消') }
  const plan = async (source: string, remoteParent: string, virtual: boolean): Promise<Plan> => {
    check()
    const original = path.basename(source)
    const item: Plan = { source, parent: remoteParent, name: original, relative: remoteParent ? `${remoteParent}/${original}` : original, directory: false, children: [] }
    try {
      validateEntryName(original, target.platform)
      const info = await fsp.lstat(source)
      if (info.isSymbolicLink()) throw new Error('不上传符号链接')
      if (!info.isDirectory() && !info.isFile()) throw new Error('不支持此文件类型')
      item.directory = info.isDirectory()
      let listing = listings.get(remoteParent)
      if (!listing) {
        listing = new Map(virtual ? [] : (await fileTree(target, remoteParent, new Set())).map((node) => [key(node.name), { dir: node.dir }]))
        listings.set(remoteParent, listing)
      }
      const existing = listing.get(key(original))
      if (existing) {
        const mergeable = item.directory && existing.dir && !existing.reserved
        let version: string | undefined
        if (replace && !item.directory && !existing.dir && !existing.reserved) {
          try { version = await remoteFileVersion(target, item.relative, signal) }
          catch { check() /* An unverifiable target may still be skipped or kept under a new name. */ }
        }
        const replaceable = !!version
        const choice = decide ? await decide({ source, relative: item.relative, mergeable, replaceable }) : 'skip'
        check()
        if (choice === 'cancel') throw new Error('传输已取消')
        if (choice === 'skip') { item.skipped = true; return item }
        if (choice === 'overwrite') {
          if (!replaceable || !version) throw new Error('此对象不能覆盖')
          item.expectedVersion = version
        } else if (choice === 'merge') {
          if (!mergeable) throw new Error('此对象不能合并')
          item.merge = true
        } else if (choice === 'keep') {
          const extension = item.directory ? '' : path.extname(original)
          const base = path.basename(original, extension)
          let index = 1
          while (listing.has(key(`${base} (${index})${extension}`))) { if (++index > 10000) throw new Error('无法找到可用名称') }
          item.name = `${base} (${index})${extension}`
          item.relative = remoteParent ? `${remoteParent}/${item.name}` : item.name
        } else throw new Error('冲突处理方式无效')
      }
      if (!item.merge) listing.set(key(item.name), { dir: item.directory, reserved: true })
      if (item.directory) for (const child of await fsp.readdir(source)) item.children.push(await plan(path.join(source, child), item.relative, !item.merge))
    } catch (error) {
      check()
      item.error = error instanceof Error ? error.message : '无法检查来源'
    }
    return item
  }
  const plans: Plan[] = []
  for (const source of sources) plans.push(await plan(source, destination, false))
  check()
  const upload = async (item: Plan): Promise<boolean> => {
    check()
    if (item.skipped) { result(item.source, item.relative, '已跳过同名对象', true); return true }
    try {
      if (item.error) throw new Error(item.error)
      // New names are exclusive; replacements recheck the captured version before publication.
      if (item.directory) {
        if (!item.merge) await createTreeEntry(target, item.parent, item.name, true)
        let allDone = true
        for (const child of item.children) if (!await upload(child)) allDone = false
        if (!allDone) { result(item.source, item.relative, '部分内容未能上传'); return false }
      } else {
        const send = () => uploadRemoteFile(target, item.parent, item.name, item.source, signal, (bytes, total) => progress(item.source, bytes, total), item.expectedVersion)
        if (item.expectedVersion) { if (!replace) throw new Error('覆盖保护不可用'); await replace(item.relative, send) }
        else await send()
      }
      result(item.source, item.relative)
      return true
    } catch (error) {
      check()
      result(item.source, item.relative, error instanceof Error ? error.message : '上传失败')
      return false
    }
  }
  for (const item of plans) await upload(item)
}

const LIST_LINUX = `import json, os, stat, sys
root, relative = sys.argv[1:]
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC
fd = os.open(root, flags)
try:
    for part in relative.split('/'):
        nxt = os.open(part, flags | os.O_NOFOLLOW, dir_fd=fd)
        os.close(fd)
        fd = nxt
    sys.stdout.reconfigure(encoding='utf-8')
    def walk(parent, prefix):
        with os.scandir(parent) as entries:
            for entry in entries:
                info = entry.stat(follow_symlinks=False)
                if stat.S_ISLNK(info.st_mode): raise ValueError('目录包含符号链接: ' + entry.name)
                if not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)): raise ValueError('目录包含不支持的对象: ' + entry.name)
                relative = prefix + '/' + entry.name if prefix else entry.name
                directory = stat.S_ISDIR(info.st_mode)
                print(json.dumps({'path': relative, 'dir': directory}, ensure_ascii=False), flush=True)
                if directory:
                    child = os.open(entry.name, flags | os.O_NOFOLLOW, dir_fd=parent)
                    try: walk(child, relative)
                    finally: os.close(child)
    walk(fd, '')
finally:
    os.close(fd)
`

type RemoteEntry = { path: string; dir: boolean }

async function remoteDirectoryEntries(target: Target, rel: string, signal: AbortSignal): Promise<RemoteEntry[]> {
  if (!target.host || target.host.id === 'local') throw new Error('请选择远程目录')
  const relative = treePath(target, rel).relative
  if (relative === '.') throw new Error('请选择项目中的子目录')
  let args: string[]
  if (target.platform === 'windows') {
    const walk = relative.split('/').map((part) => `$walk=Join-Path $walk ${psQuote(part)}; $item=Get-Item -LiteralPath $walk -Force -ErrorAction Stop; if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $item.PSIsContainer) { throw '路径不是安全目录' }`).join('; ')
    const script = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $walk=(Resolve-Path -LiteralPath ${psQuote(target.cwd)} -ErrorAction Stop).Path; ${walk}; $stack=[Collections.Generic.Stack[object]]::new(); $stack.Push(@{full=$walk; rel='' }); while($stack.Count -gt 0) { $node=$stack.Pop(); foreach($item in @(Get-ChildItem -LiteralPath $node.full -Force -ErrorAction Stop)) { if($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '目录包含符号链接' }; $name=if($node.rel) { $node.rel+'/'+$item.Name } else { $item.Name }; @{path=$name; dir=[bool]$item.PSIsContainer} | ConvertTo-Json -Compress; if($item.PSIsContainer) { $stack.Push(@{full=$item.FullName; rel=$name}) } } }`
    args = ['powershell.exe', '-NoProfile', '-Command', script]
  } else args = ['python3', '-c', LIST_LINUX, target.cwd, relative]
  const remote = await openRemoteStream(target.host, args, signal)
  remote.stdin.end()
  const entries: RemoteEntry[] = []
  const consume = async () => {
    const lines = createInterface({ input: remote.stdout, crlfDelay: Infinity })
    for await (const line of lines) {
      if (signal.aborted) throw new Error('传输已取消')
      const item: unknown = JSON.parse(line)
      if (!item || typeof item !== 'object' || !('path' in item) || !('dir' in item) || typeof item.path !== 'string' || typeof item.dir !== 'boolean') throw new Error('远程目录列表无效')
      const parts = item.path.split('/')
      if (parts.some((part) => !part || part === '.' || part === '..' || part.includes('\\') || part.includes('\0') || (process.platform === 'win32' && (/[<>:"|?*]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) || [...part].some((character) => character.charCodeAt(0) < 32))))) throw new Error(`文件名无法在本机保存：${item.path}`)
      entries.push({ path: item.path, dir: item.dir })
    }
  }
  try { await Promise.all([consume(), remote.completion]); return entries }
  catch (error) { remote.close(); throw error }
}

/** Enumerate before creating a destination, then download descendants without replacing existing paths. */
export async function downloadRemoteDirectory(target: Target, rel: string, localParent: string, signal: AbortSignal, progress: (path: string, bytes: number) => void, result: (source: string, destination: string, error?: string, directory?: boolean) => void): Promise<void> {
  const relative = treePath(target, rel).relative
  if (relative === '.') throw new Error('请选择项目中的子目录')
  const name = relative.split('/').pop()!
  if (name.includes('\\') || (process.platform === 'win32' && (/[<>:"|?*]/.test(name) || /[. ]$/.test(name)))) throw new Error('文件夹名称无法在本机保存')
  const entries = await remoteDirectoryEntries(target, relative, signal)
  if (signal.aborted) throw new Error('传输已取消')
  const parent = await fsp.realpath(localParent)
  const destination = path.join(parent, name)
  await fsp.mkdir(destination)
  const root = await fsp.realpath(destination)
  if ((process.platform === 'win32' ? root.toLowerCase() : root) !== (process.platform === 'win32' ? destination.toLowerCase() : destination)) throw new Error('目标目录已更改或包含链接')
  for (const entry of entries) {
    if (signal.aborted) throw new Error('传输已取消')
    const local = path.join(root, ...entry.path.split('/'))
    const source = `${relative}/${entry.path}`
    try {
      const actualParent = await fsp.realpath(path.dirname(local))
      const expectedParent = path.dirname(local)
      if ((process.platform === 'win32' ? actualParent.toLowerCase() : actualParent) !== (process.platform === 'win32' ? expectedParent.toLowerCase() : expectedParent)) throw new Error('目标目录已更改或包含链接')
      if (entry.dir) await fsp.mkdir(local)
      else await downloadRemoteFile(target, source, local, signal, (bytes) => progress(source, bytes))
      result(source, local, undefined, entry.dir)
    } catch (error) {
      if (signal.aborted) throw error
      result(source, local, error instanceof Error ? error.message : '下载失败', entry.dir)
    }
  }
}

/** Binary download to a new local file. The target is published only on complete success. */
export async function downloadRemoteFile(target: Target, rel: string, destination: string, signal: AbortSignal, progress: (bytes: number) => void): Promise<void> {
  if (!target.host || target.host.id === 'local') throw new Error('请选择远程文件')
  const resolved = treePath(target, rel)
  if (resolved.relative === '.') throw new Error('请选择文件')
  const parts = resolved.relative.split('/')
  let args: string[]
  if (target.platform === 'windows') {
    const walk = parts.map((part) => `$walk=Join-Path $walk ${psQuote(part)}; $item=Get-Item -LiteralPath $walk -Force -ErrorAction Stop; if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '路径包含链接' }`).join('; ')
    const script = `$ErrorActionPreference='Stop'; $walk=(Resolve-Path -LiteralPath ${psQuote(target.cwd)} -ErrorAction Stop).Path; ${walk}; if ($item.PSIsContainer) { throw '请选择文件' }; $inputFile=[IO.File]::Open($walk,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read); try { $output=[Console]::OpenStandardOutput(); $inputFile.CopyTo($output); $output.Flush() } finally { $inputFile.Dispose() }`
    args = ['powershell.exe', '-NoProfile', '-Command', script]
  } else args = ['python3', '-c', READ_LINUX, target.cwd, resolved.relative]
  const temp = path.join(path.dirname(destination), `.awb-download-${randomUUID()}.tmp`)
  let reserved = false
  let remote: Awaited<ReturnType<typeof openRemoteStream>> | undefined
  try {
    const handle = await fsp.open(temp, 'wx'); reserved = true; await handle.close()
    remote = await openRemoteStream(target.host, args, signal)
    remote.stdin.end()
    let bytes = 0
    const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) { bytes += chunk.length; progress(bytes); callback(null, chunk) } })
    await Promise.all([pipeline(remote.stdout, meter, fs.createWriteStream(temp), { signal }), remote.completion])
    if (signal.aborted) throw new Error('传输已取消')
    await fsp.link(temp, destination)
  } catch (error) { remote?.close(); throw error }
  finally { if (reserved) await fsp.unlink(temp).catch(() => undefined) }
}
