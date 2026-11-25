//! A process tree for the behavior tests, the counterpart of the Electron
//! build's `session-tree.cjs`: each level notes its pid, then starts the next
//! one detached, and stays alive.
//!
//! `awb-session-tree <pid file> [depth]`

use std::io::Write;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(file) = args.first() else {
        eprintln!("usage: awb-session-tree <pid file> [depth]");
        std::process::exit(2);
    };
    // A depth of 2 is one root, one child and one grandchild; refuse more.
    let depth: u32 = match args.get(1).map(|value| value.parse()) {
        None => 2,
        Some(Ok(depth)) if depth <= 2 => depth,
        _ => {
            eprintln!("usage: awb-session-tree <pid file> [depth 0..=2]");
            std::process::exit(2);
        }
    };
    let mut note = std::fs::OpenOptions::new().create(true).append(true).open(file).expect("open the pid file");
    writeln!(note, "{}", std::process::id()).expect("note the pid");
    drop(note);
    if depth > 0 {
        // Detached children must also be stopped when their terminal is closed.
        let mut command = std::process::Command::new(std::env::current_exe().expect("self"));
        command.arg(file).arg((depth - 1).to_string());
        command.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP: no console of its own.
            command.creation_flags(0x0000_0008 | 0x0000_0200);
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let _ = command.spawn();
    }
    loop {
        std::thread::sleep(std::time::Duration::from_secs(60));
    }
}
