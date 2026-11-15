//! Local file import. A name that already exists waits for skip, overwrite, or
//! cancel. Remote uploads stay on the upload service and do not ask.

use crate::i18n::translate;
use crate::random_id;
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
    waiting: AtomicBool,
    snapshot: Mutex<Value>,
    choice: Mutex<Option<String>>,
    cv: Condvar,
}

pub struct Imports {
    jobs: Mutex<std::collections::HashMap<String, Arc<Job>>>,
}

impl Imports {
    pub fn new() -> Self { Self { jobs: Mutex::new(std::collections::HashMap::new()) } }

    pub fn waiting(&self, id: &str) -> bool {
        self.jobs.lock().expect("imports").get(id).is_some_and(|job| job.waiting.load(Ordering::SeqCst))
    }

    pub fn decide(&self, id: &str, choice: &str, language: &str) -> Result<Value, String> {
        let job = self.jobs.lock().expect("imports").get(id).cloned()
            .ok_or_else(|| translate(language, "没有等待处理的冲突", &[] as &[String]))?;
        if !job.waiting.load(Ordering::SeqCst) || !["skip", "keep", "cancel", "merge", "overwrite"].contains(&choice) {
            return Err(translate(language, "没有等待处理的冲突", &[] as &[String]));
        }
        *job.choice.lock().expect("choice") = Some(choice.to_string());
        job.cv.notify_all();
        Ok(Value::Null)
    }

    pub fn cancel(&self, id: &str) -> bool {
        let Some(job) = self.jobs.lock().expect("imports").get(id).cloned() else { return false };
        job.cancel.store(true, Ordering::SeqCst);
        *job.choice.lock().expect("choice") = Some("cancel".to_string());
        job.cv.notify_all();
        true
    }

    pub fn dismiss(&self, id: &str) -> bool {
        let mut jobs = self.jobs.lock().expect("imports");
        let Some(job) = jobs.get(id) else { return false };
        let state = job.snapshot.lock().expect("snapshot")["state"].as_str().unwrap_or("").to_string();
        if state == "completed" || state == "cancelled" { jobs.remove(id); }
        true
    }

    pub fn start(&self, project_id: String, root: PathBuf, parent: String, sources: Vec<String>, language: String, emit: Emit) -> Result<Value, String> {
        if sources.is_empty() { return Err(translate(&language, "请选择文件或文件夹", &[] as &[String])); }
        let destination = if parent.is_empty() { root } else { root.join(&parent) };
        if !destination.is_dir() { return Err(translate(&language, "目标不是目录", &[] as &[String])); }
        let id = random_id();
        let job = Arc::new(Job {
            cancel: AtomicBool::new(false),
            waiting: AtomicBool::new(false),
            snapshot: Mutex::new(json!({
                "id": id,
                "projectId": project_id,
                "state": "running",
                "current": "",
                "destination": destination.display().to_string(),
                "bytes": 0,
                "total": 0,
                "items": []
            })),
            choice: Mutex::new(None),
            cv: Condvar::new(),
        });
        self.jobs.lock().expect("imports").insert(id.clone(), job.clone());
        thread::spawn(move || run(job, destination, sources, language, emit));
        Ok(json!(id))
    }
}

fn emit_snapshot(job: &Job, emit: &Emit) {
    let event = job.snapshot.lock().expect("snapshot").clone();
    emit(json!({ "channel": "transfer:update", "payload": event }));
}

fn run(job: Arc<Job>, destination: PathBuf, sources: Vec<String>, language: String, emit: Emit) {
    let outcome = (|| -> Result<(), String> {
        for source in &sources {
            if job.cancel.load(Ordering::SeqCst) { return Err(translate(&language, "传输已取消", &[] as &[String])); }
            let source_path = PathBuf::from(source);
            let name = source_path.file_name().and_then(|name| name.to_str()).unwrap_or("").to_string();
            if name.is_empty() || !source_path.exists() {
                return Err(translate(&language, "无法读取拖入文件的本机路径", &[] as &[String]));
            }
            let target = destination.join(&name);
            if target.exists() {
                {
                    let mut snapshot = job.snapshot.lock().expect("snapshot");
                    snapshot["state"] = json!("conflicts");
                    snapshot["current"] = json!(name);
                    snapshot["pendingConflicts"] = json!(1);
                    snapshot["items"] = json!([{
                        "source": source,
                        "destination": target.display().to_string(),
                        "status": "conflict",
                        "replaceable": source_path.is_file()
                    }]);
                }
                job.waiting.store(true, Ordering::SeqCst);
                emit_snapshot(&job, &emit);
                let choice = wait_choice(&job);
                job.waiting.store(false, Ordering::SeqCst);
                *job.choice.lock().expect("choice") = None;
                match choice.as_str() {
                    "skip" => {}
                    "overwrite" => copy_entry(&source_path, &target)?,
                    _ => return Err(translate(&language, "传输已取消", &[] as &[String])),
                }
                let mut snapshot = job.snapshot.lock().expect("snapshot");
                snapshot["items"][0]["status"] = json!("done");
                snapshot["pendingConflicts"] = json!(0);
            } else {
                copy_entry(&source_path, &target)?;
            }
        }
        Ok(())
    })();
    {
        let mut snapshot = job.snapshot.lock().expect("snapshot");
        snapshot["state"] = json!(if outcome.is_ok() { "completed" } else { "cancelled" });
    }
    emit_snapshot(&job, &emit);
}

fn wait_choice(job: &Job) -> String {
    let mut guard = job.choice.lock().expect("choice");
    loop {
        if let Some(choice) = guard.clone() { return choice; }
        if job.cancel.load(Ordering::SeqCst) { return "cancel".to_string(); }
        let (next, _) = job.cv.wait_timeout(guard, Duration::from_millis(200)).expect("choice wait");
        guard = next;
    }
}

fn copy_entry(source: &Path, target: &Path) -> Result<(), String> {
    if source.is_dir() { copy_dir(source, target) } else {
        if let Some(parent) = target.parent() { fs::create_dir_all(parent).map_err(|error| error.to_string())?; }
        fs::copy(source, target).map(|_| ()).map_err(|error| error.to_string())
    }
}

fn copy_dir(source: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir_all(target).map_err(|error| error.to_string())?;
    for entry in fs::read_dir(source).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let next = target.join(entry.file_name());
        if entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) { copy_dir(&entry.path(), &next)?; }
        else { fs::copy(entry.path(), next).map_err(|error| error.to_string())?; }
    }
    Ok(())
}
