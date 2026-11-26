//! Windows primitives for the same rules the POSIX side enforces with openat:
//! walk only real directories, never replace an existing destination, and
//! recover deleted entries from the Recycle Bin.

use super::EntryKind;
use std::fs::{File, OpenOptions};
use std::io;
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::{Path, PathBuf};
use std::ptr::{null, null_mut};
use windows_sys::Win32::Foundation::{CloseHandle, ERROR_ALREADY_EXISTS, GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE, LocalFree, WAIT_OBJECT_0};
use windows_sys::Win32::Security::Authorization::{ConvertStringSecurityDescriptorToSecurityDescriptorW, SetSecurityInfo, SE_FILE_OBJECT};
use windows_sys::Win32::Security::{GetSecurityDescriptorDacl, ACL, DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PROTECTED_DACL_SECURITY_INFORMATION, SECURITY_ATTRIBUTES};
use windows_sys::Win32::System::Console::{AttachConsole, FreeConsole, INPUT_RECORD, INPUT_RECORD_0, KEY_EVENT, KEY_EVENT_RECORD, KEY_EVENT_RECORD_0, WriteConsoleInputW};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, GetFileInformationByHandleEx, GetFinalPathNameByHandleW, MoveFileExW, ReOpenFile, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_TAG_INFO,
    FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_GENERIC_READ, FILE_SHARE_DELETE, FILE_SHARE_READ,
    FILE_SHARE_WRITE, FileAttributeTagInfo, OPEN_EXISTING, READ_CONTROL, WRITE_DAC,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JobObjectExtendedLimitInformation,
};
use windows_sys::Win32::System::Threading::{GetProcessTimes, OpenProcess, TerminateProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE, WaitForSingleObject};
use windows_sys::Win32::UI::Shell::{SHFileOperationW, FO_DELETE, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT, SHFILEOPSTRUCTW};

fn wide(text: &str) -> io::Result<Vec<u16>> {
    if text.contains('\0') { return Err(io::Error::new(io::ErrorKind::InvalidInput, "path contains a NUL byte")) }
    Ok(text.encode_utf16().chain(Some(0)).collect())
}

fn plain_name(name: &str) -> io::Result<()> {
    if name.is_empty() || name == "." || name == ".." || name.contains(['\\', '/', ':']) || name.contains('\0') {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "not a plain directory name"));
    }
    Ok(())
}

fn attributes(file: &File) -> io::Result<FILE_ATTRIBUTE_TAG_INFO> {
    let mut tag = FILE_ATTRIBUTE_TAG_INFO { FileAttributes: 0, ReparseTag: 0 };
    let size = std::mem::size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32;
    if unsafe { GetFileInformationByHandleEx(file.as_raw_handle() as HANDLE, FileAttributeTagInfo, &mut tag as *mut _ as *mut _, size) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(tag)
}

fn is_link(tag: &FILE_ATTRIBUTE_TAG_INFO) -> bool { tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 }

/// The real path of an open handle, as the kernel resolved it.
fn final_path(file: &File) -> io::Result<PathBuf> {
    let handle = file.as_raw_handle() as HANDLE;
    let length = unsafe { GetFinalPathNameByHandleW(handle, null_mut(), 0, 0) };
    if length == 0 { return Err(io::Error::last_os_error()) }
    let mut buffer = vec![0u16; length as usize + 1];
    let written = unsafe { GetFinalPathNameByHandleW(handle, buffer.as_mut_ptr(), buffer.len() as u32, 0) };
    if written == 0 || written as usize > buffer.len() { return Err(io::Error::last_os_error()) }
    let text = String::from_utf16(&buffer[..written as usize]).map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "path is not valid UTF-16"))?;
    // Strip the `\\?\` prefix; extended paths stay valid for the Win32 APIs used here.
    let path = text.strip_prefix(r"\\?\").unwrap_or(&text);
    Ok(PathBuf::from(path))
}

/// Open the directory itself, not whatever a reparse point targets. The
/// handle keeps that directory's identity for the life of the chain.
fn open_directory(path: &Path) -> io::Result<File> {
    let name = wide(&path.to_string_lossy())?;
    let handle = unsafe {
        CreateFileW(name.as_ptr(), FILE_GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, null(), OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, 0 as HANDLE)
    };
    if handle == INVALID_HANDLE_VALUE as HANDLE { return Err(io::Error::last_os_error()) }
    let file = unsafe { File::from_raw_handle(handle) };
    let tag = attributes(&file)?;
    if tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0 { return Err(io::Error::new(io::ErrorKind::Other, "not a directory")) }
    if is_link(&tag) { return Err(io::Error::new(io::ErrorKind::Other, "linked directory")) }
    Ok(file)
}

fn open_child(parent: &File, name: &str) -> io::Result<File> {
    plain_name(name)?;
    let full = final_path(parent)?.join(name);
    let child = open_directory(&full)?;
    // The parent handle pins the directory; re-check the child resolved under it.
    // Windows paths are case-insensitive.
    let expected = final_path(parent)?.to_string_lossy().to_lowercase();
    let under = final_path(&child)?.parent().is_some_and(|resolved| resolved.to_string_lossy().to_lowercase() == expected);
    if !under { return Err(io::Error::new(io::ErrorKind::Other, "linked directory")) }
    Ok(child)
}
pub struct Chain(Vec<File>);

pub fn open_chain(root: &Path, parts: &[&str]) -> io::Result<Chain> {
    let mut held = vec![open_directory(&crate::real_path(root)?)?];
    for part in parts {
        held.push(open_child(held.last().expect("root is held"), part)?);
    }
    Ok(Chain(held))
}

impl Chain {
    fn parent(&self) -> &File { self.0.last().expect("chain always holds the final directory") }

    pub fn path(&self) -> io::Result<PathBuf> { final_path(self.parent()) }

    pub fn entry_kind(&self, name: &str) -> io::Result<EntryKind> {
        plain_name(name)?;
        let full = self.path()?.join(name);
        let link_or_dir = OpenOptions::new().read(true).custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT).open(&full);
        let file = match link_or_dir {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(EntryKind::Missing),
            Err(error) => return Err(error),
        };
        let tag = attributes(&file)?;
        Ok(match {
            let directory = tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0;
            (is_link(&tag), directory)
        } {
            (true, _) => EntryKind::Link,
            (false, true) => EntryKind::Directory,
            (false, false) => EntryKind::File,
        })
    }

    pub fn rename_noreplace(&self, from: &str, to: &Chain, name: &str) -> io::Result<()> {
        plain_name(name)?;
        plain_name(from)?;
        rename_noreplace(&self.path()?.join(from), &to.path()?.join(name))
    }
}

pub fn open_read_nofollow(path: &Path) -> io::Result<File> {
    let file = OpenOptions::new().read(true).custom_flags(FILE_FLAG_OPEN_REPARSE_POINT).open(path)?;
    if is_link(&attributes(&file)?) { return Err(io::Error::new(io::ErrorKind::Other, "linked file")) }
    Ok(file)
}

/// A descriptor that grants only the file's owner access, and stops the file
/// from inheriting anything wider from its directory. `D:P` is a DACL that
/// does not inherit; `A;;FA;;;OW` is full control for the owner.
fn owner_only_descriptor() -> io::Result<OwnerDescriptor> {
    let text = wide("D:P(A;;FA;;;OW)")?;
    let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
    if unsafe { ConvertStringSecurityDescriptorToSecurityDescriptorW(text.as_ptr(), 1, &mut descriptor, null_mut()) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(OwnerDescriptor(descriptor))
}

struct OwnerDescriptor(PSECURITY_DESCRIPTOR);

impl Drop for OwnerDescriptor {
    fn drop(&mut self) {
        unsafe { LocalFree(self.0 as *mut _) };
    }
}

/// Create or truncate a file readable only by the current user. The descriptor
/// travels with the create call, so a new file is never open to other accounts,
/// and is applied again in case the file already existed with a wider ACL.
pub fn private_file(path: &Path) -> io::Result<File> {
    let name = wide(&path.to_string_lossy())?;
    let descriptor = owner_only_descriptor()?;
    let mut attributes = SECURITY_ATTRIBUTES { nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: descriptor.0, bInheritHandle: 0 };
    // The share mode `std` opens files with: the caller may rename the file
    // into place while still holding it, as the POSIX side can.
    let handle = unsafe {
        CreateFileW(name.as_ptr(), GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, &mut attributes, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, 0 as HANDLE)
    };
    if handle == INVALID_HANDLE_VALUE as HANDLE { return Err(io::Error::last_os_error()) }
    let file = unsafe { File::from_raw_handle(handle) };
    restrict_to_owner(&file);
    Ok(file)
}

pub fn rename_noreplace(from: &Path, to: &Path) -> io::Result<()> {
    let source = wide(&from.to_string_lossy())?;
    let target = wide(&to.to_string_lossy())?;
    // No MOVEFILE_REPLACE_EXISTING: the move fails when the destination exists.
    if unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), 0) } == 0 {
        let error = io::Error::last_os_error();
        return Err(if error.raw_os_error() == Some(ERROR_ALREADY_EXISTS as i32) { io::Error::new(io::ErrorKind::AlreadyExists, error) } else { error });
    }
    Ok(())
}

pub fn home() -> PathBuf {
    std::env::var_os("USERPROFILE").map(PathBuf::from).or_else(|| std::env::var_os("HOME").map(PathBuf::from)).unwrap_or_else(|| PathBuf::from("."))
}

/// Narrow an open file to its owner. The directory's ACL is not relied on: a
/// profile directory can grant other accounts access, and a credential key or
/// a private configuration file must stay readable by this user alone.
pub fn restrict_to_owner(file: &std::fs::File) {
    fn restrict(file: &std::fs::File) -> io::Result<()> {
        let descriptor = owner_only_descriptor()?;
        let mut present: windows_sys::core::BOOL = 0;
        let mut dacl: *mut ACL = null_mut();
        let mut defaulted: windows_sys::core::BOOL = 0;
        let read = unsafe { GetSecurityDescriptorDacl(descriptor.0, &mut present, &mut dacl, &mut defaulted) };
        if read == 0 || present == 0 || dacl.is_null() { return Err(io::Error::other("the owner-only descriptor has no DACL")) }
        // Applying a descriptor needs WRITE_DAC, which a handle opened for
        // writing alone lacks. Reopen the same file, not its path, so nothing
        // can be swapped in between.
        let handle = unsafe { ReOpenFile(file.as_raw_handle() as HANDLE, READ_CONTROL | WRITE_DAC, 0, FILE_ATTRIBUTE_NORMAL) };
        if handle == INVALID_HANDLE_VALUE as HANDLE { return Err(io::Error::last_os_error()) }
        let rights = unsafe { File::from_raw_handle(handle) };
        let result = unsafe {
            SetSecurityInfo(rights.as_raw_handle() as HANDLE, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                null_mut(), null_mut(), dacl as *const ACL, null())
        };
        if result != 0 { return Err(io::Error::from_raw_os_error(result as i32)) }
        Ok(())
    }
    let _ = restrict(file);
}

/// Windows has no mode bits; a new file inherits the directory's ACL.
pub fn create_shared_file(path: &Path) -> io::Result<File> {
    OpenOptions::new().write(true).create_new(true).open(path)
}

pub fn trash(path: &Path) -> io::Result<()> {
    // SHFileOperation takes a double-NUL terminated list.
    let mut list = wide(&path.to_string_lossy())?;
    list.push(0);
    let mut operation = SHFILEOPSTRUCTW {
        hwnd: std::ptr::null_mut(),
        wFunc: FO_DELETE,
        pFrom: list.as_ptr(),
        pTo: null(),
        fFlags: (FOF_ALLOWUNDO | FOF_NOERRORUI | FOF_NOCONFIRMATION | FOF_SILENT) as u16,
        fAnyOperationsAborted: 0,
        hNameMappings: null_mut(),
        lpszProgressTitle: null(),
    };
    if unsafe { SHFileOperationW(&mut operation) } != 0 || operation.fAnyOperationsAborted != 0 {
        return Err(io::Error::new(io::ErrorKind::Other, "unable to move to the Recycle Bin"));
    }
    Ok(())
}

/// Job object per helper. `KILL_ON_JOB_CLOSE` ends everything the helper
/// started when the last handle goes away; `kill` ends it on demand.
pub struct Group(Option<OwnedHandle>);

pub fn prepare(_command: &mut std::process::Command) -> io::Result<Group> {
    let job = unsafe { CreateJobObjectW(null(), null()) };
    if job.is_null() { return Err(io::Error::last_os_error()) }
    let job = unsafe { OwnedHandle::from_raw_handle(job as std::os::windows::io::RawHandle) };
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    let size = std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32;
    if unsafe { SetInformationJobObject(job.as_raw_handle() as HANDLE, JobObjectExtendedLimitInformation, &limits as *const _ as *const _, size) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(Group(Some(job)))
}

impl Group {
    pub fn attach(&self, child: &std::process::Child) -> io::Result<()> {
        let job = self.0.as_ref().expect("group holds its job until dropped");
        // A short-lived live handle is enough to add the process; the job itself
        // is what outlives the child and ends its descendants.
        if unsafe { AssignProcessToJobObject(job.as_raw_handle() as HANDLE, child.as_raw_handle() as HANDLE) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
    pub fn kill(&self) {
        if let Some(job) = self.0.as_ref() {
            unsafe { TerminateJobObject(job.as_raw_handle() as HANDLE, 1); }
        }
    }
}

pub fn process_table() -> Vec<super::ProcessRow> {
    // One snapshot of every process, the same query the Electron build used.
    // `ConvertTo-Json` emits a single object, not an array, for one process.
    let output = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress"])
        .output();
    let Ok(output) = output else { return Vec::new() };
    let Ok(text) = String::from_utf8(output.stdout) else { return Vec::new() };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text.trim()) else { return Vec::new() };
    let rows = match value {
        serde_json::Value::Array(rows) => rows,
        single @ serde_json::Value::Object(_) => vec![single],
        _ => return Vec::new(),
    };
    rows.iter().filter_map(|row| {
        let pid = row["ProcessId"].as_u64()?;
        let parent = row["ParentProcessId"].as_u64()?;
        (pid > 0 && parent > 0).then(|| (pid as u32, parent as u32))
    }).collect()
}

pub fn kill_process(pid: u32) {
    if pid <= 4 { return }
    // A direct end, as `process.kill` does: starting `taskkill` for every
    // leaf costs more than a second each when many trees close together.
    let handle = unsafe { OpenProcess(PROCESS_TERMINATE | PROCESS_SYNCHRONIZE, 0, pid) };
    if handle.is_null() { return }
    unsafe { TerminateProcess(handle, 1) };
    unsafe { WaitForSingleObject(handle, 3000) };
    unsafe { CloseHandle(handle) };
}

/// End a process and everything it started. Closing a terminal's console does
/// not end every shell, so the root is ended as well once the console is gone.
pub fn kill_tree(pid: u32) -> bool {
    if pid <= 4 { return false }
    // What `taskkill` says of it is not for the console of whoever asked.
    std::process::Command::new("taskkill").args(["/F", "/T", "/PID", &pid.to_string()])
        .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null())
        .status().map(|status| status.success()).unwrap_or(false)
}

pub fn process_exited(pid: u32) -> bool {
    if pid == 0 { return true }
    // A synchronize handle waits on the real process instead of polling it.
    // A pid that cannot be opened has already gone.
    let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
    if handle.is_null() { return true }
    let waited = unsafe { WaitForSingleObject(handle, 3000) };
    unsafe { CloseHandle(handle) };
    waited == WAIT_OBJECT_0
}

/// True once the process has exited, without waiting for it.
pub fn process_gone(pid: u32) -> bool {
    if pid == 0 { return true }
    let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
    if handle.is_null() { return true }
    let waited = unsafe { WaitForSingleObject(handle, 0) };
    unsafe { CloseHandle(handle) };
    waited == WAIT_OBJECT_0
}

/// When the process started, in 100 ns units. Attaching to a console acts on
/// whatever process the pid names right now, so the caller compares this
/// before and after.
pub fn process_created(pid: u32) -> Option<u64> {
    if pid == 0 { return None }
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() { return None }
    let mut times = [windows_sys::Win32::Foundation::FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 }; 4];
    let read = unsafe { GetProcessTimes(handle, &mut times[0], &mut times[1], &mut times[2], &mut times[3]) };
    unsafe { CloseHandle(handle) };
    (read != 0).then(|| (u64::from(times[0].dwHighDateTime) << 32) | u64::from(times[0].dwLowDateTime))
}

/// Hand a text to the console of `pid` as key strokes, from the console input
/// side. ConPTY drops unknown OSC sequences written to its input pipe, which is
/// why a terminal reply takes this way. Attaching replaces the calling
/// process's own console, so this belongs in a helper that owns nothing else.
pub fn console_key_text(pid: u32, text: &str) -> io::Result<()> {
    // A process owns at most one console. The helper starts attached to its
    // parent's, and attaching elsewhere fails while that one is held.
    unsafe { FreeConsole() };
    let attached = unsafe { AttachConsole(pid) };
    if attached == 0 { return Err(io::Error::last_os_error()) }
    let result = (|| {
        let console = unsafe { CreateFileW(wide("CONIN$")?.as_ptr(), GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, null(), OPEN_EXISTING, 0, 0 as HANDLE) };
        if console == INVALID_HANDLE_VALUE as HANDLE { return Err(io::Error::last_os_error()) }
        let records: Vec<INPUT_RECORD> = text.chars().map(|ch| INPUT_RECORD {
            EventType: KEY_EVENT as u16,
            Event: INPUT_RECORD_0 { KeyEvent: KEY_EVENT_RECORD { bKeyDown: 1, wRepeatCount: 1, wVirtualKeyCode: 0, wVirtualScanCode: 0, uChar: KEY_EVENT_RECORD_0 { UnicodeChar: ch as u16 }, dwControlKeyState: 0 } },
        }).collect();
        let mut written = 0u32;
        let ok = unsafe { WriteConsoleInputW(console, records.as_ptr(), records.len() as u32, &mut written) };
        let failure = if ok == 0 || written as usize != records.len() { Some(io::Error::last_os_error()) } else { None };
        unsafe { CloseHandle(console) };
        failure.map_or(Ok(()), Err)
    })();
    unsafe { FreeConsole() };
    result
}
