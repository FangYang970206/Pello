//! Local Git status, diff and discard. Parsing follows `src/main/git.ts`.

use crate::files::{self, count_lines, diff_too_big, read_local, TREE_DEFAULT_IGNORE};
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
    if work["binary"] == true {
        return Ok(json!({ "path": rel, "st": if untracked { "A" } else { "M" }, "before": "", "after": "", "binary": true, "tooBig": false }));
    }
    let after = if work["missing"] == true { String::new() } else { work["text"].as_str().unwrap_or("").to_string() };
    let status = if work["missing"] == true && !untracked { "D" } else if untracked { "A" } else { "M" };
    if diff_too_big(&before, &after) {
        return Ok(json!({ "path": rel, "st": status, "before": "", "after": "", "binary": false, "tooBig": true }));
    }
    Ok(json!({ "path": rel, "st": status, "before": before, "after": after, "binary": false, "tooBig": false }))
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

pub fn show_error(language: &str) -> String {
    translate(language, "远程项目的该操作尚未在 Rust 移植中实现", &[] as &[String])
}
