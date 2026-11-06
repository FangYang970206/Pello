import { psQuote } from './platform'
import { treePath, type Target } from './git'
import { openRemoteStream } from './ssh'

// Versions exclude the top entry's name and ctime so a rename preserves the version.
// Every opened descriptor and directory enumeration is still checked for concurrent changes.
const LINUX_ENTRY = `def entry_version(parent, name):
    try: fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK, dir_fd=parent)
    except FileNotFoundError: return 'absent'
    try:
        before = os.fstat(fd)
        fields = lambda s: (s.st_dev, s.st_ino, s.st_mode, s.st_size, s.st_mtime_ns)
        digest = hashlib.sha256(repr(fields(before)).encode())
        if stat.S_ISDIR(before.st_mode):
            for child in sorted(os.listdir(fd)):
                version = entry_version(fd, child)
                if version == 'absent': raise ValueError('目标目录正在更改')
                digest.update(os.fsencode(child)); digest.update(bytes([0])); digest.update(version.encode())
            kind = 'd'
        elif stat.S_ISREG(before.st_mode):
            while True:
                block = os.read(fd, 262144)
                if not block: break
                digest.update(block)
            kind = 'f'
        else: raise ValueError('目标包含链接或不支持的文件类型')
        after = os.fstat(fd)
        if fields(before) != fields(after) or before.st_ctime_ns != after.st_ctime_ns: raise ValueError('目标正在更改')
        return kind + ':' + digest.hexdigest()
    finally: os.close(fd)

def open_parent(root, relative):
    parts = relative.split('/')
    if not relative or any(p in ('', '.', '..') for p in parts): raise ValueError('不能替换项目根目录')
    parent = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for part in parts[:-1]:
            nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
            os.close(parent); parent = nxt
        return parent, parts[-1]
    except:
        os.close(parent); raise

def remove_entry(parent, name):
    info = os.stat(name, dir_fd=parent, follow_symlinks=False)
    if stat.S_ISDIR(info.st_mode):
        fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
        try:
            opened = os.fstat(fd)
            if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino): raise ValueError('临时目录已更改')
            for child in os.listdir(fd): remove_entry(fd, child)
            current = os.stat(name, dir_fd=parent, follow_symlinks=False)
            if (current.st_dev, current.st_ino) != (opened.st_dev, opened.st_ino): raise ValueError('临时目录已更改')
            os.rmdir(name, dir_fd=parent)
        finally: os.close(fd)
    else: os.unlink(name, dir_fd=parent)
`

const WINDOWS_ENTRY = `function Get-AwbEntryVersion([string]$name) {
  if(-not (Test-Path -LiteralPath $name)) { return 'absent' }
  $item=Get-Item -LiteralPath $name -Force -ErrorAction Stop
  if($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '路径包含链接' }
  $before=([string]$item.CreationTimeUtc.Ticks)+':'+$item.LastWriteTimeUtc.Ticks+':'+[int]$item.Attributes
  $hash=[Security.Cryptography.SHA256]::Create()
  try {
    if($item.PSIsContainer) {
      $parts=New-Object 'System.Collections.Generic.List[string]'
      $parts.Add($before)
      foreach($child in (Get-ChildItem -LiteralPath $name -Force -ErrorAction Stop | Sort-Object Name)) {
        $version=Get-AwbEntryVersion $child.FullName
        if($version -eq 'absent') { throw '目标目录正在更改' }
        $parts.Add(([string]$child.Name.Length)+':'+$child.Name+':'+$version)
      }
      $bytes=[Text.Encoding]::UTF8.GetBytes(($parts -join ([char]0)))
      $digest=$hash.ComputeHash($bytes); $kind='d'
    } else {
      $stream=[IO.File]::Open($name,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
      try { $digest=$hash.ComputeHash($stream); $before+=':'+([string]$stream.Length) } finally { $stream.Dispose() }
      $kind='f'
    }
    $item.Refresh()
    $after=([string]$item.CreationTimeUtc.Ticks)+':'+$item.LastWriteTimeUtc.Ticks+':'+[int]$item.Attributes
    if(-not $item.PSIsContainer) { $after+=':'+([string]$item.Length) }
    if($before -ne $after) { throw '目标正在更改' }
    $metadata=[Text.Encoding]::UTF8.GetBytes($before+':'+[BitConverter]::ToString($digest))
    return $kind+':'+[BitConverter]::ToString($hash.ComputeHash($metadata)).Replace('-','').ToLowerInvariant()
  } finally { $hash.Dispose() }
}
function Move-AwbEntry([string]$from,[string]$to) {
  if((Get-Item -LiteralPath $from -Force -ErrorAction Stop).PSIsContainer) { [IO.Directory]::Move($from,$to) }
  else { [IO.File]::Move($from,$to) }
}
function Remove-AwbStage([string]$name) {
  if(-not (Test-Path -LiteralPath $name)) { return }
  $null=Get-AwbEntryVersion $name
  Remove-Item -LiteralPath $name -Force -Recurse -ErrorAction Stop
}`

function windowsParent(target: Target, relative: string): string {
  const parts = relative.split('/'); parts.pop()
  return `$parent=(Resolve-Path -LiteralPath ${psQuote(target.cwd)} -ErrorAction Stop).Path; ` + parts.map((part) => `$parent=Join-Path $parent ${psQuote(part)}; $item=Get-Item -LiteralPath $parent -Force -ErrorAction Stop; if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $item.PSIsContainer) { throw '目标不是安全目录' }`).join('; ')
}

async function command(target: Target, args: string[], signal: AbortSignal): Promise<string> {
  if (!target.host || target.host.id === 'local') throw new Error('请选择远程项目')
  const scriptAt = target.platform === 'windows' ? args.indexOf('-Command') : -1
  const script = scriptAt >= 0 ? args[scriptAt + 1] : undefined
  // Keep the Windows command line short even for deep paths and recursive transaction scripts.
  const loader = "$ErrorActionPreference='Stop'; [Console]::InputEncoding=[Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); try { & ([ScriptBlock]::Create([Console]::In.ReadToEnd())) } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }"
  const remote = await openRemoteStream(target.host, scriptAt >= 0 ? [...args.slice(0, scriptAt), '-Command', loader] : args, signal)
  remote.stdin.end(script ? Buffer.from(script, 'utf8') : undefined)
  let output = ''
  try {
    remote.stdout.setEncoding('utf8')
    await Promise.all([(async () => { for await (const chunk of remote.stdout) { output += chunk; if (output.length > 4096) throw new Error('远程响应无效') } })(), remote.completion])
    return output.trim()
  } catch (error) { remote.close(); throw error }
}

/** Recursive version of a regular file or directory; refuses every linked descendant. */
export async function remoteEntryVersion(target: Target, path: string, signal: AbortSignal): Promise<string> {
  const relative = treePath(target, path).relative
  if (relative === '.') throw new Error('不能替换项目根目录')
  const name = relative.split('/').at(-1)!
  const args = target.platform === 'windows'
    ? ['powershell.exe', '-NoProfile', '-OutputFormat', 'Text', '-Command', `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); ${WINDOWS_ENTRY}; ${windowsParent(target, relative)}; Get-AwbEntryVersion (Join-Path $parent ${psQuote(name)})`]
    : ['python3', '-c', `import hashlib, os, shutil, stat, sys\n${LINUX_ENTRY}\nparent, name = open_parent(sys.argv[1], sys.argv[2])\ntry: print(entry_version(parent, name))\nfinally: os.close(parent)`, target.cwd, relative]
  const version = await command(target, args, signal)
  if (!/^(absent|[df]:[a-f0-9]{64})$/.test(version)) throw new Error('远程版本响应无效')
  return version
}

/** Publish a completed sibling stage. Linux exchanges atomically; Windows keeps a rollback backup. */
export async function publishRemoteStage(target: Target, path: string, stage: string, expected: string): Promise<string | undefined> {
  const relative = treePath(target, path).relative
  if (relative === '.' || !/^\.awb-upload-tree-[a-f0-9-]{36}$/.test(stage)) throw new Error('替换路径无效')
  const name = relative.split('/').at(-1)!
  const backup = stage.replace('tree-', 'backup-')
  let args: string[]
  if (target.platform === 'windows') {
    const script = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); ${WINDOWS_ENTRY}; ${windowsParent(target, relative)};
$dest=Join-Path $parent ${psQuote(name)}; $stage=Join-Path $parent ${psQuote(stage)}; $backup=Join-Path $parent ${psQuote(backup)}; $moved=$false; $published=$false
try {
  $null=Get-AwbEntryVersion $stage
  if((Get-AwbEntryVersion $dest) -ne ${psQuote(expected)}) { throw '目标已更改，原对象已保留' }
  if(${psQuote(expected)} -ne 'absent') {
    Move-AwbEntry $dest $backup; $moved=$true
    if((Get-AwbEntryVersion $backup) -ne ${psQuote(expected)}) { throw '目标已更改，原对象已保留' }
  }
  Move-AwbEntry $stage $dest; $published=$true
  if($moved) { try { Remove-AwbStage $backup; $moved=$false } catch { Write-Output ('AWB_WARNING:替换已完成，旧对象清理失败，保留于 '+$backup) } }
} catch {
  $reason=$_
  if($moved -and -not $published) {
    if(Test-Path -LiteralPath $dest) { throw ('替换失败，原对象保留于 '+$backup) }
    Move-AwbEntry $backup $dest; $moved=$false
  }
  throw $reason
} finally {
  if(-not $published) { Remove-AwbStage $stage }
}`
    args = ['powershell.exe', '-NoProfile', '-OutputFormat', 'Text', '-Command', script]
  } else {
    const script = `import ctypes, hashlib, os, shutil, stat, sys
${LINUX_ENTRY}
root, relative, stage, expected = sys.argv[1:]
parent, name = open_parent(root, relative)
old_in_stage = False
try:
    staged = entry_version(parent, stage)
    if staged == 'absent': raise ValueError('临时上传不存在')
    if entry_version(parent, name) != expected: raise ValueError('目标已更改，原对象已保留')
    libc = ctypes.CDLL(None, use_errno=True)
    rename = getattr(libc, 'renameat2', None)
    if rename is None: raise ValueError('系统不支持安全目录替换')
    rename.argtypes = (ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint)
    def move(flags):
        if rename(parent, os.fsencode(stage), parent, os.fsencode(name), flags) != 0:
            code = ctypes.get_errno(); raise OSError(code, os.strerror(code))
    if expected == 'absent': move(1)
    else:
        move(2); old_in_stage = True
        if entry_version(parent, stage) != expected:
            if entry_version(parent, name) != staged: raise ValueError('目标正在更改，原对象保留于 ' + stage)
            move(2); old_in_stage = False
            raise ValueError('目标已更改，原对象已保留')
        try:
            remove_entry(parent, stage); old_in_stage = False
        except Exception:
            print('AWB_WARNING:替换已完成，旧对象清理失败，保留于 ' + os.path.join(root, os.path.dirname(relative), stage))
finally:
    if not old_in_stage:
        try: remove_entry(parent, stage)
        except FileNotFoundError: pass
    os.close(parent)
`
    args = ['python3', '-c', script, target.cwd, relative, stage, expected]
  }
  // A cancellation may stop staging, but must not interrupt the short rename/rollback transaction.
  const output = await command(target, args, new AbortController().signal)
  if (output.startsWith('AWB_WARNING:')) return output.slice('AWB_WARNING:'.length)
}

export async function removeRemoteStage(target: Target, relative: string): Promise<void> {
  const stage = relative.split('/').at(-1)!
  if (!/^\.awb-upload-tree-[a-f0-9-]{36}$/.test(stage)) throw new Error('临时上传路径无效')
  const signal = AbortSignal.timeout(15000)
  const args = target.platform === 'windows'
    ? ['powershell.exe', '-NoProfile', '-OutputFormat', 'Text', '-Command', `$ErrorActionPreference='Stop'; ${WINDOWS_ENTRY}; for($attempt=0; $attempt -le 100; $attempt++) { try { ${windowsParent(target, relative)}; Remove-AwbStage (Join-Path $parent ${psQuote(stage)}); break } catch { if($attempt -eq 100) { throw }; Start-Sleep -Milliseconds 100 } }`]
    : ['python3', '-c', `import hashlib, os, shutil, stat, sys\n${LINUX_ENTRY}\nparent, name = open_parent(sys.argv[1], sys.argv[2])\ntry:\n    try: remove_entry(parent, name)\n    except FileNotFoundError: pass\nfinally: os.close(parent)`, target.cwd, relative]
  await command(target, args, signal)
}
