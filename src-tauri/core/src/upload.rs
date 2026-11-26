//! Remote upload. Linux streams each file into a temporary tree and publishes it
//! only after the captured version still matches. Cancel and failure remove only
//! that temporary tree. Windows keeps the JSON helper used by the upload shim.

use crate::i18n::translate;
use crate::random_id;
use crate::ssh;
use base64::Engine;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::Duration;

type Emit = Arc<dyn Fn(Value) + Send + Sync>;

struct Job {
    cancel: AtomicBool,
    publishing: AtomicBool,
    snapshot: Mutex<Value>,
    decision: Mutex<Option<bool>>,
    decision_cv: Condvar,
    retry: Mutex<Vec<String>>,
    parent: Mutex<String>,
    aliases: Vec<Value>,
    block: Mutex<Option<ReplacementBlock>>,
    /// Set once the thread that runs the upload has nothing more to do,
    /// which is what closing the workbench waits for.
    done: Mutex<bool>,
    done_cv: Condvar,
}

struct ReplacementBlock {
    targets: Vec<Value>,
    directory: bool,
    case_insensitive: bool,
}

pub struct Service {
    jobs: Mutex<std::collections::HashMap<String, Arc<Job>>>,
}

impl Service {
    pub fn new() -> Self { Self { jobs: Mutex::new(std::collections::HashMap::new()) } }

    pub fn start(&self, data: PathBuf, host: Option<Value>, project_id: String, root: String, parent: String, sources: Vec<String>, aliases: Vec<Value>, dirty: bool, language: String, emit: Emit) -> Result<Value, String> {
        if sources.is_empty() { return Err(translate(&language, "请选择文件或文件夹", &[] as &[String])); }
        let parent = normalize_parent(&parent, &language)?;
        if parent == "." { return Err(translate(&language, "不能替换项目根目录", &[] as &[String])); }
        let id = random_id();
        let snapshot = json!({
            "id": id,
            "projectId": project_id,
            "direction": "upload",
            "state": "running",
            "phase": "preparing",
            "current": "",
            "destination": root,
            "bytes": 0,
            "total": 0,
            "overallBytes": 0,
            "overallTotal": 0,
            "items": [],
            "warnings": [],
            "retryable": true,
            "successDismissMs": 2000
        });
        let job = Arc::new(Job {
            cancel: AtomicBool::new(false),
            publishing: AtomicBool::new(false),
            snapshot: Mutex::new(snapshot),
            decision: Mutex::new(None),
            decision_cv: Condvar::new(),
            retry: Mutex::new(sources.clone()),
            parent: Mutex::new(parent.clone()),
            aliases: aliases.clone(),
            block: Mutex::new(None),
            done: Mutex::new(false),
            done_cv: Condvar::new(),
        });
        self.jobs.lock().expect("uploads").insert(id.clone(), job.clone());
        let jobs = self.jobs.lock().expect("uploads").get(&id).cloned().unwrap();
        thread::spawn(move || {
            run_job(jobs.clone(), data, host, project_id, root, parent, sources, aliases, dirty, language, emit);
            *jobs.done.lock().expect("done") = true;
            jobs.done_cv.notify_all();
        });
        Ok(json!(id))
    }

    pub fn cancel(&self, id: &str, language: &str) -> Result<Value, String> {
        let job = self.job(id, language)?;
        if job.publishing.load(Ordering::SeqCst) {
            return Err(translate(language, "正在完成上传，请稍候", &[] as &[String]));
        }
        job.cancel.store(true, Ordering::SeqCst);
        job.decision_cv.notify_all();
        Ok(Value::Null)
    }

    pub fn confirm(&self, id: &str, allow: bool) {
        let Some(job) = self.jobs.lock().expect("uploads").get(id).cloned() else { return };
        *job.decision.lock().expect("decision") = Some(allow);
        job.decision_cv.notify_all();
    }

    pub fn retry(&self, data: PathBuf, host: Option<Value>, language: String, emit: Emit, id: &str) -> Result<Value, String> {
        let job = self.job(id, &language)?;
        let snapshot = job.snapshot.lock().expect("snapshot").clone();
        if snapshot["state"] == "running" { return Err(translate(&language, "传输任务不存在或尚未结束", &[] as &[String])); }
        let sources = job.retry.lock().expect("retry").clone();
        if sources.is_empty() { return Err(translate(&language, "没有可重试的失败项", &[] as &[String])); }
        let parent = job.parent.lock().expect("parent").clone();
        let aliases = job.aliases.clone();
        let project_id = snapshot["projectId"].as_str().unwrap_or("").to_string();
        let root = snapshot["destination"].as_str().unwrap_or("").to_string();
        self.start(data, host, project_id, root, parent, sources, aliases, false, language, emit)
    }

    pub fn write_blocked(&self, project_id: &str, rel: &str) -> bool {
        self.jobs.lock().expect("uploads").values().any(|job| replacement_blocks(job, project_id, rel))
    }

    /// The window is closing: the uploads that are not publishing are asked
    /// to stop, and each is waited for, for at most as long as `limit`.
    /// Whether any was still running when the time was up.
    pub fn shutdown(&self, limit: Duration) -> bool {
        let jobs: Vec<Arc<Job>> = self.jobs.lock().expect("uploads").values().filter(|job| {
            !matches!(job.snapshot.lock().expect("snapshot")["state"].as_str(), Some("completed" | "cancelled"))
        }).cloned().collect();
        for job in &jobs {
            // A publish that has begun replaces the old files; it is let to finish.
            if !job.publishing.load(Ordering::SeqCst) {
                job.cancel.store(true, Ordering::SeqCst);
                *job.decision.lock().expect("decision") = Some(false);
                job.decision_cv.notify_all();
            }
        }
        let deadline = std::time::Instant::now() + limit;
        let mut waiting = false;
        for job in &jobs {
            let mut done = job.done.lock().expect("done");
            while !*done {
                let left = deadline.saturating_duration_since(std::time::Instant::now());
                if left.is_zero() { waiting = true; break }
                let (next, _) = job.done_cv.wait_timeout(done, left).expect("done");
                done = next;
            }
        }
        waiting
    }

    /// A tree entry is about to be moved: it is refused while what the job
    /// is replacing is it, lies in it, or lies in the entry when that is a
    /// folder.
    pub fn move_blocked(&self, project_id: &str, rel: &str, directory: bool) -> bool {
        self.jobs.lock().expect("uploads").values().any(|job| {
            let guard = job.block.lock().expect("block");
            guard.as_ref().is_some_and(|block| in_the_way(block, project_id, rel, directory))
        })
    }

    pub fn project_id(&self, id: &str) -> Option<String> {
        self.jobs.lock().expect("uploads").get(id).and_then(|job| job.snapshot.lock().expect("snapshot")["projectId"].as_str().map(|value| value.to_string()))
    }

    pub fn dismiss(&self, id: &str) -> Result<Value, String> {
        let mut jobs = self.jobs.lock().expect("uploads");
        if let Some(job) = jobs.get(id) {
            let state = job.snapshot.lock().expect("snapshot")["state"].as_str().unwrap_or("").to_string();
            if state == "completed" || state == "cancelled" { jobs.remove(id); }
        }
        Ok(Value::Null)
    }

    fn job(&self, id: &str, language: &str) -> Result<Arc<Job>, String> {
        self.jobs.lock().expect("uploads").get(id).cloned().ok_or_else(|| translate(language, "传输任务不存在", &[] as &[String]))
    }
}

fn run_job(job: Arc<Job>, data: PathBuf, host: Option<Value>, project_id: String, root: String, parent: String, sources: Vec<String>, aliases: Vec<Value>, dirty: bool, language: String, emit: Emit) {
    let case_insensitive = host.as_ref().and_then(|item| item["platform"].as_str()) == Some("windows");
    let mut replaced: Vec<(String, bool)> = Vec::new();
    let outcome = (|| -> Result<(), String> {
        let mut nodes = Vec::new();
        let mut replacing = false;
        for source in &sources {
            let node = read_source(Path::new(source), &language, case_insensitive)?;
            let name = node["name"].as_str().unwrap_or("");
            let relative = if parent.is_empty() { name.to_string() } else { format!("{parent}/{name}") };
            if relative.is_empty() || relative == "." { return Err(translate(&language, "不能替换项目根目录", &[] as &[String])); }
            if exists_remote(&data, host.as_ref(), &root, &relative, &language)? {
                replacing = true;
                replaced.push((relative, node["dir"].as_bool().unwrap_or(false)));
            }
            nodes.push(node);
        }
        if job.cancel.load(Ordering::SeqCst) { return Err(translate(&language, "传输已取消", &[] as &[String])); }
        if replacing {
            let (targets, directory) = replacement_targets(&project_id, &root, &replaced, &aliases, case_insensitive);
            *job.block.lock().expect("block") = Some(ReplacementBlock { targets: targets.clone(), directory, case_insensitive });
            if dirty {
            set_phase(&job, "confirming", &emit);
            let primary = targets.first().cloned().unwrap_or_else(|| json!({ "projectId": project_id, "path": parent }));
            emit(json!({ "channel": "file:replacement", "payload": {
                "id": job.snapshot.lock().expect("snapshot")["id"],
                "projectId": primary["projectId"],
                "path": primary["path"],
                "directory": directory,
                "caseInsensitive": case_insensitive,
                "targets": targets,
                "phase": "prepare"
            }}));
            if !wait_decision(&job) {
                return Err(translate(&language, "覆盖已取消，原文件和草稿已保留", &[] as &[String]));
            }
            }
        }
        let total = tree_bytes(&nodes);
        {
            let mut snapshot = job.snapshot.lock().expect("snapshot");
            snapshot["overallTotal"] = json!(total);
            snapshot["total"] = json!(total);
        }
        set_phase(&job, "transferring", &emit);
        let staged = stage(&data, host.as_ref(), &root, &parent, &nodes, &job, &emit, &language)?;
        if let Ok(hold) = std::env::var("AWB_UPLOAD_HOLD") {
            let _ = fs::write(format!("{hold}.ready"), &staged.to_string());
            loop {
                if job.cancel.load(Ordering::SeqCst) || Path::new(&format!("{hold}.cancel")).exists() {
                    let _ = remove_stages(&data, host.as_ref(), &root, &parent, &staged, &language);
                    return Err(translate(&language, "传输已取消", &[] as &[String]));
                }
                if Path::new(&format!("{hold}.go")).exists() { break; }
                thread::sleep(Duration::from_millis(20));
            }
        }
        if job.cancel.load(Ordering::SeqCst) {
            let _ = remove_stages(&data, host.as_ref(), &root, &parent, &staged, &language);
            return Err(translate(&language, "传输已取消", &[] as &[String]));
        }
        job.publishing.store(true, Ordering::SeqCst);
        set_phase(&job, "publishing", &emit);
        if let Ok(pause) = std::env::var("AWB_UPLOAD_PUBLISH_HOLD") {
            let _ = fs::write(format!("{pause}.publishing"), "1");
            while !Path::new(&format!("{pause}.go")).exists() {
                thread::sleep(Duration::from_millis(20));
            }
        }
        let warning = match publish(&data, host.as_ref(), &root, &parent, &staged, &language) {
            Ok(warning) => warning,
            Err(error) => {
                let _ = remove_stages(&data, host.as_ref(), &root, &parent, &staged, &language);
                return Err(error);
            }
        };
        if let Some(warning) = warning {
            let mut snapshot = job.snapshot.lock().expect("snapshot");
            snapshot["warnings"] = json!([warning]);
            let event = snapshot.clone();
            drop(snapshot);
            emit(json!({ "channel": "transfer:update", "payload": event }));
        }
        let mut items = Vec::new();
        for source in &sources {
            items.push(json!({ "source": source, "destination": destination_of(&root, &parent, Path::new(source)), "status": "done" }));
        }
        job.retry.lock().expect("retry").clear();
        let mut snapshot = job.snapshot.lock().expect("snapshot");
        snapshot["items"] = Value::Array(items);
        snapshot["state"] = json!("completed");
        snapshot["phase"] = json!("done");
        let event = snapshot.clone();
        drop(snapshot);
        emit(json!({ "channel": "transfer:update", "payload": event }));
        Ok(())
    })();
    if let Err(error) = outcome {
        let cancelled = job.cancel.load(Ordering::SeqCst)
            || error == translate(&language, "传输已取消", &[] as &[String])
            || error == translate(&language, "覆盖已取消，原文件和草稿已保留", &[] as &[String]);
        let mut snapshot = job.snapshot.lock().expect("snapshot");
        snapshot["state"] = json!(if cancelled { "cancelled" } else { "completed" });
        snapshot["phase"] = json!(if cancelled { "cancelled" } else { "failed" });
        if !cancelled {
            let sources = job.retry.lock().expect("retry").clone();
            snapshot["items"] = json!(sources.iter().map(|source| json!({
                "source": source,
                "destination": destination_of(&root, &parent, Path::new(source)),
                "status": "failed",
                "error": error
            })).collect::<Vec<_>>());
        }
        let event = snapshot.clone();
        drop(snapshot);
        emit(json!({ "channel": "transfer:update", "payload": event }));
    }
    *job.block.lock().expect("block") = None;
    let (targets, directory) = replacement_targets(&project_id, &root, &replaced, &aliases, case_insensitive);
    let primary = targets.first().cloned().unwrap_or_else(|| json!({ "projectId": project_id, "path": parent }));
    emit(json!({ "channel": "file:replacement", "payload": {
        "id": job.snapshot.lock().expect("snapshot")["id"],
        "phase": "finish",
        "success": job.snapshot.lock().expect("snapshot")["phase"] == "done",
        "projectId": primary["projectId"],
        "path": primary["path"],
        "directory": directory,
        "caseInsensitive": case_insensitive,
        "targets": targets
    } }));
}

fn replacement_blocks(job: &Job, project_id: &str, rel: &str) -> bool {
    let guard = job.block.lock().expect("block");
    let Some(block) = guard.as_ref() else { return false };
    block.targets.iter().any(|target| {
        if target["projectId"].as_str() != Some(project_id) { return false }
        let path = target["path"].as_str().unwrap_or("");
        let (path, rel) = if block.case_insensitive { (path.to_lowercase(), rel.to_lowercase()) } else { (path.to_string(), rel.to_string()) };
        rel == path || (block.directory && (path.is_empty() || rel.starts_with(&format!("{path}/"))))
    })
}


/// Whether a tree entry is in the way of what the job is replacing, as the
/// replacement guard of Electron's tree:move decides it: the entry is what is
/// being replaced, lies in a replaced folder, or is a folder that holds what
/// is being replaced.
fn in_the_way(block: &ReplacementBlock, project_id: &str, rel: &str, directory: bool) -> bool {
    block.targets.iter().any(|target| {
        if target["projectId"].as_str() != Some(project_id) { return false }
        let path = target["path"].as_str().unwrap_or("");
        let (path, rel) = if block.case_insensitive { (path.to_lowercase(), rel.to_lowercase()) } else { (path.to_string(), rel.to_string()) };
        rel == path || (block.directory && (path.is_empty() || rel.starts_with(&format!("{path}/")))) || (directory && !rel.is_empty() && path.starts_with(&format!("{rel}/")))
    })
}

fn replacement_targets(project_id: &str, root: &str, replaced: &[(String, bool)], aliases: &[Value], case_insensitive: bool) -> (Vec<Value>, bool) {
    let mut targets = Vec::new();
    let directory = replaced.iter().any(|(_, dir)| *dir);
    for (relative, dir) in replaced {
        targets.push(json!({ "projectId": project_id, "path": relative }));
        let full = format!("{}/{}", root.trim_end_matches(['/', '\\']), relative);
        for alias in aliases {
            let Some(path) = alias_replacement(alias["path"].as_str().unwrap_or(""), &full, *dir, case_insensitive) else { continue };
            targets.push(json!({ "projectId": alias["id"], "path": path }));
        }
    }
    (targets, directory)
}

fn alias_replacement(alias_root: &str, full: &str, directory: bool, case_insensitive: bool) -> Option<String> {
    if let Some(path) = remote_relative(alias_root, full, case_insensitive) {
        if !path.is_empty() { return Some(path); }
    } else if directory && remote_relative(full, alias_root, case_insensitive).is_some_and(|nested| !nested.is_empty()) {
        return Some(String::new());
    }
    None
}

fn remote_relative(root: &str, full: &str, case_insensitive: bool) -> Option<String> {
    let root = root.trim_end_matches(['/', '\\']);
    let full = full.trim_end_matches(['/', '\\']);
    if case_insensitive {
        if full.eq_ignore_ascii_case(root) { return Some(String::new()); }
        let prefix = format!("{root}/");
        if full.len() > prefix.len() && full[..prefix.len()].eq_ignore_ascii_case(&prefix) {
            return Some(full[prefix.len()..].replace('\\', "/"));
        }
        return None;
    }
    if full == root { return Some(String::new()); }
    full.strip_prefix(&format!("{root}/")).map(|value| value.replace('\\', "/"))
}

fn set_phase(job: &Job, phase: &str, emit: &Emit) {
    let mut snapshot = job.snapshot.lock().expect("snapshot");
    snapshot["phase"] = json!(phase);
    snapshot["state"] = json!("running");
    let event = snapshot.clone();
    drop(snapshot);
    emit(json!({ "channel": "transfer:update", "payload": event }));
}

fn wait_decision(job: &Job) -> bool {
    let mut guard = job.decision.lock().expect("decision");
    loop {
        if let Some(allow) = *guard { return allow; }
        if job.cancel.load(Ordering::SeqCst) { return false; }
        let (next, _) = job.decision_cv.wait_timeout(guard, Duration::from_millis(40)).expect("decision");
        guard = next;
    }
}

fn normalize_parent(parent: &str, language: &str) -> Result<String, String> {
    if parent.contains('\0') || parent.split(['\\', '/']).any(|part| part == "..") {
        return Err(translate(language, "不能替换项目根目录", &[] as &[String]));
    }
    Ok(parent.replace('\\', "/").split('/').filter(|part| !part.is_empty() && *part != ".").collect::<Vec<_>>().join("/"))
}

fn destination_of(root: &str, parent: &str, source: &Path) -> String {
    let name = source.file_name().and_then(|name| name.to_str()).unwrap_or("");
    let relative = if parent.is_empty() { name.to_string() } else { format!("{parent}/{name}") };
    format!("{}/{}", root.trim_end_matches(['/', '\\']), relative)
}

fn read_source(path: &Path, language: &str, embed: bool) -> Result<Value, String> {
    let meta = fs::symlink_metadata(path).map_err(|_| translate(language, "无法检查来源", &[] as &[String]))?;
    if meta.file_type().is_symlink() { return Err(translate(language, "不上传符号链接", &[] as &[String])); }
    let name = path.file_name().and_then(|name| name.to_str()).unwrap_or("").to_string();
    if name.is_empty() || name.contains('/') || name.contains('\\') { return Err(translate(language, "名称无效", &[] as &[String])); }
    if meta.is_dir() {
        let mut children = Vec::new();
        for entry in fs::read_dir(path).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            children.push(read_source(&entry.path(), language, embed)?);
        }
        children.sort_by(|left, right| left["name"].as_str().unwrap_or("").cmp(right["name"].as_str().unwrap_or("")));
        return Ok(json!({ "name": name, "dir": true, "children": children }));
    }
    if !meta.is_file() { return Err(translate(language, "不支持此文件类型", &[] as &[String])); }
    let mut node = json!({ "name": name, "dir": false, "path": path.display().to_string(), "size": meta.len() });
    if embed {
        let bytes = fs::read(path).map_err(|error| error.to_string())?;
        node["data"] = json!(base64::engine::general_purpose::STANDARD.encode(bytes));
    }
    Ok(node)
}

fn tree_bytes(nodes: &[Value]) -> u64 {
    fn walk(node: &Value) -> u64 {
        if node["dir"].as_bool().unwrap_or(false) {
            node["children"].as_array().map(|children| children.iter().map(walk).sum()).unwrap_or(0)
        } else {
            node["size"].as_u64().unwrap_or(0)
        }
    }
    nodes.iter().map(walk).sum()
}

fn exists_remote(data: &Path, host: Option<&Value>, root: &str, relative: &str, language: &str) -> Result<bool, String> {
    let payload = json!({ "root": root, "relative": relative }).to_string();
    let output = run_helper(data, host, "exist", EXIST_PY, &payload, language)?;
    Ok(output.trim() == "yes")
}

fn stage(data: &Path, host: Option<&Value>, root: &str, parent: &str, items: &[Value], job: &Arc<Job>, emit: &Emit, language: &str) -> Result<Value, String> {
    if let Some(remote) = host.filter(|item| item["platform"].as_str() != Some("windows")) {
        return stage_linux(data, remote, root, parent, items, job, emit, language);
    }
    let payload = json!({
        "root": root,
        "parent": parent,
        "items": items,
        "errors": {
            "root": translate(language, "不能替换项目根目录", &[] as &[String]),
            "link": translate(language, "路径包含链接", &[] as &[String]),
            "name": translate(language, "名称无效", &[] as &[String])
        }
    }).to_string();
    let output = run_helper(data, host, "stage", STAGE_PY, &payload, language)?;
    serde_json::from_str(output.trim()).map_err(|_| translate(language, "远程版本响应无效", &[] as &[String]))
}

fn publish(data: &Path, host: Option<&Value>, root: &str, parent: &str, staged: &Value, language: &str) -> Result<Option<String>, String> {
    if let Some(remote) = host.filter(|item| item["platform"].as_str() != Some("windows")) {
        return publish_linux(data, remote, root, parent, staged, language);
    }
    let payload = json!({
        "root": root,
        "parent": parent,
        "items": staged,
        "errors": {
            "changed": translate(language, "目标已更改，原对象已保留", &[] as &[String]),
            "link": translate(language, "路径包含链接", &[] as &[String]),
            "missing": translate(language, "临时上传不存在", &[] as &[String]),
            "warning": translate(language, "AWB_WARNING:替换已完成，旧对象清理失败，保留于 ", &[] as &[String])
        }
    }).to_string();
    let output = run_helper(data, host, "publish", PUBLISH_PY, &payload, language)?;
    let output = output.trim();
    if let Some(rest) = output.strip_prefix("AWB_WARNING:") { return Ok(Some(rest.to_string())); }
    Ok(None)
}

fn remove_stages(data: &Path, host: Option<&Value>, root: &str, parent: &str, staged: &Value, language: &str) -> Result<(), String> {
    let payload = json!({ "root": root, "parent": parent, "items": staged }).to_string();
    run_helper(data, host, "remove", REMOVE_PY, &payload, language).map(|_| ())
}

struct ProgressWatch {
    stop: Arc<AtomicBool>,
    handle: Option<thread::JoinHandle<()>>,
}

impl Drop for ProgressWatch {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(handle) = self.handle.take() { let _ = handle.join(); }
    }
}

fn watch_progress(job: Arc<Job>, emit: Emit) -> ProgressWatch {
    let stop = Arc::new(AtomicBool::new(false));
    let flag = stop.clone();
    let handle = thread::spawn(move || {
        let mut last = Value::Null;
        let publish = |last: &mut Value| {
            let event = job.snapshot.lock().expect("snapshot").clone();
            let bytes = event["overallBytes"].clone();
            if bytes != *last {
                *last = bytes;
                emit(json!({ "channel": "transfer:update", "payload": event }));
            }
        };
        loop {
            publish(&mut last);
            if flag.load(Ordering::SeqCst) { break }
            thread::sleep(Duration::from_millis(15));
        }
        publish(&mut last);
    });
    ProgressWatch { stop, handle: Some(handle) }
}

fn note_bytes(job: &Job, bytes: u64) {
    let mut snapshot = job.snapshot.lock().expect("snapshot");
    snapshot["overallBytes"] = json!(bytes);
    snapshot["bytes"] = json!(bytes);
}

fn join_rel(parent: &str, name: &str) -> String {
    if parent.is_empty() { name.to_string() } else { format!("{parent}/{name}") }
}

fn quoted_message(language: &str, source: &str) -> String {
    serde_json::to_string(&translate(language, source, &[] as &[String])).unwrap_or_else(|_| "\"\"".into())
}

fn python_command(script: &str, args: &[String]) -> String {
    let mut parts = vec![String::from("python3"), String::from("-c"), ssh::bash_quote(script)];
    parts.extend(args.iter().map(|arg| ssh::bash_quote(arg)));
    parts.join(" ")
}

fn linux_entry(language: &str) -> String {
    r#"def entry_version(parent, name):
    try: fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK, dir_fd=parent)
    except FileNotFoundError: return "absent"
    try:
        before = os.fstat(fd)
        fields = lambda s: (s.st_dev, s.st_ino, s.st_mode, s.st_size, s.st_mtime_ns)
        digest = hashlib.sha256(repr(fields(before)).encode())
        if stat.S_ISDIR(before.st_mode):
            for child in sorted(os.listdir(fd)):
                version = entry_version(fd, child)
                if version == "absent": raise ValueError(@@CHANGING_DIR@@)
                digest.update(os.fsencode(child)); digest.update(bytes([0])); digest.update(version.encode())
            kind = "d"
        elif stat.S_ISREG(before.st_mode):
            while True:
                block = os.read(fd, 262144)
                if not block: break
                digest.update(block)
            kind = "f"
        else: raise ValueError(@@BAD_TYPE@@)
        after = os.fstat(fd)
        if fields(before) != fields(after) or before.st_ctime_ns != after.st_ctime_ns: raise ValueError(@@CHANGING@@)
        return kind + ":" + digest.hexdigest()
    finally: os.close(fd)

def open_parent(root, relative):
    parts = relative.split("/")
    if not relative or any(p in ("", ".", "..") for p in parts): raise ValueError(@@ROOT@@)
    parent = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for part in parts[:-1]:
            nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
            os.close(parent); parent = nxt
        return parent, parts[-1]
    except:
        os.close(parent); raise

def remove_entry(parent, name):
    info = os.stat(name, dir_fd=parent, follow_symlinks=False)
    if stat.S_ISDIR(info.st_mode):
        fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
        try:
            opened = os.fstat(fd)
            if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino): raise ValueError(@@TEMP@@)
            for child in os.listdir(fd): remove_entry(fd, child)
            current = os.stat(name, dir_fd=parent, follow_symlinks=False)
            if (current.st_dev, current.st_ino) != (opened.st_dev, opened.st_ino): raise ValueError(@@TEMP@@)
            os.rmdir(name, dir_fd=parent)
        finally: os.close(fd)
    else: os.unlink(name, dir_fd=parent)
"#
    .replace("@@CHANGING_DIR@@", &quoted_message(language, "目标目录正在更改"))
    .replace("@@BAD_TYPE@@", &quoted_message(language, "目标包含链接或不支持的文件类型"))
    .replace("@@CHANGING@@", &quoted_message(language, "目标正在更改"))
    .replace("@@ROOT@@", &quoted_message(language, "不能替换项目根目录"))
    .replace("@@TEMP@@", &quoted_message(language, "临时目录已更改"))
}

fn write_script(language: &str) -> String {
    r#"import os, signal, sys
root, relative, name, expected_text, temporary, expected_version = sys.argv[1:]
expected = int(expected_text)
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC
parent = os.open(root, flags)
def interrupted(signum, frame):
    raise InterruptedError(@@INTERRUPTED@@)
signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGHUP, interrupted)
created = False
try:
    for part in relative.split("/") if relative else []:
        new = os.open(part, flags | os.O_NOFOLLOW, dir_fd=parent)
        os.close(parent)
        parent = new
    output = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o600, dir_fd=parent)
    created = True
    try:
        remaining = expected
        while remaining:
            data = os.read(0, min(262144, remaining))
            if not data: raise EOFError(@@INCOMPLETE@@)
            view = memoryview(data)
            while view:
                written = os.write(output, view)
                view = view[written:]
            remaining -= len(data)
        if os.read(0, 1) != bytes([1]): raise EOFError(@@UNCONFIRMED@@)
        os.fsync(output)
    finally:
        os.close(output)
    os.link(temporary, name, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
finally:
    if created:
        try: os.unlink(temporary, dir_fd=parent)
        except FileNotFoundError: pass
    os.close(parent)
"#
    .replace("@@INTERRUPTED@@", &quoted_message(language, "传输中断"))
    .replace("@@INCOMPLETE@@", &quoted_message(language, "传输不完整"))
    .replace("@@UNCONFIRMED@@", &quoted_message(language, "传输未确认"))
}

fn publish_script(language: &str) -> String {
    let mut script = String::from("import ctypes, hashlib, os, stat, sys\n");
    script.push_str(&linux_entry(language));
    script.push_str(&r#"
root, relative, stage, expected = sys.argv[1:]
parent, name = open_parent(root, relative)
old_in_stage = False
try:
    staged = entry_version(parent, stage)
    if staged == "absent": raise ValueError(@@MISSING@@)
    if entry_version(parent, name) != expected: raise ValueError(@@CHANGED@@)
    libc = ctypes.CDLL(None, use_errno=True)
    rename = getattr(libc, "renameat2", None)
    if rename is None: raise ValueError(@@UNSAFE@@)
    rename.argtypes = (ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint)
    def move(flags):
        if rename(parent, os.fsencode(stage), parent, os.fsencode(name), flags) != 0:
            code = ctypes.get_errno(); raise OSError(code, os.strerror(code))
    if expected == "absent": move(1)
    else:
        move(2); old_in_stage = True
        if entry_version(parent, stage) != expected:
            if entry_version(parent, name) != staged: raise ValueError(@@CHANGING_AT@@ + stage)
            move(2); old_in_stage = False
            raise ValueError(@@CHANGED@@)
        try:
            remove_entry(parent, stage); old_in_stage = False
        except Exception:
            print(@@WARNING@@ + os.path.join(root, os.path.dirname(relative), stage))
finally:
    if not old_in_stage:
        try: remove_entry(parent, stage)
        except FileNotFoundError: pass
    os.close(parent)
"#
    .replace("@@MISSING@@", &quoted_message(language, "临时上传不存在"))
    .replace("@@CHANGED@@", &quoted_message(language, "目标已更改，原对象已保留"))
    .replace("@@UNSAFE@@", &quoted_message(language, "系统不支持安全目录替换"))
    .replace("@@CHANGING_AT@@", &quoted_message(language, "目标正在更改，原对象保留于 "))
    .replace("@@WARNING@@", &quoted_message(language, "AWB_WARNING:替换已完成，旧对象清理失败，保留于 ")));
    script
}

fn parse_version(output: &str, language: &str) -> Result<String, String> {
    let version = output.trim();
    let hex = version.len() == 66 && (version.starts_with("d:") || version.starts_with("f:")) && version[2..].chars().all(|char| char.is_ascii_hexdigit());
    if version == "absent" || hex { return Ok(version.to_string()) }
    Err(translate(language, "远程版本响应无效", &[] as &[String]))
}

fn remote_version(data: &Path, host: &Value, root: &str, relative: &str, language: &str) -> Result<String, String> {
    let script = format!("import hashlib, os, stat, sys\n{}\nparent, name = open_parent(sys.argv[1], sys.argv[2])\ntry:\n    print(entry_version(parent, name))\nfinally:\n    os.close(parent)\n", linux_entry(language));
    let command = python_command(&script, &[root.to_string(), relative.to_string()]);
    parse_version(&ssh::run(data, host, &command, None, language)?, language)
}

fn stream_tree(data: &Path, host: &Value, root: &str, remote_parent: &str, node: &Value, job: &Job, base: &mut u64, language: &str) -> Result<(), String> {
    let children = node["children"].as_array().cloned().unwrap_or_default();
    for child in children {
        if job.cancel.load(Ordering::SeqCst) { return Err(translate(language, "传输已取消", &[] as &[String])) }
        let name = child["name"].as_str().unwrap_or("").to_string();
        if child["dir"].as_bool().unwrap_or(false) {
            let command = ssh::linux_create_command(root, remote_parent, &name, true, language);
            ssh::run(data, host, &command, None, language)?;
            stream_tree(data, host, root, &join_rel(remote_parent, &name), &child, job, base, language)?;
        } else {
            let path = child["path"].as_str().unwrap_or("");
            let size = child["size"].as_u64().unwrap_or(0);
            let temporary = format!(".awb-upload-{}.tmp", random_id());
            let command = python_command(&write_script(language), &[root.to_string(), remote_parent.to_string(), name, size.to_string(), temporary, String::new()]);
            let start = *base;
            ssh::stream_file(data, host, &command, Path::new(path), size, &|sent| note_bytes(job, start + sent), &job.cancel, language)?;
            *base += size;
        }
    }
    Ok(())
}

fn stage_linux(data: &Path, host: &Value, root: &str, parent: &str, items: &[Value], job: &Arc<Job>, emit: &Emit, language: &str) -> Result<Value, String> {
    let _watch = watch_progress(job.clone(), emit.clone());
    let mut created = Vec::new();
    let mut base = job.snapshot.lock().expect("snapshot")["overallBytes"].as_u64().unwrap_or(0);
    let result = (|| -> Result<Value, String> {
        for item in items {
            if job.cancel.load(Ordering::SeqCst) { return Err(translate(language, "传输已取消", &[] as &[String])) }
            let name = item["name"].as_str().unwrap_or("").to_string();
            if name.is_empty() || name == "." || name == ".." || name.contains('/') || name.contains('\\') {
                return Err(translate(language, "名称无效", &[] as &[String]));
            }
            let relative = join_rel(parent, &name);
            let version = remote_version(data, host, root, &relative, language)?;
            let stage_name = format!(".awb-upload-tree-{}", random_id());
            created.push(json!({ "name": name, "stage": stage_name, "version": version }));
            if item["dir"].as_bool().unwrap_or(false) {
                let command = ssh::linux_create_command(root, parent, &stage_name, true, language);
                ssh::run(data, host, &command, None, language)?;
                stream_tree(data, host, root, &join_rel(parent, &stage_name), item, job, &mut base, language)?;
            } else {
                let path = item["path"].as_str().unwrap_or("");
                let size = item["size"].as_u64().unwrap_or(0);
                let temporary = format!(".awb-upload-{}.tmp", random_id());
                let command = python_command(&write_script(language), &[root.to_string(), parent.to_string(), stage_name.clone(), size.to_string(), temporary, String::new()]);
                let start = base;
                ssh::stream_file(data, host, &command, Path::new(path), size, &|sent| note_bytes(job, start + sent), &job.cancel, language)?;
                base += size;
            }
        }
        Ok(Value::Array(created.clone()))
    })();
    if result.is_err() { discard_stages(data, Some(host), root, parent, &Value::Array(created), language); }
    result
}

fn discard_stages(data: &Path, host: Option<&Value>, root: &str, parent: &str, staged: &Value, language: &str) {
    for _ in 0..40 {
        if remove_stages(data, host, root, parent, staged, language).is_ok() { return }
        thread::sleep(Duration::from_millis(50));
    }
}

fn publish_linux(data: &Path, host: &Value, root: &str, parent: &str, staged: &Value, language: &str) -> Result<Option<String>, String> {
    let mut warning = None;
    for item in staged.as_array().cloned().unwrap_or_default() {
        let name = item["name"].as_str().unwrap_or("");
        let stage = item["stage"].as_str().unwrap_or("");
        let version = item["version"].as_str().unwrap_or("");
        let relative = join_rel(parent, name);
        let command = python_command(&publish_script(language), &[root.to_string(), relative, stage.to_string(), version.to_string()]);
        let output = ssh::run(data, host, &command, None, language)?;
        if let Some(rest) = output.trim().strip_prefix("AWB_WARNING:") {
            if warning.is_none() { warning = Some(rest.to_string()); }
        }
    }
    Ok(warning)
}

fn run_helper(data: &Path, host: Option<&Value>, op: &str, script: &str, payload: &str, language: &str) -> Result<String, String> {
    if let Some(host) = host.filter(|host| host["platform"].as_str() == Some("windows")) {
        return ssh::run_loaded(data, host, &windows_upload_script(op, payload), language);
    }
    run_python(data, host, script, payload, language)
}

fn windows_upload_library(op: &str) -> String {
    format!(r#"$ErrorActionPreference='Stop'
function Get-AwbEntryVersion([string]$name) {{
  if(-not (Test-Path -LiteralPath $name)) {{ return 'absent' }}
  $item=Get-Item -LiteralPath $name -Force -ErrorAction Stop
  if($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {{ throw 'path contains a link' }}
  $hash=[Security.Cryptography.SHA256]::Create()
  try {{
    if($item.PSIsContainer) {{
      $parts=New-Object System.Collections.Generic.List[string]
      foreach($child in (Get-ChildItem -LiteralPath $name -Force | Sort-Object Name)) {{
        $version=Get-AwbEntryVersion $child.FullName
        $parts.Add($child.Name); $parts.Add($version)
      }}
      $digest=$hash.ComputeHash([Text.Encoding]::UTF8.GetBytes(($parts -join ([char]0))))
      return 'd:'+[BitConverter]::ToString($digest).Replace('-','').ToLowerInvariant()
    }}
    $stream=[IO.File]::Open($name,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try {{ $digest=$hash.ComputeHash($stream) }} finally {{ $stream.Dispose() }}
    return 'f:'+[BitConverter]::ToString($digest).Replace('-','').ToLowerInvariant()
  }} finally {{ $hash.Dispose() }}
}}
function Move-AwbEntry([string]$from,[string]$to) {{
  if((Get-Item -LiteralPath $from -Force).PSIsContainer) {{ [IO.Directory]::Move($from,$to) }} else {{ [IO.File]::Move($from,$to) }}
}}
function Remove-AwbStage([string]$name) {{
  if(-not (Test-Path -LiteralPath $name)) {{ return }}
  $null=Get-AwbEntryVersion $name
  Remove-Item -LiteralPath $name -Force -Recurse -ErrorAction Stop
}}
function Write-AwbNode($dest, $node) {{
  if($node.dir) {{
    New-Item -ItemType Directory -Path $dest -ErrorAction Stop | Out-Null
    foreach($child in @($node.children)) {{ Write-AwbNode (Join-Path $dest $child.name) $child }}
  }} else {{
    [IO.File]::WriteAllBytes($dest, [Convert]::FromBase64String([string]$node.data))
  }}
}}
# AWB_UPLOAD_OP {op}
$root = [IO.Path]::GetFullPath([string]$req.root)
$parent = if([string]::IsNullOrEmpty([string]$req.parent)) {{ $root }} else {{ Join-Path $root (([string]$req.parent) -replace '/','\') }}
if($parent -ne $root -and -not $parent.StartsWith($root + '\',[StringComparison]::OrdinalIgnoreCase)) {{ throw 'cannot replace the project root' }}
if('{op}' -eq 'exist') {{
  $rel = ([string]$req.relative).Trim('/')
  $path = if([string]::IsNullOrEmpty($rel)) {{ $root }} else {{ Join-Path $root ($rel -replace '/','\') }}
  if(Test-Path -LiteralPath $path) {{ 'yes' }} else {{ 'no' }}
  exit 0
}}
if('{op}' -eq 'remove') {{
  foreach($item in @($req.items)) {{
    $name=[string]$item.stage
    if(-not $name.StartsWith('.awb-upload-tree-')) {{ continue }}
    Remove-AwbStage (Join-Path $parent $name)
  }}
  'removed'
  exit 0
}}
if('{op}' -eq 'stage') {{
  $results=New-Object System.Collections.Generic.List[object]
  foreach($item in @($req.items)) {{
    $name=[string]$item.name
    if($name -eq '' -or $name -eq '.' -or $name -eq '..' -or $name.Contains('/') -or $name.Contains('\')) {{ throw 'invalid name' }}
    $dest=Join-Path $parent $name
    $expected=Get-AwbEntryVersion $dest
    $stage='.awb-upload-tree-' + [guid]::NewGuid().ToString()
    Write-AwbNode (Join-Path $parent $stage) $item
    $results.Add([pscustomobject]@{{ name=$name; stage=$stage; version=$expected }})
  }}
  $results | ConvertTo-Json -Compress
  exit 0
}}
if('{op}' -eq 'publish') {{
  foreach($item in @($req.items)) {{
    $dest=Join-Path $parent ([string]$item.name)
    $stage=Join-Path $parent ([string]$item.stage)
    if(-not (Test-Path -LiteralPath $stage)) {{ throw 'staged upload is missing' }}
    if((Get-AwbEntryVersion $dest) -ne [string]$item.version) {{
      Remove-AwbStage $stage
      throw 'target changed and the original was kept'
    }}
    $backup=Join-Path $parent ([string]$item.stage).Replace('tree-','backup-')
    $moved=$false
    if([string]$item.version -ne 'absent') {{ Move-AwbEntry $dest $backup; $moved=$true }}
    Move-AwbEntry $stage $dest
    if($moved) {{
      try {{ Remove-AwbStage $backup }} catch {{ Write-Output ('AWB_WARNING:' + $backup) }}
    }}
  }}
  exit 0
}}
"#)
}

/// The Windows upload script for one operation, with the request it acts on
/// written into it. The script reaches the host on its input, which it must
/// have to itself: the command line is too short to carry it. The request is
/// set where the script first reads it: every operation ends the script, so
/// nothing after them is reached.
fn windows_upload_script(op: &str, payload: &str) -> String {
    let quoted = payload.replace('\'', "''");
    windows_upload_library(op).replacen(&format!("# AWB_UPLOAD_OP {op}"), &format!("# AWB_UPLOAD_OP {op}\n$req = '{quoted}' | ConvertFrom-Json"), 1)
}

fn run_python(data: &Path, host: Option<&Value>, script: &str, payload: &str, language: &str) -> Result<String, String> {
    if let Some(host) = host {
        let command = format!("python3 -c {}", ssh::bash_quote(script));
        return ssh::run(data, host, &command, Some(payload.as_bytes()), language);
    }
    let mut child = std::process::Command::new("python3");
    child.arg("-c").arg(script).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    let mut child = child.spawn().map_err(|error| error.to_string())?;
    if let Some(mut stdin) = child.stdin.take() { use std::io::Write; let _ = stdin.write_all(payload.as_bytes()); }
    let output = child.wait_with_output().map_err(|error| error.to_string())?;
    if output.status.success() { return Ok(String::from_utf8_lossy(&output.stdout).into_owned()); }
    let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if detail.is_empty() { translate(language, "上传失败", &[] as &[String]) } else { detail })
}

const EXIST_PY: &str = r#"import json, os, sys
req = json.load(sys.stdin)
root = os.path.realpath(req["root"])
rel = req["relative"].strip("/")
path = root if not rel else os.path.realpath(os.path.join(root, rel))
print("yes" if os.path.lexists(path) else "no")
"#;

const STAGE_PY: &str = r#"import base64, hashlib, json, os, sys, uuid
req = json.load(sys.stdin)
root = os.path.realpath(req["root"])
parent_rel = req["parent"].strip("/")
parent = root if not parent_rel else os.path.realpath(os.path.join(root, parent_rel))
if parent != root and not parent.startswith(root + os.sep):
    raise SystemExit(req["errors"]["root"])
def version(path):
    if not os.path.lexists(path):
        return "absent"
    if os.path.islink(path):
        raise SystemExit(req["errors"]["link"])
    digest = hashlib.sha256()
    if os.path.isdir(path):
        for name in sorted(os.listdir(path)):
            child = os.path.join(path, name)
            if os.path.islink(child):
                raise SystemExit(req["errors"]["link"])
            digest.update(name.encode())
            digest.update(b"\0")
            digest.update(version(child).encode())
        return "d:" + digest.hexdigest()
    with open(path, "rb") as handle:
        digest.update(handle.read())
    return "f:" + digest.hexdigest()
def write_node(dest, node):
    if node["dir"]:
        os.mkdir(dest)
        for child in node["children"]:
            write_node(os.path.join(dest, child["name"]), child)
    else:
        with open(dest, "wb") as handle:
            handle.write(base64.b64decode(node["data"]))
results = []
for item in req["items"]:
    name = item["name"]
    if name in ("", ".", "..") or "/" in name or "\\" in name:
        raise SystemExit(req["errors"]["name"])
    dest = os.path.join(parent, name)
    if os.path.abspath(dest) == root:
        raise SystemExit(req["errors"]["root"])
    expected = version(dest)
    stage_name = ".awb-upload-tree-" + str(uuid.uuid4())
    write_node(os.path.join(parent, stage_name), item)
    results.append({"name": name, "stage": stage_name, "version": expected})
print(json.dumps(results))
"#;

const PUBLISH_PY: &str = r#"import hashlib, json, os, shutil, sys
req = json.load(sys.stdin)
root = os.path.realpath(req["root"])
parent_rel = req["parent"].strip("/")
parent = root if not parent_rel else os.path.realpath(os.path.join(root, parent_rel))
def version(path):
    if not os.path.lexists(path):
        return "absent"
    if os.path.islink(path):
        raise SystemExit(req["errors"]["link"])
    digest = hashlib.sha256()
    if os.path.isdir(path):
        for name in sorted(os.listdir(path)):
            child = os.path.join(path, name)
            if os.path.islink(child):
                raise SystemExit(req["errors"]["link"])
            digest.update(name.encode())
            digest.update(b"\0")
            digest.update(version(child).encode())
        return "d:" + digest.hexdigest()
    with open(path, "rb") as handle:
        digest.update(handle.read())
    return "f:" + digest.hexdigest()
warnings = []
for item in req["items"]:
    dest = os.path.join(parent, item["name"])
    stage = os.path.join(parent, item["stage"])
    if not os.path.lexists(stage):
        raise SystemExit(req["errors"]["missing"])
    if version(dest) != item["version"]:
        shutil.rmtree(stage) if os.path.isdir(stage) else os.remove(stage)
        raise SystemExit(req["errors"]["changed"])
    backup = os.path.join(parent, item["stage"].replace("tree-", "backup-", 1))
    if item["version"] != "absent":
        os.rename(dest, backup)
    os.rename(stage, dest)
    if item["version"] != "absent":
        try:
            shutil.rmtree(backup) if os.path.isdir(backup) else os.remove(backup)
        except OSError:
            warnings.append(req["errors"]["warning"] + backup)
if warnings:
    print(warnings[0])
"#;

const REMOVE_PY: &str = r#"import json, os, shutil, sys
req = json.load(sys.stdin)
root = os.path.realpath(req["root"])
parent_rel = req["parent"].strip("/")
parent = root if not parent_rel else os.path.realpath(os.path.join(root, parent_rel))
for item in req["items"]:
    name = item["stage"]
    if not name.startswith(".awb-upload-tree-"):
        continue
    path = os.path.join(parent, name)
    if os.path.isdir(path):
        shutil.rmtree(path)
    elif os.path.lexists(path):
        os.remove(path)
print("removed")
"#;
