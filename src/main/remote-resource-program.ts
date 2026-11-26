import type { OsKind } from '../shared/types'
import { t } from '../shared/i18n'
import { psQuote } from './platform'

function localize(program: string, quote: (text: string) => string) {
  const messages: Record<string, string> = {
    FILE: t("配置是符号链接，请选择真实配置文件"),
    LARGE: t("配置文件超过 32 MB"),
    READING: t("读取版本期间文件已更改"),
    CANCELLED: t("已取消"),
    CHANGED: t("配置已被其他程序修改，请刷新后重试"),
    SNAPSHOT: t("远程输出过大"),
    LINK: t("不能切换指向其他目录的 Skill 链接"),
    DIRECTORY: t("目录不存在")
  }
  return program.replace(/'PELLO_RESOURCE_([A-Z]+)'/g, (_, key: string) => quote(messages[key]))
}

const linux = String.raw`
import hashlib, json, os, stat, sys, tempfile

q = json.loads(sys.stdin.readline())
op = q['op']
limit = 32 * 1024 * 1024

def read(file, links=True):
    try:
        flags = os.O_RDONLY | os.O_NONBLOCK | (0 if links else os.O_NOFOLLOW)
        with os.fdopen(os.open(file, flags), 'rb') as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode):
                raise ValueError('PELLO_RESOURCE_FILE')
            if info.st_size > limit:
                raise ValueError('PELLO_RESOURCE_LARGE')
            data = stream.read(limit + 1)
            after = os.fstat(stream.fileno())
            if len(data) > limit or (info.st_size, info.st_mtime_ns, info.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                raise ValueError('PELLO_RESOURCE_READING')
            stamp = ':'.join(map(str, (info.st_dev, info.st_ino, info.st_mtime_ns, info.st_ctime_ns, hashlib.sha256(data).hexdigest())))
            return dict(path=file, content=data.decode('utf-8'), stamp=stamp)
    except FileNotFoundError:
        return dict(path=file)

def approve():
    print('OK', flush=True)
    if sys.stdin.readline().strip() != '1':
        raise ValueError('PELLO_RESOURCE_CANCELLED')

def change(file, expected):
    if read(file, False).get('stamp', '') != expected:
        raise ValueError('PELLO_RESOURCE_CHANGED')

def stage(parent, content):
    handle, file = tempfile.mkstemp(prefix='.pello-resource-', dir=parent)
    try:
        with os.fdopen(handle, 'wb') as stream:
            stream.write(content.encode('utf-8'))
            stream.flush()
            os.fsync(stream.fileno())
        return file
    except:
        os.unlink(file)
        raise

try:
    if op == 'profile':
        home = os.path.expanduser('~')
        env = {key: os.environ[key] for key in ('CODEX_HOME', 'XDG_CONFIG_HOME', 'CLAUDE_CONFIG_DIR', 'PI_CODING_AGENT_DIR', 'OPENCODE_CONFIG') if key in os.environ and os.path.isabs(os.environ[key])}
        jsonc = os.path.join(env.get('XDG_CONFIG_HOME', os.path.join(home, '.config')), 'opencode', 'opencode.jsonc')
        print(json.dumps(dict(home=home, env=env, jsonc=jsonc if os.path.isfile(jsonc) else '')))
    elif op == 'browse':
        folder = os.path.realpath(q['path'] or os.path.expanduser('~'))
        dirs, files = [], []
        for item in os.scandir(folder):
            if item.is_dir(): dirs.append(item.name)
            elif item.is_file(): files.append(item.name)
        parent = os.path.dirname(folder)
        print(json.dumps(dict(path=folder, parent=parent if parent != folder else None, dirs=dirs, files=files)))
    elif op == 'snapshot':
        files, skills, errors, visited = {}, [], [], set()
        total = 0
        def collect(file):
            global total
            if file not in files:
                try:
                    files[file] = read(file)
                    total += len(files[file].get('content', '').encode('utf-8'))
                except (OSError, UnicodeError, ValueError) as error:
                    files[file] = dict(path=file, error=str(error))
                if total > limit:
                    raise RuntimeError('PELLO_RESOURCE_SNAPSHOT')
            return 'content' in files[file] or 'error' in files[file]
        for file in q['files']: collect(file)
        pending = list(reversed(q['roots']))
        while pending:
            folder = pending.pop()
            try:
                info = os.stat(folder)
                key = (info.st_dev, info.st_ino)
                if key in visited: continue
                visited.add(key)
                file = os.path.join(folder, 'SKILL.md')
                if collect(file) or collect(file + '.awb-disabled'):
                    skills.append(file)
                else:
                    del files[file], files[file + '.awb-disabled']
                    pending.extend(item.path for item in os.scandir(folder) if item.is_dir())
            except FileNotFoundError:
                continue
            except OSError as error:
                errors.append(str(error))
        print(json.dumps(dict(files=list(files.values()), skills=skills, errors=errors), ensure_ascii=False))
    elif op == 'canonical':
        print(json.dumps(os.path.realpath(q['path'])))
    elif op == 'mkdir':
        approve()
        os.makedirs(q['path'], exist_ok=True)
    elif op == 'rename':
        source, dest, root = q['path'], q['dest'], os.path.realpath(q['root'])
        if os.path.commonpath([root, os.path.realpath(source)]) != root or os.path.dirname(source) != os.path.dirname(dest):
            raise ValueError('PELLO_RESOURCE_LINK')
        approve()
        change(source, q['stamp'])
        os.link(source, dest, follow_symlinks=False)
        try: os.unlink(source)
        except:
            os.unlink(dest)
            raise
    elif op == 'write':
        file, expected = q['path'], q['stamp']
        parent = os.path.realpath(os.path.dirname(file))
        file = os.path.join(parent, os.path.basename(file))
        change(file, expected)
        approve()
        os.makedirs(parent, exist_ok=True)
        temp, backup = stage(parent, q['content']), None
        try:
            change(file, expected)
            if expected:
                backup = stage(parent, read(file, False)['content'])
                change(file, expected)
                os.replace(backup, file + '.awb-backup')
                backup = None
                change(file, expected)
                os.replace(temp, file)
            else:
                os.link(temp, file)
        finally:
            for staged in (temp, backup):
                if staged and os.path.exists(staged): os.unlink(staged)
except Exception as error:
    sys.exit(str(error))
`

// Keep the encoded command short enough for the Windows OpenSSH default shell.
const windows = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::InputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false,$true)
$q=[Console]::ReadLine()|ConvertFrom-Json
function item($p){Get-Item -LiteralPath $p -Force -ErrorAction Stop}
function read($p,$safe){
 try{$i=item $p}catch [Management.Automation.ItemNotFoundException]{return @{path=$p}}
 if($i.PSIsContainer -or ($safe -and ($i.Attributes -band 1024))){throw 'PELLO_RESOURCE_FILE'}
 if($i.Length -gt 32MB){throw 'PELLO_RESOURCE_LARGE'}
 $b=[IO.File]::ReadAllBytes($p)
 if($b.Length -gt 32MB){throw 'PELLO_RESOURCE_LARGE'}
 $hash=[BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($b))
 @{path=$p;content=[Console]::InputEncoding.GetString($b);stamp="$($i.LastWriteTimeUtc.Ticks):$($i.CreationTimeUtc.Ticks):$hash"}
}
function approve{[Console]::WriteLine('OK');if([Console]::ReadLine() -ne '1'){throw 'PELLO_RESOURCE_CANCELLED'}}
function check($p){if([string](read $p $true).stamp -cne $q.stamp){throw 'PELLO_RESOURCE_CHANGED'}}
function canonical($p){
 $p=[IO.Path]::GetFullPath($p)
 $parts=[Collections.Generic.Stack[string]]::new()
 while($true){
   $root=[IO.Path]::GetPathRoot($p)
   if($p -eq $root){break}
   $parts.Push([IO.Path]::GetFileName($p));$p=[IO.Path]::GetDirectoryName($p)
 }
 while($parts.Count){
   $p=Join-Path $p $parts.Pop()
   try{$i=item $p}catch [Management.Automation.ItemNotFoundException]{continue}
   if($i.Target){$dest=@($i.Target)[0];if(![IO.Path]::IsPathRooted($dest)){$dest=Join-Path $i.DirectoryName $dest};$p=[IO.Path]::GetFullPath($dest)}
 }
 $p
}
function out($value){ConvertTo-Json -InputObject $value -Depth 8 -Compress}
switch($q.op){
 profile {
   $envPaths=@{}
   'CODEX_HOME','XDG_CONFIG_HOME','CLAUDE_CONFIG_DIR','PI_CODING_AGENT_DIR','OPENCODE_CONFIG'|%{$v=[Environment]::GetEnvironmentVariable($_);if($v -match '^(?:[A-Z]:[\\/]|\\\\)'){$envPaths[$_]=$v}}
   $config=$envPaths.XDG_CONFIG_HOME;if(!$config){$config=Join-Path $HOME '.config'}
   $jsonc=Join-Path $config 'opencode\opencode.jsonc';if(![IO.File]::Exists($jsonc)){$jsonc=''}
   out @{home=$HOME;env=$envPaths;jsonc=$jsonc}
 }
 browse {
   $p=$q.path;if(!$p){$p=$HOME};$d=item $p
   if(!$d.PSIsContainer){throw 'PELLO_RESOURCE_DIRECTORY'}
   $entries=@(Get-ChildItem -LiteralPath $d.FullName -Force)
   out @{path=$d.FullName;parent=$d.Parent.FullName;dirs=@($entries|? PSIsContainer|% Name);files=@($entries|? {!$_.PSIsContainer}|% Name)}
 }
 snapshot {
   $files=@{};$skills=[Collections.Generic.List[string]]::new();$errors=[Collections.Generic.List[string]]::new()
   $seen=@{};$dirs=[Collections.Generic.Stack[string]]::new();$bytes=0
   foreach($f in $q.files){try{$files[$f]=read $f}catch{$files[$f]=@{path=$f;error=$_.Exception.Message}}}
   foreach($root in $q.roots){$dirs.Push($root)}
   while($dirs.Count){
      $d=$dirs.Pop()
      try{
        $i=item $d;$real=canonical $d
        if($seen.ContainsKey($real)){continue};$seen[$real]=$true
        $f=Join-Path $d 'SKILL.md'
        try{$r=read $f;if(!$r.ContainsKey('content')){$r=read ($f+'.awb-disabled')}}catch{$r=@{path=$f;error=$_.Exception.Message}}
        if($r.ContainsKey('content') -or $r.error){$files[$r.path]=$r;$skills.Add($f);$bytes+=$r.content.Length}
        else{Get-ChildItem -LiteralPath $i.FullName -Directory -Force|%{$dirs.Push($_.FullName)}}
      }catch [Management.Automation.ItemNotFoundException]{}catch{$errors.Add($_.Exception.Message)}
      if($bytes -gt 32MB){throw 'PELLO_RESOURCE_SNAPSHOT'}
   }
   out @{files=@($files.Values);skills=@($skills.ToArray());errors=@($errors.ToArray())}
 }
 canonical {out (canonical $q.path)}
 mkdir {approve;$null=[IO.Directory]::CreateDirectory($q.path)}
 rename {
   $p=canonical $q.path;$root=(canonical $q.root).TrimEnd('\')+'\'
   if(!$p.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)){throw 'PELLO_RESOURCE_LINK'}
   approve;check $q.path
   [IO.File]::Move($q.path,$q.dest)
 }
 write {
   $p=$q.path;check $p;approve
   $parent=[IO.Path]::GetDirectoryName($p);$null=[IO.Directory]::CreateDirectory($parent)
   $temp=Join-Path $parent ('.pello-resource-'+[Guid]::NewGuid())
   try{[IO.File]::WriteAllText($temp,$q.content,[Console]::OutputEncoding);check $p
     if($q.stamp){[IO.File]::Replace($temp,$p,($p+'.awb-backup'))}
     else{[IO.File]::Move($temp,$p)}
   }finally{[IO.File]::Delete($temp)}
 }
}
`

export function remoteResourceProgram(platform: OsKind, operation: string): string[] {
  if (platform !== 'windows') return ['python3', '-c', localize(linux, JSON.stringify)]
  const [setup, ...handlers] = windows.split(/\n (?=[a-z]+ \{)/)
  const handler = handlers.find((item) => item.startsWith(operation + ' {'))
  if (!handler) throw new Error('Unknown remote resource operation')
  const body = handler.slice(handler.indexOf('{') + 1, handler.indexOf('\n }') >= 0 ? handler.indexOf('\n }') : handler.lastIndexOf('}'))
  return ['powershell.exe', '-NoProfile', '-OutputFormat', 'Text', '-Command', localize(setup.replace(/switch\(\$q.op\)\{$/, '') + body, psQuote)]
}
