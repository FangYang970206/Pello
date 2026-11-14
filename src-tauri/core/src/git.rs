//! Local Git status, diff and discard. Parsing follows `src/main/git.ts`.

use crate::files::{self, count_lines, diff_too_big, read_local, TREE_DEFAULT_IGNORE};
use base64::Engine;
use crate::i18n::translate;
use serde_json::{json, Value};
use std::path::Path;
use std::process::Command;

pub fn status(root: &Path, language: &str) -> Result<Value, String> {
    let root = std::fs::canonicalize(root).map_err(|error| error.to_string())?;
    let single = single_status(&root)?;
    if single["isRepo"] == true {
        return Ok(single);
    }
    let (roots, errors) = discover(&root);
    let mut files = Vec::new();
    let mut flags = serde_json::Map::new();
    let mut repositories = Vec::new();
    let mut errors = errors;
    for repo_root in roots {
        let prefix = repo_root.strip_prefix(&root).unwrap_or(&repo_root).to_string_lossy().replace('\\', "/");
        let repo = match single_status(&repo_root) {
            Ok(repo) if repo["isRepo"] == true => repo,
            _ => {
                errors.push(json!(format!("{prefix}：无法读取 Git 状态")));
                continue;
            }
        };
        let count = repo["files"].as_array().map(|files| files.len()).unwrap_or(0);
        repositories.push(json!({ "path": prefix, "branch": repo["branch"], "count": count }));
        for file in repo["files"].as_array().cloned().unwrap_or_default() {
            let rel = format!("{prefix}/{}", file["path"].as_str().unwrap_or(""));
            flags.insert(rel.clone(), json!(repo["untracked"][file["path"].as_str().unwrap_or("")].as_bool().unwrap_or(false)));
            let mut file = file;
            file["path"] = json!(rel);
            file["repository"] = json!(prefix);
            files.push(file);
        }
    }
    repositories.sort_by(|left, right| left["path"].as_str().unwrap_or("").cmp(right["path"].as_str().unwrap_or("")));
    files.sort_by(|left, right| left["path"].as_str().unwrap_or("").cmp(right["path"].as_str().unwrap_or("")));
    let _ = language;
    Ok(json!({ "isRepo": false, "branch": "", "files": files, "repositories": repositories, "errors": errors, "untracked": flags }))
}

fn single_status(root: &Path) -> Result<Value, String> {
    let status = match git(root, &["status", "--porcelain=v1", "-z", "-uall", "-b", "--", "."]) {
        Ok(status) => status,
        Err(_) => return Ok(empty_status()),
    };
    if status.trim().is_empty() && !is_repo(root) { return Ok(empty_status()) }
    let mut parsed = parse_status(&status);
    let prefix = git(root, &["rev-parse", "--show-prefix"]).unwrap_or_default();
    let prefix = prefix.trim().trim_end_matches('/');
    if !prefix.is_empty() {
        parsed.retain(|file| file.path.starts_with(prefix));
        for file in &mut parsed {
            file.path = file.path[prefix.len()..].trim_start_matches('/').to_string();
        }
    }
    let nums = git(root, &["diff", "--relative", "--numstat", "-z", "HEAD", "--", "."])
        .or_else(|_| git(root, &["diff", "--relative", "--numstat", "-z", "--", "."]))
        .map(|text| parse_numstat(&text))
        .unwrap_or_default();
    let mut files = Vec::new();
    let mut untracked = serde_json::Map::new();
    for file in parsed {
        untracked.insert(file.path.clone(), json!(file.untracked));
        let (add, del) = if let Some(stat) = nums.get(&file.path) {
            *stat
        } else if file.untracked {
            let bytes = std::fs::read(root.join(&file.path)).unwrap_or_default();
            (count_lines(&bytes), 0)
        } else {
            (0, 0)
        };
        files.push(json!({ "path": file.path, "st": file.status, "add": add, "del": del }));
    }
    let branch = parse_branch(&status);
    Ok(json!({ "isRepo": true, "branch": branch, "files": files, "untracked": untracked }))
}

fn empty_status() -> Value {
    json!({ "isRepo": false, "branch": "", "files": [], "untracked": {} })
}

fn discover(root: &Path) -> (Vec<std::path::PathBuf>, Vec<Value>) {
    let mut queue = vec![root.to_path_buf()];
    let mut roots = Vec::new();
    let mut errors = Vec::new();
    let mut index = 0;
    while index < queue.len() {
        let folder = queue[index].clone();
        index += 1;
        let entries = match std::fs::read_dir(&folder) {
            Ok(entries) => entries,
            Err(_) => {
                let rel = folder.strip_prefix(root).map(|path| path.display().to_string()).unwrap_or_else(|_| ".".into());
                errors.push(json!(format!("{rel}：无法读取")));
                continue;
            }
        };
        let mut children = Vec::new();
        let mut git = false;
        for entry in entries.flatten() {
            if entry.file_name() == ".git" { git = true; continue }
            let Ok(file_type) = entry.file_type() else { continue };
            if file_type.is_dir() && !file_type.is_symlink() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if !TREE_DEFAULT_IGNORE.contains(&name.as_str()) { children.push(entry.path()); }
            }
        }
        if git { roots.push(folder); continue }
        queue.extend(children);
    }
    (roots, errors)
}

struct ParsedFile { path: String, status: String, untracked: bool }

fn parse_branch(status: &str) -> String {
    let line = status.split(['\n', '\r', '\0']).find(|line| line.starts_with("## "));
    let Some(line) = line else { return String::new() };
    let body = &line[3..];
    if let Some(rest) = body.strip_prefix("No commits yet on ") { return rest.split("...").next().unwrap_or(rest).to_string() }
    if body.starts_with("HEAD (no branch)") { return "HEAD".into() }
    body.split("...").next().unwrap_or(body).trim().to_string()
}

fn parse_status(text: &str) -> Vec<ParsedFile> {
    let mut files = Vec::new();
    let nul = text.contains('\0');
    let entries: Vec<&str> = if nul { text.split('\0').collect() } else { text.split(['\n', '\r']).collect() };
    let mut index = 0;
    while index < entries.len() {
        let line = entries[index];
        index += 1;
        if line.is_empty() || line.starts_with("## ") || line.len() < 4 { continue }
        let xy = &line[..2];
        let mut file = line[3..].to_string();
        if nul && xy.chars().any(|char| char == 'R' || char == 'C') { index += 1 }
        if !nul {
            if let Some(arrow) = file.find(" -> ") { file = file[arrow + 4..].to_string(); }
        }
        if xy == "??" { files.push(ParsedFile { path: file, status: "A".into(), untracked: true }); }
        else if xy.contains('D') { files.push(ParsedFile { path: file, status: "D".into(), untracked: false }); }
        else if xy.contains('A') { files.push(ParsedFile { path: file, status: "A".into(), untracked: false }); }
        else { files.push(ParsedFile { path: file, status: "M".into(), untracked: false }); }
    }
    files
}

fn parse_numstat(text: &str) -> std::collections::HashMap<String, (i64, i64)> {
    let mut map = std::collections::HashMap::new();
    let nul = text.contains('\0');
    let entries: Vec<&str> = if nul { text.split('\0').collect() } else { text.split(['\n', '\r']).collect() };
    let mut index = 0;
    while index < entries.len() {
        let line = entries[index];
        index += 1;
        let mut parts = line.split('\t');
        let Some(add) = parts.next() else { continue };
        let Some(del) = parts.next() else { continue };
        let Some(mut name) = parts.next() else { continue };
        if nul && name.is_empty() {
            index += 1;
            name = entries.get(index).copied().unwrap_or("");
            index += 1;
        }
        if name.is_empty() { continue }
        let add = if add == "-" { 0 } else { add.parse().unwrap_or(0) };
        let del = if del == "-" { 0 } else { del.parse().unwrap_or(0) };
        map.insert(name.to_string(), (add, del));
    }
    map
}

fn is_repo(root: &Path) -> bool {
    git(root, &["rev-parse", "--is-inside-work-tree"]).map(|text| text.trim() == "true").unwrap_or(false)
}

fn git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git").arg("-C").arg(cwd).arg("-c").arg("core.quotepath=false").args(args).output().map_err(|error| error.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    if output.status.success() || !stdout.is_empty() { return Ok(stdout) }
    Err(String::from_utf8_lossy(&output.stderr).into_owned())
}

pub fn diff(root: &Path, rel: &str, untracked: bool, language: &str) -> Result<Value, String> {
    let rel = files::clean_relative(rel, language)?;
    let work = read_local(root, &rel, language)?;
    let before = if untracked { String::new() } else { git(root, &["show", &format!("HEAD:{rel}")]).unwrap_or_default() };
    Ok(diff_body(&rel, untracked, &work, before))
}

fn diff_body(rel: &str, untracked: bool, work: &Value, before: String) -> Value {
    if work["binary"] == true {
        return json!({ "path": rel, "st": if untracked { "A" } else { "M" }, "before": "", "after": "", "binary": true, "tooBig": false });
    }
    let after = if work["missing"] == true { String::new() } else { work["text"].as_str().unwrap_or("").to_string() };
    let status = if work["missing"] == true && !untracked { "D" } else if untracked { "A" } else { "M" };
    if diff_too_big(&before, &after) {
        return json!({ "path": rel, "st": status, "before": "", "after": "", "binary": false, "tooBig": true });
    }
    json!({ "path": rel, "st": status, "before": before, "after": after, "binary": false, "tooBig": false })
}

pub fn discard(root: &Path, rel: &str, untracked: bool, language: &str) -> Result<(), String> {
    let rel = files::clean_relative(rel, language)?;
    if untracked {
        git(root, &["clean", "-f", "--", &rel])?;
        return Ok(());
    }
    if git(root, &["restore", "--source=HEAD", "--worktree", "--staged", "--", &rel]).is_err() {
        git(root, &["checkout", "HEAD", "--", &rel])?;
    }
    Ok(())
}

fn git_remote(data: &Path, host: &Value, root: &str, args: &[&str], language: &str) -> Result<String, String> {
    let mut command = if host["platform"] == "windows" {
        format!("[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); git -C {} -c core.quotepath=false", crate::ssh::ps_quote(root))
    } else {
        format!("git -C {} -c core.quotepath=false", crate::ssh::bash_quote(root))
    };
    for arg in args {
        command.push(' ');
        command.push_str(&if host["platform"] == "windows" { crate::ssh::ps_quote(arg) } else { crate::ssh::bash_quote(arg) });
    }
    crate::ssh::run(data, host, &command, None, language)
}

/// Remote `git show` plus the worktree read. The JSON matches local `diff`.
pub fn diff_remote(data: &Path, host: &Value, root: &str, rel: &str, untracked: bool, language: &str) -> Result<Value, String> {
    let rel = files::clean_relative(rel, language)?;
    let work = read_remote(data, host, root, &rel, language)?;
    let before = if untracked { String::new() } else { git_remote(data, host, root, &["show", &format!("HEAD:{rel}")], language).unwrap_or_default() };
    Ok(diff_body(&rel, untracked, &work, before))
}

/// Electron `gitDiscard`: untracked files use `git clean -f`, tracked files use
/// `git restore --source=HEAD --worktree --staged` and fall back to `git checkout`.
/// The commit object is not rewritten.
pub fn discard_remote(data: &Path, host: &Value, root: &str, rel: &str, untracked: bool, language: &str) -> Result<(), String> {
    let rel = files::clean_relative(rel, language)?;
    if untracked {
        git_remote(data, host, root, &["clean", "-f", "--", &rel], language)?;
        return Ok(());
    }
    if git_remote(data, host, root, &["restore", "--source=HEAD", "--worktree", "--staged", "--", &rel], language).is_err() {
        git_remote(data, host, root, &["checkout", "HEAD", "--", &rel], language)?;
    }
    Ok(())
}

pub fn show_error(language: &str) -> String {
    translate(language, "远程项目的该操作尚未在 Rust 移植中实现", &[] as &[String])
}

pub fn read_remote(data: &Path, host: &Value, root: &str, rel: &str, language: &str) -> Result<Value, String> {
    let Ok(relative) = files::clean_relative(rel, language) else { return Ok(files::missing_file()) };
    if relative.is_empty() { return Ok(files::missing_file()) }
    if host["platform"] == "windows" {
        let script = crate::ssh::windows_read_script(root, &relative, language);
        return match crate::ssh::run(data, host, &script, None, language) {
            Ok(text) => {
                let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, text.trim()).unwrap_or_default();
                Ok(files::decode_file(&bytes))
            }
            Err(_) => Ok(files::missing_file()),
        };
    }
    let absolute = join_remote(root, &relative);
    let quoted = crate::ssh::bash_quote(&absolute);
    let script = format!("base64 -w 0 {quoted} 2>/dev/null || base64 {quoted}");
    match crate::ssh::run(data, host, &script, None, language) {
        Ok(text) => {
            let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, text.trim()).unwrap_or_default();
            Ok(files::decode_file(&bytes))
        }
        Err(_) => Ok(files::missing_file()),
    }
}

pub fn write_remote(data: &Path, host: &Value, root: &str, rel: &str, text: &str, version: Option<&str>, language: &str) -> Result<Value, String> {
    let relative = files::clean_relative(rel, language)?;
    if relative.is_empty() || version.is_some_and(|value| value.len() != 64 || !value.chars().all(|char| char.is_ascii_hexdigit())) {
        return Err(translate(language, "请先读取文件再保存", &[] as &[String]));
    }
    let bytes = text.as_bytes();
    if bytes.len() > 2_000_000 {
        return Err(translate(language, "文件超过 2 MB，无法在内置编辑器中保存", &[] as &[String]));
    }
    if version.is_none() {
        return create_remote_missing(data, host, root, &relative, bytes, language);
    }
    let current = read_remote(data, host, root, &relative, language)?;
    if current["missing"] == true { return Err(translate(language, "文件不存在", &[] as &[String])) }
    if current["version"] != version.unwrap_or("") { return Err(translate(language, "文件已被其他程序修改，请重新读取后合并更改", &[] as &[String])) }
    if current["binary"] == true { return Err(translate(language, "只能编辑 UTF-8 文本文件", &[] as &[String])) }
    if host["platform"] == "windows" {
        let script = crate::ssh::windows_write_script(root, &relative, language);
        let payload = base64::engine::general_purpose::STANDARD.encode(bytes);
        return match crate::ssh::run(data, host, &script, Some(payload.as_bytes()), language) {
            Ok(_) => read_remote(data, host, root, &relative, language),
            Err(_) => Err(translate(language, "文件已被其他程序修改，请重新读取后合并更改", &[] as &[String])),
        };
    }
    let absolute = join_remote(root, &relative);
    let root_q = crate::ssh::bash_quote(root);
    let file_q = crate::ssh::bash_quote(&absolute);
    let version = version.unwrap_or("");
    let script = format!(r#"set -e
root=$(cd -P -- {root_q} && pwd)
file={file_q}
[ ! -L "$file" ] || {{ echo AWB_UNSAFE_PATH >&2; exit 1; }}
parent=$(cd -P -- "$(dirname -- "$file")" && pwd)
root=${{root%/}}
case "$parent/" in "$root/"*) ;; *) echo AWB_UNSAFE_PATH >&2; exit 1;; esac
file="$parent/$(basename -- "$file")"
file_hash() {{ (sha256sum < "$file" 2>/dev/null || shasum -a 256 < "$file") | cut -d ' ' -f 1; }}
[ "$(file_hash)" = '{version}' ] || {{ echo AWB_CONFLICT >&2; exit 1; }}
temp=$(mktemp "$parent/.awb-XXXXXX")
trap 'rm -f -- "$temp"' EXIT
cp -p -- "$file" "$temp"
base64 -d > "$temp"
[ "$(file_hash)" = '{version}' ] || {{ echo AWB_CONFLICT >&2; exit 1; }}
mv -f -- "$temp" "$file"
printf saved"#);
    let payload = base64::engine::general_purpose::STANDARD.encode(bytes);
    match crate::ssh::run(data, host, &script, Some(payload.as_bytes()), language) {
        Ok(_) => read_remote(data, host, root, &relative, language),
        Err(error) if error.contains("AWB_CONFLICT") => Err(translate(language, "文件已被其他程序修改，请重新读取后合并更改", &[] as &[String])),
        Err(error) if error.contains("AWB_UNSAFE_PATH") => Err(translate(language, "无法保存项目目录外的文件或符号链接", &[] as &[String])),
        Err(error) => Err(error),
    }
}

/// Electron `createMissingFile`: Linux uses `os.link`, so a file created concurrently is left in place.
fn create_remote_missing(data: &Path, host: &Value, root: &str, relative: &str, bytes: &[u8], language: &str) -> Result<Value, String> {
    let mut parts: Vec<&str> = relative.split('/').filter(|part| !part.is_empty()).collect();
    let name = parts.pop().ok_or_else(|| translate(language, "请先读取文件再保存", &[] as &[String]))?;
    files::validate_entry_name(name, host["platform"] == "windows", language)?;
    let parent = parts.join("/");
    let payload = base64::engine::general_purpose::STANDARD.encode(bytes);
    if host["platform"] == "windows" {
        let walk = parts.iter().map(|part| format!("$walk=Join-Path $walk {}; if ((Get-Item -LiteralPath $walk -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {{ throw 'AWB_UNSAFE_PATH' }}", crate::ssh::ps_quote(part))).collect::<Vec<_>>().join("; ");
        let script = format!("$ErrorActionPreference='Stop'; $root=(Resolve-Path -LiteralPath {} -ErrorAction Stop).Path.TrimEnd('\\')+'\\'; $file=[IO.Path]::GetFullPath((Join-Path $root {})); if (-not $file.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)) {{ throw 'AWB_UNSAFE_PATH' }}; $walk=$root.TrimEnd('\\'); {walk}; $temp=Join-Path (Split-Path -LiteralPath $file) ('.awb-create-' + [guid]::NewGuid().ToString() + '.tmp'); try {{ [IO.File]::WriteAllBytes($temp, [Convert]::FromBase64String([Console]::In.ReadToEnd())); [IO.File]::Move($temp, $file) }} catch {{ if (Test-Path -LiteralPath $temp) {{ Remove-Item -LiteralPath $temp -Force }}; throw }}", crate::ssh::ps_quote(root), crate::ssh::ps_quote(&relative.replace('/', "\\")));
        crate::ssh::run(data, host, &script, Some(payload.as_bytes()), language).map_err(|error| if error.contains("AWB_UNSAFE_PATH") { translate(language, "无法保存项目目录外的文件或符号链接", &[] as &[String]) } else { error })?;
    } else {
        let script = r#"import os, sys, uuid, base64
root, relative, name = sys.argv[1:]
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC
parent = os.open(root, flags)
try:
    for part in relative.split("/") if relative else []:
        nxt = os.open(part, flags | os.O_NOFOLLOW, dir_fd=parent)
        os.close(parent)
        parent = nxt
    temp = ".awb-create-" + uuid.uuid4().hex + ".tmp"
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o666, dir_fd=parent)
    try:
        os.write(fd, base64.b64decode(sys.stdin.read()))
    finally:
        os.close(fd)
    try:
        os.link(temp, name, src_dir_fd=parent, dst_dir_fd=parent)
    finally:
        os.unlink(temp, dir_fd=parent)
finally:
    os.close(parent)
"#;
        let command = format!("python3 -c {} {} {} {}", crate::ssh::bash_quote(script), crate::ssh::bash_quote(root), crate::ssh::bash_quote(&parent), crate::ssh::bash_quote(name));
        crate::ssh::run(data, host, &command, Some(payload.as_bytes()), language)?;
    }
    let written = read_remote(data, host, root, relative, language)?;
    if written["missing"] == true { return Err(translate(language, "文件不存在", &[] as &[String])) }
    Ok(written)
}

pub fn list_remote(data: &Path, host: &Value, root: &str, rel: &str, ignored: &[String], language: &str) -> Result<Value, String> {
    let relative = files::clean_relative(rel, language)?;
    if host["platform"] == "windows" {
        let script = crate::ssh::windows_tree_script(root, &relative, language);
        let text = crate::ssh::run(data, host, &script, None, language).unwrap_or_default();
        let mut nodes = Vec::new();
        for line in text.lines().filter(|line| !line.trim().is_empty()) {
            let Ok(entry) = serde_json::from_str::<Value>(line) else { continue };
            let dir = entry["dir"].as_bool().unwrap_or(false);
            let name = entry["path"].as_str().unwrap_or(entry["name"].as_str().unwrap_or("")).to_string();
            if name.is_empty() || (dir && ignored.iter().any(|rule| rule == &name)) { continue }
            let path = if relative.is_empty() || relative == "." { name.clone() } else { format!("{relative}/{name}") };
            nodes.push(json!({ "name": name, "dir": dir, "path": path }));
        }
        return Ok(Value::Array(nodes));
    }
    let absolute = if relative.is_empty() || relative == "." { root.to_string() } else { join_remote(root, &relative) };
    let quoted = crate::ssh::bash_quote(&absolute);
    let script = format!(r#"for f in {quoted}/* {quoted}/.[!.]* {quoted}/..?*; do [ -L "$f" ] && continue; [ -e "$f" ] || continue; if [ -d "$f" ]; then printf 'd%s\0' "${{f##*/}}"; elif [ -f "$f" ]; then printf 'f%s\0' "${{f##*/}}"; fi; done"#);
    let text = crate::ssh::run(data, host, &script, None, language).unwrap_or_default();
    let mut nodes = Vec::new();
    for entry in text.split('\0').filter(|entry| !entry.is_empty()) {
        let dir = entry.starts_with('d');
        let name = entry[1..].to_string();
        if dir && ignored.iter().any(|rule| rule == &name) { continue }
        let path = if relative.is_empty() || relative == "." { name.clone() } else { format!("{relative}/{name}") };
        nodes.push(json!({ "name": name, "dir": dir, "path": path }));
    }
    nodes.sort_by(|left, right| {
        let left_dir = left["dir"].as_bool().unwrap_or(false);
        let right_dir = right["dir"].as_bool().unwrap_or(false);
        right_dir.cmp(&left_dir).then_with(|| left["name"].as_str().unwrap_or("").cmp(right["name"].as_str().unwrap_or("")))
    });
    Ok(Value::Array(nodes))
}

pub fn status_remote(data: &Path, host: &Value, root: &str, language: &str) -> Result<Value, String> {
    let quoted = crate::ssh::bash_quote(root);
    let status = crate::ssh::run(data, host, &format!("git -C {quoted} -c core.quotepath=false status --porcelain=v1 -z -uall -b -- ."), None, language).unwrap_or_default();
    if status.trim().is_empty() {
        let inside = crate::ssh::run(data, host, &format!("git -C {quoted} rev-parse --is-inside-work-tree"), None, language).unwrap_or_default();
        if inside.trim() != "true" { return Ok(empty_status()) }
    }
    let parsed = parse_status(&status);
    let nums = crate::ssh::run(data, host, &format!("git -C {quoted} -c core.quotepath=false diff --relative --numstat -z HEAD -- ."), None, language)
        .or_else(|_| crate::ssh::run(data, host, &format!("git -C {quoted} -c core.quotepath=false diff --relative --numstat -z -- ."), None, language))
        .map(|text| parse_numstat(&text))
        .unwrap_or_default();
    let mut files = Vec::new();
    let mut untracked = serde_json::Map::new();
    for file in parsed {
        untracked.insert(file.path.clone(), json!(file.untracked));
        let (add, del) = nums.get(&file.path).copied().unwrap_or((0, 0));
        files.push(json!({ "path": file.path, "st": file.status, "add": add, "del": del }));
    }
    let _ = language;
    Ok(json!({ "isRepo": true, "branch": parse_branch(&status), "files": files, "untracked": untracked }))
}

fn join_remote(root: &str, relative: &str) -> String {
    format!("{}/{}", root.trim_end_matches('/'), relative)
}
