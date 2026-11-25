/** Read-only helpers run over a private SSH exec stream; no files are installed remotely. */
export function remoteReadProgram(platform: 'linux' | 'windows'): string[] {
  if (platform === 'linux') return ['python3', '-u', '-c', `import sys,os,json,stat
for line in sys.stdin.buffer:
 data=b''; status='ERROR'; handles=[]
 try:
  req=json.loads(line); root=os.path.realpath(req['root']); rel=req['path']; limit=req['limit']
  parts=rel.split('/')
  if not rel or any(p in ('','..','.') or '\\x00' in p for p in parts) or not 0<limit<=12000000: raise ValueError()
  fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY); handles.append(fd)
  for part in parts[:-1]:
   fd=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd); handles.append(fd)
  fd=os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd); handles.append(fd)
  before=os.fstat(fd)
  if not stat.S_ISREG(before.st_mode): raise ValueError()
  if before.st_size>limit: status='LARGE'
  else:
   chunks=[]; remaining=limit+1
   while remaining:
    chunk=os.read(fd,min(262144,remaining))
    if not chunk: break
    chunks.append(chunk); remaining-=len(chunk)
   data=b''.join(chunks); after=os.fstat(fd)
   if len(data)>limit: data=b''; status='LARGE'
   elif (before.st_size,before.st_mtime_ns,before.st_ctime_ns)!=(after.st_size,after.st_mtime_ns,after.st_ctime_ns): data=b''; status='CHANGED'
   else: status='OK'
 except FileNotFoundError: status='MISSING'
 except Exception: status='ERROR'; data=b''
 finally:
  for fd in reversed(handles): os.close(fd)
 sys.stdout.buffer.write(('PELLO1 '+status+' '+str(len(data))+'\\n').encode()); sys.stdout.buffer.write(data); sys.stdout.buffer.flush()
`]
  return ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', `
$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
$output=[Console]::OpenStandardOutput()
while ($null -ne ($line=[Console]::ReadLine())) {
 $bytes=[byte[]]@(); $status='ERROR'; $stream=$null
 try {
  $req=$line|ConvertFrom-Json; $limit=[int]$req.limit
  $root=(Resolve-Path -LiteralPath $req.root -ErrorAction Stop).Path.TrimEnd('\\')
  $relative=[string]$req.path
  if (-not $relative -or [IO.Path]::IsPathRooted($relative) -or $limit -le 0 -or $limit -gt 12000000) { throw 'Invalid path' }
  $file=$root
  foreach ($part in $relative.Split('/')) {
   if (-not $part -or $part -eq '.' -or $part -eq '..' -or $part.Contains('\\') -or $part.Contains(':')) { throw 'Invalid path' }
   $file=Join-Path $file $part
   $item=Get-Item -LiteralPath $file -Force -ErrorAction Stop
   if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Invalid path' }
  }
  if ($item.PSIsContainer) { throw 'Invalid file' }
  $stream=[IO.FileStream]::new($file,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
  if ($stream.Length -gt $limit) { $status='LARGE' }
  else {
   $bytes=[byte[]]::new([int]$stream.Length); $offset=0
   while ($offset -lt $bytes.Length) { $read=$stream.Read($bytes,$offset,$bytes.Length-$offset); if (-not $read) { throw 'Changed file' }; $offset+=$read }
   $status='OK'
  }
 } catch [System.Management.Automation.ItemNotFoundException] { $status='MISSING' }
 catch [System.IO.FileNotFoundException] { $status='MISSING' }
 catch [System.IO.DirectoryNotFoundException] { $status='MISSING' }
 catch { $bytes=[byte[]]@(); $status='ERROR' }
 finally { if ($stream) { $stream.Dispose() } }
 $header=[Text.Encoding]::ASCII.GetBytes('PELLO1 '+$status+' '+$bytes.Length+[char]10)
 $output.Write($header,0,$header.Length); $output.Write($bytes,0,$bytes.Length); $output.Flush()
}
`]
}

/** Keep only the initial machine's exec alive; idle child channels would pin an interactive SSH master. */
export function remoteReadRelay(command: string): string[] {
  return ['python3', '-u', '-c', `import sys,subprocess
for line in sys.stdin.buffer:
 try:
  result=subprocess.run(['bash','-c',sys.argv[1]],input=line,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=18)
  data=result.stdout
  if result.returncode or not data.startswith(b'PELLO1 ') or len(data)>12000128: data=b'PELLO1 ERROR 0\\n'
 except Exception: data=b'PELLO1 ERROR 0\\n'
 sys.stdout.buffer.write(data); sys.stdout.buffer.flush()
`, command]
}
