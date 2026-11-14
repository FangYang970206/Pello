// The remote worker reads JSON from stdin and returns only matches as JSONL.
// No user query, file contents or ignore rules are interpolated into shell code.
export const CONTENT_SEARCH_LINUX = `import os, sys, json, re, stat, signal
c = json.load(sys.stdin)
root = os.path.realpath(c['root'])
source = c['query'] if c.get('regex') else re.escape(c['query'])
if c.get('whole'): source = r'(?<!\\w)(?:' + source + r')(?!\\w)'
try: pattern = re.compile(source, 0 if c['sensitive'] else re.IGNORECASE)
except re.error:
    print(json.dumps({'error': 'invalid'}), flush=True); sys.exit(0)
def timeout(signum, frame): raise TimeoutError()
signal.signal(signal.SIGALRM, timeout)
ignored = set(c['ignored'])
remaining = 2000
def emit(value):
    print(json.dumps(value, ensure_ascii=True), flush=True)
def scan(directory, relative):
    global remaining
    try:
        entries = sorted(os.scandir(directory), key=lambda e: e.name)
    except OSError:
        if not relative: raise
        emit({'errors': 1}); return
    emit({})
    for entry in entries:
        if remaining <= 0: return
        rel = relative + '/' + entry.name if relative else entry.name
        try:
            if entry.is_symlink(): continue
            if entry.is_dir(follow_symlinks=False):
                if not entry.name.startswith('.') and entry.name not in ignored:
                    scan(entry.path, rel)
                continue
            if not entry.is_file(follow_symlinks=False): continue
            # Resolve every ancestor again before opening; do not follow links outside the project.
            real = os.path.realpath(entry.path)
            if os.path.commonpath([root, real]) != root or real != entry.path: continue
            fd = os.open(entry.path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(fd, 'rb') as f:
                info = os.fstat(f.fileno())
                if not stat.S_ISREG(info.st_mode): continue
                if info.st_size > 2000000:
                    emit({'skipped': 1}); continue
                raw = f.read(2000001)
            if len(raw) > 2000000 or b'\\0' in raw:
                emit({'skipped': 1}); continue
            try: text = raw.decode('utf-8')
            except UnicodeDecodeError:
                emit({'skipped': 1}); continue
            matches = []
            if c.get('regex'): signal.setitimer(signal.ITIMER_REAL, 0.5)
            for number, line in enumerate(text.split('\\n'), 1):
                if line.endswith('\\r'): line = line[:-1]
                for m in pattern.finditer(line):
                    matches.append({'line': number, 'column': len(line[:m.start()].encode('utf-16-le')) // 2 + 1,
                        'before': line[max(0, m.start()-80):m.start()], 'match': m.group(), 'after': line[m.end():m.end()+160].rstrip('\\r')})
                    remaining -= 1
                    if remaining <= 0: break
                if remaining <= 0: break
            signal.setitimer(signal.ITIMER_REAL, 0)
            emit({'file': {'path': rel, 'matches': matches}} if matches else {})
        except TimeoutError:
            emit({'error': 'timeout'}); return
        except OSError:
            emit({'errors': 1})
scan(root, '')
if remaining <= 0: emit({'limited': True})
`

export const CONTENT_SEARCH_WINDOWS = `$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$c=[Console]::In.ReadToEnd() | ConvertFrom-Json
$root=(Resolve-Path -LiteralPath $c.root).Path.TrimEnd('\\')
$options=[Text.RegularExpressions.RegexOptions]::CultureInvariant
if (-not $c.sensitive) { $options=$options -bor [Text.RegularExpressions.RegexOptions]::IgnoreCase }
$source=if ($c.regex) { $c.query } else { [regex]::Escape($c.query) }
if ($c.whole) { $source='(?<![\\p{L}\\p{N}_])(?:'+$source+')(?![\\p{L}\\p{N}_])' }
try { $pattern=[regex]::new($source,$options,[TimeSpan]::FromMilliseconds(500)) }
catch { [Console]::WriteLine('{"error":"invalid"}'); exit 0 }
$decoder=[Text.UTF8Encoding]::new($false,$true)
$script:remaining=2000
function Emit($value) { [Console]::WriteLine(($value | ConvertTo-Json -Depth 8 -Compress)) }
function Scan($directory,$relative) {
    try { $entries=@(Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop | Sort-Object Name) }
    catch { if (-not $relative) { throw }; Emit @{errors=1}; return }
    Emit @{}
    foreach ($entry in $entries) {
        if ($script:remaining -le 0) { return }
        if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
        $rel=if ($relative) { $relative+'/'+$entry.Name } else { $entry.Name }
        if ($entry.PSIsContainer) {
            if (-not $entry.Name.StartsWith('.') -and $entry.Name -cnotin $c.ignored) { Scan $entry.FullName $rel }
            continue
        }
        try {
            $walk=$root
            $safe=$true
            foreach ($part in $rel.Split('/')) {
                $walk=Join-Path $walk $part
                if ((Get-Item -LiteralPath $walk -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { $safe=$false; break }
            }
            if (-not $safe) { continue }
            if ($entry.Length -gt 2000000) { Emit @{skipped=1}; continue }
            $stream=[IO.File]::OpenRead($entry.FullName)
            try {
                $raw=[byte[]]::new(2000001)
                $length=0
                while ($length -lt $raw.Length) {
                    $read=$stream.Read($raw,$length,$raw.Length-$length)
                    if (-not $read) { break }; $length+=$read
                }
            } finally { $stream.Dispose() }
            if ($length -gt 2000000 -or [Array]::IndexOf($raw,[byte]0,0,$length) -ge 0) { Emit @{skipped=1}; continue }
            try { $text=$decoder.GetString($raw,0,$length) } catch { Emit @{skipped=1}; continue }
            $matches=[Collections.Generic.List[object]]::new()
            $number=0
            foreach ($line in $text.Split([char]10)) {
                $line=$line.TrimEnd([char]13)
                $number++
                foreach ($m in $pattern.Matches($line)) {
                    $start=[Math]::Max(0,$m.Index-80)
                    $end=$m.Index+$m.Length
                    $matches.Add(@{line=$number;column=$m.Index+1;before=$line.Substring($start,$m.Index-$start);match=$m.Value;after=$line.Substring($end,[Math]::Min(160,$line.Length-$end)).TrimEnd([char]13)})
                    $script:remaining--
                    if ($script:remaining -le 0) { break }
                }
                if ($script:remaining -le 0) { break }
            }
            if ($matches.Count) { Emit @{file=@{path=$rel;matches=@($matches.ToArray())}} } else { Emit @{} }
        } catch {
            if ($_.Exception.GetBaseException() -is [Text.RegularExpressions.RegexMatchTimeoutException]) { Emit @{error='timeout'}; return }
            Emit @{errors=1}
        }
    }
}
Scan $root ''
if ($script:remaining -le 0) { Emit @{limited=$true} }
`
