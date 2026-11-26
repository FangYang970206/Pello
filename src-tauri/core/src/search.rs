//! File-name and content search. Local scans follow `src/main/content-search.ts`.
//! Remote scans run the same Linux worker as `content-search-scripts.ts`.

use crate::files;
use crate::i18n::translate;
use serde_json::{json, Value};
use std::fs;
use std::io::Read;
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

const MAX_MATCHES: usize = 2000;
const MAX_BYTES: u64 = 2_000_000;
const CONTENT_EVENTS: usize = 32;
const CONTENT_BUDGET: Duration = Duration::from_millis(40);
const TREE_DIRECTORIES: usize = 8;
const REGEX_BUDGET: Duration = Duration::from_millis(500);

struct DirEntry {
    name: String,
    directory: bool,
    file: bool,
}

pub struct ContentSearch {
    root: PathBuf,
    project_id: String,
    identity: String,
    ignored: Vec<String>,
    matcher: Option<JsMatcher>,
    remaining: usize,
    skipped: u64,
    errors: u64,
    limited: bool,
    done: bool,
    /// Set to stop the search. It is shared, so a search can be stopped while
    /// its next batch is still being waited for.
    cancelled: Arc<AtomicBool>,
    stack: Vec<String>,
    current_dir: String,
    current: Vec<DirEntry>,
    buffered: Option<VecDeque<Value>>,
    /// The command whose output is read as it comes, for a search on a
    /// remote host. It is read until the command ends, then dropped.
    stream: Option<crate::ssh::CommandStream>,
}

pub struct TreeSearch {
    root: PathBuf,
    project_id: String,
    identity: String,
    query: String,
    ignored: Vec<String>,
    pending: Vec<String>,
    cancelled: bool,
    ready: Option<Vec<Value>>,
}

impl ContentSearch {
    pub fn start(root: &Path, project_id: &str, identity: &str, query: &str, sensitive: bool, regex: bool, whole: bool, ignored: &[String], language: &str) -> Result<Self, String> {
        validate_content_query(query, language)?;
        let matcher = JsMatcher::start(query, sensitive, regex, whole, language)?;
        Ok(Self {
            root: root.to_path_buf(),
            project_id: project_id.to_string(),
            identity: identity.to_string(),
            ignored: ignored.to_vec(),
            matcher: Some(matcher),
            remaining: MAX_MATCHES,
            skipped: 0,
            errors: 0,
            limited: false,
            done: false,
            cancelled: crate::ssh::CancelFlag::new().into_shared(),
            stack: vec![String::new()],
            current_dir: String::new(),
            current: Vec::new(),
            buffered: None,
            stream: None,
        })
    }

    /// A search that reads the output of a command already running on a
    /// remote host: each line is what the host reports for one file.
    pub fn from_stream(project_id: &str, identity: &str, stream: crate::ssh::CommandStream, language: &str) -> Self {
        let _ = language;
        // The search and its stream share one flag: stopping the search ends
        // the wait for the next line and the command on the host together.
        let cancelled = stream.cancel_flag().into_shared();
        Self {
            root: PathBuf::new(),
            project_id: project_id.to_string(),
            identity: identity.to_string(),
            ignored: Vec::new(),
            matcher: None,
            remaining: MAX_MATCHES,
            skipped: 0,
            errors: 0,
            limited: false,
            done: false,
            cancelled,
            stack: Vec::new(),
            current_dir: String::new(),
            current: Vec::new(),
            buffered: None,
            stream: Some(stream),
        }
    }

    pub fn from_remote_output(project_id: &str, identity: &str, output: &str, language: &str) -> Result<Self, String> {
        let mut files = VecDeque::new();
        let mut skipped = 0u64;
        let mut errors = 0u64;
        let mut limited = false;
        for line in output.lines().filter(|line| !line.trim().is_empty()) {
            let event: Value = serde_json::from_str(line).map_err(|_| translate(language, "正则表达式无效", &[] as &[String]))?;
            if let Some(error) = event["error"].as_str() {
                let message = if error == "timeout" { "正则表达式执行超时，请简化表达式" } else { "正则表达式无效" };
                return Err(translate(language, message, &[] as &[String]));
            }
            skipped += event["skipped"].as_u64().unwrap_or(0);
            errors += event["errors"].as_u64().unwrap_or(0);
            limited |= event["limited"].as_bool().unwrap_or(false);
            if event.get("file").is_some_and(|file| file.is_object()) {
                files.push_back(event["file"].clone());
            }
        }
        Ok(Self {
            root: PathBuf::new(),
            project_id: project_id.to_string(),
            identity: identity.to_string(),
            ignored: Vec::new(),
            matcher: None,
            remaining: MAX_MATCHES,
            skipped,
            errors,
            limited,
            done: false,
            cancelled: crate::ssh::CancelFlag::new().into_shared(),
            stack: Vec::new(),
            current_dir: String::new(),
            current: Vec::new(),
            buffered: Some(files),
            stream: None,
        })
    }

    pub fn identity(&self) -> &str { &self.identity }
    pub fn project_id(&self) -> &str { &self.project_id }
    /// Whether the search was stopped.
    fn is_cancelled(&self) -> bool { self.cancelled.load(Ordering::SeqCst) }

    /// Stop the search. It takes no more than a shared reference, so a search
    /// can be stopped while another thread waits for its next batch; that
    /// batch then ends at once. A search on a remote host ends its command
    /// there.
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    /// The flag that stops this search, for a caller that cannot reach the
    /// search itself while a batch is being waited for.
    pub fn cancel_flag(&self) -> crate::ssh::CancelFlag {
        crate::ssh::CancelFlag::from_shared(Arc::clone(&self.cancelled))
    }

    /// Let a search that was stopped finish its batch and drop its stream.
    fn settle(&mut self) {
        self.stream = None;
    }

    pub fn next(&mut self, language: &str) -> Result<Value, String> {
        if self.is_cancelled() {
            self.settle();
            return Ok(self.batch(true, Vec::new()));
        }
        if let Some(stream) = self.stream.as_ref() {
            // As much as one batch holds, read from the host as it comes: up
            // to a count of events or a slice of time, whichever ends first.
            let started = Instant::now();
            let mut items = Vec::new();
            for _ in 0..CONTENT_EVENTS {
                let Some(line) = stream.next_line() else {
                    if self.is_cancelled() || stream.cancelled() {
                        // A search stopped by the user answers as finished, as on the Electron build.
                        self.settle();
                        return Ok(self.batch(true, Vec::new()));
                    }
                    stream.finish()?;
                    self.settle();
                    self.done = true;
                    break;
                };
                let event: Value = match serde_json::from_str(&line) {
                    Ok(event) => event,
                    Err(_) if self.is_cancelled() || stream.cancelled() => {
                        self.settle();
                        return Ok(self.batch(true, Vec::new()));
                    }
                    Err(_) => return Err(translate(language, "正则表达式无效", &[] as &[String])),
                };
                if let Some(error) = event["error"].as_str() {
                    self.settle();
                    let message = if error == "timeout" { "正则表达式执行超时，请简化表达式" } else { "正则表达式无效" };
                    return Err(translate(language, message, &[] as &[String]));
                }
                self.skipped += event["skipped"].as_u64().unwrap_or(0);
                self.errors += event["errors"].as_u64().unwrap_or(0);
                self.limited |= event["limited"].as_bool().unwrap_or(false);
                if event.get("file").is_some_and(|file| file.is_object()) {
                    items.push(event["file"].clone());
                }
                if started.elapsed() >= CONTENT_BUDGET { break }
            }
            return Ok(self.batch(self.done, items));
        }
        if self.buffered.is_some() {
            let started = Instant::now();
            let mut items = Vec::new();
            while items.len() < CONTENT_EVENTS && started.elapsed() < CONTENT_BUDGET {
                let Some(file) = self.buffered.as_mut().and_then(|files| files.pop_front()) else {
                    self.done = true;
                    break;
                };
                items.push(file);
            }
            return Ok(self.batch(self.done, items));
        }
        let started = Instant::now();
        let mut items = Vec::new();
        for _ in 0..CONTENT_EVENTS {
            if self.done || self.is_cancelled() || started.elapsed() >= CONTENT_BUDGET { break }
            if let Some(file) = self.step(language)? { items.push(file); }
        }
        if self.is_cancelled() {
            return Ok(self.batch(true, Vec::new()));
        }
        Ok(self.batch(self.done, items))
    }

    fn batch(&self, done: bool, items: Vec<Value>) -> Value {
        json!({ "items": items, "done": done, "limited": self.limited, "skipped": self.skipped, "errors": self.errors })
    }

    fn step(&mut self, language: &str) -> Result<Option<Value>, String> {
        if self.current.is_empty() {
            let Some(relative) = self.stack.pop() else {
                self.done = true;
                return Ok(None);
            };
            match list_directory(&self.root, &relative, language) {
                Ok(entries) => {
                    self.current_dir = relative;
                    self.current = entries;
                    Ok(None)
                }
                Err(error) if relative.is_empty() => Err(error),
                Err(_) => {
                    self.errors += 1;
                    Ok(None)
                }
            }
        } else {
            let entry = self.current.remove(0);
            let relative = if self.current_dir.is_empty() { entry.name.clone() } else { format!("{}/{}", self.current_dir, entry.name) };
            if entry.directory {
                if !entry.name.starts_with('.') && !self.ignored.iter().any(|rule| rule == &entry.name) {
                    self.stack.push(relative);
                }
                return Ok(None);
            }
            if !entry.file { return Ok(None) }
            self.scan_file(&relative, language)
        }
    }

    fn scan_file(&mut self, relative: &str, language: &str) -> Result<Option<Value>, String> {
        let started = Instant::now();
        let bytes = match read_search_file(&self.root, relative, language) {
            Ok(Some(bytes)) => bytes,
            Ok(None) => {
                self.skipped += 1;
                return Ok(None);
            }
            Err(_) => {
                self.errors += 1;
                return Ok(None);
            }
        };
        if started.elapsed() >= REGEX_BUDGET {
            return Err(translate(language, "正则表达式执行超时，请简化表达式", &[] as &[String]));
        }
        let text = match String::from_utf8(bytes) {
            Ok(text) => text,
            Err(_) => {
                self.skipped += 1;
                return Ok(None);
            }
        };
        let matcher = self.matcher.as_mut().ok_or_else(|| translate(language, "内容搜索进程无法启动", &[] as &[String]))?;
        let matches = matcher.scan(&text, self.remaining, language)?;
        self.remaining = self.remaining.saturating_sub(matches.len());
        let file = if matches.is_empty() { None } else { Some(json!({ "path": relative, "matches": matches })) };
        if self.remaining == 0 {
            self.limited = true;
            self.done = true;
            self.stack.clear();
            self.current.clear();
        }
        Ok(file)
    }
}

impl TreeSearch {
    pub fn start(root: &Path, project_id: &str, identity: &str, query: &str, ignored: &[String], language: &str) -> Result<Self, String> {
        let query = query.trim();
        if query.is_empty() || query.len() > 500 {
            return Err(translate(language, "搜索参数无效", &[] as &[String]));
        }
        Ok(Self {
            root: root.to_path_buf(),
            project_id: project_id.to_string(),
            identity: identity.to_string(),
            query: query.to_lowercase(),
            ignored: ignored.to_vec(),
            pending: vec![String::new()],
            cancelled: false,
            ready: None,
        })
    }

    pub fn from_matches(project_id: &str, identity: &str, items: Vec<Value>) -> Self {
        Self {
            root: PathBuf::new(),
            project_id: project_id.to_string(),
            identity: identity.to_string(),
            query: String::new(),
            ignored: Vec::new(),
            pending: Vec::new(),
            cancelled: false,
            ready: Some(items),
        }
    }

    pub fn identity(&self) -> &str { &self.identity }
    pub fn project_id(&self) -> &str { &self.project_id }
    pub fn cancel(&mut self) { self.cancelled = true; }

    pub fn next(&mut self, language: &str) -> Result<Value, String> {
        if self.cancelled {
            return Ok(json!({ "items": [], "done": true }));
        }
        if let Some(items) = self.ready.take() {
            return Ok(json!({ "items": items, "done": true }));
        }
        let mut items = Vec::new();
        for _ in 0..TREE_DIRECTORIES {
            if self.pending.is_empty() || self.cancelled { break }
            let relative = self.pending.remove(0);
            let nodes = files::list_tree(&self.root, &relative, &self.ignored, language)?;
            let Some(nodes) = nodes.as_array() else { continue };
            for node in nodes {
                if self.cancelled { break }
                let name = node["name"].as_str().unwrap_or("");
                let path = node["path"].as_str().unwrap_or("");
                if node["dir"] == true {
                    if !name.starts_with('.') { self.pending.push(path.to_string()); }
                } else if path.to_lowercase().contains(&self.query) {
                    items.push(node.clone());
                }
            }
        }
        let done = self.cancelled || self.pending.is_empty();
        Ok(json!({ "items": if self.cancelled { Vec::<Value>::new() } else { items }, "done": done }))
    }
}

pub const LINUX_CONTENT_SEARCH: &str = r#"import os, sys, json, re, stat, signal
c = json.load(sys.stdin)
root = os.path.realpath(c['root'])
source = c['query'] if c.get('regex') else re.escape(c['query'])
if c.get('whole'): source = r'(?<!\w)(?:' + source + r')(?!\w)'
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
            if len(raw) > 2000000 or b'\0' in raw:
                emit({'skipped': 1}); continue
            try: text = raw.decode('utf-8')
            except UnicodeDecodeError:
                emit({'skipped': 1}); continue
            matches = []
            if c.get('regex'): signal.setitimer(signal.ITIMER_REAL, 0.5)
            for number, line in enumerate(text.split('\n'), 1):
                if line.endswith('\r'): line = line[:-1]
                for m in pattern.finditer(line):
                    matches.append({'line': number, 'column': len(line[:m.start()].encode('utf-16-le')) // 2 + 1,
                        'before': line[max(0, m.start()-80):m.start()], 'match': m.group(), 'after': line[m.end():m.end()+160].rstrip('\r')})
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
"#;

pub const LINUX_TREE_SEARCH: &str = r#"import os, json, sys
c = json.load(sys.stdin)
root = os.path.realpath(c['root'])
query = c['query'].lower()
ignored = set(c['ignored'])
items = []
def walk(directory, relative):
    try:
        entries = sorted(os.scandir(directory), key=lambda e: e.name)
    except OSError:
        if not relative: raise
        return
    for entry in entries:
        if entry.is_symlink(): continue
        rel = relative + '/' + entry.name if relative else entry.name
        if entry.is_dir(follow_symlinks=False):
            if not entry.name.startswith('.') and entry.name not in ignored:
                walk(entry.path, rel)
            continue
        if entry.is_file(follow_symlinks=False) and query in rel.lower():
            items.append({'name': entry.name, 'path': rel, 'dir': False})
walk(root, '')
print(json.dumps(items), flush=True)
"#;

pub fn remote_content_shell() -> String {
    format!("python3 -u -c {}", crate::ssh::bash_quote(LINUX_CONTENT_SEARCH))
}

/// Windows content search. The query arrives on stdin. The script text does not contain it.
pub fn windows_content_script() -> &'static str {
    r#"$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$c=[Console]::In.ReadToEnd() | ConvertFrom-Json
$root=(Resolve-Path -LiteralPath $c.root).Path.TrimEnd('\')
$options=[Text.RegularExpressions.RegexOptions]::CultureInvariant
if (-not $c.sensitive) { $options=$options -bor [Text.RegularExpressions.RegexOptions]::IgnoreCase }
$source=if ($c.regex) { $c.query } else { [regex]::Escape($c.query) }
if ($c.whole) { $source='(?<![\p{L}\p{N}_])(?:'+$source+')(?![\p{L}\p{N}_])' }
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
if ($script:remaining -le 0) { Emit @{limited=$true} }"#
}

pub fn valid_search_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 100 && id.chars().all(|char| char.is_ascii_alphanumeric() || char == '_' || char == '-')
}

fn validate_content_query(query: &str, language: &str) -> Result<(), String> {
    if query.trim().is_empty() || query.len() > 500 || query.chars().any(|char| char == '\r' || char == '\n' || char == '\0') {
        return Err(translate(language, "搜索参数无效", &[] as &[String]));
    }
    Ok(())
}

fn escape_regex(query: &str) -> String {
    let mut escaped = String::new();
    for char in query.chars() {
        if ".*+?^${}()|[]\\".contains(char) { escaped.push('\\'); }
        escaped.push(char);
    }
    escaped
}

fn list_directory(root: &Path, relative: &str, language: &str) -> Result<Vec<DirEntry>, String> {
    let (full, _) = files::local_existing(root, relative, language)?;
    let mut entries = Vec::new();
    for entry in fs::read_dir(&full).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        if file_type.is_symlink() { continue }
        entries.push(DirEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            directory: file_type.is_dir(),
            file: file_type.is_file(),
        });
    }
    entries.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(entries)
}

fn read_search_file(root: &Path, relative: &str, language: &str) -> Result<Option<Vec<u8>>, String> {
    let (full, _) = files::local_existing(root, relative, language)?;
    let file = crate::sys::open_read_nofollow(&full).map_err(|error| error.to_string())?;
    let meta = file.metadata().map_err(|error| error.to_string())?;
    if !meta.is_file() { return Ok(None) }
    if meta.len() > MAX_BYTES { return Ok(None) }
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1).read_to_end(&mut bytes).map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_BYTES || bytes.contains(&0) || std::str::from_utf8(&bytes).is_err() {
        return Ok(None);
    }
    Ok(Some(bytes))
}

/// A content pattern of the JavaScript kind: the source with the `i` and `u`
/// flags and the whole-word frame the search adds around it, compiled once
/// for a search.
struct JsMatcher {
    pattern: Arc<fancy_regex::Regex>,
    /// Whether the source is text to find as written rather than a pattern.
    literal: bool,
    /// The thread that runs a pattern a user wrote, one for a whole search,
    /// as the Electron build keeps one worker for it. Text that is not a
    /// pattern is matched on the calling thread, as it is there.
    scanner: Option<Scanner>,
}

/// One scanning thread, and the way its search says it is over.
struct Scanner {
    requests: mpsc::Sender<(String, usize)>,
    replies: mpsc::Receiver<Result<Vec<Value>, ()>>,
}

impl Scanner {
    fn start(pattern: Arc<fancy_regex::Regex>) -> Self {
        let (requests, asked) = mpsc::channel::<(String, usize)>();
        let (replies, answered) = mpsc::channel::<Result<Vec<Value>, ()>>();
        std::thread::spawn(move || {
            // The thread ends when the search is dropped, which closes the
            // channel it is asked on, or when nobody is left to answer to.
            while let Ok((text, remaining)) = asked.recv() {
                if replies.send(scan_lines(&pattern, &text, remaining)).is_err() { break }
            }
        });
        Self { requests, replies: answered }
    }

    /// Ask for a scan of one file and wait for its matches, for at most the
    /// budget. `None` when the scan did not answer in time.
    fn scan(&self, text: &str, remaining: usize) -> Option<Result<Vec<Value>, ()>> {
        self.requests.send((text.to_string(), remaining)).ok()?;
        self.replies.recv_timeout(REGEX_BUDGET).ok()
    }
}

impl JsMatcher {
    fn start(query: &str, sensitive: bool, regex: bool, whole: bool, language: &str) -> Result<Self, String> {
        // Text that is not a pattern is the text with every special character
        // escaped, so there is nothing in it that can backtrack.
        let source = if regex { query.to_string() } else { escape_regex(query) };
        let framed = if whole { format!(r"(?<![\p{{L}}\p{{N}}_])(?:{source})(?![\p{{L}}\p{{N}}_])") } else { source };
        // Only the case-insensitive flag has a group form; an empty `(?u)` is not a pattern.
        let ignoring_case = if sensitive { "" } else { "(?i)" };
        // Compiling is where a pattern with a syntax error is refused.
        let pattern = fancy_regex::Regex::new(&format!("{ignoring_case}{framed}")).map_err(|_| translate(language, "正则表达式无效", &[] as &[String]))?;
        Ok(Self { pattern: Arc::new(pattern), literal: !regex, scanner: None })
    }

    fn scan(&mut self, text: &str, remaining: usize, language: &str) -> Result<Vec<Value>, String> {
        // The engine gives up on a pattern that backtracks past its limit.
        // That is a pattern too costly to run, not a file without matches.
        let too_costly = || translate(language, "正则表达式执行超时，请简化表达式", &[] as &[String]);
        if self.literal { return scan_lines(&self.pattern, text, remaining).map_err(|_| too_costly()) }
        let scanner = self.scanner.get_or_insert_with(|| Scanner::start(Arc::clone(&self.pattern)));
        match scanner.scan(text, remaining) {
            Some(Ok(matches)) => Ok(matches),
            // A scan that ran past its budget is given up on, and its thread
            // with it: the thread is not left running what nobody waits for.
            // The next file starts a thread of its own.
            Some(Err(())) | None => {
                self.scanner = None;
                Err(too_costly())
            }
        }
    }
}

/// Non-overlapping matches per line, with the context the results list shows.
/// Offsets, columns and context are counted in UTF-16 units, the way the
/// renderer measures string positions. `Err` means the engine stopped at its
/// backtracking limit, so the answer would have been incomplete.
fn scan_lines(pattern: &fancy_regex::Regex, text: &str, remaining: usize) -> Result<Vec<Value>, ()> {
    let mut matches = Vec::new();
    let mut left = remaining;
    for (number, original) in text.split('\n').enumerate() {
        let line = original.strip_suffix('\r').unwrap_or(original);
        let units: Vec<u16> = line.encode_utf16().collect();
        let unit_of = |byte: usize| line[..byte].encode_utf16().count();
        for found in pattern.find_iter(line) {
            let found = found.map_err(|_| ())?;
            let index = unit_of(found.start());
            let end = unit_of(found.end());
            let matched = String::from_utf16_lossy(&units[index..end]);
            let before = String::from_utf16_lossy(&units[index.saturating_sub(80)..index]);
            let after = String::from_utf16_lossy(&units[end..(end + 160).min(units.len())]).replace('\r', "");
            matches.push(json!({ "line": number + 1, "column": index + 1, "before": before, "match": matched, "after": after }));
            left -= 1;
            if left == 0 { return Ok(matches) }
        }
    }
    Ok(matches)
}
