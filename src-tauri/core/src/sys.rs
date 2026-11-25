//! Platform primitives behind the file, search and upload rules. The workbench
//! relies on them to keep every path inside the real project, to publish files
//! without replacing another writer, and to recover deleted entries.

#[cfg(unix)]
mod unix;

#[cfg(windows)]
mod windows;

#[cfg(unix)]
use unix as imp;

#[cfg(windows)]
use windows as imp;

pub use imp::{home, open_read_nofollow, private_file, rename_noreplace, trash};

#[cfg(windows)]
pub use imp::console_key_text;

/// Narrow a freshly created file to the current user.
pub fn restrict_to_owner(file: &std::fs::File) {
    imp::restrict_to_owner(file)
}

/// Create a new ordinary file, failing when it already exists. Imported Skill
/// files use this so an import never overwrites an existing resource.
pub fn create_shared_file(path: &std::path::Path) -> std::io::Result<std::fs::File> {
    imp::create_shared_file(path)
}

/// One `pid -> parent pid` row of a single process-table snapshot.
pub type ProcessRow = (u32, u32);

/// Read every `pid, parent` pair once. An empty result means the table could
/// not be read, and callers must fall back rather than assume no descendants.
pub fn process_table() -> Vec<ProcessRow> {
    imp::process_table()
}

/// When the process started, for telling a live process from a reused pid.
/// `None` when it cannot be read.
pub fn process_created(pid: u32) -> Option<u64> {
    imp::process_created(pid)
}

/// End one process without touching its relatives.
pub fn kill_process(pid: u32) {
    imp::kill_process(pid)
}

/// End a process together with everything it started. True when the system
/// carried it out.
pub fn kill_tree(pid: u32) -> bool {
    imp::kill_tree(pid)
}

/// True once the process has exited. Waits up to three seconds otherwise.
pub fn process_exited(pid: u32) -> bool {
    imp::process_exited(pid)
}

/// A spawned helper and everything it starts, ended together.
pub struct ProcessGroup(imp::Group);

impl ProcessGroup {
    /// Apply before spawn so the child is born inside the group.
    pub fn prepare(command: &mut std::process::Command) -> std::io::Result<Self> {
        Ok(Self(imp::prepare(command)?))
    }

    /// Run right after a successful spawn.
    pub fn attach(&self, child: &std::process::Child) -> std::io::Result<()> {
        self.0.attach(child)
    }

    pub fn kill(&self) {
        self.0.kill()
    }
}

/// A helper process together with the group that ends its whole tree.
pub struct Helper {
    pub child: std::process::Child,
    group: imp::Group,
}

impl Helper {
    pub fn spawn(command: &mut std::process::Command) -> std::io::Result<Self> {
        let group = imp::prepare(command)?;
        let child = command.spawn()?;
        group.attach(&child)?;
        Ok(Self { child, group })
    }

    /// True once the leader has exited, without reaping it.
    pub fn done(&mut self) -> bool {
        self.child.try_wait().ok().flatten().is_some()
    }

    /// End the leader and everything it started.
    pub fn stop(&mut self) {
        self.group.kill();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for Helper {
    fn drop(&mut self) {
        // A cancelled task must not leave its helpers behind.
        self.group.kill();
    }
}

/// What a directory entry is, read without following links.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EntryKind {
    Missing,
    File,
    Directory,
    Link,
    Other,
}

/// An opened chain of real directories from a root down to a parent. Holding
/// the handles keeps each component from being swapped for a link mid-operation.
pub struct DirectoryChain(imp::Chain);

impl DirectoryChain {
    /// Open every component without following links; any link fails the chain.
    pub fn open(root: &std::path::Path, parts: &[&str]) -> Result<Self, std::io::Error> {
        Ok(Self(imp::open_chain(root, parts)?))
    }

    pub fn kind(&self, name: &str) -> Result<EntryKind, std::io::Error> {
        self.0.entry_kind(name)
    }

    /// Rename inside the two verified chains; an existing destination fails.
    pub fn rename(&self, from: &str, to: &DirectoryChain, name: &str) -> Result<(), std::io::Error> {
        self.0.rename_noreplace(from, &to.0, name)
    }
}
