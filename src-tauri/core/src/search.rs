//! File-name and content search. Local scans follow `src/main/content-search.ts`.
//! Remote scans run the same Linux worker as `content-search-scripts.ts`.

use crate::files;
use crate::i18n::translate;
use serde_json::{json, Value};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
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
    cancelled: bool,
    stack: Vec<String>,
    current_dir: String,
    current: Vec<DirEntry>,
    buffered: Option<VecDeque<Value>>,
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
            cancelled: false,
            stack: vec![String::new()],
            current_dir: String::new(),
            current: Vec::new(),
            buffered: None,
        })
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
            cancelled: false,
            stack: Vec::new(),
            current_dir: String::new(),
            current: Vec::new(),
            buffered: Some(files),
        })
    }

    pub fn identity(&self) -> &str { &self.identity }
    pub fn project_id(&self) -> &str { &self.project_id }
    pub fn cancel(&mut self) { self.cancelled = true; }

    pub fn next(&mut self, language: &str) -> Result<Value, String> {
        if self.cancelled {
            return Ok(self.batch(true, Vec::new()));
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
            if self.done || self.cancelled || started.elapsed() >= CONTENT_BUDGET { break }
            if let Some(file) = self.step(language)? { items.push(file); }
        }
        if self.cancelled {
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
$script:remaining=2000
function Emit($value) { [Console]::WriteLine(($value | ConvertTo-Json -Depth 8 -Compress)) }
function Scan($directory,$relative) {
    try { $entries=@(Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop | Sort-Object Name) }
    catch { if (-not $relative) { throw }; Emit @{errors=1}; return }
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
            foreach ($part in $rel.Split('/')) { $walk=Join-Path $walk $part }
            if ((Get-Item -LiteralPath $walk -Force).Length -gt 2000000) { Emit @{skipped=1}; continue }
            $raw=[IO.File]::ReadAllBytes($walk)
            $text=[Text.Encoding]::UTF8.GetString($raw)
            $matches=@()
            $number=0
            foreach ($line in $text.Split("`n")) {
                $number++
                $item=$line.TrimEnd("`r")
                foreach ($m in $pattern.Matches($item)) {
                    $matches += @{ line=$number; column=$m.Index+1; before=$item.Substring([Math]::Max(0,$m.Index-80), [Math]::Min($m.Index,80)); match=$m.Value; after=$item.Substring($m.Index+$m.Length, [Math]::Min(160, $item.Length-($m.Index+$m.Length))) }
                    $script:remaining--
                    if ($script:remaining -le 0) { break }
                }
                if ($script:remaining -le 0) { break }
            }
            if ($matches.Count) { Emit @{ file=@{ path=$rel; matches=$matches } } }
        } catch [System.Text.RegularExpressions.RegexMatchTimeoutException] { Emit @{error='timeout'}; return }
        catch { Emit @{errors=1} }
    }
}
Scan $root ''
if ($script:remaining -le 0) { Emit @{limited=$true} }
"#
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
    let file = File::options().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK).open(&full).map_err(|error| error.to_string())?;
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

struct JsMatcher {
    child: Child,
    stdin: ChildStdin,
    lines: Receiver<String>,
    source: String,
    flags: String,
    whole: bool,
}

impl Drop for JsMatcher {
    fn drop(&mut self) { self.kill(); }
}

impl JsMatcher {
    fn start(query: &str, sensitive: bool, regex: bool, whole: bool, language: &str) -> Result<Self, String> {
        let source = if regex { query.to_string() } else { escape_regex(query) };
        let flags = if sensitive { "gu" } else { "giu" };
        let script = std::env::temp_dir().join("pello-content-search-worker.js");
        fs::write(&script, WORKER_JS).map_err(|error| error.to_string())?;
        let node = std::env::var("AWB_NODE_BIN").unwrap_or_else(|_| "node".into());
        let mut command = Command::new(node);
        command.arg(&script);
        command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        #[cfg(unix)]
        { use std::os::unix::process::CommandExt; command.process_group(0); }
        let mut child = command.spawn().map_err(|_| translate(language, "内容搜索进程无法启动", &[] as &[String]))?;
        let stdin = child.stdin.take().ok_or_else(|| translate(language, "内容搜索进程无法启动", &[] as &[String]))?;
        let stdout = child.stdout.take().ok_or_else(|| translate(language, "内容搜索进程无法启动", &[] as &[String]))?;
        let (tx, lines) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                match line {
                    Ok(line) => { if tx.send(line).is_err() { break; } }
                    Err(_) => break,
                }
            }
        });
        let mut matcher = Self { child, stdin, lines, source, flags: flags.into(), whole };
        let payload = json!({ "op": "validate", "source": matcher.source.clone(), "flags": matcher.flags.clone(), "whole": matcher.whole });
        let response = matcher.roundtrip(&payload, Duration::from_secs(3), language)?;
        if response["error"] == "syntax" {
            return Err(translate(language, "正则表达式无效", &[] as &[String]));
        }
        if response["ok"] != true {
            return Err(translate(language, "内容搜索进程无法启动", &[] as &[String]));
        }
        Ok(matcher)
    }

    fn scan(&mut self, text: &str, remaining: usize, language: &str) -> Result<Vec<Value>, String> {
        let payload = json!({
            "op": "scan",
            "source": self.source.clone(),
            "flags": self.flags.clone(),
            "whole": self.whole,
            "text": text,
            "remaining": remaining,
        });
        let response = self.roundtrip(&payload, REGEX_BUDGET, language)?;
        if response["error"] == "syntax" {
            return Err(translate(language, "正则表达式无效", &[] as &[String]));
        }
        Ok(response["matches"].as_array().cloned().unwrap_or_default())
    }

    fn roundtrip(&mut self, payload: &Value, timeout: Duration, language: &str) -> Result<Value, String> {
        let line = serde_json::to_string(payload).map_err(|error| error.to_string())?;
        writeln!(self.stdin, "{line}").map_err(|_| translate(language, "内容搜索进程无法启动", &[] as &[String]))?;
        self.stdin.flush().map_err(|_| translate(language, "内容搜索进程无法启动", &[] as &[String]))?;
        match self.lines.recv_timeout(timeout) {
            Ok(line) => serde_json::from_str(&line).map_err(|_| translate(language, "正则表达式无效", &[] as &[String])),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                self.kill();
                Err(translate(language, "正则表达式执行超时，请简化表达式", &[] as &[String]))
            }
            Err(_) => Err(translate(language, "内容搜索进程无法启动", &[] as &[String])),
        }
    }

    fn kill(&mut self) {
        #[cfg(unix)]
        unsafe { libc::kill(-(self.child.id() as i32), libc::SIGKILL); }
        let _ = self.child.kill();
    }
}

const WORKER_JS: &str = r#"
const fs = require('fs');
if (process.env.AWB_SEARCH_ARGV) fs.writeFileSync(process.env.AWB_SEARCH_ARGV, JSON.stringify(process.argv));
function compile(source, flags, whole) {
  try { new RegExp(source, flags); }
  catch (error) { return { error: 'syntax' }; }
  const wrapped = whole ? '(?<![\\p{L}\\p{N}_])(?:' + source + ')(?![\\p{L}\\p{N}_])' : source;
  try { return { pattern: new RegExp(wrapped, flags) }; }
  catch (error) { return { error: 'syntax' }; }
}
function scan(text, pattern, remaining) {
  const matches = [];
  let number = 0;
  for (const originalLine of String(text).split('\n')) {
    const line = originalLine.replace(/\r$/, '');
    number++;
    for (const match of line.matchAll(pattern)) {
      const index = match.index || 0;
      const end = index + match[0].length;
      matches.push({ line: number, column: index + 1, before: line.slice(Math.max(0, index - 80), index), match: match[0], after: line.slice(end, end + 160).replace(/\r$/, '') });
      if (--remaining <= 0) break;
    }
    if (remaining <= 0) break;
  }
  return matches;
}
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); }
    catch (error) { process.stdout.write(JSON.stringify({ error: 'syntax' }) + '\n'); continue; }
    const compiled = compile(msg.source, msg.flags, !!msg.whole);
    if (compiled.error) { process.stdout.write(JSON.stringify({ error: 'syntax' }) + '\n'); continue; }
    if (msg.op === 'validate') { process.stdout.write(JSON.stringify({ ok: true }) + '\n'); continue; }
    process.stdout.write(JSON.stringify({ matches: scan(msg.text, compiled.pattern, msg.remaining | 0) }) + '\n');
  }
});
"#;
