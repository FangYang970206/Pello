//! Interactive CLI stand-in for the behavior tests, the counterpart of the
//! Electron build's `program-status.cjs`: native reports, a persistent process,
//! no model calls.
//!
//! It asks which status protocol the terminal speaks, and starts reporting only
//! once the terminal answers. A terminal that never answers leaves it silent.
//!
//! Input is read the way a native TUI reads it. Windows gives the reply to the
//! console as key records, which reach the console's reader rather than a pipe,
//! so the Windows build reads `CONIN$` itself; elsewhere it reads stdin. The
//! console is read raw before the query goes out, so the answer cannot land in
//! a console still in line mode.

use std::io::Write;
use std::sync::mpsc::{Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const QUERY: &[u8] = b"\x1b]7501;?\x1b\\";
const IDLE: &str = "idle";
/// Held while the terminal is written to, by the main loop or by the reader.
static OUT: Mutex<()> = Mutex::new(());

/// Say what a key record was, as the console gives it. The reader of the
/// Windows console calls this: a sequence the terminal sends for a key is
/// decoded by ConPTY into one record, with the key and the modifiers held,
/// and that record is all a native TUI ever sees of it.
fn name_key(virtual_key: u16, modifiers: u32, character: u32) {
    let _held = OUT.lock().expect("output");
    let mut out = std::io::stdout();
    let _ = out.write_all(format!("STATUS_KEYS_{virtual_key}:{modifiers}:{character}\r\n").as_bytes());
    let _ = out.flush();
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let app = args.first().cloned().unwrap_or_else(|| "fixture".into());
    let session = args.get(1).cloned().unwrap_or_default();
    // `AWB_PROBE_KEYS` has every key record named as it is read, with the key
    // and the modifiers held. A sequence the terminal sends for a key is
    // decoded by ConPTY into one such record, which is all a native TUI ever
    // sees of it.
    let named = std::env::var_os("AWB_PROBE_KEYS").is_some();
    let mut out = std::io::stdout();
    let input: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
    let (sender, receiver): (Sender<()>, Receiver<()>) = std::sync::mpsc::channel();
    if !spawn_reader(input.clone(), sender) { return }
    let _ = out.write_all(QUERY);
    let _ = out.flush();
    let mut negotiated = false;
    // What has arrived but is not yet a whole line, as node's fixture keeps it.
    let mut pending: Vec<u8> = Vec::new();
    loop {
        // Woken by each arrival from the terminal; the long wait ends the
        // process once the terminal is gone.
        if receiver.recv_timeout(Duration::from_secs(600)).is_err() { return }
        let _held = OUT.lock().expect("output");
        {
            let mut input = input.lock().expect("input");
            pending.append(&mut input);
        }
        let mut data = pending;
        if !negotiated && data.windows(QUERY.len()).any(|window| window == QUERY) {
            data = cut_first(&data, QUERY);
            negotiated = true;
            let _ = out.write_all(b"STATUS_PROBE_OK\r\n");
            report(&app, &session, IDLE, &mut out);
        }
        while let Some(at) = data.iter().position(|byte| *byte == b'\r' || *byte == b'\n') {
            let command = String::from_utf8_lossy(&data[..at]).trim().to_string();
            data.drain(..at + 1);
            if command == "exit" { return }
            // `exit 3` ends with that code, as a process that failed does.
            if let Some(code) = command.strip_prefix("exit ") {
                let _ = out.write_all(format!("STATUS_COMMAND_{command}\r\n").as_bytes());
                let _ = out.flush();
                std::process::exit(code.trim().parse().unwrap_or(1));
            }
            for (name, state) in [("work", "working"), ("idle", IDLE), ("done", "done"), ("blocked", "blocked")] {
                if command == name { report(&app, &session, state, &mut out) }
            }
            if command == "progresswork" { let _ = out.write_all(b"\x1b]9;4;3\x07"); }
            if command == "progressidle" { let _ = out.write_all(b"\x1b]9;4;0\x07"); }
            let _ = out.write_all(format!("STATUS_COMMAND_{command}\r\n").as_bytes());
        }
        pending = data;
        // Where the input is read as bytes, a key the terminal sends without a
        // line ending, as Shift+Enter is, is what is left after the lines.
        if !cfg!(windows) && named && !pending.is_empty() {
            let _ = out.write_all(format!("STATUS_KEYS_{}\r\n", pending.iter().map(|byte| format!("{byte:02x}")).collect::<String>()).as_bytes());
            pending.clear();
        }
        let _ = out.flush();
        drop(_held);
    }
}

/// Start reading the terminal. False when there is no terminal to read.
#[cfg(not(windows))]
fn spawn_reader(input: Arc<Mutex<Vec<u8>>>, sender: Sender<()>) -> bool {
    std::thread::spawn(move || {
        use std::io::Read;
        let mut stdin = std::io::stdin();
        let mut buffer = [0u8; 4096];
        while let Ok(count) = stdin.read(&mut buffer) {
            if count == 0 { break }
            input.lock().expect("input").extend_from_slice(&buffer[..count]);
            let _ = sender.send(());
        }
    });
    true
}

/// Open the console and leave line mode, as a TUI does before its first draw.
#[cfg(windows)]
fn raw_console() -> Option<windows_sys::Win32::Foundation::HANDLE> {
    use windows_sys::Win32::Foundation::{GENERIC_READ, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{CreateFileW, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING};
    use windows_sys::Win32::System::Console::{GetConsoleMode, SetConsoleMode};
    const ECHO_INPUT: u32 = 0x0001;
    const LINE_INPUT: u32 = 0x0002;
    const PROCESSED_INPUT: u32 = 0x0004;
    const QUICK_EDIT: u32 = 0x0040;
    let name: Vec<u16> = "CONIN$\0".encode_utf16().collect();
    let console = unsafe { CreateFileW(name.as_ptr(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, std::ptr::null(), OPEN_EXISTING, 0, 0 as HANDLE) };
    if console == INVALID_HANDLE_VALUE as HANDLE { return None }
    let mut mode = 0u32;
    unsafe { GetConsoleMode(console, &mut mode) };
    unsafe { SetConsoleMode(console, mode & !(ECHO_INPUT | LINE_INPUT | PROCESSED_INPUT | QUICK_EDIT)) };
    Some(console)
}

#[cfg(windows)]
fn spawn_reader(input: Arc<Mutex<Vec<u8>>>, sender: Sender<()>) -> bool {
    use windows_sys::Win32::Foundation::HANDLE;
    let Some(console) = raw_console() else { return false };
    let console = console as usize;
    std::thread::spawn(move || {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Console::{ReadConsoleInputW, INPUT_RECORD, KEY_EVENT};
        let console = console as HANDLE;
        let mut records: [INPUT_RECORD; 64] = unsafe { std::mem::zeroed() };
        let named = std::env::var_os("AWB_PROBE_KEYS").is_some();
        loop {
            let mut count = 0u32;
            if unsafe { ReadConsoleInputW(console, records.as_mut_ptr(), records.len() as u32, &mut count) } == 0 || count == 0 { break }
            let mut fresh: Vec<u8> = Vec::new();
            let mut units: Vec<u16> = Vec::new();
            for record in &records[..count as usize] {
                if record.EventType != KEY_EVENT as u16 { continue }
                let key = unsafe { record.Event.KeyEvent };
                // A TUI takes the character of each key press.
                if key.bKeyDown == 0 { continue }
                let ch = unsafe { key.uChar.UnicodeChar };
                // Each press of the return key is named with the modifiers.
                if named && key.wVirtualKeyCode == 13 { name_key(key.wVirtualKeyCode, key.dwControlKeyState, ch as u32); }
                if ch != 0 { units.push(ch); }
            }
            // The console gives UTF-16 units, one per key; an escape sequence is
            // plain ASCII, one byte per unit.
            if units.is_empty() { continue }
            fresh.extend_from_slice(&String::from_utf16_lossy(&units).as_bytes());
            input.lock().expect("input").extend_from_slice(&fresh);
            let _ = sender.send(());
        }
        unsafe { CloseHandle(console) };
    });
    true
}

fn report(app: &str, session: &str, state: &str, out: &mut dyn Write) {
    let _ = out.write_all(format!("\x1b]7501;state={state}:app={app}{}\x1b\\", if session.is_empty() { String::new() } else { format!(":session={session}") }).as_bytes());
}

fn cut_first(data: &[u8], needle: &[u8]) -> Vec<u8> {
    match data.windows(needle.len()).position(|window| window == needle) {
        Some(at) => [&data[..at], &data[at + needle.len()..]].concat(),
        None => data.to_vec(),
    }
}
