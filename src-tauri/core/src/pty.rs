//! Local PTY sessions. Shell idle/busy follows the managed prompt OSC, not silence.

use crate::i18n::translate;
use crate::shells::{self, discover};
use crate::ssh;
use portable_pty::{CommandBuilder, PtySize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

type Emit = Arc<dyn Fn(Value) + Send + Sync>;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase { Starting, Prompt, Command, Dead }

struct Live {
    phase: Phase,
    state: String,
    exit_code: Option<i32>,
    started_at: Option<u64>,
    input_ready: bool,
    shell: String,
    kind: String,
    command: String,
    cwd: PathBuf,
    launched: bool,
    last_interrupt: Option<Instant>,
    restore: bool,
}

pub struct Manager {
    sessions: Mutex<HashMap<String, Session>>,
}

struct Session {
    live: Arc<Mutex<Live>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    stop: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    resize: Box<dyn Fn(u16, u16) + Send + Sync>,
}

impl Manager {
    pub fn new() -> Self { Self { sessions: Mutex::new(HashMap::new()) } }

    pub fn create(&self, data: &Path, id: &str, cwd: &Path, kind: &str, shell: &str, command: &str, agent_session: Option<&str>, restore: bool, language: &str, emit: Emit) -> Result<Value, String> {
        if !cwd.is_dir() { return Err(translate(language, "目录不存在", &[] as &[String])) }
        if kind != "shell" && agent_session.unwrap_or("").is_empty() && !load_history(data, id).is_empty() {
            return Err(translate(language, "无法唯一定位旧 Agent 对话，原终端历史已保留；未创建空白对话", &[] as &[String]));
        }
        let shells = discover();
        let use_zsh = shell == "zsh" && shells.iter().any(|item| item.id == "zsh");
        let shell_id = if use_zsh { "zsh" } else { "bash" };
        let binary = shells.iter().find(|item| item.id == shell_id).map(|item| item.path.clone())
            .ok_or_else(|| translate(language, "未检测到 {{0}}，请在设置中选择可用 Shell", &[shell_id.to_string()]))?;
        let (bash_rc, zsh_rc) = shells::ensure_shell_files(data)?;
        let system = portable_pty::native_pty_system();
        let pair = system.openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 }).map_err(|error| error.to_string())?;
        let mut builder = CommandBuilder::new(binary);
        if use_zsh {
            builder.arg("-i");
            builder.env("ZDOTDIR", zsh_rc.parent().unwrap_or(Path::new(".")));
        } else {
            let rc = bash_rc.to_string_lossy().into_owned();
            builder.arg("--noprofile");
            builder.arg("--rcfile");
            builder.arg(rc);
            builder.arg("-i");
        }
        builder.env("AWB_CWD", cwd);
        builder.env("TERM", "xterm-256color");
        builder.cwd(cwd);
        let child = pair.slave.spawn_command(builder).map_err(|error| error.to_string())?;
        let reader = pair.master.try_clone_reader().map_err(|error| error.to_string())?;
        let writer = pair.master.take_writer().map_err(|error| error.to_string())?;
        let child = Arc::new(Mutex::new(child));
        let master = Arc::new(Mutex::new(pair.master));
        let stop_child = child.clone();
        let resize_master = master.clone();
        let live = Arc::new(Mutex::new(Live {
            phase: Phase::Starting,
            state: "running".into(),
            exit_code: None,
            started_at: Some(now_ms()),
            input_ready: false,
            shell: shell_id.into(),
            kind: kind.into(),
            command: command.to_string(),
            cwd: cwd.to_path_buf(),
            launched: command.is_empty(),
            last_interrupt: None,
            restore,
        }));
        let session = Session {
            live: live.clone(),
            writer: Arc::new(Mutex::new(writer)),
            stop: Mutex::new(Some(Box::new(move || { let _ = stop_child.lock().expect("child").kill(); }))),
            resize: Box::new(move |cols, rows| { let _ = resize_master.lock().expect("master").resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }); }),
        };
        self.sessions.lock().expect("pty").insert(id.to_string(), session);
        spawn_reader(id.to_string(), data.to_path_buf(), reader, live.clone(), self.writer(id), emit.clone());
        let live_timer = live.clone();
        let writer_timer = self.writer(id);
        let emit_timer = emit;
        let id_timer = id.to_string();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(1200));
            arm(&id_timer, &live_timer, &writer_timer, &emit_timer, true);
        });
        let guard = live.lock().expect("pty live");
        let info = snapshot(id, &guard);
        drop(guard);
        Ok(info)
    }

    pub fn create_remote(&self, data: &Path, id: &str, cwd: &str, kind: &str, shell: &str, command: &str, agent_session: Option<&str>, restore: bool, host: &Value, language: &str, emit: Emit) -> Result<Value, String> {
        if kind != "shell" && agent_session.unwrap_or("").is_empty() && !load_history(data, id).is_empty() {
            return Err(translate(language, "无法唯一定位旧 Agent 对话，原终端历史已保留；未创建空白对话", &[] as &[String]));
        }
        let shell_id = if host["platform"] == "windows" { "pwsh" } else if shell == "zsh" { "zsh" } else { "bash" };
        let remote = ssh::open_shell(data, host, cwd, language)?;
        let live = Arc::new(Mutex::new(Live {
            phase: Phase::Starting,
            state: "running".into(),
            exit_code: None,
            started_at: Some(now_ms()),
            input_ready: false,
            shell: shell_id.into(),
            kind: kind.into(),
            command: command.to_string(),
            cwd: PathBuf::from(cwd),
            launched: command.is_empty(),
            last_interrupt: None,
            restore,
        }));
        let session = Session {
            live: live.clone(),
            writer: Arc::new(Mutex::new(remote.input)),
            stop: Mutex::new(Some(remote.stop)),
            resize: Box::new(|_, _| {}),
        };
        self.sessions.lock().expect("pty").insert(id.to_string(), session);
        spawn_reader(id.to_string(), data.to_path_buf(), remote.output, live.clone(), self.writer(id), emit.clone());
        let live_timer = live.clone();
        let writer_timer = self.writer(id);
        let emit_timer = emit;
        let id_timer = id.to_string();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(1200));
            arm(&id_timer, &live_timer, &writer_timer, &emit_timer, true);
        });
        let guard = live.lock().expect("pty live");
        let info = snapshot(id, &guard);
        drop(guard);
        Ok(info)
    }

    fn writer(&self, id: &str) -> Arc<Mutex<Box<dyn Write + Send>>> {
        self.sessions.lock().expect("pty").get(id).map(|session| session.writer.clone()).expect("session")
    }

    pub fn launch_meta(&self, id: &str) -> Option<(PathBuf, String, String, String)> {
        let sessions = self.sessions.lock().expect("pty");
        let live = sessions.get(id)?.live.lock().expect("pty live");
        Some((live.cwd.clone(), live.kind.clone(), live.shell.clone(), live.command.clone()))
    }

    pub fn write(&self, id: &str, data: &[u8], emit: &Emit) {
        let Some(session) = self.sessions.lock().expect("pty").get(id).map(|session| session.live.clone()) else { return };
        let writer = self.writer(id);
        let newline = data.contains(&b'\n') || data.contains(&b'\r');
        {
            let mut live = session.lock().expect("pty live");
            if live.phase == Phase::Dead { return }
            if newline && live.phase == Phase::Prompt {
                live.phase = Phase::Command;
                live.state = "running".into();
                live.input_ready = false;
                live.started_at = Some(now_ms());
                let event = snapshot(id, &live);
                drop(live);
                emit(json!({ "channel": "pty:event", "payload": event }));
            }
        }
        let _ = writer.lock().expect("writer").write_all(data);
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) {
        let sessions = self.sessions.lock().expect("pty");
        let Some(session) = sessions.get(id) else { return };
        (session.resize)(cols, rows);
    }

    pub fn interrupt(&self, id: &str, emit: &Emit) -> String {
        let Some(live) = self.sessions.lock().expect("pty").get(id).map(|session| session.live.clone()) else { return "signal".into() };
        let writer = self.writer(id);
        let mut live = live.lock().expect("pty live");
        if live.phase == Phase::Dead { return "signal".into() }
        let now = Instant::now();
        if live.state == "running" {
            if live.last_interrupt.is_some_and(|last| now.duration_since(last) < Duration::from_secs(4)) {
                live.last_interrupt = None;
                let _ = writer.lock().expect("writer").write_all(b"\x03");
                if live.kind == "shell" {
                    live.phase = Phase::Prompt;
                    live.state = "idle".into();
                    live.exit_code = None;
                    live.started_at = None;
                    live.input_ready = true;
                    let event = snapshot(id, &live);
                    drop(live);
                    emit(json!({ "channel": "pty:event", "payload": event }));
                }
                return "exit".into();
            }
            live.last_interrupt = Some(now);
            let _ = writer.lock().expect("writer").write_all(b"\x03");
            return "hint".into();
        }
        let _ = writer.lock().expect("writer").write_all(b"\x03");
        "signal".into()
    }

    pub fn close(&self, id: &str) {
        let Some(session) = self.sessions.lock().expect("pty").remove(id) else { return };
        if let Some(stop) = session.stop.lock().expect("stop").take() { stop(); }
        session.live.lock().expect("pty live").phase = Phase::Dead;
    }

    pub fn snapshot_of(&self, id: &str) -> Option<Value> {
        let sessions = self.sessions.lock().expect("pty");
        let session = sessions.get(id)?;
        let guard = session.live.lock().expect("pty live");
        let info = snapshot(id, &guard);
        drop(guard);
        Some(info)
    }
}

fn spawn_reader(id: String, data: PathBuf, mut reader: Box<dyn Read + Send>, live: Arc<Mutex<Live>>, writer: Arc<Mutex<Box<dyn Write + Send>>>, emit: Emit) {
    std::thread::spawn(move || {
        let mut pending = String::new();
        let mut raw = Vec::new();
        let mut buffer = [0u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(size) => {
                    raw.extend_from_slice(&buffer[..size]);
                    let split = match std::str::from_utf8(&raw) {
                        Ok(_) => raw.len(),
                        Err(error) => error.valid_up_to(),
                    };
                    if split == 0 && raw.len() < 4 { continue }
                    let text = String::from_utf8_lossy(&raw[..split.max(if split == 0 { raw.len() } else { split })]).into_owned();
                    if split == 0 { raw.clear(); } else { raw.drain(..split); }
                    pending.push_str(&text);
                    let (visible, prompts) = drain_prompts(&mut pending);
                    if !visible.is_empty() {
                        let restore = live.lock().expect("pty live").restore;
                        if restore { let _ = append_ansi(&data, &id, &visible); }
                        emit(json!({ "channel": "pty:event", "payload": { "type": "data", "id": id, "data": visible } }));
                    }
                    if !prompts.is_empty() { arm(&id, &live, &writer, &emit, false); }
                }
            }
        }
        let mut live = live.lock().expect("pty live");
        if live.phase != Phase::Dead {
            live.phase = Phase::Dead;
            live.state = "exited".into();
            live.exit_code = Some(0);
            live.input_ready = false;
            let event = snapshot(&id, &live);
            drop(live);
            emit(json!({ "channel": "pty:event", "payload": event }));
        }
    });
}

fn arm(id: &str, live: &Mutex<Live>, writer: &Mutex<Box<dyn Write + Send>>, emit: &Emit, from_timer: bool) {
    let mut live = live.lock().expect("pty live");
    if live.phase == Phase::Dead { return }
    if from_timer && live.phase != Phase::Starting { return }
    if !live.launched && !live.command.is_empty() {
        let command = format!("{}\n", live.command);
        live.launched = true;
        live.phase = Phase::Command;
        live.state = "running".into();
        live.input_ready = false;
        let _ = writer.lock().expect("writer").write_all(command.as_bytes());
    } else if live.command.is_empty() || live.phase == Phase::Command {
        live.phase = Phase::Prompt;
        live.state = "idle".into();
        live.input_ready = true;
        live.started_at = None;
        live.exit_code = None;
    }
    let event = snapshot(id, &live);
    drop(live);
    emit(json!({ "channel": "pty:event", "payload": event }));
}

fn drain_prompts(pending: &mut String) -> (String, Vec<i32>) {
    let mut visible = String::new();
    let mut codes = Vec::new();
    loop {
        let Some(start) = pending.find('\u{1b}') else {
            visible.push_str(pending);
            pending.clear();
            break;
        };
        visible.push_str(&pending[..start]);
        let rest = pending[start..].to_string();
        let Some(end) = rest.find('\u{7}') else {
            if rest.len() > 80 {
                visible.push_str(&rest[..1]);
                *pending = rest[1..].to_string();
                continue;
            }
            *pending = rest;
            break;
        };
        let sequence = &rest[..=end];
        if let Some(code) = sequence.strip_prefix("\u{1b}]777;awb;prompt;").and_then(|tail| tail.trim_end_matches('\u{7}').parse::<i32>().ok()) {
            codes.push(code);
        } else {
            visible.push_str(sequence);
        }
        *pending = rest[end + 1..].to_string();
    }
    (visible, codes)
}

fn snapshot(id: &str, live: &Live) -> Value {
    json!({
        "type": "state",
        "id": id,
        "state": live.state,
        "exitCode": live.exit_code,
        "startedAt": live.started_at,
        "inputReady": live.input_ready,
        "shell": live.shell,
        "kind": live.kind,
        "agentKind": Value::Null,
        "agentSessionId": Value::Null
    })
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|time| time.as_millis() as u64).unwrap_or(0)
}

pub fn history_name(id: &str) -> String {
    let digest = Sha256::digest(id.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn load_history(data: &Path, id: &str) -> String {
    std::fs::read_to_string(data.join("terminal-history").join(format!("{}.log", history_name(id)))).unwrap_or_default()
}

pub fn save_history(data: &Path, id: &str, text: &str) -> Result<(), String> {
    if id.is_empty() || text.is_empty() { return Ok(()) }
    let dir = data.join("terminal-history");
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let destination = dir.join(format!("{}.log", history_name(id)));
    let temporary = destination.with_extension("log.tmp");
    std::fs::write(&temporary, text).map_err(|error| error.to_string())?;
    std::fs::rename(&temporary, &destination).map_err(|error| error.to_string())?;
    Ok(())
}

fn append_ansi(data: &Path, id: &str, text: &str) -> Result<(), String> {
    if text.is_empty() { return Ok(()) }
    let dir = data.join("terminal-history");
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let path = dir.join(format!("{}.ansi", history_name(id)));
    let mut file = std::fs::OpenOptions::new().create(true).append(true).open(path).map_err(|error| error.to_string())?;
    file.write_all(text.as_bytes()).map_err(|error| error.to_string())?;
    Ok(())
}

pub fn prune_history(data: &Path, ids: &[String]) {
    let keep: std::collections::HashSet<String> = ids.iter().map(|id| history_name(id)).collect();
    let Ok(entries) = std::fs::read_dir(data.join("terminal-history")) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(stem) = name.strip_suffix(".log").or_else(|| name.strip_suffix(".ansi")) else { continue };
        if keep.contains(stem) { continue }
        let _ = std::fs::remove_file(entry.path());
    }
}
