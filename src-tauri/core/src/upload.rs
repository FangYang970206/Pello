//! Remote upload. A same-name file is overwritten and a same-name directory is
//! replaced as a whole after the temporary tree is complete and its version matches.
//! Cancel and failure remove only the temporary tree. The source is copied.

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
}

pub struct Service {
    jobs: Mutex<std::collections::HashMap<String, Arc<Job>>>,
}

impl Service {
    pub fn new() -> Self { Self { jobs: Mutex::new(std::collections::HashMap::new()) } }

    pub fn start(&self, data: PathBuf, host: Option<Value>, project_id: String, root: String, parent: String, sources: Vec<String>, dirty: bool, language: String, emit: Emit) -> Result<Value, String> {
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
        });
        self.jobs.lock().expect("uploads").insert(id.clone(), job.clone());
        let jobs = self.jobs.lock().expect("uploads").get(&id).cloned().unwrap();
        thread::spawn(move || run_job(jobs, data, host, project_id, root, parent, sources, dirty, language, emit));
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
        let project_id = snapshot["projectId"].as_str().unwrap_or("").to_string();
        let root = snapshot["destination"].as_str().unwrap_or("").to_string();
        self.start(data, host, project_id, root, parent, sources, false, language, emit)
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

fn run_job(job: Arc<Job>, data: PathBuf, host: Option<Value>, project_id: String, root: String, parent: String, sources: Vec<String>, dirty: bool, language: String, emit: Emit) {
    let case_insensitive = host.as_ref().and_then(|item| item["platform"].as_str()) == Some("windows");
    let mut replaced = Vec::new();
    let outcome = (|| -> Result<(), String> {
        let mut nodes = Vec::new();
        let mut replacing = false;
        for source in &sources {
            let node = read_source(Path::new(source), &language)?;
            let name = node["name"].as_str().unwrap_or("");
            let relative = if parent.is_empty() { name.to_string() } else { format!("{parent}/{name}") };
            if relative.is_empty() || relative == "." { return Err(translate(&language, "不能替换项目根目录", &[] as &[String])); }
            if exists_remote(&data, host.as_ref(), &root, &relative, &language)? {
                replacing = true;
                replaced.push(relative);
            }
            nodes.push(node);
        }
        if job.cancel.load(Ordering::SeqCst) { return Err(translate(&language, "传输已取消", &[] as &[String])); }
        if dirty && replacing {
            set_phase(&job, "confirming", &emit);
            emit(json!({ "channel": "file:replacement", "payload": {
                "id": job.snapshot.lock().expect("snapshot")["id"],
                "projectId": project_id,
                "path": parent,
                "directory": true,
                "caseInsensitive": case_insensitive,
                "targets": [{ "projectId": project_id, "path": parent }],
                "phase": "prepare"
            }}));
            if !wait_decision(&job) {
                return Err(translate(&language, "覆盖已取消，原文件和草稿已保留", &[] as &[String]));
            }
        }
        set_phase(&job, "transferring", &emit);
        let staged = stage(&data, host.as_ref(), &root, &parent, &nodes, &language)?;
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
        let warning = publish(&data, host.as_ref(), &root, &parent, &staged, &language)?;
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
    let targets = replaced.iter().map(|path| json!({ "projectId": project_id, "path": path })).collect::<Vec<_>>();
    let primary = targets.first().cloned().unwrap_or_else(|| json!({ "projectId": project_id, "path": parent }));
    emit(json!({ "channel": "file:replacement", "payload": {
        "id": job.snapshot.lock().expect("snapshot")["id"],
        "phase": "finish",
        "success": job.snapshot.lock().expect("snapshot")["phase"] == "done",
        "projectId": primary["projectId"],
        "path": primary["path"],
        "directory": false,
        "caseInsensitive": case_insensitive,
        "targets": targets
    } }));
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

fn read_source(path: &Path, language: &str) -> Result<Value, String> {
    let meta = fs::symlink_metadata(path).map_err(|_| translate(language, "无法检查来源", &[] as &[String]))?;
    if meta.file_type().is_symlink() { return Err(translate(language, "不上传符号链接", &[] as &[String])); }
    let name = path.file_name().and_then(|name| name.to_str()).unwrap_or("").to_string();
    if name.is_empty() || name.contains('/') || name.contains('\\') { return Err(translate(language, "名称无效", &[] as &[String])); }
    if meta.is_dir() {
        let mut children = Vec::new();
        for entry in fs::read_dir(path).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            children.push(read_source(&entry.path(), language)?);
        }
        children.sort_by(|left, right| left["name"].as_str().unwrap_or("").cmp(right["name"].as_str().unwrap_or("")));
        return Ok(json!({ "name": name, "dir": true, "children": children }));
    }
    if !meta.is_file() { return Err(translate(language, "不支持此文件类型", &[] as &[String])); }
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    Ok(json!({ "name": name, "dir": false, "data": base64::engine::general_purpose::STANDARD.encode(bytes) }))
}

fn exists_remote(data: &Path, host: Option<&Value>, root: &str, relative: &str, language: &str) -> Result<bool, String> {
    let payload = json!({ "root": root, "relative": relative }).to_string();
    let output = run_helper(data, host, "exist", EXIST_PY, &payload, language)?;
    Ok(output.trim() == "yes")
}

fn stage(data: &Path, host: Option<&Value>, root: &str, parent: &str, items: &[Value], language: &str) -> Result<Value, String> {
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

fn run_helper(data: &Path, host: Option<&Value>, op: &str, script: &str, payload: &str, language: &str) -> Result<String, String> {
    if host.and_then(|host| host["platform"].as_str()) == Some("windows") {
        let command = windows_upload_script(op);
        return ssh::run(data, host.expect("windows host"), &command, Some(payload.as_bytes()), language);
    }
    run_python(data, host, script, payload, language)
}

fn windows_upload_script(op: &str) -> String {
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
$req = [Console]::In.ReadToEnd() | ConvertFrom-Json
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
    $backup=Join-Path $parent (([string]$item.stage) -replace 'tree-','backup-',1)
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
