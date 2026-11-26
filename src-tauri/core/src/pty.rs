//! PTY sessions. Completion comes from the shell prompt marker, OSC 7501, or a lifecycle hook.
//! Process liveness, Enter, and silence do not mark an agent idle. OSC 7501 wins over OSC 9;4.

use crate::i18n::translate;
use crate::shells;
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
    /// The process that owns the terminal's console; a reply goes to it.
    root_pid: u32,
    /// Whether the terminal runs on this machine: a native Codex there reads
    /// console key events, and Shift+Enter is sent to it as a key record.
    local: bool,
    /// Whether the end of what ran was said to the page, so that the end of
    /// the process itself does not say it a second time.
    announced: bool,
    /// How what runs was ended by the workbench rather than by itself: the
    /// state, the code and why. It is said when the terminal next returns to
    /// its prompt, or a moment later if the prompt is not waited for.
    pending_end: Option<(&'static str, i32, &'static str)>,
    /// Set once the terminal is being closed, for good or to be started
    /// again: nothing more is said to the page of it, as the Electron build
    /// says nothing while it is closing.
    closing: bool,
    /// What runs in the terminal was ended to start it again: the command is
    /// typed again once the terminal shows its prompt, or a moment later.
    restart_pending: bool,
}

/// What a restart of a terminal comes to.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Restart {
    /// The command is typed again in the terminal, which stays.
    Retyped,
    /// The process of the terminal is gone: the terminal is created again.
    Respawn,
    /// A Shell at its prompt is not started again.
    Nothing,
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

    /// A terminal on this machine. `extra` is environment of the executor
    /// that runs in it, as the settings dialog gives one.
    pub fn create(&self, data: &Path, id: &str, cwd: &Path, kind: &str, shell: &str, command: &str, agent_session: Option<&str>, restore: bool, language: &str, emit: Emit, extra: &[(String, String)]) -> Result<Value, String> {        if !cwd.is_dir() { return Err(translate(language, "目录不存在", &[] as &[String])) }
        if kind != "shell" && agent_session.unwrap_or("").is_empty() && !load_history(data, id).is_empty() {
            return Err(translate(language, "无法唯一定位旧 Agent 对话，原终端历史已保留；未创建空白对话", &[] as &[String]));
        }
        let rc = shells::ensure_shell_files(data)?;
        let spec = shells::resolve_local_shell(shell, &rc, language)?;
        let shell_id = spec.shell.clone();
        let system = portable_pty::native_pty_system();
        let pair = system.openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 }).map_err(|error| error.to_string())?;
        let mut builder = CommandBuilder::new(&spec.file);
        builder.args(spec.args.iter().map(String::as_str));
        // Windows names its environment without regard to case. One PATH key
        // keeps the shell's own lookup from seeing a stale duplicate.
        let replaces_path = cfg!(windows) && spec.env.iter().any(|(key, _)| key == "PATH");
        if replaces_path {
            for (key, _) in std::env::vars_os() {
                if key.to_string_lossy().eq_ignore_ascii_case("PATH") && key != "PATH" { builder.env_remove(key); }
            }
        }
        for (key, value) in &spec.env { builder.env(key, value); }
        // A POSIX shell inside Windows reads forward slashes; PowerShell and
        // CMD want the path as the system spells it.
        builder.env("AWB_CWD", if cfg!(windows) && shell_id == "bash" { cwd.to_string_lossy().replace('\\', "/") } else { cwd.display().to_string() });
        builder.env("TERM", "xterm-256color");
        builder.env("COLORTERM", "truecolor");
        builder.env("PI_PROGRAM_STATUS", "1");
        if cfg!(windows) { builder.env("PI_HARDWARE_CURSOR", "1"); }
        for (key, value) in extra { builder.env(key, value); }
        builder.cwd(cwd);
        let child = pair.slave.spawn_command(builder).map_err(|error| error.to_string())?;
        let root_pid = child.process_id().unwrap_or(0);
        // The process is ended through its own copy of the handle, so that it
        // can be ended while its exit is waited for.
        let mut killer = child.clone_killer();
        let reader = pair.master.try_clone_reader().map_err(|error| error.to_string())?;
        let writer = pair.master.take_writer().map_err(|error| error.to_string())?;
        let master = Arc::new(Mutex::new(pair.master));
        let resize_master = master.clone();
        let stop: Box<dyn FnOnce() + Send> = Box::new(move || { let _ = killer.kill(); });
        let resize: Box<dyn Fn(u16, u16) + Send + Sync> = Box::new(move |cols, rows| { let _ = resize_master.lock().expect("master").resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }); });
        self.start_session(data, id, cwd, kind, &shell_id, command, agent_session, restore, language, emit, reader, writer, stop, resize, root_pid, true, Some(child))
    }
    pub fn create_remote(&self, data: &Path, id: &str, cwd: &str, kind: &str, shell: &str, command: &str, agent_session: Option<&str>, restore: bool, host: &Value, language: &str, emit: Emit) -> Result<Value, String> {
        if kind != "shell" && agent_session.unwrap_or("").is_empty() && !load_history(data, id).is_empty() {
            return Err(translate(language, "无法唯一定位旧 Agent 对话，原终端历史已保留；未创建空白对话", &[] as &[String]));
        }
        let shell_id = shells::shell_for_host(host["platform"].as_str().unwrap_or("linux"), shell);
        let remote = ssh::open_shell(data, host, cwd, language)?;
        self.start_session(data, id, Path::new(cwd), kind, shell_id, command, agent_session, restore, language, emit, remote.output, remote.input, remote.stop, Box::new(|_, _| {}), 0, false, None)
    }

    fn start_session(&self, data: &Path, id: &str, cwd: &Path, kind: &str, shell: &str, command: &str, agent_session: Option<&str>, restore: bool, language: &str, emit: Emit, reader: Box<dyn Read + Send>, writer: Box<dyn Write + Send>, stop: Box<dyn FnOnce() + Send>, resize: Box<dyn Fn(u16, u16) + Send + Sync>, root_pid: u32, local: bool, child: Option<Box<dyn portable_pty::Child + Send + Sync>>) -> Result<Value, String> {
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
            root_pid,
            local,
            announced: false,
            pending_end: None,
            closing: false,
            restart_pending: false,
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
                let quoted = if shell == "pwsh" || shell == "cmd" { crate::ssh::ps_quote(&file.display().to_string()) } else { crate::ssh::bash_path_quote(&file) };
                live.lock().expect("pty live").command = format!("{command} --settings {quoted}");
            }
        }
        self.sessions.lock().expect("pty").insert(id.to_string(), session);
        record_lifecycle("spawn", Some(root_pid));
        // The terminal's output is read until its pipe closes, which on Windows
        // waits for the last writer of the pipe rather than for the process.
        // The process itself is waited for apart from that, as the Electron
        // build is told of its exit: that is what ends the terminal.
        spawn_reader(id.to_string(), reader, live.clone(), writer.clone(), emit.clone(), child.is_some());
        if let Some(mut child) = child {
            let live = live.clone();
            let emit = emit.clone();
            let id = id.to_string();
            std::thread::spawn(move || {
                let code = child.wait().map(|status| status.exit_code() as i32).unwrap_or(1);
                process_ended(&id, &live, &emit, code);
            });
        }
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

    /// What Shift+Enter sends: a plain Enter with no agent to tell the
    /// difference, and otherwise what `shift_enter_key` names.
    pub fn shift_enter(&self, id: &str, emit: &Emit) {
        let Some(live) = self.sessions.lock().expect("pty").get(id).map(|session| session.live.clone()) else { return };
        let key: &[u8] = {
            let live = live.lock().expect("pty live");
            shift_enter_key(live.agent_kind.as_deref(), live.local, cfg!(windows))
        };
        self.write(id, key, emit);
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) {
        let sessions = self.sessions.lock().expect("pty");
        let Some(session) = sessions.get(id) else { return };
        (session.resize)(cols, rows);
    }

    pub fn interrupt(&self, id: &str, emit: &Emit) -> String {
        let Some(live) = self.sessions.lock().expect("pty").get(id).map(|session| session.live.clone()) else { return "signal".into() };
        let writer = self.writer(id);
        let mut guard = live.lock().expect("pty live");
        if guard.phase == Phase::Dead { return "signal".into() }
        let now = Instant::now();
        if guard.state == "running" {
            if guard.last_interrupt.is_some_and(|last| now.duration_since(last) < Duration::from_secs(4)) {
                guard.last_interrupt = None;
                // What is said of the end is set before anything is ended:
                // ending what runs can take the shell with it, and the thread
                // that waits for the shell says what was set, were it still
                // running when the shell went.
                let agent = guard.kind != "shell" || guard.native_working;
                if agent { guard.pending_end = Some(("exited", 0, "ctrlc")); }
                // The second interrupt ends what runs below the shell; only
                // a root that started nothing gets the interrupt itself.
                drop(guard);
                if !kill_children(self.root_pid(id)) { let _ = writer.lock().expect("writer").write_all(b"\x03"); }
                let mut guard = live.lock().expect("pty live");
                if !agent {
                    guard.phase = Phase::Prompt;
                    guard.state = "idle".into();
                    guard.exit_code = None;
                    guard.started_at = None;
                    guard.input_ready = true;
                    guard.announced = false;
                    let event = snapshot(id, &guard);
                    drop(guard);
                    emit(json!({ "channel": "pty:event", "payload": event }));
                } else {
                    // An Agent that was interrupted twice is said to have
                    // ended, as the Electron build says it, once the terminal
                    // shows its prompt or a moment from now.
                    let id = id.to_string();
                    let live_timer = self.live_of(&id);
                    let writer_timer = writer.clone();
                    let emit_timer = emit.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_millis(350));
                        flush_pending_end(&id, &live_timer, &writer_timer, &emit_timer);
                    });
                }
                return "exit".into();
            }
            guard.last_interrupt = Some(now);
            let _ = writer.lock().expect("writer").write_all(b"\x03");
            return "hint".into();
        }
        let _ = writer.lock().expect("writer").write_all(b"\x03");
        "signal".into()
    }

    /// End what runs in the terminal, and keep the terminal: what runs is
    /// said to have been forced to end. The session stays, as it does when a
    /// process ends by itself.
    pub fn force_kill(&self, id: &str, emit: &Emit) {
        let Some(live) = self.sessions.lock().expect("pty").get(id).map(|session| session.live.clone()) else { return };
        if live.lock().expect("pty live").phase == Phase::Dead { return }
        live.lock().expect("pty live").pending_end = Some(("failed", 1, "kill"));
        if !kill_children(self.root_pid(id)) {
            let sessions = self.sessions.lock().expect("pty");
            if let Some(stop) = sessions.get(id).and_then(|session| session.stop.lock().expect("stop").take()) { stop(); }
        }
        let live_timer = self.live_of(id);
        let writer = self.writer(id);
        let emit_timer = emit.clone();
        let id = id.to_string();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(400));
            flush_pending_end(&id, &live_timer, &writer, &emit_timer);
        });
    }

    /// Start what runs in the terminal again. While it runs, what runs is
    /// ended and the command is typed again in the same terminal, once it
    /// shows its prompt or a moment later; nothing is said of that end, as
    /// the Electron build says nothing of it. Should the process of the
    /// terminal go with what ran in it, the terminal is to be created again.
    /// Once that process is already gone it is so too, and a Shell at its
    /// prompt is left.
    pub fn restart(&self, id: &str, emit: &Emit) -> Restart {
        let Some(live) = self.sessions.lock().expect("pty").get(id).map(|session| session.live.clone()) else { return Restart::Nothing };
        let writer = self.writer(id);
        {
            let mut guard = live.lock().expect("pty live");
            if guard.command.is_empty() {
                return if guard.phase == Phase::Dead { Restart::Respawn } else { Restart::Nothing };
            }
            if guard.phase == Phase::Dead || guard.closing { return Restart::Respawn }
            // What is ended to be started again is not said, however it ends.
            guard.restart_pending = true;
            guard.pending_end = None;
            guard.announced = true;
        }
        if !kill_children(self.root_pid(id)) {
            let mut guard = live.lock().expect("pty live");
            guard.restart_pending = false;
            begin_command(id, &mut guard, &writer, emit);
            return Restart::Retyped
        }
        // The prompt is waited for as long as the Electron build waits, and
        // no longer: what the restart comes to is known when this returns.
        let deadline = Instant::now() + Duration::from_millis(450);
        let mut retyped = false;
        let mut ended = false;
        while !(retyped || ended) && Instant::now() < deadline {
            {
                let guard = live.lock().expect("pty live");
                // The prompt came and the command was typed again.
                retyped = !guard.restart_pending;
                // The process of the terminal went with what ran in it.
                ended = guard.phase == Phase::Dead;
            }
            // The shell went with what ran in it, but its exit is not said
            // yet by the thread that waits for it, so it is asked of the
            // system: a command typed into it now would be lost with it.
            ended = ended || crate::sys::process_gone(self.root_pid(id));
            if !(retyped || ended) { std::thread::sleep(Duration::from_millis(20)); }
        }
        if retyped { return Restart::Retyped }
        if ended {
            let mut guard = live.lock().expect("pty live");
            // Said to have been announced, so that the exit the waiting
            // thread reports says nothing more.
            guard.restart_pending = false;
            guard.announced = true;
            return Restart::Respawn
        }
        let mut guard = live.lock().expect("pty live");
        guard.restart_pending = false;
        begin_command(id, &mut guard, &writer, emit);
        Restart::Retyped
    }

    /// The Agent session the terminal resumes, for when it is created again.
    pub fn agent_session_of(&self, id: &str) -> Option<String> {
        self.sessions.lock().expect("pty").get(id).and_then(|session| session.live.lock().expect("pty live").agent_session.clone())
    }

    fn live_of(&self, id: &str) -> Arc<Mutex<Live>> {
        self.sessions.lock().expect("pty").get(id).map(|session| session.live.clone()).expect("session")
    }

    fn root_pid(&self, id: &str) -> u32 {
        self.sessions.lock().expect("pty").get(id).map(|session| session.root_pid).unwrap_or(0)
    }

    pub fn close(&self, id: &str) {
        let Some(session) = self.sessions.lock().expect("pty").remove(id) else { return };
        session.live.lock().expect("pty live").closing = true;
        let root = session.root_pid;
        let rows = snapshot_table();
        let steps = windows_shutdown_plan(&rows, &[root], root != 0 && !rows.is_empty());
        run_shutdown_plan(&[(&session, root)], &steps);
    }

    /// End every terminal. On Windows the process table is read once for all
    /// of them, and every descendant is ended before the first root: reading
    /// it once per terminal costs a shell start each, which is seconds per
    /// terminal when many close together, as they do when the window closes.
    pub fn close_all(&self) {
        let sessions: Vec<(String, Session)> = {
            let mut table = self.sessions.lock().expect("pty");
            table.drain().collect()
        };
        if sessions.is_empty() {
            record_lifecycle("quit", None);
            return;
        }
        for (_, session) in &sessions { session.live.lock().expect("pty live").closing = true; }
        let rows = snapshot_table();
        let roots: Vec<u32> = sessions.iter().map(|(_, session)| session.root_pid).collect();
        let snapshot_ok = roots.iter().any(|root| *root != 0) && !rows.is_empty();
        let steps = windows_shutdown_plan(&rows, &roots, snapshot_ok);
        run_shutdown_plan(&sessions.iter().map(|(_, session)| (session, session.root_pid)).collect::<Vec<_>>(), &steps);
        record_lifecycle("quit", None);
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

fn spawn_reader(id: String, mut reader: Box<dyn Read + Send>, live: Arc<Mutex<Live>>, writer: Arc<Mutex<Box<dyn Write + Send>>>, emit: Emit, watched: bool) {
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
        // A process waited for apart from this says how it ended. Only the
        // connection of a remote terminal ends here, with its pipe.
        if !watched { process_ended(&id, &live, &emit, 0); }
    });
}

/// The process of the terminal has ended, with `code`. The page is told once,
/// with why, unless the end of what ran was said as it returned to the prompt.
/// What the workbench ended is said so even when the shell left with what ran
/// in it, before its prompt could: the shell of a terminal on Windows leaves
/// when the program in the foreground is ended.
fn process_ended(id: &str, live: &Mutex<Live>, emit: &Emit, code: i32) {
    let mut live = live.lock().expect("pty live");
    if live.phase == Phase::Dead { return }
    live.phase = Phase::Dead;
    live.input_ready = false;
    live.native_working = false;
    live.started_at = None;
    let (state, code, reason) = match live.pending_end.take() {
        Some(ended) => ended,
        None => (if code == 0 { "exited" } else { "failed" }, code, "exit"),
    };
    live.state = state.into();
    live.exit_code = Some(code);
    let said = !live.announced && !live.closing;
    live.announced = true;
    // A terminal being closed, for good or to be started again, says nothing
    // more: the page is done with it.
    let event = if live.closing { None } else { Some(snapshot(id, &live)) };
    drop(live);
    let Some(event) = event else { return };
    let event = if said { announce(event, reason) } else { event };
    emit(json!({ "channel": "pty:event", "payload": event }));
}

/// The helper beside this program; `AWB_CONSOLE_REPLY_BIN` names another.
fn console_reply_helper() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("AWB_CONSOLE_REPLY_BIN") { return Some(PathBuf::from(path)) }
    let program = std::env::current_exe().ok()?;
    let name = program.file_name()?.to_string_lossy();
    let stem = name.strip_suffix(".exe").unwrap_or(&name);
    Some(program.with_file_name(format!("{stem}-console-reply.exe")))
}

/// Answer `queries` capability queries in the console of `root_pid`. `None`
/// where the reply goes to the terminal itself.
fn console_reply(root_pid: u32, queries: usize) -> Option<Box<dyn FnOnce() + Send>> {
    if !cfg!(windows) || root_pid == 0 { return None }
    let created = crate::sys::process_created(root_pid)?;
    let helper = console_reply_helper()?;
    Some(Box::new(move || {
        for _ in 0..queries {
            // The helper owns its console, so it is the one that attaches.
            #[cfg(windows)]
            let status = {
                use std::os::windows::process::CommandExt;
                std::process::Command::new(&helper).arg(root_pid.to_string()).arg(created.to_string()).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).creation_flags(0x0800_0000).status()
            };
            #[cfg(not(windows))]
            let status: Result<std::process::ExitStatus, std::io::Error> = Err(std::io::Error::other("no console reply here"));
            if !matches!(status, Ok(status) if status.success()) { break }
        }
    }))
}

fn handle_chunk(id: &str, live: &Arc<Mutex<Live>>, writer: &Arc<Mutex<Box<dyn Write + Send>>>, chunk: &str, emit: &Emit) {
    let mut guard = live.lock().expect("pty live");
    let activity = guard.program.push(chunk);
    let queries = activity.queries;
    let changed = !activity.reports.is_empty();
    apply_reports(&mut guard, &activity.reports);
    guard.pending.push_str(&activity.text);
    let (visible, prompts) = drain_prompts(&mut guard.pending);
    let recorded_for_restore = guard.restore;
    let data = guard.data.clone();
    // The output of a terminal being closed is kept for its history, as the
    // Electron build keeps it, but the page is done with the terminal and is
    // told nothing more of it.
    let closing = guard.closing;
    let state_event = if changed && !closing { Some(snapshot(id, &guard)) } else { None };
    let visible = if closing { String::new() } else { visible };
    if queries > 0 {
        // ConPTY drops an unknown OSC sequence written to its input pipe, so
        // Windows hands the reply to the console as key strokes from a helper.
        match console_reply(guard.root_pid, queries) {
            Some(reply) => drop(std::thread::spawn(reply)),
            None => {
                let reply = b"\x1b]7501;?\x1b\\";
                let mut output = writer.lock().expect("writer");
                for _ in 0..queries { let _ = output.write_all(reply); }
            }
        }
    }
    drop(guard);
    // The complete record is kept as the history is: for a terminal whose
    // output is restored, and for no other, so that a terminal that keeps
    // none, as one made to test an executor, leaves nothing behind. A
    // terminal being closed is recorded no further: the last of what it
    // showed is not written after its history is deleted.
    if !chunk.is_empty() && recorded_for_restore && !closing { let _ = append_ansi(&data, id, chunk); }
    if !visible.is_empty() {
        emit(json!({ "channel": "pty:event", "payload": { "type": "data", "id": id, "data": visible } }));
    }
    if let Some(event) = state_event {
        emit(json!({ "channel": "pty:event", "payload": event }));
    }
    if !prompts.is_empty() && !closing { arm(id, live, writer, emit, false, prompts.last().copied()); }
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
    // A directory is a path, which a POSIX shell on Windows writes with forward slashes.
    let quote_path = |path: &Path| if shell == "pwsh" || shell == "cmd" { crate::ssh::ps_quote(&path.display().to_string()) } else { crate::ssh::bash_path_quote(path) };
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
                (format!("{command} --session-dir {} --continue", quote_path(directory)), Some(id.unwrap_or_else(|| "pello:directory".into())))
            }
        }
        _ => (command.to_string(), id),
    }
}

fn valid_agent_session(value: &str) -> Option<String> {
    if value.is_empty() || value.len() > 512 { return None }
    if value.chars().all(|char| char.is_ascii_alphanumeric() || ":./@+-_".contains(char)) { Some(value.to_string()) } else { None }
}

/// Say what the workbench ended if the terminal has not shown its prompt
/// since: the terminal takes input again, and the state, the code and why are
/// given. Nothing once the terminal is gone.
fn flush_pending_end(id: &str, live: &Mutex<Live>, _writer: &Mutex<Box<dyn Write + Send>>, emit: &Emit) {
    let mut live = live.lock().expect("pty live");
    let Some((state, code, reason)) = live.pending_end else { return };
    if live.phase == Phase::Dead || live.closing { return }
    live.pending_end = None;
    live.phase = Phase::Prompt;
    live.state = state.into();
    live.exit_code = Some(code);
    live.input_ready = true;
    live.announced = true;
    let event = announce(snapshot(id, &live), reason);
    drop(live);
    emit(json!({ "channel": "pty:event", "payload": event }));
}

/// Type the command of the terminal again where it runs, as the Electron
/// build does to start an Agent again: nothing of the run before is kept,
/// and its end is not said.
fn begin_command(id: &str, live: &mut Live, writer: &Mutex<Box<dyn Write + Send>>, emit: &Emit) {
    if live.phase == Phase::Dead || live.closing { return }
    live.phase = Phase::Command;
    live.agent_kind = if live.kind == "shell" { None } else { Some(live.kind.clone()) };
    live.native_status = false;
    live.native_working = false;
    live.state = "running".into();
    live.started_at = Some(now_ms());
    live.exit_code = None;
    live.input_ready = false;
    live.announced = false;
    live.pending_end = None;
    let event = snapshot(id, live);
    // The line ends with a carriage return, as the Electron build sends it.
    let _ = writer.lock().expect("writer").write_all(format!("{}\r", live.command).as_bytes());
    emit(json!({ "channel": "pty:event", "payload": event }));
}

fn arm(id: &str, live: &Mutex<Live>, writer: &Mutex<Box<dyn Write + Send>>, emit: &Emit, from_timer: bool, prompt_code: Option<i32>) {
    let mut live = live.lock().expect("pty live");
    if live.phase == Phase::Dead || live.closing { return }
    if from_timer && live.phase != Phase::Starting { return }
    // A shell prompt after a foreground command means that command has exited.
    // Electron clears the native agent there even if the last report was working.
    let shell_returned = live.kind == "shell" && live.phase == Phase::Command && prompt_code.is_some();
    // The prompt that follows the end of what ran, to start it again: the
    // command is typed again, and the end is not said.
    if prompt_code.is_some() && live.restart_pending {
        live.restart_pending = false;
        begin_command(id, &mut live, writer, emit);
        return
    }
    // What the workbench ended is said when the terminal shows its prompt,
    // unless it has been said from the timer by then.
    if let Some((state, code, reason)) = if prompt_code.is_some() { live.pending_end.take() } else { None } {
        // As when a process ends by itself: the terminal takes input again
        // and nothing runs in it as an Agent.
        live.phase = Phase::Prompt;
        live.state = state.into();
        live.exit_code = Some(code);
        live.input_ready = true;
        live.started_at = None;
        live.native_working = false;
        live.native_status = false;
        live.announced = true;
        let event = announce(snapshot(id, &live), reason);
        drop(live);
        emit(json!({ "channel": "pty:event", "payload": event }));
        return
    }
    let mut said = None;
    if live.native_working && !shell_returned { return }
    // A prompt once the end was said, as when what ran was forced to end a
    // moment before, says nothing again.
    if live.announced && prompt_code.is_some() { return }
    if !live.launched && !live.command.is_empty() {
        // The line ends with a carriage return, as the Electron build sends
        // it: Windows PowerShell takes a bare line feed for a line break
        // inside a command and waits at `>>` for the rest of it, so the
        // command is typed but never runs.
        let command = format!("{}\r", live.command);
        live.launched = true;
        live.phase = Phase::Command;
        live.state = "running".into();
        live.input_ready = false;
        let _ = writer.lock().expect("writer").write_all(command.as_bytes());
    } else if live.launched && live.kind != "shell" && prompt_code.is_some() {
        // A non-shell command returned to the prompt. Its end is said to the
        // page: zero is exited, anything else is failed, and nothing runs
        // as an Agent in the terminal from here on. The session it resumed
        // stays with the terminal, as the Electron build keeps it: what is
        // started again resumes the same conversation.
        let code = prompt_code.unwrap_or(0);
        live.phase = Phase::Prompt;
        live.exit_code = Some(code);
        live.input_ready = true;
        live.native_working = false;
        live.native_status = false;
        live.started_at = None;
        live.state = if code == 0 { "exited" } else { "failed" }.into();
        live.agent_kind = None;
        live.announced = true;
        said = Some("exit");
    } else if live.command.is_empty() || live.phase == Phase::Command {
        live.phase = Phase::Prompt;
        live.state = "idle".into();
        live.input_ready = true;
        live.started_at = None;
        live.exit_code = None;
        if shell_returned {
            live.agent_kind = None;
            live.agent_session = None;
            live.native_working = false;
            live.native_status = false;
        }
    }
    let event = snapshot(id, &live);
    drop(live);
    let event = match said { Some(reason) => announce(event, reason), None => event };
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
        "born": live.born,
        // Only the end of what ran is said to the page, and then with why.
        "announce": false
    })
}

/// The state of the terminal as the end of what ran is said, with why it
/// ended: a command or process that ended, a process forced to end, or the
/// second interrupt.
fn announce(mut event: Value, reason: &str) -> Value {
    event["announce"] = json!(true);
    event["reason"] = json!(reason);
    event
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

/// The terminal's output as it has arrived so far, status reports included.
pub fn load_journal(data: &Path, id: &str) -> String {
    std::fs::read_to_string(data.join("terminal-history").join(format!("{}.ansi", history_name(id)))).unwrap_or_default()
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

/// The history of a terminal closed for good: what its page kept of it
/// and its complete record, which may never have been written.
pub fn delete_history(data: &Path, id: &str) {
    let directory = data.join("terminal-history");
    let name = history_name(id);
    for file in [format!("{name}.log"), format!("{name}.ansi"), format!("{name}.log.tmp")] {
        let _ = std::fs::remove_file(directory.join(file));
    }
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

fn record_lifecycle(kind: &str, pid: Option<u32>) {
    let Ok(path) = std::env::var("AWB_PTY_LIFECYCLE") else { return };
    let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) else { return };
    use std::io::Write;
    let line = match pid {
        Some(pid) => format!(r#"{{"type":"{kind}","pid":{pid}}}"#),
        None => format!(r#"{{"type":"{kind}"}}"#),
    };
    let _ = writeln!(file, "{line}");
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

/// Every process and their parents as the system lists them now. The log
/// notes each read, which tells how many a closing took.
fn snapshot_table() -> Vec<ProcessRow> {
    record_shutdown("snapshot");
    crate::sys::process_table().into_iter().map(|(pid, parent)| ProcessRow { pid, parent }).collect()
}

/// End what the root of a terminal started, below it, and not the root: what
/// runs in a terminal is ended this way and the shell it was started from
/// stays. False when the root started nothing, as a Shell at its prompt, and
/// then what runs is the root itself.
fn kill_children(root: u32) -> bool {
    if root == 0 { return false }
    let table = crate::sys::process_table();
    let children = |pid: u32| table.iter().filter(|(_, parent)| *parent == pid).map(|(pid, _)| *pid).collect::<Vec<_>>();
    let kids = children(root);
    if kids.is_empty() { return false }
    // On Windows each child goes with everything it started, as the Electron
    // build ends it: `taskkill /T` is what the shell of a POSIX terminal
    // takes as the end of its foreground program, and it goes with it. The
    // leaves ended one by one leave that shell without its prompt.
    if cfg!(windows) {
        for pid in kids { crate::sys::kill_tree(pid); }
        return true
    }
    // Elsewhere every descendant is ended from one reading of the table,
    // leaves first.
    let mut stack = kids;
    let mut all = Vec::new();
    while let Some(pid) = stack.pop() {
        all.push(pid);
        stack.extend(children(pid));
    }
    for pid in all.into_iter().rev() { crate::sys::kill_process(pid); }
    true
}

/// Close the given terminals by the plan, which names their roots. The
/// session of a root is stopped when its root is ended, and each is marked
/// dead and reported exited once its root has gone.
fn run_shutdown_plan(sessions: &[(&Session, u32)], steps: &[ShutdownStep]) {
    for (session, _) in sessions {
        session.hook_stop.store(true, Ordering::Relaxed);
        if let Some(addr) = session.hook_addr { let _ = TcpStream::connect_timeout(&addr, Duration::from_millis(200)); }
    }
    let mut ended: Vec<bool> = vec![false; sessions.len()];
    for step in steps {
        match step {
            ShutdownStep::KillDescendant(pid) => {
                crate::sys::kill_process(*pid);
                record_shutdown(&format!("kill {pid}"));
            }
            ShutdownStep::EndRoot(pid) => {
                if let Some(index) = sessions.iter().position(|(_, root)| *root == *pid) {
                    if !ended[index] {
                        if let Some(stop) = sessions[index].0.stop.lock().expect("stop").take() { stop(); }
                        ended[index] = true;
                    }
                }
                record_shutdown(&format!("end {pid}"));
            }
            ShutdownStep::WaitNativeExit(pid) => {
                if crate::sys::process_exited(*pid) {
                    record_shutdown(&format!("wait {pid}"));
                    continue;
                }
                // The console is closed but the root is still there, as a
                // shell that ignores the closing of its terminal is. It is
                // ended with its tree, as the Electron build does, and
                // waited for again.
                let tree = crate::sys::kill_tree(*pid);
                record_shutdown(&format!("tree {pid} {}", tree as u8));
                crate::sys::process_exited(*pid);
                record_shutdown(&format!("wait {pid}"));
            }
        }
    }
    for (index, (session, root)) in sessions.iter().enumerate() {
        if !ended[index] {
            if let Some(stop) = session.stop.lock().expect("stop").take() { stop(); }
        }
        session.live.lock().expect("pty live").phase = Phase::Dead;
        record_lifecycle("exit", Some(*root));
    }
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

/// What is written for Shift+Enter. A Shell with nothing running is sent an
/// Enter. An Agent is sent the key sequence for it. Native Codex reads
/// console key events on Windows, and ConPTY decodes this input record as
/// the return key with shift held; only on this machine, as a remote Codex
/// reads the sequence from its own terminal.
pub fn shift_enter_key(agent: Option<&str>, local: bool, windows: bool) -> &'static [u8] {
    match agent {
        None => b"\r",
        Some("codex") if local && windows => b"\x1b[13;28;13;1;16;1_",
        Some(_) => b"\x1b[13;2u",
    }
}

#[cfg(test)]
mod tests {
    use super::shift_enter_key;

    #[test]
    fn shift_enter_is_an_enter_only_with_nothing_running() {
        // On Windows, to the native Codex on this machine.
        assert_eq!(shift_enter_key(None, true, true), b"\r");
        assert_eq!(shift_enter_key(None, false, true), b"\r");
        assert_eq!(shift_enter_key(Some("codex"), true, true), b"\x1b[13;28;13;1;16;1_");
        // Any other Agent, and the native Codex elsewhere or remote.
        for agent in ["claude", "opencode", "pi", "omp", "keys"] {
            assert_eq!(shift_enter_key(Some(agent), true, true), b"\x1b[13;2u", "{agent}");
        }
        assert_eq!(shift_enter_key(Some("codex"), false, true), b"\x1b[13;2u");
        // Elsewhere nothing reads console key events.
        assert_eq!(shift_enter_key(Some("codex"), true, false), b"\x1b[13;2u");
        assert_eq!(shift_enter_key(Some("claude"), true, false), b"\x1b[13;2u");
        assert_eq!(shift_enter_key(None, true, false), b"\r");
    }
}
