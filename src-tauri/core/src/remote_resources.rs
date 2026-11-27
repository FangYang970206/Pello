//! An agent's resources on a remote host: the host is asked with the
//! program of [crate::remote_resource_program], and what it answers is
//! used in place of the files themselves. A request that changes something
//! is approved in two steps, so that the workbench can see that the host
//! still is the one it asked and that nothing changed in between. What the
//! host says is bounded, as what a search or an upload says is.
use crate::i18n::translate;
use crate::remote_resource_program::remote_resource_program;
use crate::ssh::open_resource_stream;
use serde_json::{json, Value};
use std::path::Path;
use std::time::{Duration, Instant};

/// Above this what the host says is not taken: it is more than any
/// resource of an agent is, and the workbench would only run out of
/// memory reading it.
const LIMIT: usize = 48 * 1024 * 1024;
/// How long the host has to answer, from the command being started to its
/// being ended.
const TIMEOUT: Duration = Duration::from_secs(25);

fn t(language: &str, text: &str) -> String {
    translate(language, text, &[] as &[String])
}

/// Ask a remote host to do one thing with an agent's resources, and say
/// what it answers. `guard` is asked before anything is sent, once the host
/// has said it is ready to change something, and so is the fingerprint of
/// the scope the thing is done for: a host or a template changed in between
/// is refused rather than written to as it was. `cancel` ends the asking.
pub fn remote_resource<T: serde::de::DeserializeOwned>(
    data: &Path,
    host: &Value,
    request: &Value,
    guard: &dyn Fn() -> Result<(), String>,
    cancel: Option<&crate::ssh::CancelFlag>,
    language: &str,
) -> Result<T, String> {
    guard()?;
    let operation = request["op"].as_str().unwrap_or("");
    let commit = matches!(operation, "write" | "rename" | "mkdir");
    let args = remote_resource_program(host["platform"].as_str().unwrap_or("linux"), operation, language)?;
    let command = crate::ssh::remote_command(host["platform"].as_str().unwrap_or("linux"), &args);
    let started = Instant::now();
    let deadline = started + TIMEOUT;
    let mut stream = open_resource_stream(data, host, &command, language)?;
    // The host has until one moment to answer, from before the connection
    // was made to the command's end: a host that says nothing is not waited
    // for forever, wherever the waiting is.
    stream.set_deadline(deadline);
    let mut pieces: Vec<u8> = Vec::new();
    let mut ready = !commit;
    let payload = format!("{}\n", request.to_string());
    if commit {
        // The request is given first, and the host is told to go on only
        // once it has said that it is ready.
        stream.write(payload.as_bytes());
    } else {
        stream.write(payload.as_bytes());
        stream.close_input();
    }
    let mut buffer = [0u8; 16 * 1024];
    let stopped = cancel.map(|flag| flag.clone());
    loop {
        if let Some(flag) = &stopped {
            if flag.is_stopped() { return Err(t(language, "已取消")) }
        }
        if started.elapsed() >= TIMEOUT { return Err(t(language, "SSH 连接超时")) }
        let size = stream.read(&mut buffer)?;
        if size == 0 { break }
        pieces.extend_from_slice(&buffer[..size]);
        if pieces.len() > LIMIT { return Err(t(language, "远程输出过大")) }
        if !ready && pieces.len() >= 3 {
            if String::from_utf8_lossy(&pieces).trim() != "OK" { return Err(t(language, "远程资源写入准备失败")) }
            pieces.clear();
            ready = true;
            guard()?;
            stream.write(b"1\n");
            stream.close_input();
        }
    }
    stream.finish()?;
    // An operation that changes something says nothing of it: it is asked
    // for as an option, and what is not said is nothing.
    let output = String::from_utf8_lossy(&pieces).trim().to_string();
    serde_json::from_str::<T>(if output.is_empty() { "null" } else { &output }).map_err(|error| error.to_string())
}

/// What a host says of itself when asked: where the user's home is, which
/// of the variables that move an agent's files are set, and where the
/// OpenCode configuration written as JSON with comments is, if it is there.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RemoteProfile {
    pub home: String,
    #[serde(default)]
    pub env: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    pub jsonc: String,
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
struct FileEntry {
    path: String,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    stamp: Option<String>,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
struct Snapshot {
    #[serde(default)]
    files: Vec<FileEntry>,
    #[serde(default)]
    skills: Vec<String>,
    #[serde(default)]
    errors: Vec<String>,
}

/// What a host said of an agent's files when it was asked once: every file
/// read then, and every Skill found then. A change asked of it is kept
/// until it is published, and published as one request, so that what the
/// page showed is what the host had when it is asked to change it.
pub struct RemoteResourceSnapshot {
    files: std::collections::BTreeMap<String, FileEntry>,
    skills: Vec<String>,
    errors: Vec<String>,
    change: Option<Value>,
}

impl RemoteResourceSnapshot {
    /// The file as the host had it when asked; an error if it could not be
    /// read then, and nothing if it was not there.
    pub fn read(&self, file: &str) -> Result<String, String> {
        let entry = self.files.get(file);
        if let Some(error) = entry.and_then(|entry| entry.error.as_deref()) { return Err(error.to_string()) }
        Ok(entry.and_then(|entry| entry.content.clone()).unwrap_or_default())
    }

    /// Whether the host had the file when asked, or could not read it: a
    /// file that is there and cannot be read is not a file that is not
    /// there.
    pub fn exists(&self, file: &str) -> bool {
        self.files.get(file).is_some_and(|entry| entry.content.is_some() || entry.error.is_some())
    }

    /// Keep a change to be published: the file as it is to be. The version
    /// the host said it had is what the change is checked against there.
    pub fn write(&mut self, file: &str, _before: &str, next: &str) -> Result<(), String> {
        self.change = Some(json!({ "op": "write", "path": file, "stamp": self.files.get(file).and_then(|entry| entry.stamp.clone()).unwrap_or_default(), "content": next }));
        Ok(())
    }

    /// The Skills the host said it had, with what it could not look into.
    pub fn skills(&self, _roots: &[String], errors: &mut Vec<String>) -> Vec<String> {
        errors.extend(self.errors.iter().cloned());
        self.skills.clone()
    }

    /// Keep a Skill to be moved under its new name.
    pub fn rename_skill(&mut self, root: &str, source: &str, dest: &str) -> Result<(), String> {
        self.change = Some(json!({ "op": "rename", "root": root, "path": source, "dest": dest, "stamp": self.files.get(source).and_then(|entry| entry.stamp.clone()).unwrap_or_default() }));
        Ok(())
    }

    /// Ask the host to make the change kept, if there is one.
    pub fn publish(&self, data: &Path, host: &Value, guard: &dyn Fn() -> Result<(), String>, language: &str) -> Result<(), String> {
        let Some(change) = &self.change else { return Ok(()) };
        remote_resource::<Option<Value>>(data, host, change, guard, None, language).map(|_| ())
    }
}

/// Ask a host once for every file and every Skill an operation needs, as
/// the Electron build asks: the files by name, and the Skills under the
/// roots given.
pub fn remote_snapshot(
    data: &Path,
    host: &Value,
    files: &[String],
    roots: &[String],
    guard: &dyn Fn() -> Result<(), String>,
    cancel: Option<&crate::ssh::CancelFlag>,
    language: &str,
) -> Result<RemoteResourceSnapshot, String> {
    let files: Vec<String> = files.iter().filter(|file| !file.is_empty()).cloned().collect();
    let snapshot = remote_resource::<Snapshot>(data, host, &json!({ "op": "snapshot", "files": files, "roots": roots }), guard, cancel, language)?;
    Ok(RemoteResourceSnapshot {
        files: snapshot.files.into_iter().map(|entry| (entry.path.clone(), entry)).collect(),
        skills: snapshot.skills,
        errors: snapshot.errors,
        change: None,
    })
}

/// The folder a host has at a path, or its home if none is given: the
/// path, the one above it if there is one, the folders in it, and, when
/// asked, the files.
pub fn browse_remote_resources(data: &Path, host: &Value, input: &str, files: bool, language: &str) -> Result<Value, String> {
    #[derive(serde::Deserialize)]
    struct Listed {
        path: String,
        #[serde(default)]
        parent: Option<String>,
        #[serde(default)]
        dirs: Vec<String>,
        #[serde(default)]
        files: Vec<String>,
    }
    let listed = remote_resource::<Listed>(data, host, &json!({ "op": "browse", "path": input }), &|| Ok(()), None, language)?;
    let windows = host["platform"].as_str() == Some("windows");
    let entries = |names: Vec<String>| {
        let mut names = names;
        names.sort();
        names.into_iter().map(|name| json!({ "name": name, "path": host_path::join(&listed.path, &name, windows) })).collect::<Vec<_>>()
    };
    let mut result = json!({ "path": listed.path, "parent": listed.parent, "dirs": entries(listed.dirs) });
    if files { result["files"] = json!(entries(listed.files)); }
    Ok(result)
}

/// Paths as the host writes them, whichever platform the workbench runs
/// on: joined and taken apart by the separators of the host's platform.
pub mod host_path {
    /// Join two parts of a path as the host's platform writes them.
    pub fn join(base: &str, name: &str, windows: bool) -> String {
        if base.is_empty() { return name.to_string() }
        if windows {
            if base.ends_with('\\') || base.ends_with('/') { format!("{base}{name}") } else { format!("{base}\\{name}") }
        } else if base.ends_with('/') {
            format!("{base}{name}")
        } else {
            format!("{base}/{name}")
        }
    }

    /// The folder a path is in, as the host's platform writes it.
    pub fn dirname(path: &str, windows: bool) -> String {
        let separators: &[char] = if windows { &['\\', '/'] } else { &['/'] };
        match path.rfind(separators) {
            Some(0) => path[..1].to_string(),
            Some(at) => path[..at].to_string(),
            None => ".".to_string(),
        }
    }
}
