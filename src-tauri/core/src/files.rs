//! Local project files. Boundary checks follow `src/main/git.ts` for the local host.

use crate::i18n::translate;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const TREE_DEFAULT_IGNORE: &[&str] = &[".git", "node_modules", "dist", "out", ".next", "__pycache__", ".cache"];
const MAX_DIFF: usize = 250_000;

pub fn default_ignore() -> Vec<String> {
    TREE_DEFAULT_IGNORE.iter().map(|name| (*name).to_string()).collect()
}

pub fn clean_relative(rel: &str, language: &str) -> Result<String, String> {
    if rel.contains('\0') || rel.split(['\\', '/']).any(|part| part == "..") || looks_absolute(rel) {
        return Err(translate(language, "非法文件路径", &[] as &[String]));
    }
    Ok(rel.replace('\\', "/").split('/').filter(|part| !part.is_empty() && *part != ".").collect::<Vec<_>>().join("/"))
}

fn looks_absolute(rel: &str) -> bool {
    let bytes = rel.as_bytes();
    if bytes.first() == Some(&b'/') || bytes.first() == Some(&b'\\') { return true }
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

pub fn validate_entry_name(name: &str, windows: bool, language: &str) -> Result<(), String> {
    if name.is_empty() || name == "." || name == ".." || name.chars().any(|char| char == '\0' || char == '/' || char == '\\') {
        return Err(translate(language, "名称无效", &[] as &[String]));
    }
    if windows {
        let reserved = name.split('.').next().unwrap_or(name);
        let bad = name.chars().any(|char| "<>:\"|?*".contains(char) || (char as u32) < 32)
            || name.ends_with('.')
            || name.ends_with(' ')
            || matches!(reserved.to_ascii_lowercase().as_str(), "con" | "prn" | "aux" | "nul" | "com1" | "com2" | "com3" | "com4" | "com5" | "com6" | "com7" | "com8" | "com9" | "lpt1" | "lpt2" | "lpt3" | "lpt4" | "lpt5" | "lpt6" | "lpt7" | "lpt8" | "lpt9");
        if bad { return Err(translate(language, "Windows 名称无效", &[] as &[String])); }
    }
    Ok(())
}

fn canonical_dir(path: &Path) -> Result<PathBuf, String> {
    fs::canonicalize(path).map_err(|error| error.to_string())
}

fn inside(root: &Path, path: &Path) -> bool {
    path.starts_with(root)
}

pub fn local_existing(root: &Path, rel: &str, language: &str) -> Result<(PathBuf, String), String> {
    let root = canonical_dir(root)?;
    let relative = clean_relative(rel, language)?;
    let full = if relative.is_empty() { root.clone() } else { canonical_dir(&root.join(&relative))? };
    if !inside(&root, &full) {
        return Err(translate(language, "路径超出项目目录", &[] as &[String]));
    }
    Ok((full, if relative.is_empty() { ".".into() } else { relative }))
}

fn version_of(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8000).any(|byte| *byte == 0)
}

fn decode_file(bytes: &[u8]) -> Value {
    let binary = looks_binary(bytes) || std::str::from_utf8(bytes).is_err();
    json!({
        "text": if binary { String::new() } else { String::from_utf8_lossy(bytes).into_owned() },
        "binary": binary,
        "missing": false,
        "version": version_of(bytes),
        "tooBig": bytes.len() > 2_000_000
    })
}

fn missing_file() -> Value {
    json!({ "text": "", "binary": false, "missing": true, "version": Value::Null })
}

pub fn read_local(root: &Path, rel: &str, language: &str) -> Result<Value, String> {
    let Ok(relative) = clean_relative(rel, language) else { return Ok(missing_file()) };
    if relative.is_empty() { return Ok(missing_file()) }
    match local_existing(root, &relative, language) {
        Ok((full, _)) => Ok(fs::read(&full).map(|bytes| decode_file(&bytes)).unwrap_or_else(|_| missing_file())),
        Err(_) => Ok(missing_file()),
    }
}

pub fn write_local(root: &Path, rel: &str, text: &str, version: Option<&str>, language: &str) -> Result<Value, String> {
    let relative = clean_relative(rel, language)?;
    if relative.is_empty() || version.is_some_and(|value| !is_version(value)) {
        return Err(translate(language, "请先读取文件再保存", &[] as &[String]));
    }
    let bytes = text.as_bytes();
    if bytes.len() > 2_000_000 {
        return Err(translate(language, "文件超过 2 MB，无法在内置编辑器中保存", &[] as &[String]));
    }
    if version.is_none() {
        return create_missing(root, &relative, bytes, language);
    }
    let version = version.unwrap();
    let (full, _) = local_existing(root, &relative, language)?;
    let current = fs::read(&full).map_err(|error| error.to_string())?;
    if version_of(&current) != version {
        return Err(translate(language, "文件已被其他程序修改，请重新读取后合并更改", &[] as &[String]));
    }
    if looks_binary(&current) || std::str::from_utf8(&current).is_err() {
        return Err(translate(language, "只能编辑 UTF-8 文本文件", &[] as &[String]));
    }
    let mode = fs::metadata(&full).map(|meta| meta.permissions()).ok();
    let temporary = full.with_file_name(format!(".{}.awb-{}.tmp", full.file_name().and_then(|name| name.to_str()).unwrap_or("file"), crate::random_id()));
    let write_result = (|| -> Result<(), String> {
        {
            let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&temporary).map_err(|error| error.to_string())?;
            if let Some(mode) = mode.as_ref() {
                let _ = file.set_permissions(mode.clone());
            }
            file.write_all(bytes).map_err(|error| error.to_string())?;
        }
        let again = fs::read(&full).map_err(|error| error.to_string())?;
        if version_of(&again) != version {
            return Err(translate(language, "文件已被其他程序修改，请重新读取后合并更改", &[] as &[String]));
        }
        fs::rename(&temporary, &full).map_err(|error| error.to_string())?;
        Ok(())
    })();
    if temporary.exists() { let _ = fs::remove_file(&temporary); }
    write_result?;
    read_local(root, &relative, language)
}

fn is_version(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn create_missing(root: &Path, rel: &str, bytes: &[u8], language: &str) -> Result<Value, String> {
    let mut parts: Vec<&str> = rel.split('/').filter(|part| !part.is_empty()).collect();
    let name = parts.pop().unwrap_or("");
    validate_entry_name(name, false, language)?;
    let parent_rel = parts.join("/");
    let (parent, _) = local_existing(root, &parent_rel, language)?;
    if !parent.is_dir() {
        return Err(translate(language, "目标不是目录", &[] as &[String]));
    }
    let destination = parent.join(name);
    let temporary = parent.join(format!(".awb-{}.tmp", crate::random_id()));
    let publish = (|| -> Result<(), String> {
        fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
        fs::hard_link(&temporary, &destination).map_err(|error| error.to_string())?;
        Ok(())
    })();
    if temporary.exists() { let _ = fs::remove_file(&temporary); }
    publish?;
    read_local(root, rel, language)
}

pub fn list_tree(root: &Path, rel: &str, ignored: &[String], language: &str) -> Result<Value, String> {
    let (full, relative) = local_existing(root, rel, language)?;
    let mut nodes = Vec::new();
    for entry in fs::read_dir(&full).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        if file_type.is_symlink() { continue }
        let dir = file_type.is_dir();
        if !dir && !file_type.is_file() { continue }
        let name = entry.file_name().to_string_lossy().into_owned();
        if dir && ignored.iter().any(|rule| rule == &name) { continue }
        let path = if relative == "." { name.clone() } else { format!("{relative}/{name}") };
        nodes.push(json!({ "name": name, "path": path, "dir": dir }));
    }
    nodes.sort_by(|left, right| {
        let left_dir = left["dir"].as_bool().unwrap_or(false);
        let right_dir = right["dir"].as_bool().unwrap_or(false);
        right_dir.cmp(&left_dir).then_with(|| left["name"].as_str().unwrap_or("").cmp(right["name"].as_str().unwrap_or("")))
    });
    Ok(Value::Array(nodes))
}

pub fn create_entry(root: &Path, parent: &str, name: &str, directory: bool, language: &str) -> Result<String, String> {
    let parent = clean_relative(parent, language)?;
    validate_entry_name(name, false, language)?;
    let relative = if parent.is_empty() { name.to_string() } else { format!("{parent}/{name}") };
    let (base, _) = local_existing(root, &parent, language)?;
    if !base.is_dir() {
        return Err(translate(language, "目标不是目录", &[] as &[String]));
    }
    let destination = base.join(name);
    if directory {
        fs::create_dir(&destination).map_err(|error| error.to_string())?;
    } else {
        fs::OpenOptions::new().write(true).create_new(true).open(&destination).map_err(|error| error.to_string())?;
    }
    Ok(relative)
}

pub fn rename_entry(root: &Path, rel: &str, name: &str, directory: bool, language: &str) -> Result<String, String> {
    let clean = clean_relative(rel, language)?;
    let parent = clean.rsplit_once('/').map(|(parent, _)| parent.to_string()).unwrap_or_default();
    relocate(root, &clean, &parent, name, directory, language)
}

pub fn move_entry(root: &Path, rel: &str, parent: &str, directory: bool, language: &str) -> Result<String, String> {
    let clean = clean_relative(rel, language)?;
    let name = clean.rsplit_once('/').map(|(_, name)| name).unwrap_or(clean.as_str());
    relocate(root, &clean, parent, name, directory, language)
}

fn relocate(root: &Path, rel: &str, parent: &str, name: &str, directory: bool, language: &str) -> Result<String, String> {
    let rel = clean_relative(rel, language)?;
    if rel.is_empty() { return Err(translate(language, "不能重命名项目根目录", &[] as &[String])); }
    let parent = clean_relative(parent, language)?;
    validate_entry_name(name, false, language)?;
    let next = if parent.is_empty() { name.to_string() } else { format!("{parent}/{name}") };
    if directory && (parent == rel || parent.starts_with(&format!("{rel}/"))) {
        return Err(translate(language, "不能移入自身或子目录", &[] as &[String]));
    }
    if rel == next { return Ok(rel) }
    rename_nofollow(root, &rel, &parent, name, directory, language)?;
    Ok(next)
}

fn rename_nofollow(root: &Path, rel: &str, parent: &str, name: &str, directory: bool, language: &str) -> Result<(), String> {
    let root = canonical_dir(root)?;
    let source_parts: Vec<&str> = rel.split('/').filter(|part| !part.is_empty()).collect();
    let source_name = source_parts.last().copied().unwrap_or("");
    let source_parent_parts = &source_parts[..source_parts.len() - 1];
    let source_parent = open_chain(&root, source_parent_parts, language)?;
    let info = lstat_at(source_parent.as_raw_fd(), source_name)?;
    let is_link = info.st_mode & libc::S_IFMT == libc::S_IFLNK;
    let is_dir = info.st_mode & libc::S_IFMT == libc::S_IFDIR;
    let is_file = info.st_mode & libc::S_IFMT == libc::S_IFREG;
    if is_link || (directory && !is_dir) || (!directory && !is_file) {
        return Err(translate(language, "文件类型已更改或路径包含符号链接", &[] as &[String]));
    }
    let dest_parts: Vec<&str> = parent.split('/').filter(|part| !part.is_empty()).collect();
    let dest_parent = open_chain(&root, &dest_parts, language)?;
    let source_c = std::ffi::CString::new(source_name).map_err(|_| translate(language, "名称无效", &[] as &[String]))?;
    let dest_c = std::ffi::CString::new(name).map_err(|_| translate(language, "名称无效", &[] as &[String]))?;
    let result = unsafe { libc::renameat2(source_parent.as_raw_fd(), source_c.as_ptr(), dest_parent.as_raw_fd(), dest_c.as_ptr(), libc::RENAME_NOREPLACE) };
    if result != 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(())
}

fn open_chain(root: &Path, parts: &[&str], language: &str) -> Result<std::os::fd::OwnedFd, String> {
    let mut current = open_directory(root)?;
    for part in parts {
        current = open_child_directory(&current, part).map_err(|_| translate(language, "文件类型已更改或路径包含符号链接", &[] as &[String]))?;
    }
    Ok(current)
}

fn open_directory(path: &Path) -> Result<std::os::fd::OwnedFd, String> {
    let text = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()).map_err(|error| error.to_string())?;
    let fd = unsafe { libc::open(text.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC) };
    if fd < 0 { return Err(std::io::Error::last_os_error().to_string()) }
    Ok(unsafe { std::os::fd::OwnedFd::from_raw_fd(fd) })
}

fn open_child_directory(parent: &std::os::fd::OwnedFd, name: &str) -> std::io::Result<std::os::fd::OwnedFd> {
    let text = std::ffi::CString::new(name)?;
    let fd = unsafe { libc::openat(parent.as_raw_fd(), text.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
    if fd < 0 { Err(std::io::Error::last_os_error()) } else { Ok(unsafe { std::os::fd::OwnedFd::from_raw_fd(fd) }) }
}

fn lstat_at(dir: std::os::fd::RawFd, name: &str) -> Result<libc::stat, String> {
    let text = std::ffi::CString::new(name).map_err(|error| error.to_string())?;
    let mut info = unsafe { std::mem::zeroed::<libc::stat>() };
    let result = unsafe { libc::fstatat(dir, text.as_ptr(), &mut info, libc::AT_SYMLINK_NOFOLLOW) };
    if result != 0 { return Err(std::io::Error::last_os_error().to_string()) }
    Ok(info)
}

pub fn trash_entry(root: &Path, rel: &str, directory: bool, language: &str) -> Result<(), String> {
    let (full, relative) = local_existing(root, rel, language)?;
    if relative == "." { return Err(translate(language, "不能删除项目根目录", &[] as &[String])); }
    let root = canonical_dir(root)?;
    let lexical = root.join(&relative);
    let meta = fs::symlink_metadata(&lexical).map_err(|error| error.to_string())?;
    let same = lexical == full;
    if !same || meta.file_type().is_symlink() {
        return Err(translate(language, "不能通过符号链接删除项目文件", &[] as &[String]));
    }
    if meta.is_dir() != directory || (!meta.is_dir() && !meta.is_file()) {
        return Err(translate(language, "文件类型已更改，请刷新目录", &[] as &[String]));
    }
    trash_path(&lexical)
}

fn trash_path(path: &Path) -> Result<(), String> {
    if let Ok(status) = std::process::Command::new("gio").arg("trash").arg(path).status() {
        if status.success() { return Ok(()) }
    }
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."));
    let trash = home.join(".local/share/Trash");
    let files = trash.join("files");
    let info = trash.join("info");
    fs::create_dir_all(&files).map_err(|error| error.to_string())?;
    fs::create_dir_all(&info).map_err(|error| error.to_string())?;
    let base = path.file_name().and_then(|name| name.to_str()).unwrap_or("item");
    let mut destination = files.join(base);
    if destination.exists() {
        destination = files.join(format!("{base}-{}", crate::random_id()));
    }
    fs::rename(path, &destination).map_err(|error| error.to_string())?;
    let info_name = format!("{}.trashinfo", destination.file_name().and_then(|name| name.to_str()).unwrap_or(base));
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or(Duration::from_secs(0)).as_secs();
    let body = format!("[Trash Info]\nPath={}\nDeletionDate={stamp}\n", path.display());
    fs::write(info.join(info_name), body).map_err(|error| error.to_string())?;
    Ok(())
}

pub fn check_path(input: &str, language: &str) -> Value {
    let value = input.trim();
    if value.is_empty() { return json!({ "kind": "empty" }) }
    if !value.starts_with('/') || value.contains('\0') { return json!({ "kind": "invalid" }) }
    let path = Path::new(value);
    match fs::metadata(path) {
        Ok(meta) if meta.is_dir() => {}
        Ok(_) => return json!({ "kind": "missing" }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return json!({ "kind": "missing" }),
        Err(error) => return json!({ "kind": "error", "detail": error.to_string() }),
    }
    let inside = std::process::Command::new("git").arg("-C").arg(path).arg("rev-parse").arg("--is-inside-work-tree").output();
    let Ok(inside) = inside else { return json!({ "kind": "plain" }) };
    if String::from_utf8_lossy(&inside.stdout).trim() != "true" { return json!({ "kind": "plain" }) }
    let branch = std::process::Command::new("git").arg("-C").arg(path).arg("rev-parse").arg("--abbrev-ref").arg("HEAD").output().ok()
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string()).unwrap_or_default();
    let _ = language;
    json!({ "kind": "git", "branch": branch })
}

pub fn list_dir(input: &str) -> Value {
    let mut current = input.trim().to_string();
    if current.is_empty() {
        current = std::env::var("HOME").unwrap_or_else(|_| "/".into());
    }
    let path = PathBuf::from(&current);
    let mut dirs = Vec::new();
    let read = fs::read_dir(&path);
    let Ok(read) = read else {
        return json!({ "path": current, "parent": parent_of(&current), "dirs": [], "error": "无法读取目录" });
    };
    for entry in read.flatten() {
        let Ok(file_type) = entry.file_type() else { continue };
        if !file_type.is_dir() || file_type.is_symlink() { continue }
        let name = entry.file_name().to_string_lossy().into_owned();
        if TREE_DEFAULT_IGNORE.contains(&name.as_str()) { continue }
        dirs.push(json!({ "name": name, "path": entry.path().display().to_string() }));
    }
    dirs.sort_by(|left, right| left["name"].as_str().unwrap_or("").cmp(right["name"].as_str().unwrap_or("")));
    json!({ "path": fs::canonicalize(&path).unwrap_or(path).display().to_string(), "parent": parent_of(&current), "dirs": dirs })
}

fn parent_of(value: &str) -> Value {
    let path = Path::new(value);
    if path == Path::new("/") { return Value::Null }
    path.parent().map(|parent| json!(parent.display().to_string())).unwrap_or(Value::Null)
}

pub fn count_lines(bytes: &[u8]) -> i64 {
    if bytes.is_empty() || bytes.contains(&0) { return 0 }
    let mut count = bytes.iter().filter(|byte| **byte == b'\n').count() as i64;
    if bytes.last() != Some(&b'\n') { count += 1 }
    count
}

pub fn diff_too_big(before: &str, after: &str) -> bool {
    before.len() + after.len() > MAX_DIFF
}

use std::os::fd::FromRawFd;
