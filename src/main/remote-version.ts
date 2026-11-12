import { t } from '../shared/i18n'
import { treePath, type Target } from './git'
import { psQuote } from './platform'
import { openRemoteStream } from './ssh'

/** Fingerprint the opened inode, including metadata and a streaming binary digest. */
export const LINUX_FILE_VERSION = () => `def file_version(fd):
    before = os.fstat(fd)
    if not stat.S_ISREG(before.st_mode): raise ValueError(${JSON.stringify(t("不是普通文件"))})
    digest = hashlib.sha256()
    os.lseek(fd, 0, os.SEEK_SET)
    while True:
        block = os.read(fd, 262144)
        if not block: break
        digest.update(block)
    after = os.fstat(fd)
    fields = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns, s.st_mode)
    if fields(before) != fields(after): raise ValueError(${JSON.stringify(t("读取版本期间文件已更改"))})
    return ':'.join(str(n) for n in fields(after)) + ':' + digest.hexdigest()
`

export const WINDOWS_FILE_VERSION = () => `function Get-AwbFileVersion([string]$name) { $item=Get-Item -LiteralPath $name -Force -ErrorAction Stop; if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw ${psQuote(t("不是安全的普通文件"))} }; $stream=[IO.File]::Open($name,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read); try { $before=([string]$item.Length)+':'+$item.LastWriteTimeUtc.Ticks+':'+$item.CreationTimeUtc.Ticks; $sha=[Security.Cryptography.SHA256]::Create(); try { $digest=[BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }; $item.Refresh(); $after=([string]$item.Length)+':'+$item.LastWriteTimeUtc.Ticks+':'+$item.CreationTimeUtc.Ticks; if($before -ne $after) { throw ${psQuote(t("读取版本期间文件已更改"))} }; return $after+':'+$digest } finally { $stream.Dispose() } }`

export async function remoteFileVersion(target: Target, rel: string, signal: AbortSignal): Promise<string> {
  if (!target.host || target.host.id === 'local') throw new Error(t("请选择远程文件"))
  const relative = treePath(target, rel).relative
  if (relative === '.') throw new Error(t("请选择项目中的文件"))
  let args: string[]
  if (target.platform === 'windows') {
    const walk = relative.split('/').map((part) => `$walk=Join-Path $walk ${psQuote(part)}; $item=Get-Item -LiteralPath $walk -Force -ErrorAction Stop; if($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw ${psQuote(t("路径包含链接"))} }`).join('; ')
    args = ['powershell.exe', '-NoProfile', '-OutputFormat', 'Text', '-Command', `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); ${WINDOWS_FILE_VERSION()}; $walk=(Resolve-Path -LiteralPath ${psQuote(target.cwd)} -ErrorAction Stop).Path; ${walk}; Get-AwbFileVersion $walk`]
  } else {
    const script = `import hashlib, os, stat, sys
${LINUX_FILE_VERSION()}
root, relative = sys.argv[1:]
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC
parent = os.open(root, flags)
try:
    parts = relative.split('/')
    for part in parts[:-1]:
        nxt = os.open(part, flags | os.O_NOFOLLOW, dir_fd=parent)
        os.close(parent)
        parent = nxt
    fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK, dir_fd=parent)
    try: print(file_version(fd))
    finally: os.close(fd)
finally: os.close(parent)
`
    args = ['python3', '-c', script, target.cwd, relative]
  }
  const remote = await openRemoteStream(target.host, args, signal)
  remote.stdin.end()
  let output = ''
  const read = async () => {
    remote.stdout.setEncoding('utf8')
    for await (const chunk of remote.stdout) {
      output += chunk
      if (output.length > 2048) throw new Error(t("远程版本响应无效"))
    }
  }
  try {
    await Promise.all([read(), remote.completion])
    const version = output.trim()
    if (!/^[0-9a-f:-]+$/.test(version) || version.length < 64) throw new Error(t("远程版本响应无效"))
    return version
  } catch (error) { remote.close(); throw error }
}
