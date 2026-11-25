//! Hands a terminal's fixed reply to its console as key strokes. The main
//! process starts it, because attaching to a console replaces the attaching
//! process's own console.
//!
//! `awb-console-reply <pid> <expected creation time>` sends the reply.
//! `awb-console-reply created <pid>` prints when the process started.

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("created") {
        match args.get(1).and_then(|value| value.parse::<u32>().ok()).and_then(pello_core::sys::process_created) {
            Some(created) => println!("{created}"),
            None => std::process::exit(3),
        }
        return;
    }
    let (Some(pid), Some(created)) = (args.first().and_then(|value| value.parse::<u32>().ok()), args.get(1).and_then(|value| value.parse::<u64>().ok())) else {
        eprintln!("usage: awb-console-reply <pid> <creation time>");
        std::process::exit(2);
    };
    // Attaching acts on whichever process the pid names now. The same start
    // time before and after means it was the one the caller meant.
    if pid == 0 || pello_core::sys::process_created(pid) != Some(created) { std::process::exit(3) }
    if let Err(error) = pello_core::sys::console_key_text(pid, "\u{1b}]7501;?\u{1b}\\") {
        eprintln!("console reply: {error}");
        std::process::exit(4);
    }
    if pello_core::sys::process_created(pid) != Some(created) { std::process::exit(3) }
}
