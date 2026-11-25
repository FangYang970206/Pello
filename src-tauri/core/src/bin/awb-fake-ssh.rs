//! A stand-in for `ssh`, used only by the behavior tests. It records every call
//! the way the tests expect, refuses what real `ssh` refuses, and runs the
//! remote command on this machine so a test can observe what the workbench sent.
//! The tests point `AWB_SSH_BIN` at it.

use std::io::Write;
use std::path::PathBuf;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let log = PathBuf::from(std::env::var_os("AWB_SSH_LOG").expect("AWB_SSH_LOG"));
    let record = std::iter::once(std::env::var("SSH_AUTH_SOCK").unwrap_or_default())
        .chain(args.iter().cloned())
        .collect::<Vec<_>>()
        .join("\u{1e}");
    let mut file = std::fs::OpenOptions::new().create(true).append(true).open(&log).expect("open the call log");
    file.write_all(format!("CALL\u{1e}{record}\n").as_bytes()).expect("record the call");

    let last = args.last().cloned().unwrap_or_default();
    match args.iter().position(|arg| arg == "-i").and_then(|index| args.get(index + 1)) {
        Some(key) => {
            let text = std::fs::read_to_string(key).unwrap_or_default();
            if text.is_empty() { std::process::exit(2) }
            if !text.contains("OPENSSH PRIVATE KEY") { std::process::exit(3) }
            if !args.iter().any(|arg| arg == "IdentitiesOnly=yes") { std::process::exit(4) }
        }
        None => {
            if !agent_present() { std::process::exit(5) }
        }
    }

    if let Some(script) = pello_core::ssh::decode_powershell_command(&last) {
        // A Windows remote hands the words to the named program as they are.
        // Re-quoting the decoded script on a command line would lose its quotes.
        #[cfg(windows)]
        {
            let words: Vec<&str> = last.split_whitespace().collect();
            if script.contains("AWB_UPLOAD_OP ") {
                let mut remote = command(words[0]);
                remote.args(&words[1..]);
                exit(run(&mut remote));
            }
            // The other scripts name paths of an imaginary remote and are
            // judged by their text.
            exit(0);
        }
        #[cfg(unix)]
        {
            // Upload scripts name a helper that does the file work.
            let op = script.split("AWB_UPLOAD_OP ").nth(1).and_then(|rest| rest.split_whitespace().next());
            if let Some(op) = op {
                let helper = std::env::var_os("AWB_UPLOAD_HELPER").expect("AWB_UPLOAD_HELPER");
                exit(run(&mut command("python3").arg(helper).arg(op)));
            }
            exit(0);
        }
    }

    if last.contains("uname -s") {
        println!("{}", std::env::var("AWB_SSH_OS").unwrap_or_else(|_| "Linux".into()));
        return;
    }
    #[cfg(unix)]
    exit(run(&mut command("bash").arg("-lc").arg(&last)));
    #[cfg(windows)]
    {
        // Only a POSIX host can run a Linux remote command.
        eprintln!("fake ssh: Linux remote commands need a POSIX host");
        exit(255);
    }
}

fn command(program: &str) -> std::process::Command {
    std::process::Command::new(program)
}

/// Run a remote command with the caller's standard streams attached, which is
/// how `ssh` connects them, and report its exit code.
fn run(command: &mut std::process::Command) -> i32 {
    command.stdin(std::process::Stdio::inherit()).stdout(std::process::Stdio::inherit()).stderr(std::process::Stdio::inherit());
    command.status().map(|status| status.code().unwrap_or(255)).unwrap_or(127)
}

fn exit(code: i32) -> ! {
    std::process::exit(code)
}

fn agent_present() -> bool {
    let Some(sock) = std::env::var_os("SSH_AUTH_SOCK") else { return false };
    #[cfg(unix)]
    {
        std::fs::metadata(&sock).map(|meta| meta.file_type().is_socket()).ok() == Some(true)
    }
    #[cfg(windows)]
    {
        pipe_exists(&sock.to_string_lossy())
    }
}

/// True when a client can open the named pipe, the way `ssh` reaches an agent
/// on Windows. The pipe exists while its single waiting instance is between
/// clients, so a busy answer is retried briefly.
#[cfg(windows)]
fn pipe_exists(name: &str) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{CreateFileW, OPEN_EXISTING};
    let wide: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        let handle = unsafe { CreateFileW(wide.as_ptr(), 0xC0000000, 0, std::ptr::null(), OPEN_EXISTING, 0, 0 as HANDLE) };
        if handle != INVALID_HANDLE_VALUE as HANDLE {
            unsafe { CloseHandle(handle) };
            return true;
        }
        let busy = std::io::Error::last_os_error().raw_os_error() == Some(231);
        if !busy || std::time::Instant::now() > deadline { return false }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
}
