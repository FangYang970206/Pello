//! PTY sessions. Completion comes from the shell prompt marker, OSC 7501, or a lifecycle hook.
//! Process liveness, Enter, and silence do not mark an agent idle. OSC 7501 wins over OSC 9;4.

use crate::i18n::translate;
use crate::shells::{self, discover};
use crate::ssh;
use portable_pty::{CommandBuilder, PtySize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

type Emit = Arc<dyn Fn(Value) + Send + Sync>;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase { Starting, Prompt, Command, Dead }

#[derive(Clone, Copy, PartialEq, Eq)]
enum Protocol { Program, Progress, Lifecycle }

struct Report {
    state: &'static str,
    app: Option<String>,
    session: Option<String>,
    protocol: Protocol,
}

struct Activity {
    text: String,
    reports: Vec<Report>,
    queries: usize,
}

struct ProgramStatus {
    pending: String,
}

impl ProgramStatus {
    fn push(&mut self, chunk: &str) -> Activity {
        self.pending.push_str(chunk);
        let mut text = String::new();
        let mut reports = Vec::new();
        let mut queries = 0;
        let prefixes = ["\u{1b}]7501;", "\u{1b}]9;4;"];
        while !self.pending.is_empty() {
            let Some(at) = self.pending.find("\u{1b}]") else {
                let hold = if self.pending.ends_with('\u{1b}') { 1 } else { 0 };
                let end = self.pending.len() - hold;
                text.push_str(&self.pending[..end]);
                self.pending = if hold == 1 { "\u{1b}".into() } else { String::new() };
                break;
            };
            text.push_str(&self.pending[..at]);
            self.pending = self.pending[at..].to_string();
            let known = prefixes.iter().any(|prefix| self.pending.starts_with(prefix));
            if !known {
                if prefixes.iter().any(|prefix| prefix.starts_with(&self.pending)) { break }
                text.push_str(&self.pending[..self.pending.len().min(2)]);
                self.pending = self.pending[self.pending.len().min(2)..].to_string();
                continue;
            }
            let bel = self.pending.find('\u{7}');
            let st = self.pending.find("\u{1b}\\");
            let Some(end) = (match (bel, st) {
                (Some(bel), Some(st)) => Some(bel.min(st)),
                (Some(bel), None) => Some(bel),
                (None, Some(st)) => Some(st),
                (None, None) => None,
            }) else {
                if self.pending.len() > 16384 { text.push_str(&self.pending); self.pending.clear(); }
                break;
            };
            let marker = if bel == Some(end) { 1 } else { 2 };
            let sequence = self.pending[..end].to_string();
            self.pending = self.pending[end + marker..].to_string();
            if let Some(payload) = sequence.strip_prefix(prefixes[0]) {
                if payload == "?" { queries += 1; continue }
                let mut fields = std::collections::HashMap::<String, String>::new();
                for pair in payload.split(':') {
                    let Some((key, value)) = pair.split_once('=') else { continue };
                    fields.insert(key.to_string(), value.to_string());
                }
                if fields.contains_key("id") || fields.contains_key("parent") { continue }
                let state = match fields.get("state").map(String::as_str) {
                    Some("working") => "working",
                    Some("idle" | "blocked" | "done" | "error") => "waiting",
                    Some("clear") => "clear",
                    _ => continue,
                };
                reports.push(Report { state, app: fields.remove("app"), session: fields.remove("session"), protocol: Protocol::Program });
            } else if let Some(payload) = sequence.strip_prefix(prefixes[1]) {
                let state = payload.split(';').next().unwrap_or("");
                if state == "1" || state == "3" { reports.push(Report { state: "working", app: None, session: None, protocol: Protocol::Progress }); }
                else if state == "0" || state == "2" || state == "4" { reports.push(Report { state: "waiting", app: None, session: None, protocol: Protocol::Progress }); }
            }
        }
        Activity { text, reports, queries }
    }
}

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
    born: u64,
    data: PathBuf,
    agent_kind: Option<String>,
    agent_session: Option<String>,
    native_status: bool,
    native_working: bool,
    pending: String,
    program: ProgramStatus,
}

pub struct Manager {
    sessions: Mutex<HashMap<String, Session>>,
}

struct Session {
    live: Arc<Mutex<Live>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    stop: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    resize: Box<dyn Fn(u16, u16) + Send + Sync>,
    hook_stop: Arc<AtomicBool>,
    hook_addr: Option<SocketAddr>,
    hook_token: String,
    root_pid: u32,
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
            builder.arg("--noprofile");
            builder.arg("--rcfile");
            builder.arg(bash_rc.to_string_lossy().into_owned());
            builder.arg("-i");
        }
        builder.env("AWB_CWD", cwd);
        builder.env("TERM", "xterm-256color");
        builder.env("PI_PROGRAM_STATUS", "1");
        if cfg!(windows) { builder.env("PI_HARDWARE_CURSOR", "1"); }
        builder.cwd(cwd);
        let child = pair.slave.spawn_command(builder).map_err(|error| error.to_string())?;
        let root_pid = child.process_id().unwrap_or(0);
        let reader = pair.master.try_clone_reader().map_err(|error| error.to_string())?;
        let writer = pair.master.take_writer().map_err(|error| error.to_string())?;
        let child = Arc::new(Mutex::new(child));
        let master = Arc::new(Mutex::new(pair.master));
        let stop_child = child.clone();
        let resize_master = master.clone();
        let stop: Box<dyn FnOnce() + Send> = Box::new(move || { let _ = stop_child.lock().expect("child").kill(); });
        let resize: Box<dyn Fn(u16, u16) + Send + Sync> = Box::new(move |cols, rows| { let _ = resize_master.lock().expect("master").resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }); });
        self.start_session(data, id, cwd, kind, shell_id, command, agent_session, restore, language, emit, reader, writer, stop, resize, root_pid)
    }

    pub fn create_remote(&self, data: &Path, id: &str, cwd: &str, kind: &str, shell: &str, command: &str, agent_session: Option<&str>, restore: bool, host: &Value, language: &str, emit: Emit) -> Result<Value, String> {
        if kind != "shell" && agent_session.unwrap_or("").is_empty() && !load_history(data, id).is_empty() {
            return Err(translate(language, "无法唯一定位旧 Agent 对话，原终端历史已保留；未创建空白对话", &[] as &[String]));
        }
        let shell_id = if host["platform"] == "windows" { "pwsh" } else if shell == "zsh" { "zsh" } else { "bash" };
        let remote = ssh::open_shell(data, host, cwd, language)?;
        self.start_session(data, id, Path::new(cwd), kind, shell_id, command, agent_session, restore, language, emit, remote.output, remote.input, remote.stop, Box::new(|_, _| {}), 0)
    }

    fn start_session(&self, data: &Path, id: &str, cwd: &Path, kind: &str, shell: &str, command: &str, agent_session: Option<&str>, restore: bool, language: &str, emit: Emit, reader: Box<dyn Read + Send>, writer: Box<dyn Write + Send>, stop: Box<dyn FnOnce() + Send>, resize: Box<dyn Fn(u16, u16) + Send + Sync>, root_pid: u32) -> Result<Value, String> {
        let history = if restore { load_history(data, id) } else { String::new() };
        let replay = if restore { restore_history_text(&history, language) } else { String::new() };
        let (hook_stop, listener, hook_token) = start_hook();
        let hook_addr = listener.as_ref().and_then(|listener| listener.local_addr().ok());
        let live = Arc::new(Mutex::new(Live {
            phase: Phase::Starting,
            state: "running".into(),
            exit_code: None,
            started_at: Some(now_ms()),
            input_ready: false,
            shell: shell.into(),
            kind: kind.into(),
            command: command.to_string(),
            cwd: cwd.to_path_buf(),
            launched: command.is_empty(),
            last_interrupt: None,
            restore,
            born: next_born(),
            data: data.to_path_buf(),
            agent_kind: if kind == "shell" { None } else { Some(kind.to_string()) },
            agent_session: agent_session.filter(|value| !value.is_empty()).and_then(valid_agent_session),
            native_status: false,
            native_working: false,
            pending: String::new(),
            program: ProgramStatus { pending: String::new() },
        }));
        let writer = Arc::new(Mutex::new(writer));
        let hook_live = live.clone();
        let hook_emit = emit.clone();
        let hook_id = id.to_string();
        let hook_token_for_thread = hook_token.clone();
        let hook_stop_for_thread = hook_stop.clone();
        if let Some(listener) = listener {
            std::thread::spawn(move || serve_hook(listener, hook_stop_for_thread, hook_token_for_thread, hook_id, hook_live, hook_emit));
        }
        let settings_token = hook_token.clone();
        let session = Session {
            live: live.clone(),
            writer: writer.clone(),
            stop: Mutex::new(Some(stop)),
            resize,
            hook_stop,
            hook_addr,
            hook_token,
            root_pid,
        };
        if kind == "claude" {
            if let Some(addr) = hook_addr {
                let file = claude_settings_file(data, addr.port(), &settings_token);
                let quoted = if shell == "pwsh" || shell == "cmd" { crate::ssh::ps_quote(&file.display().to_string()) } else { crate::ssh::bash_quote(&file.display().to_string()) };
                live.lock().expect("pty live").command = format!("{command} --settings {quoted}");
            }
        }
        self.sessions.lock().expect("pty").insert(id.to_string(), session);
        spawn_reader(id.to_string(), reader, live.clone(), writer.clone(), emit.clone());
        let live_timer = live.clone();
        let writer_timer = writer;
        let emit_timer = emit;
        let id_timer = id.to_string();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(1200));
            arm(&id_timer, &live_timer, &writer_timer, &emit_timer, true, None);
        });
        let guard = live.lock().expect("pty live");
        let mut info = snapshot(id, &guard);
        drop(guard);
        info["history"] = json!(history);
        info["replay"] = json!(replay);
        info["replayed"] = json!(!replay.is_empty());
        info["launchCommand"] = json!(live.lock().expect("pty live").command);
        info["rootPid"] = json!(root_pid);
        info["piProgramStatus"] = json!("1");
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

    pub fn born(&self, id: &str) -> Option<u64> {
        let sessions = self.sessions.lock().expect("pty");
        let born = sessions.get(id)?.live.lock().expect("pty live").born;
        Some(born)
    }

    pub fn hook(&self, id: &str) -> Option<(u16, String)> {
        let sessions = self.sessions.lock().expect("pty");
        let session = sessions.get(id)?;
        Some((session.hook_addr?.port(), session.hook_token.clone()))
    }

    /// The reader thread uses this for every chunk. Tests drive the same function.
    pub fn feed(&self, id: &str, chunk: &str, emit: &Emit) {
        let Some((live, writer)) = self.sessions.lock().expect("pty").get(id).map(|session| (session.live.clone(), session.writer.clone())) else { return };
        handle_chunk(id, &live, &writer, chunk, emit);
    }

    pub fn write(&self, id: &str, data: &[u8], emit: &Emit) {
        let Some(session) = self.sessions.lock().expect("pty").get(id).map(|session| session.live.clone()) else { return };
        let writer = self.writer(id);
        let newline = data.contains(&b'\n') || data.contains(&b'\r');
        {
            let mut live = session.lock().expect("pty live");
            if live.phase == Phase::Dead { return }
            if newline && live.phase == Phase::Prompt && !live.native_working {
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
                if live.kind == "shell" && !live.native_working {
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
        session.hook_stop.store(true, Ordering::Relaxed);
        if let Some(addr) = session.hook_addr { let _ = TcpStream::connect_timeout(&addr, Duration::from_millis(200)); }
        let root = session.root_pid;
        let rows = process_snapshot();
        let steps = windows_shutdown_plan(&rows, &[root], root != 0 && !rows.is_empty());
        let mut ended = false;
        for step in steps {
            match step {
                ShutdownStep::KillDescendant(pid) => {
                    kill_descendant(pid);
                    record_shutdown(&format!("kill {pid}"));
                }
                ShutdownStep::EndRoot(pid) => {
                    if !ended {
                        if let Some(stop) = session.stop.lock().expect("stop").take() { stop(); }
                        ended = true;
                    }
                    record_shutdown(&format!("end {pid}"));
                }
                ShutdownStep::WaitNativeExit(pid) => {
                    wait_native(pid);
                    record_shutdown(&format!("wait {pid}"));
                }
            }
        }
        if !ended {
            if let Some(stop) = session.stop.lock().expect("stop").take() { stop(); }
        }
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

fn start_hook() -> (Arc<AtomicBool>, Option<TcpListener>, String) {
    let stop = Arc::new(AtomicBool::new(false));
    let token = hook_token();
    (stop, TcpListener::bind("127.0.0.1:0").ok(), token)
}

fn serve_hook(listener: TcpListener, stop: Arc<AtomicBool>, token: String, id: String, live: Arc<Mutex<Live>>, emit: Emit) {
    for stream in listener.incoming() {
        if stop.load(Ordering::Relaxed) { break }
        let Ok(mut stream) = stream else { break };
        if stop.load(Ordering::Relaxed) { break }
        let _ = stream.set_read_timeout(Some(Duration::from_millis(300)));
        let mut buffer = [0u8; 1024];
        let Ok(size) = stream.read(&mut buffer) else { continue };
        let text = String::from_utf8_lossy(&buffer[..size]).into_owned();
        let path = text.split_whitespace().nth(1).unwrap_or("").to_string();
        let mut parts = path.split('/').filter(|part| !part.is_empty());
        let got = parts.next().unwrap_or("");
        let state = match parts.next().unwrap_or("") {
            "working" => "working",
            "waiting" => "waiting",
            "clear" => "clear",
            _ => "",
        };
        if got == token && !state.is_empty() {
            let mut guard = live.lock().expect("pty live");
            apply_reports(&mut guard, &[Report { state, app: None, session: None, protocol: Protocol::Lifecycle }]);
            let event = snapshot(&id, &guard);
            drop(guard);
            emit(json!({ "channel": "pty:event", "payload": event }));
        }
        let _ = stream.write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n");
    }
}

fn hook_token() -> String {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).expect("system random");
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn spawn_reader(id: String, mut reader: Box<dyn Read + Send>, live: Arc<Mutex<Live>>, writer: Arc<Mutex<Box<dyn Write + Send>>>, emit: Emit) {
    std::thread::spawn(move || {
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
                    let take = if split == 0 { raw.len() } else { split };
                    let text = String::from_utf8_lossy(&raw[..take]).into_owned();
                    if split == 0 { raw.clear(); } else { raw.drain(..split); }
                    handle_chunk(&id, &live, &writer, &text, &emit);
                }
            }
        }
        let mut live = live.lock().expect("pty live");
        if live.phase != Phase::Dead {
            live.phase = Phase::Dead;
            live.state = "exited".into();
            live.exit_code = Some(0);
            live.input_ready = false;
            live.native_working = false;
            let event = snapshot(&id, &live);
            drop(live);
            emit(json!({ "channel": "pty:event", "payload": event }));
        }
    });
}

fn handle_chunk(id: &str, live: &Arc<Mutex<Live>>, writer: &Arc<Mutex<Box<dyn Write + Send>>>, chunk: &str, emit: &Emit) {
    let mut guard = live.lock().expect("pty live");
    let activity = guard.program.push(chunk);
    let queries = activity.queries;
    let changed = !activity.reports.is_empty();
    apply_reports(&mut guard, &activity.reports);
    guard.pending.push_str(&activity.text);
    let (visible, prompts) = drain_prompts(&mut guard.pending);
    let _recorded_for_restore = guard.restore;
    let data = guard.data.clone();
    let state_event = if changed { Some(snapshot(id, &guard)) } else { None };
    drop(guard);
    if queries > 0 {
        let reply = b"\x1b]7501;?\x1b\\";
        let mut output = writer.lock().expect("writer");
        for _ in 0..queries { let _ = output.write_all(reply); }
    }
    if !chunk.is_empty() { let _ = append_ansi(&data, id, chunk); }
    if !visible.is_empty() {
        emit(json!({ "channel": "pty:event", "payload": { "type": "data", "id": id, "data": visible } }));
    }
    if let Some(event) = state_event {
        emit(json!({ "channel": "pty:event", "payload": event }));
    }
    if !prompts.is_empty() { arm(id, live, writer, emit, false, prompts.last().copied()); }
}

fn apply_reports(live: &mut Live, reports: &[Report]) {
    for report in reports {
        if report.protocol == Protocol::Progress && live.native_status { continue }
        if report.protocol == Protocol::Program { live.native_status = true; }
        if let Some(agent) = report.app.as_deref().and_then(native_agent) {
            if report.state != "clear" {
                live.agent_kind = Some(agent.to_string());
                if let Some(session) = report.session.as_deref().and_then(valid_agent_session) {
                    live.agent_session = Some(session);
                }
            }
        }
        match report.state {
            "working" => {
                live.phase = Phase::Command;
                live.state = "running".into();
                live.input_ready = false;
                live.exit_code = None;
                if live.started_at.is_none() { live.started_at = Some(now_ms()); }
                if report.protocol == Protocol::Program || report.protocol == Protocol::Lifecycle { live.native_working = true; }
            }
            "waiting" => {
                // The process is still alive. Electron records programWaiting
                // without changing the command state, so Recent can list an
                // idle agent (state stays "running", inputReady becomes true).
                // A shell that already returned to its prompt stays idle.
                live.native_working = false;
                live.input_ready = true;
                live.exit_code = None;
            }
            "clear" => {
                live.native_working = false;
                live.native_status = false;
                live.agent_kind = if live.kind == "shell" { None } else { Some(live.kind.clone()) };
                live.agent_session = None;
                live.input_ready = true;
                live.state = "idle".into();
                live.phase = Phase::Prompt;
                live.started_at = None;
            }
            _ => {}
        }
    }
}

fn native_agent(app: &str) -> Option<&'static str> {
    let file = app.rsplit(['/', '\\']).next().unwrap_or(app);
    let name = file.strip_suffix(".exe").or_else(|| file.strip_suffix(".cmd")).or_else(|| file.strip_suffix(".ps1")).or_else(|| file.strip_suffix(".bat")).unwrap_or(file);
    match name.to_ascii_lowercase().as_str() {
        "claude" | "claude-code" => Some("claude"),
        "codex" => Some("codex"),
        "opencode" => Some("opencode"),
        "pi" => Some("pi"),
        "omp" | "oh-my-pi" => Some("omp"),
        _ => None,
    }
}

pub fn resume_command(kind: &str, command: &str, session: Option<&str>, directory: &Path, shell: &str) -> (String, Option<String>) {
    let quote = |text: &str| if shell == "pwsh" || shell == "cmd" { crate::ssh::ps_quote(text) } else { crate::ssh::bash_quote(text) };
    let id = session.and_then(valid_agent_session);
    match kind {
        "claude" => {
            let next = id.clone().unwrap_or_else(crate::random_id);
            let flag = if id.is_some() { "--resume" } else { "--session-id" };
            (format!("{command} {flag} {}", quote(&next)), Some(next))
        }
        "codex" if id.is_some() => {
            let id = id.unwrap();
            (format!("{command} resume {} --no-daemon", quote(&id)), Some(id))
        }
        "opencode" => {
            let next = id.clone().unwrap_or_else(|| format!("ses_{}", crate::random_id().replace('-', "")));
            (format!("{command} --session {}", quote(&next)), Some(next))
        }
        "pi" | "omp" => {
            if let Some(id) = id.clone().filter(|value| !value.starts_with("pello:")) {
                let flag = if kind == "pi" { "--session" } else { "--resume" };
                (format!("{command} {flag} {}", quote(&id)), Some(id))
            } else {
                (format!("{command} --session-dir {} --continue", quote(&directory.display().to_string())), Some(id.unwrap_or_else(|| "pello:directory".into())))
            }
        }
        _ => (command.to_string(), id),
    }
}

fn valid_agent_session(value: &str) -> Option<String> {
    if value.is_empty() || value.len() > 512 { return None }
    if value.chars().all(|char| char.is_ascii_alphanumeric() || ":./@+-_".contains(char)) { Some(value.to_string()) } else { None }
}

fn arm(id: &str, live: &Mutex<Live>, writer: &Mutex<Box<dyn Write + Send>>, emit: &Emit, from_timer: bool, prompt_code: Option<i32>) {
    let mut live = live.lock().expect("pty live");
    if live.phase == Phase::Dead { return }
    if from_timer && live.phase != Phase::Starting { return }
    if live.native_working { return }
    if !live.launched && !live.command.is_empty() {
        let command = format!("{}\n", live.command);
        live.launched = true;
        live.phase = Phase::Command;
        live.state = "running".into();
        live.input_ready = false;
        let _ = writer.lock().expect("writer").write_all(command.as_bytes());
    } else if live.launched && live.kind != "shell" && prompt_code.is_some() {
        // A non-shell command returned to the prompt. Electron keeps the exit
        // code on the tab: zero is exited, anything else is failed.
        let code = prompt_code.unwrap_or(0);
        live.phase = Phase::Prompt;
        live.exit_code = Some(code);
        live.input_ready = true;
        live.native_working = false;
        live.started_at = None;
        live.state = if code == 0 { "exited" } else { "failed" }.into();
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
    let marker = "\u{1b}]777;awb;prompt;";
    loop {
        let Some(start) = pending.find('\u{1b}') else {
            visible.push_str(pending);
            pending.clear();
            break;
        };
        visible.push_str(&pending[..start]);
        let rest = pending[start..].to_string();
        if rest.starts_with(marker) {
            let Some(end) = rest.find('\u{7}') else {
                if rest.len() > 80 { visible.push_str(&rest[..1]); *pending = rest[1..].to_string(); continue; }
                *pending = rest;
                break;
            };
            if let Ok(code) = rest[marker.len()..end].parse::<i32>() { codes.push(code); }
            else { visible.push_str(&rest[..=end]); }
            *pending = rest[end + 1..].to_string();
            continue;
        }
        if rest.starts_with("\u{1b}[") {
            if let Some(relative) = rest.as_bytes().get(2..).and_then(|bytes| bytes.iter().position(|byte| (0x40..=0x7e).contains(byte))) {
                let end = 2 + relative + 1;
                visible.push_str(&rest[..end]);
                *pending = rest[end..].to_string();
                continue;
            }
            if rest.len() > 64 { visible.push_str(&rest[..1]); *pending = rest[1..].to_string(); continue; }
            *pending = rest;
            break;
        }
        visible.push_str(&rest[..rest.len().min(1)]);
        *pending = rest[rest.len().min(1)..].to_string();
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
        "agentKind": live.agent_kind,
        "agentSessionId": live.agent_session,
        "born": live.born
    })
}

/// Dot colors follow `src/renderer/terminal-state.ts`. Shell stays gray. An agent request spins yellow; idle is steady green.
pub fn terminal_status(kind: &str, agent_kind: Option<&str>, state: &str, input_ready: bool) -> Value {
    let agent = match agent_kind {
        Some(agent) => Some(agent),
        None if kind == "shell" => None,
        None => Some(kind),
    };
    if agent.is_none() && state != "failed" && state != "exited" {
        return json!({ "color": "inactive", "spinning": false, "activity": "shell" });
    }
    if state == "running" && !input_ready {
        return json!({ "color": "busy", "spinning": true, "activity": "running" });
    }
    if state == "failed" { return json!({ "color": "failed", "spinning": false, "activity": "failed" }); }
    if state == "exited" { return json!({ "color": "inactive", "spinning": false, "activity": "closed" }); }
    if input_ready {
        return json!({ "color": if agent.is_some() { "ready" } else { "inactive" }, "spinning": false, "activity": "waiting" });
    }
    json!({ "color": "inactive", "spinning": false, "activity": "starting" })
}

pub fn restore_history_text(text: &str, language: &str) -> String {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let normalized = normalized.trim_end();
    if normalized.is_empty() { return String::new(); }
    let body = normalized.replace('\n', "\r\n");
    let open = translate(language, "── 上次会话记录 ──", &[] as &[String]);
    let close = translate(language, "── 会话已恢复，下面连接新进程 ──", &[] as &[String]);
    format!("\u{1b}[38;5;244m{open}\u{1b}[0m\r\n{body}\r\n\u{1b}[38;5;244m{close}\u{1b}[0m\r\n")
}

fn next_born() -> u64 {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
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

fn claude_settings_file(data: &Path, port: u16, token: &str) -> PathBuf {
    let file = data.join(format!("claude-status-{token}.json"));
    let hook = |state: &str| json!([{ "hooks": [{ "type": "http", "url": format!("http://127.0.0.1:{port}/{token}/{state}"), "timeout": 2 }] }]);
    let settings = json!({ "hooks": {
        "SessionStart": hook("waiting"),
        "UserPromptSubmit": hook("working"),
        "PreToolUse": hook("working"),
        "PostToolUse": hook("working"),
        "Stop": hook("waiting"),
        "StopFailure": hook("waiting"),
        "PermissionRequest": hook("waiting"),
        "Notification": [{ "matcher": "idle_prompt|permission_prompt|elicitation_dialog|auth_success", "hooks": [{ "type": "http", "url": format!("http://127.0.0.1:{port}/{token}/waiting"), "timeout": 2 }] }],
        "SessionEnd": hook("clear")
    }});
    let _ = std::fs::write(&file, settings.to_string());
    file
}

fn process_snapshot() -> Vec<ProcessRow> {
    let mut rows = Vec::new();
    let Ok(entries) = std::fs::read_dir("/proc") else { return rows };
    for entry in entries.flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else { continue };
        let Ok(stat) = std::fs::read_to_string(entry.path().join("stat")) else { continue };
        let Some(end) = stat.rfind(')') else { continue };
        let mut fields = stat[end + 1..].split_whitespace();
        let _state = fields.next();
        let parent = fields.next().and_then(|value| value.parse().ok()).unwrap_or(0);
        if pid > 0 && parent > 0 { rows.push(ProcessRow { pid, parent }); }
    }
    rows
}

fn kill_descendant(pid: u32) {
    if pid <= 1 { return }
    if cfg!(windows) {
        let _ = std::process::Command::new("taskkill").args(["/F", "/PID", &pid.to_string()]).status();
        return;
    }
    unsafe { libc::kill(pid as i32, libc::SIGKILL); }
}

fn wait_native(pid: u32) {
    if pid == 0 { return }
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let mut status = 0;
        let result = unsafe { libc::waitpid(pid as i32, &mut status, libc::WNOHANG) };
        if result == pid as i32 || result < 0 || Instant::now() >= deadline { return }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn record_shutdown(line: &str) {
    if let Ok(path) = std::env::var("AWB_SHUTDOWN_LOG") {
        let mut file = std::fs::OpenOptions::new().create(true).append(true).open(path).ok();
        if let Some(file) = file.as_mut() {
            use std::io::Write;
            let _ = writeln!(file, "{line}");
        }
    }
}

/// One row from a single Windows process snapshot.
#[derive(Clone, Copy)]
pub struct ProcessRow {
    pub pid: u32,
    pub parent: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ShutdownStep {
    /// Descendants, deepest first. These are not ConPTY roots.
    KillDescendant(u32),
    /// A PTY root. Native teardown starts only after earlier steps finish.
    EndRoot(u32),
    /// Wait for that root's ConPTY exit callback before the next root.
    WaitNativeExit(u32),
}

/// Windows close: one snapshot, leaves before parents, then each root serially.
/// `taskkill` is not paired with native teardown of the same root.
pub fn windows_shutdown_plan(rows: &[ProcessRow], roots: &[u32], snapshot_ok: bool) -> Vec<ShutdownStep> {
    if !snapshot_ok {
        return roots.iter().flat_map(|root| [ShutdownStep::EndRoot(*root), ShutdownStep::WaitNativeExit(*root)]).collect();
    }
    let mut children: std::collections::HashMap<u32, Vec<u32>> = std::collections::HashMap::new();
    for row in rows {
        if row.pid == 0 || row.parent == 0 { continue; }
        children.entry(row.parent).or_default().push(row.pid);
    }
    let root_set: std::collections::HashSet<u32> = roots.iter().copied().collect();
    let mut descendants = Vec::new();
    fn visit(pid: u32, children: &std::collections::HashMap<u32, Vec<u32>>, roots: &std::collections::HashSet<u32>, out: &mut Vec<u32>) {
        for child in children.get(&pid).into_iter().flatten() {
            if roots.contains(child) { continue; }
            visit(*child, children, roots, out);
            out.push(*child);
        }
    }
    for root in roots {
        visit(*root, &children, &root_set, &mut descendants);
    }
    let mut steps: Vec<ShutdownStep> = descendants.into_iter().map(ShutdownStep::KillDescendant).collect();
    for root in roots {
        steps.push(ShutdownStep::EndRoot(*root));
        steps.push(ShutdownStep::WaitNativeExit(*root));
    }
    steps
}

pub fn shutdown_is_serial(steps: &[ShutdownStep]) -> bool {
    let mut awaiting: Option<u32> = None;
    for step in steps {
        match step {
            ShutdownStep::EndRoot(pid) => {
                if awaiting.is_some() { return false; }
                awaiting = Some(*pid);
            }
            ShutdownStep::WaitNativeExit(pid) => {
                if awaiting != Some(*pid) { return false; }
                awaiting = None;
            }
            ShutdownStep::KillDescendant(_) if awaiting.is_some() => return false,
            ShutdownStep::KillDescendant(_) => {}
        }
    }
    awaiting.is_none()
}
