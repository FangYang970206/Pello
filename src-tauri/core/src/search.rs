//! Local file-name and content search. Remote projects stay on the explicit
//! not-ported error. Limits and skip rules follow `src/main/content-search.ts`
//! and the tree search in `src/main/index.ts`.

use crate::files;
use crate::i18n::translate;
use fancy_regex::Regex;
use serde_json::{json, Value};
use std::fs::{self, File};
use std::io::Read;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
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
    pattern: Regex,
    remaining: usize,
    skipped: u64,
    errors: u64,
    limited: bool,
    done: bool,
    cancelled: bool,
    stack: Vec<String>,
    current_dir: String,
    current: Vec<DirEntry>,
}

pub struct TreeSearch {
    root: PathBuf,
    project_id: String,
    identity: String,
    query: String,
    ignored: Vec<String>,
    pending: Vec<String>,
    cancelled: bool,
}

impl ContentSearch {
    pub fn start(root: &Path, project_id: &str, identity: &str, query: &str, sensitive: bool, regex: bool, whole: bool, ignored: &[String], language: &str) -> Result<Self, String> {
        validate_content_query(query, language)?;
        let pattern = compile_pattern(query, sensitive, regex, whole, language)?;
        Ok(Self {
            root: root.to_path_buf(),
            project_id: project_id.to_string(),
            identity: identity.to_string(),
            ignored: ignored.to_vec(),
            pattern,
            remaining: MAX_MATCHES,
            skipped: 0,
            errors: 0,
            limited: false,
            done: false,
            cancelled: false,
            stack: vec![String::new()],
            current_dir: String::new(),
            current: Vec::new(),
        })
    }

    pub fn identity(&self) -> &str { &self.identity }
    pub fn project_id(&self) -> &str { &self.project_id }
    pub fn cancel(&mut self) { self.cancelled = true; }

    pub fn next(&mut self, language: &str) -> Result<Value, String> {
        if self.cancelled {
            return Ok(self.batch(true, Vec::new()));
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
        let matches = scan_text(&self.pattern, &text, self.remaining, started, language)?;
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
        })
    }

    pub fn identity(&self) -> &str { &self.identity }
    pub fn project_id(&self) -> &str { &self.project_id }
    pub fn cancel(&mut self) { self.cancelled = true; }

    pub fn next(&mut self, language: &str) -> Result<Value, String> {
        if self.cancelled {
            return Ok(json!({ "items": [], "done": true }));
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

pub fn valid_search_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 100 && id.chars().all(|char| char.is_ascii_alphanumeric() || char == '_' || char == '-')
}

fn validate_content_query(query: &str, language: &str) -> Result<(), String> {
    if query.trim().is_empty() || query.len() > 500 || query.chars().any(|char| char == '\r' || char == '\n' || char == '\0') {
        return Err(translate(language, "搜索参数无效", &[] as &[String]));
    }
    Ok(())
}

fn compile_pattern(query: &str, sensitive: bool, regex: bool, whole: bool, language: &str) -> Result<Regex, String> {
    let source = if regex { query.to_string() } else { escape_regex(query) };
    let flags = if sensitive { "" } else { "(?i)" };
    let invalid = translate(language, "正则表达式无效", &[] as &[String]);
    Regex::new(&format!("{flags}{source}")).map_err(|_| invalid.clone())?;
    if whole {
        Regex::new(&format!(r"{flags}(?<![\p{{L}}\p{{N}}_])(?:{source})(?![\p{{L}}\p{{N}}_])")).map_err(|_| invalid)
    } else {
        Regex::new(&format!("{flags}{source}")).map_err(|_| invalid)
    }
}

fn escape_regex(query: &str) -> String {
    let mut escaped = String::new();
    for char in query.chars() {
        if ".*+?^${}()|[]\\".contains(char) { escaped.push('\\'); }
        escaped.push(char);
    }
    escaped
}

fn scan_text(pattern: &Regex, text: &str, mut remaining: usize, started: Instant, language: &str) -> Result<Vec<Value>, String> {
    let mut matches = Vec::new();
    for (number, original) in text.split('\n').enumerate() {
        if started.elapsed() >= REGEX_BUDGET {
            return Err(translate(language, "正则表达式执行超时，请简化表达式", &[] as &[String]));
        }
        let line = original.strip_suffix('\r').unwrap_or(original);
        for found in pattern.find_iter(line) {
            let found = found.map_err(|_| translate(language, "正则表达式执行超时，请简化表达式", &[] as &[String]))?;
            let start = byte_to_utf16(line, found.start());
            let end = byte_to_utf16(line, found.end());
            matches.push(json!({
                "line": number + 1,
                "column": start + 1,
                "before": utf16_slice(line, start.saturating_sub(80), start),
                "match": found.as_str(),
                "after": utf16_slice(line, end, end + 160).trim_end_matches('\r'),
            }));
            remaining = remaining.saturating_sub(1);
            if remaining == 0 { return Ok(matches) }
        }
    }
    Ok(matches)
}

fn byte_to_utf16(text: &str, byte: usize) -> usize {
    text.get(..byte).map(|prefix| prefix.encode_utf16().count()).unwrap_or(0)
}

fn utf16_slice(text: &str, start: usize, end: usize) -> String {
    if start >= end { return String::new() }
    String::from_utf16_lossy(&text.encode_utf16().skip(start).take(end - start).collect::<Vec<_>>())
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
