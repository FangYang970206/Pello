//! Downloads from a remote project to this machine, as the Electron build's
//! `DownloadManager` and the two download functions of `remote-file.ts`.
//!
//! A download is a task: it reports itself like an upload, can be cancelled,
//! keeps what failed so that it can be tried again, and ends with the
//! workbench. A file is written to a temporary name beside its destination
//! and published only once it is whole. A destination that exists is
//! replaced only when the save dialog confirmed it, and only if it is the
//! same file it was when the dialog answered.

use crate::file_id::{self, Stamp};
use crate::i18n::translate;
use crate::ssh;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

type Emit = Arc<dyn Fn(Value) + Send + Sync>;
type Histories = std::collections::HashMap<String, Arc<History>>;

/// One thing to download: a remote path and where it goes on this machine.
#[derive(Clone)]
struct Entry {
    source: String,
    destination: PathBuf,
    kind: &'static str,
}

/// What a download remembers once it has ended, so that what failed can be
/// tried again on the same host and at the same path.
struct History {
    id: String,
    data: PathBuf,
    root: String,
    project_id: String,
    identity: String,
    anchor: PathBuf,
    failed: Mutex<Vec<Entry>>,
    finished: Mutex<bool>,
    cancel: Arc<AtomicBool>,
    done: Mutex<bool>,
    done_cv: Condvar,
}

/// Finished downloads are kept for retry; fifty is the limit, past which the
/// finished ones make room.
const LIMIT: usize = 50;

/// Above this interval a progress event is sent, so that a file that arrives
/// in many small pieces does not flood the page.
const PROGRESS_EVERY: Duration = Duration::from_millis(100);

pub struct Service {
    histories: Mutex<Histories>,
}

impl Default for Service {
    fn default() -> Self { Self::new() }
}

impl Service {
    pub fn new() -> Self { Self { histories: Mutex::new(Histories::new()) } }

    /// Start a download of one remote file or directory to a place chosen on
    /// this machine. The anchor is the real path of the directory the choice
    /// was made in, and nothing is written outside it.
    pub fn start(&self, project_id: &str, identity: &str, host: Value, data: PathBuf, root: &str, source: &str, destination: &Path, directory: bool, language: &str, emit: Emit) -> Result<String, String> {
        let anchor = real_path(if directory { destination } else { destination.parent().unwrap_or(destination) }, language)?;
        let entry = Entry {
            source: source.to_string(),
            destination: if directory { anchor.clone() } else { anchor.join(name_of(destination, language)?) },
            kind: if directory { "tree" } else { "file" },
        };
        self.run(project_id, identity, host, data, root, anchor, vec![entry], language, emit)
    }

    /// Ask a download to stop. It ends as cancelled once what it is doing now
    /// has returned.
    pub fn cancel(&self, id: &str) -> bool {
        let Some(history) = self.histories.lock().expect("downloads").get(id).cloned() else { return false };
        history.cancel.store(true, Ordering::SeqCst);
        true
    }

    /// Forget a download that has ended.
    pub fn dismiss(&self, id: &str) -> bool {
        let mut histories = self.histories.lock().expect("downloads");
        let finished = histories.get(id).map(|history| *history.finished.lock().expect("finished")).unwrap_or(false);
        if finished { histories.remove(id); }
        finished
    }

    /// The project a download was made from.
    pub fn project_id(&self, id: &str) -> String {
        self.histories.lock().expect("downloads").get(id).map(|history| history.project_id.clone()).unwrap_or_default()
    }

    /// Whether a download is known by this id.
    pub fn has(&self, id: &str) -> bool {
        self.histories.lock().expect("downloads").contains_key(id)
    }

    /// Try the entries that failed again, as a new download, once the
    /// project is still on the host and at the path it was.
    pub fn retry(&self, id: &str, host: Value, identity: &str, language: &str, emit: Emit) -> Result<String, String> {
        let history = self.history(id, language)?;
        if !*history.finished.lock().expect("finished") || history.failed.lock().expect("failed").is_empty() {
            return Err(translate(language, "没有可重试的失败项", &[] as &[String]));
        }
        if history.identity != identity {
            return Err(translate(language, "项目环境已更改", &[] as &[String]));
        }
        let failed = history.failed.lock().expect("failed").clone();
        self.run(&history.project_id, identity, host, history.data.clone(), &history.root, history.anchor.clone(), failed, language, emit)
    }

    /// Ask every download that has not ended to stop, and wait for them.
    pub fn shutdown(&self, limit: Duration) -> bool {
        let running: Vec<Arc<History>> = self.histories.lock().expect("downloads").values()
            .filter(|history| !*history.finished.lock().expect("finished")).cloned().collect();
        for history in &running { history.cancel.store(true, Ordering::SeqCst); }
        let deadline = Instant::now() + limit;
        let mut left = false;
        for history in &running {
            let mut done = history.done.lock().expect("done");
            while !*done {
                let Some(wait) = deadline.checked_duration_since(Instant::now()) else { left = true; break };
                let (guard, _) = history.done_cv.wait_timeout(done, wait).expect("done");
                done = guard;
            }
        }
        left
    }

    fn history(&self, id: &str, language: &str) -> Result<Arc<History>, String> {
        self.histories.lock().expect("downloads").get(id).cloned()
            .ok_or_else(|| translate(language, "传输任务不存在或尚未结束", &[] as &[String]))
    }

    fn run(&self, project_id: &str, identity: &str, host: Value, data: PathBuf, root: &str, anchor: PathBuf, entries: Vec<Entry>, language: &str, emit: Emit) -> Result<String, String> {
        let id = crate::random_id();
        let history = Arc::new(History {
            id: id.clone(),
            data,
            root: root.to_string(),
            project_id: project_id.to_string(),
            identity: identity.to_string(),
            anchor,
            failed: Mutex::new(Vec::new()),
            finished: Mutex::new(false),
            cancel: Arc::new(AtomicBool::new(false)),
            done: Mutex::new(false),
            done_cv: Condvar::new(),
        });
        {
            let mut histories = self.histories.lock().expect("downloads");
            if histories.len() >= LIMIT {
                let finished: Vec<String> = histories.iter().filter(|(_, history)| *history.finished.lock().expect("finished")).map(|(id, _)| id.clone()).collect();
                for finished_id in finished { histories.remove(&finished_id); }
            }
            histories.insert(id.clone(), Arc::clone(&history));
        }
        let worker = Arc::clone(&history);
        let language = language.to_string();
        std::thread::spawn(move || {
            execute(worker.clone(), entries, host, &language, &emit);
            *worker.done.lock().expect("done") = true;
            worker.done_cv.notify_all();
        });
        Ok(id)
    }
}

/// Run one download to its end. What came of each entry is in the snapshot
/// as it comes. The state is `cancelled` when the download was asked to stop
/// and `completed` otherwise, whatever came of the entries.
fn execute(history: Arc<History>, entries: Vec<Entry>, host: Value, language: &str, emit: &Emit) {
    let snapshot = Mutex::new(json!({
        "id": history.id,
        "projectId": history.project_id,
        "state": "running",
        "current": "",
        "destination": entries[0].destination.display().to_string(),
        "bytes": 0,
        "total": 0,
        "items": [],
        "direction": "download",
    }));
    let send = |snapshot: &Value| emit(json!({ "channel": "transfer:update", "payload": snapshot }));
    let last = Mutex::new(Instant::now() - PROGRESS_EVERY);
    // The bytes that have come so far are in the snapshot; the page is told
    // no more often than the interval, so a file that arrives in many small
    // pieces does not flood it.
    let progress = |source: &str, bytes: u64| {
        let mut held = snapshot.lock().expect("snapshot");
        held["current"] = json!(source);
        held["bytes"] = json!(bytes);
        let due = last.lock().expect("last").elapsed() >= PROGRESS_EVERY;
        if due {
            *last.lock().expect("last") = Instant::now();
            send(&held.clone());
        }
    };
    // One entry is over: what came of it is in the snapshot, and what failed
    // is kept so that it can be tried again.
    let result = |entry: &Entry, error: Option<String>| {
        if error.is_some() { history.failed.lock().expect("failed").push(entry.clone()); }
        let mut held = snapshot.lock().expect("snapshot");
        let mut item = json!({ "source": entry.source, "destination": entry.destination.display().to_string(), "status": if error.is_some() { "failed" } else { "done" } });
        if let Some(error) = error { item["error"] = json!(error); }
        held["items"].as_array_mut().expect("items").push(item);
        send(&held.clone());
    };
    let cancelled = || history.cancel.load(Ordering::SeqCst);
    send(&snapshot.lock().expect("snapshot").clone());
    for entry in &entries {
        if cancelled() { break }
        {
            let mut held = snapshot.lock().expect("snapshot");
            held["current"] = json!(entry.source);
            held["destination"] = json!(entry.destination.display().to_string());
            held["bytes"] = json!(0);
            send(&held.clone());
        }
        let outcome = check(&history, entry, language).and_then(|_| match entry.kind {
            "tree" => download_tree(&host, &history.data, &history.root, &entry.source, &entry.destination, &history.cancel, &progress, language, &|source, destination, error, directory| {
                result(&Entry { source: source.to_string(), destination: PathBuf::from(destination), kind: if directory { "directory" } else { "file" } }, error);
            }),
            // A file is written over what the save dialog confirmed.
            _ => download_file(&host, &history.data, &history.root, &entry.source, &entry.destination, &history.cancel, &progress, true, language),
        });
        let error = match outcome {
            Ok(()) => None,
            Err(Failure::Cancelled) => break,
            Err(Failure::Exists) => Some(translate(language, "目标已存在，请选择新的文件名或目录", &[] as &[String])),
            Err(Failure::Message(error)) => Some(error),
        };
        // A tree reports what came of each of its entries as it goes, so it
        // says nothing of itself unless it could not be started.
        if entry.kind != "tree" || error.is_some() { result(entry, error); }
    }

    let state = if cancelled() { "cancelled" } else { "completed" };
    {
        let mut held = snapshot.lock().expect("snapshot");
        held["state"] = json!(state);
        *history.finished.lock().expect("finished") = true;
        send(&held.clone());
    }
}



/// Whether an entry may be written where it says: the download was not
/// stopped, and the directory that takes it is inside the anchor and is
/// still the directory it was, not a link put in its place.
fn check(history: &History, entry: &Entry, language: &str) -> Result<(), Failure> {
    if history.cancel.load(Ordering::SeqCst) { return Err(Failure::Cancelled) }
    let parent = if entry.kind == "tree" { entry.destination.as_path() } else { entry.destination.parent().unwrap_or(&entry.destination) };
    // The anchor is a real path and the entry was made below it, so a path
    // that is not below it was put there by something else.
    if parent.strip_prefix(&history.anchor).is_err() {
        return Err(Failure::Message(translate(language, "下载位置超出所选目录", &[] as &[String])));
    }
    unchanged_directory(parent, language).map_err(Failure::Message)
}

/// The real path of a directory: where the files go. What is there must be a
/// directory, so that the anchor is not a link to somewhere else.
fn real_path(directory: &Path, language: &str) -> Result<PathBuf, String> {
    let real = crate::real_path(directory).map_err(|error| error.to_string())?;
    if !real.is_dir() { return Err(translate(language, "目标不是目录", &[] as &[String])) }
    Ok(real)
}

/// The name a file is saved under, the one chosen in the dialog. A name that
/// cannot be made on this machine is refused before anything is read.
fn name_of(destination: &Path, language: &str) -> Result<String, String> {
    let name = destination.file_name().and_then(|name| name.to_str()).unwrap_or("");
    if name.is_empty() || name.contains('\\') || (cfg!(windows) && (name.chars().any(|character| "<>:\"|?*".contains(character)) || name.ends_with('.') || name.ends_with(' '))) {
        return Err(translate(language, "文件夹名称无法在本机保存", &[] as &[String]));
    }
    Ok(name.to_string())
}

/// Whether a directory is still the one it was named as: its real path is
/// itself, so no link is in the way.
fn unchanged_directory(directory: &Path, language: &str) -> Result<(), String> {
    let real = crate::real_path(directory).map_err(|error| error.to_string())?;
    if !same_path(&real, directory) {
        return Err(translate(language, "下载位置已更改或包含链接", &[] as &[String]));
    }
    Ok(())
}

/// Windows does not tell `a` from `A` in a path.
fn same_path(left: &Path, right: &Path) -> bool {
    if cfg!(windows) {
        left.to_string_lossy().to_lowercase() == right.to_string_lossy().to_lowercase()
    } else {
        left == right
    }
}

/// How an entry did not come through: what to say about it, that its
/// destination was there already, or that the download was stopped.
enum Failure {
    Message(String),
    Exists,
    Cancelled,
}

impl From<String> for Failure {
    fn from(message: String) -> Self { Failure::Message(message) }
}

/// Read one remote file into its destination. The bytes go to a temporary
/// name beside the destination first; the destination gets them only once
/// the whole file is there. What is at the destination already is replaced
/// only when `replace_existing` says the save dialog confirmed it, and only
/// if it is still the file it was then.
fn download_file(host: &Value, data: &Path, root: &str, source: &str, destination: &Path, cancel: &Arc<AtomicBool>, progress: &(dyn Fn(&str, u64) + Send + Sync), replace_existing: bool, language: &str) -> Result<(), Failure> {
    // What the destination is now, if it is to be replaced: it has to be a
    // plain file, and it has to be this file still when the download is in.
    let expected = if replace_existing { Some(plain_file_or_absent(destination, language)?) } else { None };
    let temp = destination.parent().unwrap_or(destination).join(format!(".awb-download-{}.tmp", crate::random_id()));
    // The temporary name is taken before anything is read, so that two
    // downloads to one name do not write to one file.
    let mut held = match std::fs::OpenOptions::new().write(true).create_new(true).open(&temp) {
        Ok(file) => file,
        Err(error) => return Err(Failure::Message(error.to_string())),
    };
    let outcome = receive(host, data, root, source, &mut held, cancel, progress, language).and_then(|_| {
        if cancel.load(Ordering::SeqCst) { return Err(Failure::Cancelled) }
        publish(&temp, destination, expected, language)
    });
    drop(held);
    let _ = std::fs::remove_file(&temp);
    outcome
}

/// Read the remote file into the open temporary file.
fn receive(host: &Value, data: &Path, root: &str, source: &str, held: &mut std::fs::File, cancel: &Arc<AtomicBool>, progress: &(dyn Fn(&str, u64) + Send + Sync), language: &str) -> Result<(), Failure> {
    let command = read_command(host, root, source, language)?;
    let moved = |bytes: u64| progress(source, bytes);
    let outcome = ssh::receive_file(data, host, &command, held, &moved, cancel, language);
    // A download that was asked to stop is not a failure of the file,
    // whatever the connection said on its way out.
    if cancel.load(Ordering::SeqCst) { return Err(Failure::Cancelled) }
    outcome.map_err(Failure::Message)
}

/// Publish a whole temporary file under its name. Over a file the dialog
/// confirmed, the temporary file is renamed onto it; onto a new name, it is
/// linked, which fails when the name is taken meanwhile.
fn publish(temp: &Path, destination: &Path, expected: Option<Option<Stamp>>, language: &str) -> Result<(), Failure> {
    match expected {
        // A file was there when the download began: it has to be that file.
        Some(Some(expected)) => {
            let current = plain_file(destination, language)?;
            if current != expected {
                return Err(Failure::Message(translate(language, "目标文件已更改，请重新检查冲突", &[] as &[String])));
            }
            std::fs::rename(temp, destination).map_err(|error| Failure::Message(error.to_string()))
        }
        _ => match std::fs::hard_link(temp, destination) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Err(Failure::Exists),
            Err(error) => Err(Failure::Message(error.to_string())),
        },
    }
}

/// What is at a path that is to be replaced: the stamp of the plain file
/// there, or nothing when there is nothing there.
fn plain_file_or_absent(destination: &Path, language: &str) -> Result<Option<Stamp>, Failure> {
    match file_id::inspect(destination) {
        None => Ok(None),
        Some((file_id::Kind::File, Some(stamp))) => Ok(Some(stamp)),
        _ => Err(Failure::Message(translate(language, "目标不是普通文件或包含链接", &[] as &[String]))),
    }
}

/// The stamp of the plain file at a path. A link, a directory or nothing
/// there is not a file that can be replaced.
fn plain_file(destination: &Path, language: &str) -> Result<Stamp, Failure> {
    match file_id::inspect(destination) {
        Some((file_id::Kind::File, Some(stamp))) => Ok(stamp),
        _ => Err(Failure::Message(translate(language, "目标不是普通文件或包含链接", &[] as &[String]))),
    }
}

/// The remote command that writes one file of the project to its output. A
/// link anywhere on the way, or a directory, ends it with an error.
fn read_command(host: &Value, root: &str, source: &str, language: &str) -> Result<String, Failure> {
    let relative = crate::files::clean_relative(source, language)?;
    if host["platform"] == "windows" {
        let link = crate::ssh::ps_quote(&translate(language, "路径包含链接", &[] as &[String]));
        let pick = crate::ssh::ps_quote(&translate(language, "请选择文件", &[] as &[String]));
        let parts: Vec<&str> = relative.split('/').filter(|part| !part.is_empty()).collect();
        let walk = parts.iter().map(|part| format!("$walk=Join-Path $walk {}; $item=Get-Item -LiteralPath $walk -Force -ErrorAction Stop; if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {{ throw {link} }}", crate::ssh::ps_quote(part))).collect::<Vec<_>>().join("; ");
        let script = format!(
            "$ErrorActionPreference='Stop'; $walk=(Resolve-Path -LiteralPath {} -ErrorAction Stop).Path; {walk}; if ($item.PSIsContainer) {{ throw {pick} }}; \
             $inputFile=[IO.File]::Open($walk,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read); \
             try {{ $output=[Console]::OpenStandardOutput(); $inputFile.CopyTo($output); $output.Flush() }} finally {{ $inputFile.Dispose() }}",
            crate::ssh::ps_quote(&root));
        return Ok(crate::ssh::remote_command("windows", &[String::from("powershell.exe"), String::from("-NoProfile"), String::from("-Command"), script]));
    }
    let script = READ_LINUX.replace("NOT_A_REGULAR_FILE", &translate(language, "不是普通文件", &[] as &[String]));
    let command = format!("python3 -c {} {} {}", crate::ssh::bash_quote(&script), crate::ssh::bash_quote(&root), crate::ssh::bash_quote(&relative));
    Ok(crate::ssh::remote_command("linux", &[String::from("bash"), String::from("-lc"), command]))
}

/// Read one file on a POSIX host, following no link and refusing what is not
/// a plain file.
const READ_LINUX: &str = r#"import os, stat, sys
root, relative = sys.argv[1:]
parts = relative.split('/')
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC
parent = os.open(root, flags)
try:
    for part in parts[:-1]:
        new = os.open(part, flags | os.O_NOFOLLOW, dir_fd=parent)
        os.close(parent)
        parent = new
    file = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
    try:
        if not stat.S_ISREG(os.fstat(file).st_mode): raise ValueError('NOT_A_REGULAR_FILE')
        while True:
            data = os.read(file, 262144)
            if not data: break
            sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()
    finally:
        os.close(file)
finally:
    os.close(parent)
"#;


/// Download a directory of the remote project into the chosen local
/// directory, under its own name. What is in it is listed before anything is
/// made, so that the destination is made only for a directory that can be
/// read, and each thing in it is reported as it comes. Nothing that is there
/// already is replaced.
fn download_tree(host: &Value, data: &Path, root: &str, source: &str, local_parent: &Path, cancel: &Arc<AtomicBool>, progress: &(dyn Fn(&str, u64) + Send + Sync), language: &str, result: &dyn Fn(&str, &Path, Option<String>, bool)) -> Result<(), Failure> {
    let relative = crate::files::clean_relative(source, language)?;
    if relative.is_empty() { return Err(Failure::Message(translate(language, "请选择项目中的子目录", &[] as &[String]))) }
    let name = relative.rsplit('/').next().unwrap_or(&relative).to_string();
    // The name is that of the directory on the remote; it has to be a name
    // this machine can make.
    crate::files::validate_entry_name(&name, cfg!(windows), language)?;
    let entries = remote_entries(host, data, root, &relative, language)?;
    if cancel.load(Ordering::SeqCst) { return Err(Failure::Cancelled) }
    let parent = crate::real_path(local_parent).map_err(|error| Failure::Message(error.to_string()))?;
    let destination = parent.join(&name);
    // Made, not taken: a directory of that name there already is not merged
    // with.
    std::fs::create_dir(&destination).map_err(|error| Failure::Message(error.to_string()))?;
    let real = crate::real_path(&destination).map_err(|error| Failure::Message(error.to_string()))?;
    if !same_path(&real, &destination) {
        return Err(Failure::Message(translate(language, "目标目录已更改或包含链接", &[] as &[String])));
    }
    for entry in entries {
        if cancel.load(Ordering::SeqCst) { return Err(Failure::Cancelled) }
        let local = entry.path.split('/').fold(real.clone(), |path, part| path.join(part));
        let from = format!("{relative}/{}", entry.path);
        let outcome = crate::real_path(local.parent().unwrap_or(&local))
            .map_err(|error| Failure::Message(error.to_string()))
            .and_then(|actual| {
                if !same_path(&actual, local.parent().unwrap_or(&local)) {
                    return Err(Failure::Message(translate(language, "目标目录已更改或包含链接", &[] as &[String])));
                }
                if entry.directory { std::fs::create_dir(&local).map_err(|error| Failure::Message(error.to_string())) }
                else { download_file(host, data, root, &from, &local, cancel, progress, false, language) }
            });
        match outcome {
            Ok(()) => result(&from, &local, None, entry.directory),
            Err(Failure::Cancelled) => return Err(Failure::Cancelled),
            Err(Failure::Exists) => result(&from, &local, Some(translate(language, "目标已存在，请选择新的文件名或目录", &[] as &[String])), entry.directory),
            Err(Failure::Message(error)) => result(&from, &local, Some(error), entry.directory),
        }
    }
    Ok(())
}

/// One thing in a remote directory, by its path from that directory.
struct RemoteEntry {
    path: String,
    directory: bool,
}

/// Everything in a remote directory, below it, with links refused.
fn remote_entries(host: &Value, data: &Path, root: &str, relative: &str, language: &str) -> Result<Vec<RemoteEntry>, Failure> {
    let command = list_command(host, root, relative, language)?;
    let text = crate::ssh::run(data, host, &command, None, language)?;
    let mut entries = Vec::new();
    for line in text.lines() {
        if line.trim().is_empty() { continue }
        let Ok(item) = serde_json::from_str::<Value>(line) else {
            return Err(Failure::Message(translate(language, "远程目录列表无效", &[] as &[String])));
        };
        let (Some(path), Some(directory)) = (item["path"].as_str(), item["dir"].as_bool()) else {
            return Err(Failure::Message(translate(language, "远程目录列表无效", &[] as &[String])));
        };
        for part in path.split('/') {
            if part.is_empty() || part == "." || part == ".." || part.contains('\\') || part.contains('\0')
                || (cfg!(windows) && (part.chars().any(|character| "<>:\"|?*".contains(character) || character < ' ')
                    || part.ends_with('.') || part.ends_with(' ') || reserved_name(part))) {
                return Err(Failure::Message(translate(language, "文件名无法在本机保存：{{0}}", &[path.to_string()])));
            }
        }
        entries.push(RemoteEntry { path: path.to_string(), directory });
    }
    Ok(entries)
}

/// Whether a name is one Windows keeps for a device: `con`, `nul`, `com1`
/// and the like, alone or before a dot, in any case.
fn reserved_name(part: &str) -> bool {
    let lower = part.to_ascii_lowercase();
    let stem = lower.split('.').next().unwrap_or(&lower);
    ["con", "prn", "aux", "nul"].contains(&stem)
        || ["com", "lpt"].iter().any(|prefix| stem.strip_prefix(prefix).is_some_and(|rest| rest.len() == 1 && rest.as_bytes()[0].is_ascii_digit()))
}

/// The remote command that lists a directory of the project, one line of
/// JSON for each thing in it, with its path from that directory.
fn list_command(host: &Value, root: &str, relative: &str, language: &str) -> Result<String, Failure> {
    if host["platform"] == "windows" {
        let link = crate::ssh::ps_quote(&translate(language, "目录包含符号链接", &[] as &[String]));
        let unsafe_dir = crate::ssh::ps_quote(&translate(language, "路径不是安全目录", &[] as &[String]));
        let parts: Vec<&str> = relative.split('/').filter(|part| !part.is_empty()).collect();
        let walk = parts.iter().map(|part| format!("$walk=Join-Path $walk {}; $item=Get-Item -LiteralPath $walk -Force -ErrorAction Stop; if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $item.PSIsContainer) {{ throw {unsafe_dir} }}", crate::ssh::ps_quote(part))).collect::<Vec<_>>().join("; ");
        let script = format!(
            "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $walk=(Resolve-Path -LiteralPath {} -ErrorAction Stop).Path; {walk}; \
             $stack=[Collections.Generic.Stack[object]]::new(); $stack.Push(@{{full=$walk; rel=''}}); \
             while($stack.Count -gt 0) {{ $node=$stack.Pop(); foreach($item in @(Get-ChildItem -LiteralPath $node.full -Force -ErrorAction Stop)) {{ \
             if($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {{ throw {link} }}; \
             $name=if($node.rel) {{ $node.rel+'/'+$item.Name }} else {{ $item.Name }}; \
             @{{path=$name; dir=[bool]$item.PSIsContainer}} | ConvertTo-Json -Compress; \
             if($item.PSIsContainer) {{ $stack.Push(@{{full=$item.FullName; rel=$name}}) }} }} }}",
            crate::ssh::ps_quote(root));
        return Ok(crate::ssh::remote_command("windows", &[String::from("powershell.exe"), String::from("-NoProfile"), String::from("-Command"), script]));
    }
    let command = format!("python3 -c {} {} {}", crate::ssh::bash_quote(LIST_LINUX), crate::ssh::bash_quote(root), crate::ssh::bash_quote(relative));
    Ok(crate::ssh::remote_command("linux", &[String::from("bash"), String::from("-lc"), command]))
}

/// List a directory on a POSIX host, following no link and refusing what is
/// neither a plain file nor a directory.
const LIST_LINUX: &str = r#"import json, os, stat, sys
root, relative = sys.argv[1:]
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC
fd = os.open(root, flags)
try:
    for part in relative.split('/'):
        nxt = os.open(part, flags | os.O_NOFOLLOW, dir_fd=fd)
        os.close(fd)
        fd = nxt
    sys.stdout.reconfigure(encoding='utf-8')
    def walk(parent, prefix):
        with os.scandir(parent) as entries:
            for entry in entries:
                info = entry.stat(follow_symlinks=False)
                if stat.S_ISLNK(info.st_mode): raise ValueError('LINK: ' + entry.name)
                if not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)): raise ValueError('UNSUPPORTED: ' + entry.name)
                relative = prefix + '/' + entry.name if prefix else entry.name
                directory = stat.S_ISDIR(info.st_mode)
                print(json.dumps({'path': relative, 'dir': directory}, ensure_ascii=False), flush=True)
                if directory:
                    child = os.open(entry.name, flags | os.O_NOFOLLOW, dir_fd=parent)
                    try: walk(child, relative)
                    finally: os.close(child)
    walk(fd, '')
finally:
    os.close(fd)
"#;
