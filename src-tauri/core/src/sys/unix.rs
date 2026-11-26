//! POSIX primitives: openat-style directory walks, no-replace rename, and the
//! freedesktop trash. Each function keeps the behavior the port already had.

use super::EntryKind;
use std::ffi::CString;
use std::fs::OpenOptions;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

pub struct Chain(Vec<OwnedFd>);

fn directory(path: &std::ffi::OsStr) -> io::Result<OwnedFd> {
    let text = CString::new(path.as_encoded_bytes()).map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains a NUL byte"))?;
    let fd = unsafe { libc::open(text.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC) };
    if fd < 0 { return Err(io::Error::last_os_error()) }
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

fn child(parent: &OwnedFd, name: &str) -> io::Result<OwnedFd> {
    let text = CString::new(name).map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "name contains a NUL byte"))?;
    let fd = unsafe { libc::openat(parent.as_raw_fd(), text.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
    if fd < 0 { return Err(io::Error::last_os_error()) }
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

pub fn open_chain(root: &Path, parts: &[&str]) -> io::Result<Chain> {
    let mut held = vec![directory(root.as_os_str())?];
    for part in parts {
        held.push(child(held.last().expect("root is held"), part)?);
    }
    Ok(Chain(held))
}

impl Chain {
    fn parent(&self) -> &OwnedFd { self.0.last().expect("chain always holds the final directory") }

    pub fn entry_kind(&self, name: &str) -> io::Result<EntryKind> {
        let text = CString::new(name).map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "name contains a NUL byte"))?;
        let mut info: libc::stat = unsafe { std::mem::zeroed() };
        let result = unsafe { libc::fstatat(self.parent().as_raw_fd(), text.as_ptr(), &mut info, libc::AT_SYMLINK_NOFOLLOW) };
        if result != 0 { return Err(io::Error::last_os_error()) }
        Ok(match info.st_mode & libc::S_IFMT {
            libc::S_IFLNK => EntryKind::Link,
            libc::S_IFDIR => EntryKind::Directory,
            libc::S_IFREG => EntryKind::File,
            _ => EntryKind::Other,
        })
    }

    pub fn rename_noreplace(&self, from: &str, to: &Chain, name: &str) -> io::Result<()> {
        let source = CString::new(from).map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "name contains a NUL byte"))?;
        let target = CString::new(name).map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "name contains a NUL byte"))?;
        let result = unsafe { libc::renameat2(self.parent().as_raw_fd(), source.as_ptr(), to.parent().as_raw_fd(), target.as_ptr(), libc::RENAME_NOREPLACE) };
        if result != 0 { return Err(io::Error::last_os_error()) }
        Ok(())
    }
}

pub fn open_read_nofollow(path: &Path) -> io::Result<std::fs::File> {
    OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK).open(path)
}

/// Create or truncate a file readable only by the current user.
pub fn private_file(path: &Path) -> io::Result<std::fs::File> {
    OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(path)
}

pub fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."))
}

pub fn restrict_to_owner(file: &std::fs::File) {
    use std::os::unix::fs::PermissionsExt;
    let _ = file.set_permissions(std::fs::Permissions::from_mode(0o600));
}

pub fn create_shared_file(path: &Path) -> io::Result<std::fs::File> {
    OpenOptions::new().write(true).create_new(true).mode(0o644).open(path)
}

pub fn trash(path: &Path) -> io::Result<()> {
    if let Ok(program) = std::env::var("AWB_TRASH_BIN") {
        let output = std::process::Command::new(&program).arg(path).output()?;
        if !output.status.success() {
            return Err(io::Error::new(io::ErrorKind::Other, "unable to move to the trash"));
        }
        return Ok(());
    }
    if let Ok(status) = std::process::Command::new("gio").arg("trash").arg(path).status() {
        if status.success() { return Ok(()) }
    }
    let data_home = std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).unwrap_or_else(|| home().join(".local").join("share"));
    let trash = data_home.join("Trash");
    let files = trash.join("files");
    let info = trash.join("info");
    std::fs::create_dir_all(&files)?;
    std::fs::create_dir_all(&info)?;
    let base = path.file_name().and_then(|name| name.to_str()).unwrap_or("item");
    let mut destination = files.join(base);
    if destination.exists() {
        destination = files.join(format!("{base}-{}", crate::random_id()));
    }
    std::fs::rename(path, &destination)?;
    let info_name = format!("{}.trashinfo", destination.file_name().and_then(|name| name.to_str()).unwrap_or(base));
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or(std::time::Duration::from_secs(0)).as_secs();
    let body = format!("[Trash Info]\nPath={}\nDeletionDate={stamp}\n", path.display());
    std::fs::write(info.join(info_name), body)?;
    Ok(())
}

/// POSIX session per helper; `kill(-pgid)` reaches everything it started.
/// The group id is the leader's pid, learned when the child is attached.
pub struct Group(std::cell::Cell<u32>);

pub fn prepare(command: &mut std::process::Command) -> io::Result<Group> {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
    Ok(Group(std::cell::Cell::new(0)))
}

impl Group {
    pub fn attach(&self, child: &std::process::Child) -> io::Result<()> {
        self.0.set(child.id());
        Ok(())
    }

    pub fn kill(&self) {
        let pid = self.0.get();
        if pid > 1 { unsafe { libc::kill(-(pid as i32), libc::SIGKILL); } }
    }
}

pub fn process_table() -> Vec<super::ProcessRow> {
    let mut rows = Vec::new();
    let Ok(entries) = std::fs::read_dir("/proc") else { return rows };
    for entry in entries.flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else { continue };
        let Ok(stat) = std::fs::read_to_string(entry.path().join("stat")) else { continue };
        let Some(end) = stat.rfind(')') else { continue };
        let mut fields = stat[end + 1..].split_whitespace();
        let _state = fields.next();
        let parent = fields.next().and_then(|value| value.parse().ok()).unwrap_or(0);
        if pid > 0 && parent > 0 { rows.push((pid, parent)); }
    }
    rows
}

pub fn kill_process(pid: u32) {
    if pid <= 1 { return }
    unsafe { libc::kill(pid as i32, libc::SIGKILL); }
}

pub fn process_exited(pid: u32) -> bool {
    if pid == 0 { return true }
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    loop {
        let mut status = 0;
        let result = unsafe { libc::waitpid(pid as i32, &mut status, libc::WNOHANG) };
        if result == pid as i32 || result < 0 || std::time::Instant::now() >= deadline { return true }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

/// True once the process has exited, without waiting for it. A process that
/// is still there answers the empty signal, one that is gone does not.
pub fn process_gone(pid: u32) -> bool {
    if pid == 0 { return true }
    unsafe { libc::kill(pid as i32, 0) != 0 && *libc::__errno_location() == libc::ESRCH }
}

/// When the process started. The POSIX side writes a reply to the terminal, so
/// nothing attaches to another process and the value is unused.
pub fn process_created(_pid: u32) -> Option<u64> {
    None
}

/// The POSIX side ends a root with its own signal, which also reaches the
/// process group it leads.
pub fn kill_tree(_pid: u32) -> bool {
    false
}
