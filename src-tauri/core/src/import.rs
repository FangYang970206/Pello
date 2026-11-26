//! Local import. The whole batch is checked for names that exist already
//! before anything is copied; each conflict waits for skip, keep both, merge
//! or overwrite, and a choice can cover the conflicts of the same kind. A
//! file is copied to a temporary file next to the target and published by a
//! hard link, so a name that appears meanwhile is never taken over without
//! being asked about. Remote uploads stay on the upload service and do not ask.

use crate::file_id::{FileId, Kind, Stamp};
use crate::i18n::translate;
use crate::random_id;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::Duration;

type Emit = Arc<dyn Fn(Value) + Send + Sync>;
type Entry = (PathBuf, PathBuf);

struct Job {
    project_id: String,
    /// The directory the entries were asked to be imported into.
    root: PathBuf,
    cancel: AtomicBool,
    snapshot: Mutex<Value>,
    /// The answer to the conflict on show: the choice and whether it is to
    /// cover the conflicts of the same kind.
    decision: Mutex<Option<(String, bool)>>,
    decision_cv: Condvar,
    /// What the page said about replacing files: `None` until it has said.
    permission: Mutex<Option<bool>>,
    permission_cv: Condvar,
    /// Set while the page is being asked about a replacement, so that none
    /// of the files is saved under it.
    block: Mutex<Option<Block>>,
    /// The other projects on this machine, which may lie on the files a
    /// replacement touches.
    projects: Vec<Value>,
    /// Whether the page has unsaved drafts, which are asked about first.
    dirty: Arc<Mutex<bool>>,
    emit: Emit,
    /// Set once the thread that runs the transfer has nothing more to do,
    /// which is what closing the workbench waits for.
    done: Mutex<bool>,
    done_cv: Condvar,
}

struct Block {
    targets: Vec<Value>,
    directory: bool,
    case_insensitive: bool,
}

pub struct Imports {
    jobs: Mutex<HashMap<String, Arc<Job>>>,
}

impl Imports {
    pub fn new() -> Self { Self { jobs: Mutex::new(HashMap::new()) } }

    pub fn start(&self, project_id: String, root: PathBuf, parent: String, sources: Vec<String>, projects: Vec<Value>, dirty: Arc<Mutex<bool>>, language: String, emit: Emit) -> Result<Value, String> {
        if sources.is_empty() { return Err(translate(&language, "请选择文件或文件夹", &[] as &[String])); }
        let destination = if parent.is_empty() { root } else { root.join(&parent) };
        if !destination.is_dir() { return Err(translate(&language, "目标不是目录", &[] as &[String])); }
        let entries = sources.iter().map(|source| {
            let source = PathBuf::from(source);
            (source.clone(), destination.join(source.file_name().unwrap_or_default()))
        }).collect();
        self.start_entries(project_id, destination, entries, projects, dirty, language, emit, false)
    }

    fn start_entries(&self, project_id: String, destination: PathBuf, entries: Vec<Entry>, projects: Vec<Value>, dirty: Arc<Mutex<bool>>, language: String, emit: Emit, keep_both: bool) -> Result<Value, String> {
        {
            let mut jobs = self.jobs.lock().expect("imports");
            // Finished transfers are kept for retry and for keeping both;
            // fifty is the limit, past which the finished ones make room.
            if jobs.len() >= 50 {
                let finished: Vec<String> = jobs.iter().filter(|(_, job)| is_over(job)).map(|(id, _)| id.clone()).collect();
                for id in finished { jobs.remove(&id); }
            }
        }
        let id = random_id();
        let job = Arc::new(Job {
            project_id: project_id.clone(),
            root: destination.clone(),
            cancel: AtomicBool::new(false),
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
            decision: Mutex::new(None),
            decision_cv: Condvar::new(),
            permission: Mutex::new(None),
            permission_cv: Condvar::new(),
            block: Mutex::new(None),
            projects,
            dirty,
            emit: emit.clone(),
            done: Mutex::new(false),
            done_cv: Condvar::new(),
        });
        self.jobs.lock().expect("imports").insert(id.clone(), job.clone());
        let told = Arc::clone(&job);
        thread::spawn(move || {
            run(job, entries, keep_both, language);
            *told.done.lock().expect("done") = true;
            told.done_cv.notify_all();
        });
        Ok(json!(id))
    }

    pub fn cancel(&self, id: &str) -> bool {
        let Some(job) = self.jobs.lock().expect("imports").get(id).cloned() else { return false };
        job.stop();
        true
    }

    /// Whether a conflict of this transfer is on show, waiting for a choice.
    pub fn waiting(&self, id: &str) -> bool {
        self.jobs.lock().expect("imports").get(id).is_some_and(|job| job.snapshot.lock().expect("snapshot")["state"] == "conflicts")
    }

    /// The page has said whether the files it was asked about may be replaced.
    pub fn allow(&self, id: &str, allow: bool) -> bool {
        let Some(job) = self.jobs.lock().expect("imports").get(id).cloned() else { return false };
        *job.permission.lock().expect("permission") = Some(allow);
        job.permission_cv.notify_all();
        true
    }

    pub fn project_id(&self, id: &str) -> Option<String> {
        self.jobs.lock().expect("imports").get(id).map(|job| job.project_id.clone())
    }

    pub fn decide(&self, id: &str, choice: &str, apply: bool, language: &str) -> Result<Value, String> {
        let job = self.jobs.lock().expect("imports").get(id).cloned()
            .ok_or_else(|| translate(language, "传输任务不存在", &[] as &[String]))?;
        let waiting = job.snapshot.lock().expect("snapshot")["state"].as_str() == Some("conflicts");
        if !waiting || !["skip", "keep", "cancel", "merge", "overwrite"].contains(&choice) {
            return Err(translate(language, "没有等待处理的冲突", &[] as &[String]));
        }
        let item = job.snapshot.lock().expect("snapshot")["items"][0].clone();
        validate(&item, choice, language)?;
        *job.decision.lock().expect("decision") = Some((choice.to_string(), apply));
        job.decision_cv.notify_all();
        Ok(Value::Null)
    }

    pub fn dismiss(&self, id: &str) -> bool {
        let mut jobs = self.jobs.lock().expect("imports");
        let Some(job) = jobs.get(id) else { return false };
        if is_over(job) { jobs.remove(id); }
        true
    }

    pub fn context(&self, id: &str, language: &str) -> Result<(String, PathBuf), String> {
        let job = self.jobs.lock().expect("imports").get(id).cloned()
            .ok_or_else(|| translate(language, "传输任务不存在", &[] as &[String]))?;
        Ok((job.project_id.clone(), job.root.clone()))
    }

    pub fn retry(&self, id: &str, language: String) -> Result<Value, String> {
        let job = self.job(id, &language)?;
        let snapshot = job.snapshot.lock().expect("snapshot").clone();
        if !["completed", "cancelled"].contains(&snapshot["state"].as_str().unwrap_or("")) {
            return Err(translate(&language, "传输任务不存在或尚未结束", &[] as &[String]));
        }
        let entries: Vec<Entry> = snapshot["items"].as_array().map(|items| items.iter().filter_map(|item| {
            let failed = item["status"] == "failed" && item["source"].as_str().is_some_and(|source| !source.is_empty()) && item["error"] != "部分内容未能复制";
            failed.then(|| (PathBuf::from(item["source"].as_str().unwrap_or("")), PathBuf::from(item["destination"].as_str().unwrap_or(""))))
        }).collect()).unwrap_or_default();
        if entries.is_empty() { return Err(translate(&language, "没有可重试的失败项", &[] as &[String])); }
        self.start_entries(job.project_id.clone(), job.root.clone(), entries, job.projects.clone(), job.dirty.clone(), language, job.emit.clone(), false)
    }

    pub fn keep_both(&self, id: &str, language: String) -> Result<Value, String> {
        let job = self.job(id, &language)?;
        let snapshot = job.snapshot.lock().expect("snapshot").clone();
        if !["completed", "cancelled"].contains(&snapshot["state"].as_str().unwrap_or("")) {
            return Err(translate(&language, "传输任务不存在或尚未结束", &[] as &[String]));
        }
        let entries: Vec<Entry> = snapshot["items"].as_array().map(|items| items.iter().filter_map(|item| {
            (item["status"] == "conflict").then(|| (PathBuf::from(item["source"].as_str().unwrap_or("")), PathBuf::from(item["destination"].as_str().unwrap_or(""))))
        }).collect()).unwrap_or_default();
        if entries.is_empty() { return Err(translate(&language, "没有同名冲突项", &[] as &[String])); }
        self.start_entries(job.project_id.clone(), job.root.clone(), entries, job.projects.clone(), job.dirty.clone(), language, job.emit.clone(), true)
    }

    /// The window is closing: every transfer still running is cancelled and
    /// waited for, for at most as long as `limit`. Whether any was still
    /// running when the time was up.
    pub fn shutdown(&self, limit: Duration) -> bool {
        let jobs: Vec<Arc<Job>> = self.jobs.lock().expect("imports").values().filter(|job| !is_over(job)).cloned().collect();
        for job in &jobs { job.stop(); }
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

    pub fn write_blocked(&self, project_id: &str, rel: &str) -> bool {
        self.jobs.lock().expect("imports").values().any(|job| blocks(job, project_id, rel))
    }

    /// A tree entry is about to be moved: it is refused while what the job
    /// is replacing is it, lies in it, or lies in the entry when that is a
    /// folder.
    pub fn move_blocked(&self, project_id: &str, rel: &str, directory: bool) -> bool {
        self.jobs.lock().expect("imports").values().any(|job| {
            let guard = job.block.lock().expect("block");
            guard.as_ref().is_some_and(|block| in_the_way(block, project_id, rel, directory))
        })
    }

    fn job(&self, id: &str, language: &str) -> Result<Arc<Job>, String> {
        self.jobs.lock().expect("imports").get(id).cloned().ok_or_else(|| translate(language, "传输任务不存在", &[] as &[String]))
    }
}

impl Job {
    /// Ends the transfer: a conflict on show and a question about replacing
    /// files are answered by it, so that nothing is left waiting for the page.
    fn stop(&self) {
        self.cancel.store(true, Ordering::SeqCst);
        *self.decision.lock().expect("decision") = Some(("cancel".to_string(), false));
        *self.permission.lock().expect("permission") = Some(false);
        self.decision_cv.notify_all();
        self.permission_cv.notify_all();
    }
}

fn is_over(job: &Job) -> bool {
    matches!(job.snapshot.lock().expect("snapshot")["state"].as_str(), Some("completed" | "cancelled"))
}

fn blocks(job: &Job, project_id: &str, rel: &str) -> bool {
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
fn in_the_way(block: &Block, project_id: &str, rel: &str, directory: bool) -> bool {
    block.targets.iter().any(|target| {
        if target["projectId"].as_str() != Some(project_id) { return false }
        let path = target["path"].as_str().unwrap_or("");
        let (path, rel) = if block.case_insensitive { (path.to_lowercase(), rel.to_lowercase()) } else { (path.to_string(), rel.to_string()) };
        rel == path || (block.directory && (path.is_empty() || rel.starts_with(&format!("{path}/")))) || (directory && !rel.is_empty() && path.starts_with(&format!("{rel}/")))
    })
}

fn emit_snapshot(job: &Job, emit: &Emit) {
    let event = job.snapshot.lock().expect("snapshot").clone();
    emit(json!({ "channel": "transfer:update", "payload": event }));
}

/// Waits for the choice made about the conflict on show. Cancelling the
/// transfer ends the wait.
fn wait_decision(job: &Job) -> Option<(String, bool)> {
    let mut guard = job.decision.lock().expect("decision");
    loop {
        if let Some(answer) = guard.clone() { return Some(answer); }
        if job.cancel.load(Ordering::SeqCst) { return None; }
        let (next, _) = job.decision_cv.wait_timeout(guard, Duration::from_millis(40)).expect("decision");
        guard = next;
    }
}

/// Waits until the page has said whether the files may be replaced. Cancelling
/// the transfer answers no.
fn wait_permission(job: &Job) -> bool {
    let mut guard = job.permission.lock().expect("permission");
    loop {
        if let Some(allow) = *guard { return allow; }
        if job.cancel.load(Ordering::SeqCst) { return false; }
        let (next, _) = job.permission_cv.wait_timeout(guard, Duration::from_millis(40)).expect("permission");
        guard = next;
    }
}

/// Where an entry is written relative to the project, as the page spells
/// paths: forward slashes, and lowercase on a system that ignores case.
fn entry_key(root: &Path, path: &Path) -> String {
    let text = match path.strip_prefix(root) {
        Ok(relative) => relative.to_string_lossy().replace('\\', "/"),
        Err(_) => path.to_string_lossy().replace('\\', "/"),
    };
    if cfg!(windows) { text.to_lowercase() } else { text }
}

/// A choice made for the conflicts of one kind, for the rest of this transfer.
#[derive(Default)]
struct Policy {
    choices: HashMap<&'static str, String>,
}

impl Policy {
    fn kind(item: &Value) -> &'static str {
        if item["mergeable"] == true { "directory" } else if item["replaceable"] == true { "file" } else { "other" }
    }

    fn get(&self, item: &Value) -> Option<String> { self.choices.get(Self::kind(item)).cloned() }

    fn remember(&mut self, item: &Value, choice: &str, language: &str) -> Result<(), String> {
        validate(item, choice, language)?;
        if choice != "cancel" { self.choices.insert(Self::kind(item), choice.to_string()); }
        Ok(())
    }
}

fn validate(item: &Value, choice: &str, language: &str) -> Result<(), String> {
    if !["skip", "keep", "cancel", "merge", "overwrite"].contains(&choice)
        || (choice == "merge" && item["mergeable"] != true)
        || (choice == "overwrite" && item["replaceable"] != true) {
        return Err(translate(language, "此冲突不支持所选处理方式", &[] as &[String]));
    }
    Ok(())
}

/// What has been decided about the names that exist already, each by the
/// source it comes from and the name it would take.
#[derive(Default)]
struct Plan {
    root: PathBuf,
    skipped: HashSet<(String, String)>,
    kept: HashSet<(String, String)>,
    /// The file to be replaced, as it was when the choice to replace it was
    /// made: the replacement is made only while it is still this one.
    replacements: HashMap<(String, String), Stamp>,
    /// The directory to be merged into, as it was when that was chosen.
    merges: HashMap<(String, String), FileId>,
    /// What is at each name that exists already.
    observed: HashMap<PathBuf, Stamp>,
    policy: Policy,
}

impl Plan {
    fn new(root: PathBuf) -> Self {
        Self { root, ..Self::default() }
    }

    fn key(&self, source: &Path, target: &Path) -> (String, String) {
        (entry_key(&self.root, source), entry_key(&self.root, target))
    }

    /// Notes the choice made for one conflict, for the copy to act on.
    fn select(&mut self, item: &Value, choice: &str) {
        let source = PathBuf::from(item["source"].as_str().unwrap_or(""));
        let target = PathBuf::from(item["destination"].as_str().unwrap_or(""));
        let key = self.key(&source, &target);
        match choice {
            "skip" => { self.skipped.insert(key); }
            "keep" => { self.kept.insert(key); }
            "overwrite" => { if let Some(stamp) = self.observed.get(&target) { self.replacements.insert(key, stamp.clone()); } }
            "merge" => { if let Some(stamp) = self.observed.get(&target) { self.merges.insert(key, stamp.id); } }
            _ => {}
        }
    }

    /// Walks the entries and gathers the names that exist already and have
    /// no decision yet. A directory chosen to be merged into is walked into,
    /// so that the files in it are asked about too.
    fn scan(&mut self, entries: &[Entry], job: &Job, language: &str) -> Result<Vec<Value>, String> {
        let mut found = Vec::new();
        let mut seen: HashSet<PathBuf> = HashSet::new();
        for (source, target) in entries {
            if job.cancel.load(Ordering::SeqCst) { break; }
            self.visit(source, target, &mut seen, &mut found, job, language)?;
        }
        Ok(found)
    }

    fn visit(&mut self, source: &Path, target: &Path, seen: &mut HashSet<PathBuf>, found: &mut Vec<Value>, job: &Job, language: &str) -> Result<(), String> {
        if job.cancel.load(Ordering::SeqCst) { return Ok(()); }
        let key = self.key(source, target);
        if self.skipped.contains(&key) || self.kept.contains(&key) || self.replacements.contains_key(&key) { return Ok(()); }
        self.check_parent(target, language)?;
        // Two entries of the batch that would take one name are one conflict.
        let duplicate = !seen.insert(target.to_path_buf());
        // A broken link is there too, as `lstat` finds it in the Electron build.
        let target_info = crate::file_id::inspect(target);
        if target_info.is_none() && !duplicate { return Ok(()); }
        let source_info = crate::file_id::inspect(source);        let is = |info: &Option<(Kind, Option<Stamp>)>, kind: Kind| {
            info.map(|(found, _)| found == kind).unwrap_or(false)
        };
        let mergeable = is(&target_info, Kind::Directory) && is(&source_info, Kind::Directory) && !duplicate;
        let replaceable = is(&target_info, Kind::File) && is(&source_info, Kind::File) && !duplicate;
        let item = json!({ "source": source.display().to_string(), "destination": target.display().to_string(), "status": "conflict", "mergeable": mergeable, "replaceable": replaceable });
        if let Some((_, Some(stamp))) = &target_info { self.observed.insert(target.to_path_buf(), *stamp); }
        let approved = self.merges.get(&key).copied();
        if let Some(approved) = approved {
            // The directory that was chosen must still be the same one.
            if !mergeable || target_info.and_then(|(_, stamp)| stamp).map(|stamp| stamp.id) != Some(approved) {
                return Err(translate(language, "目标目录已更改，请重新检查", &[] as &[String]));
            }
        } else {
            match self.policy.get(&item) {
                None => { found.push(item); return Ok(()); }
                Some(remembered) => self.select(&item, &remembered),
            }
        }
        if self.merges.contains_key(&key) {
            self.check_parent(&target.join("_"), language)?;
            let mut children: Vec<PathBuf> = fs::read_dir(source).map_err(|error| error.to_string())?
                .filter_map(|child| child.ok().map(|child| child.path())).collect();
            children.sort();
            for child in children {
                if job.cancel.load(Ordering::SeqCst) { break; }
                let name = child.file_name().unwrap_or_default();
                self.visit(&child, &target.join(name), seen, found, job, language)?;
            }
        }
        Ok(())
    }

    /// The directory a file is written into must be the project's own, not a
    /// link out of it and not swapped for another since the batch began.
    fn check_parent(&self, target: &Path, language: &str) -> Result<(), String> {
        let parent = target.parent().unwrap_or(Path::new(""));
        let relative = match parent.strip_prefix(&self.root) {
            Ok(relative) => relative,
            Err(_) => return Err(translate(language, "目标超出项目目录", &[] as &[String])),
        };
        if relative.components().any(|part| matches!(part, std::path::Component::ParentDir)) {
            return Err(translate(language, "目标超出项目目录", &[] as &[String]));
        }
        let resolved = crate::real_path(parent).map_err(|error| error.to_string())?;
        let same = if cfg!(windows) {
            resolved.to_string_lossy().to_lowercase() == parent.to_string_lossy().to_lowercase()
        } else {
            resolved == parent
        };
        if !same { return Err(translate(language, "目标目录已变更或包含链接", &[] as &[String])); }
        Ok(())
    }
}

fn run(job: Arc<Job>, entries: Vec<Entry>, keep_both: bool, language: String) {
    // The status bar is told at once that a transfer is going on, so that it
    // has something to show while the batch is still being checked.
    emit_snapshot(&job, &job.emit);
    let outcome = (|| -> Result<(), String> {
        let real_destination = crate::real_path(&job.root).map_err(|error| error.to_string())?;
        let mut plan = Plan::new(real_destination.clone());
        // A transfer that keeps both names has nothing to ask: every name
        // that exists already gets another one.
        if !keep_both {
            let mut conflicts = plan.scan(&entries, &job, &language)?;
            while !conflicts.is_empty() && !job.cancel.load(Ordering::SeqCst) {
                // One conflict is on show at a time; how many are waiting
                // after it is said with it.
                {
                    let mut snapshot = job.snapshot.lock().expect("snapshot");
                    snapshot["items"] = json!([conflicts[0].clone()]);
                    snapshot["pendingConflicts"] = json!(conflicts.len());
                    snapshot["state"] = json!("conflicts");
                }
                emit_snapshot(&job, &job.emit);
                let Some((choice, apply)) = wait_decision(&job) else { break };
                *job.decision.lock().expect("decision") = None;
                if choice == "cancel" { job.cancel.store(true, Ordering::SeqCst); break; }
                if apply { plan.policy.remember(&conflicts[0], &choice, &language)?; }
                plan.select(&conflicts[0], &choice);
                conflicts = plan.scan(&entries, &job, &language)?;
            }
            {
                let mut snapshot = job.snapshot.lock().expect("snapshot");
                snapshot["items"] = json!([]);
                snapshot.as_object_mut().expect("snapshot").remove("pendingConflicts");
                if !job.cancel.load(Ordering::SeqCst) { snapshot["state"] = json!("running"); }
            }
            emit_snapshot(&job, &job.emit);
        }
        for (source, target) in &entries {
            if job.cancel.load(Ordering::SeqCst) { break; }
            let real_source = match crate::real_path(source) {
                Ok(real) => real,
                Err(error) => {
                    result(&job, &source.display().to_string(), target, "failed", Some(&error.to_string()), &job.emit);
                    continue;
                }
            };
            // Nothing is imported into the folder it comes from, or into a
            // folder inside that one.
            let inside = real_destination.strip_prefix(&real_source).is_ok();
            if inside {
                let error = translate(&language, "不能导入到来源目录自身或其子目录", &[] as &[String]);
                result(&job, &source.display().to_string(), target, "failed", Some(&error), &job.emit);
                continue;
            }
            let _ = copy_entry(&job, &mut plan, source, target, keep_both, &language);
        }
        Ok(())
    })();
    match outcome {
        Ok(_) => {}
        Err(error) => {
            if !job.cancel.load(Ordering::SeqCst) {
                result(&job, "", &job.root, "failed", Some(&error), &job.emit);
            }
        }
    }
    finish(&job);
}

/// Ends the transfer: nothing is current any more, and it ended on its own
/// or because it was cancelled.
fn finish(job: &Job) {
    {
        let mut snapshot = job.snapshot.lock().expect("snapshot");
        snapshot["current"] = json!("");
        snapshot["state"] = json!(if job.cancel.load(Ordering::SeqCst) { "cancelled" } else { "completed" });
    }
    emit_snapshot(job, &job.emit);
}

/// What a transfer says about one entry when it is over. The error is given
/// in the transfer's language by the one that met it.
fn result(job: &Job, source: &str, target: &Path, status: &str, error: Option<&str>, emit: &Emit) {
    let mut snapshot = job.snapshot.lock().expect("snapshot");
    let mut item = json!({ "source": source, "destination": target.display().to_string(), "status": status });
    if let Some(error) = error { item["error"] = json!(error); }
    snapshot["items"].as_array_mut().expect("items").push(item);
    drop(snapshot);
    emit_snapshot(job, emit);
}

/// The next free name for an entry that is to keep both: `name (2).txt`.
fn alternate(original: &Path, index: u32) -> PathBuf {
    let directory = original.is_dir();
    let extension = if directory { None } else { original.extension().map(|value| value.to_os_string()) };
    let stem = original.file_stem().unwrap_or_default().to_os_string();
    let mut name = format!("{} ({index})", stem.to_string_lossy());
    if let Some(extension) = extension { name.push('.'); name.push_str(&extension.to_string_lossy()); }
    original.with_file_name(name)
}

/// Puts a copied file under its name without taking a name that was taken
/// meanwhile: the link is made to the name, which fails if something is
/// there. `None` then, unless both are to be kept, in which case the next
/// free name is taken. The name actually taken is given back.
fn publish(temporary: &Path, target: &Path, keep_both: bool, language: &str) -> Result<Option<PathBuf>, String> {
    let original = target.to_path_buf();
    let mut target = original.clone();
    for index in 0u32.. {
        match fs::hard_link(temporary, &target) {
            Ok(()) => return Ok(Some(target)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.to_string()),
        }
        // A name that was taken meanwhile is a conflict that was not asked
        // about, unless both are to be kept.
        if !keep_both { return Ok(None); }
        if index >= 10_000 { return Err(translate(language, "无法找到可用名称", &[] as &[String])); }
        target = alternate(&original, index + 1);
    }
    unreachable!("the loop ends by returning")
}

/// Asks the page whether the files may be replaced, and keeps the files from
/// being saved under the replacement meanwhile. `false` when the page
/// refused or the transfer was cancelled.
fn guard_replacement(job: &Job, project_id: &str, replaced: &[(&Path, bool)]) -> bool {
    let (targets, directory) = replacement_targets(project_id, &job.root, replaced, &job.projects);
    *job.block.lock().expect("block") = Some(Block { targets: targets.clone(), directory, case_insensitive: cfg!(windows) });
    let id = job.snapshot.lock().expect("snapshot")["id"].as_str().unwrap_or("").to_string();
    let event = |phase: &str, success: Option<bool>| {
        let mut payload = json!({ "id": id, "phase": phase, "projectId": targets[0]["projectId"], "path": targets[0]["path"],
            "directory": directory, "caseInsensitive": cfg!(windows), "targets": targets });
        if let Some(success) = success { payload["success"] = json!(success); }
        json!({ "channel": "file:replacement", "payload": payload })
    };
    let allowed = (|| {
        // Only drafts are asked about: with none open the files are replaced.
        if !*job.dirty.lock().expect("dirty") { return true; }
        *job.permission.lock().expect("permission") = None;
        (job.emit)(event("prepare", None));
        wait_permission(job)
    })();
    *job.block.lock().expect("block") = None;
    (job.emit)(event("finish", Some(allowed)));
    allowed
}

/// The projects and paths a replacement touches: the project itself, and
/// any other local project that lies on the replaced files or inside a
/// replaced directory. A path is given relative to the root of the project
/// it belongs to.
fn replacement_targets(project_id: &str, root: &Path, replaced: &[(&Path, bool)], projects: &[Value]) -> (Vec<Value>, bool) {
    let slash = |path: &Path| path.to_string_lossy().replace('\\', "/");
    let real = |path: &Path| crate::real_path(path).ok();
    let real_root = real(root).unwrap_or_else(|| root.to_path_buf());
    let mut targets = Vec::new();
    let directory = replaced.iter().any(|(_, dir)| *dir);
    for (path, dir) in replaced {
        targets.push(json!({ "projectId": project_id, "path": slash(path.strip_prefix(&real_root).unwrap_or(path)) }));
        let real_path = real(path).unwrap_or_else(|| path.to_path_buf());
        for project in projects {
            let Some(other) = real(Path::new(project["path"].as_str().unwrap_or(""))) else { continue };
            // The replaced path is inside the other project, or is its root.
            if let Ok(relative) = real_path.strip_prefix(&other) {
                targets.push(json!({ "projectId": project["id"], "path": slash(relative) }));
                continue;
            }
            // A replaced directory holds the other project: all of it is touched.
            if *dir && other.strip_prefix(&real_path).is_ok_and(|relative| !relative.as_os_str().is_empty()) {
                targets.push(json!({ "projectId": project["id"], "path": "" }));
            }
        }
    }
    (targets, directory)
}

/// Copies one entry, a file or a folder, and tells how it went.
fn copy_entry(job: &Job, plan: &mut Plan, source: &Path, target: &Path, keep_both: bool, language: &str) -> Result<(), String> {
    let key = plan.key(source, target);
    if plan.skipped.contains(&key) {
        result(job, &source.display().to_string(), target, "conflict", Some(&translate(language, "已跳过同名对象", &[] as &[String])), &job.emit);
        return Ok(());
    }
    if job.cancel.load(Ordering::SeqCst) { return Ok(()); }
    let keep_both = keep_both || plan.kept.contains(&key);
    let outcome = (|| -> Result<(), String> {
        plan.check_parent(target, language)?;
        let (kind, stamp) = crate::file_id::inspect(source).ok_or_else(|| translate(language, "无法读取拖入文件的本机路径", &[] as &[String]))?;
        if kind == Kind::Other { return Err(translate(language, "不导入符号链接", &[] as &[String])); }
        if same_file(source, target) { return Err(translate(language, "不能覆盖来源文件自身", &[] as &[String])); }
        if kind == Kind::Directory { return copy_folder(job, plan, source, target, keep_both, language); }        let Some(stamp) = stamp else { return Err(translate(language, "不支持此文件类型", &[] as &[String])); };
        copy_file(job, plan, source, target, &key, keep_both, stamp, language)
    })();
    // A failure that stopped the copy is told here, but not when the
    // transfer was cancelled: what was copied has told itself already.
    if let Err(error) = &outcome {
        if !job.cancel.load(Ordering::SeqCst) {
            result(job, &source.display().to_string(), target, "failed", Some(error), &job.emit);
        }
    }
    outcome
}

/// Says that a transfer is going on: what is being copied, into which
/// directory, and how much of it.
fn progress(job: &Job, source: &Path, directory: &Path, bytes: u64, total: u64, emit: &Emit) {
    {
        let mut snapshot = job.snapshot.lock().expect("snapshot");
        snapshot["current"] = json!(source.display().to_string());
        snapshot["destination"] = json!(directory.display().to_string());
        snapshot["bytes"] = json!(bytes);
        snapshot["total"] = json!(total);
    }
    emit_snapshot(job, emit);
}

/// Copies one file to a temporary file next to where it goes, then puts it
/// under its name. A file that is replaced is replaced only while it is
/// still the file the conflict about it was answered for.
fn copy_file(job: &Job, plan: &mut Plan, source: &Path, target: &Path, key: &(String, String), keep_both: bool, stamp: Stamp, language: &str) -> Result<(), String> {
    let directory = target.parent().unwrap_or(target).to_path_buf();
    progress(job, source, &directory, 0, stamp.size, &job.emit);
    let temporary = directory.join(format!(".awb-transfer-{}.tmp", random_id()));
    let outcome = (|| -> Result<(), String> {
        let mut input = fs::File::open(source).map_err(|error| error.to_string())?;
        let mut output = fs::OpenOptions::new().write(true).create_new(true).open(&temporary).map_err(|error| error.to_string())?;
        let mut buffer = vec![0u8; 256 * 1024];
        let mut bytes = 0u64;
        loop {
            if job.cancel.load(Ordering::SeqCst) { return Ok(()); }
            let read = input.read(&mut buffer).map_err(|error| error.to_string())?;
            if read == 0 { break; }
            output.write_all(&buffer[..read]).map_err(|error| error.to_string())?;
            bytes += read as u64;
            progress(job, source, &directory, bytes, stamp.size, &job.emit);
        }
        if job.cancel.load(Ordering::SeqCst) { return Ok(()); }
        plan.check_parent(target, language)?;
        let name = match plan.replacements.get(key).cloned() {
            Some(expected) => {
                if !guard_replacement(job, &job.project_id, &[(target, false)]) || job.cancel.load(Ordering::SeqCst) {
                    return Err(translate(language, "覆盖已取消，原文件和草稿已保留", &[] as &[String]));
                }
                plan.check_parent(target, language)?;
                let Some((_, Some(current))) = crate::file_id::inspect(target) else { return Err(translate(language, "目标文件已更改，请重新检查冲突", &[] as &[String])); };
                if current != expected { return Err(translate(language, "目标文件已更改，请重新检查冲突", &[] as &[String])); }
                fs::rename(&temporary, target).map_err(|error| error.to_string())?;
                target.to_path_buf()
            }
            None => match publish(&temporary, target, keep_both, language)? {
                None => { result(job, &source.display().to_string(), target, "conflict", None, &job.emit); return Ok(()); }
                Some(name) => name,
            },
        };
        result(job, &source.display().to_string(), &name, "done", None, &job.emit);
        Ok(())
    })();
    // The temporary file goes whatever happened; only what was published
    // under a name stays.
    let _ = fs::remove_file(&temporary);
    outcome
}

/// Whether two paths lead to one file.
fn same_file(one: &Path, other: &Path) -> bool {
    match (crate::file_id::inspect(one), crate::file_id::inspect(other)) {
        (Some((_, Some(one))), Some((_, Some(other)))) => one.id == other.id,
        _ => false,
    }
}

/// Copies a folder and what is in it. Each file in it tells how its own
/// copy went; the folder is told as failed when anything in it did not go.
fn copy_folder(job: &Job, plan: &mut Plan, source: &Path, target: &Path, keep_both: bool, language: &str) -> Result<(), String> {
    let original = target.to_path_buf();
    let mut target = original.clone();
    for index in 0u32.. {
        // The name is looked at as it is now, so that one taken instead is
        // not mistaken for the one that was chosen.
        if let Some(approved) = plan.merges.get(&plan.key(source, &target)).copied() {
            // The folder chosen to be merged into must still be that folder.
            let Some((Kind::Directory, Some(current))) = crate::file_id::inspect(&target) else { return Err(translate(language, "目标目录已变更，请重新检查", &[] as &[String])); };
            if current.id != approved { return Err(translate(language, "目标目录已变更，请重新检查", &[] as &[String])); }
            plan.check_parent(&target.join("_"), language)?;
            break;
        }
        match fs::create_dir(&target) {
            Ok(()) => break,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.to_string()),
        }
        // A name that exists already is a conflict that was not asked about,
        // unless both are to be kept.
        if !keep_both {
            result(job, &source.display().to_string(), &target, "conflict", None, &job.emit);
            return Ok(());
        }
        if index >= 10_000 { return Err(translate(language, "无法找到可用名称", &[] as &[String])); }
        target = alternate(&original, index + 1);
    }
    let before = job.snapshot.lock().expect("snapshot")["items"].as_array().map(|items| items.len()).unwrap_or(0);
    let mut children: Vec<PathBuf> = fs::read_dir(source).map_err(|error| error.to_string())?
        .filter_map(|child| child.ok().map(|child| child.path())).collect();
    children.sort();
    for child in children {
        if job.cancel.load(Ordering::SeqCst) { break; }
        let name = child.file_name().unwrap_or_default();
        let _ = copy_entry(job, plan, &child, &target.join(name), keep_both, language);
    }
    if job.cancel.load(Ordering::SeqCst) { return Ok(()); }
    let failed = job.snapshot.lock().expect("snapshot")["items"].as_array()
        .map(|items| items[before..].iter().any(|item| item["status"] != "done"))
        .unwrap_or(false);
    let error = failed.then(|| translate(language, "部分内容未能复制", &[] as &[String]));
    result(job, &source.display().to_string(), &target, if failed { "failed" } else { "done" }, error.as_deref(), &job.emit);
    Ok(())
}
