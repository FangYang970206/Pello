//! What a file is apart from its name. Two paths to one file share an id, so
//! a replacement can tell whether the file it is about to overwrite is still
//! the one that was looked at when the conflict was answered. On Windows the
//! id is the volume and the file index; elsewhere it is the device and the
//! inode, as Node's `fs.Stats` reports them to the Electron build.

use std::fs;
use std::path::Path;

/// The file itself: two paths to one file share it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FileId(pub u64, pub u64);

/// What a file was at a moment: which file, how long, and when it was last
/// written and when its metadata last changed. A file rewritten in place
/// gets the same id and a later time, so both are needed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Stamp {
    pub id: FileId,
    pub size: u64,
    /// Nanoseconds since the epoch; negative before it.
    pub modified: i128,
    pub changed: i128,
}

/// The kind of a path as it is named, not as it points: a link is a link.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    File,
    Directory,
    Other,
}

/// What is at a path, or `None` when there is nothing there. A broken link
/// is still a link, so it is `Other`, not missing.
pub fn inspect(path: &Path) -> Option<(Kind, Option<Stamp>)> {
    let metadata = fs::symlink_metadata(path).ok()?;
    let file_type = metadata.file_type();
    let kind = if file_type.is_symlink() || !(file_type.is_file() || file_type.is_dir()) {
        Kind::Other
    } else if file_type.is_dir() {
        Kind::Directory
    } else {
        Kind::File
    };
    let stamp = stamp_of(path, &metadata).ok();
    Some((kind, stamp))
}

#[cfg(windows)]
fn stamp_of(path: &Path, _metadata: &fs::Metadata) -> std::io::Result<Stamp> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::FILETIME;
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS,
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ,
        FILE_SHARE_WRITE, OPEN_EXISTING,
    };
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    // A link is opened as itself, so that the stamp is of the link.
    let handle = unsafe {
        CreateFileW(wide.as_ptr(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(), OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, std::ptr::null_mut())
    };
    // A failed open gives `INVALID_HANDLE_VALUE`, which is -1 and not null.
    if handle.is_null() || handle == windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE {
        return Err(std::io::Error::last_os_error());
    }
    let mut information = BY_HANDLE_FILE_INFORMATION { dwFileAttributes: 0, ftCreationTime: FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 },
        ftLastAccessTime: FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 }, ftLastWriteTime: FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 },
        dwVolumeSerialNumber: 0, nFileSizeHigh: 0, nFileSizeLow: 0, nNumberOfLinks: 0, nFileIndexHigh: 0, nFileIndexLow: 0 };
    let ok = unsafe { GetFileInformationByHandle(handle, &mut information) };
    unsafe { windows_sys::Win32::Foundation::CloseHandle(handle) };
    if ok == 0 { return Err(std::io::Error::last_os_error()); }
    let ticks = |time: FILETIME| ((time.dwHighDateTime as i64) << 32 | time.dwLowDateTime as i64) as i128;
    Ok(Stamp {
        id: FileId(information.dwVolumeSerialNumber as u64, (information.nFileIndexHigh as u64) << 32 | information.nFileIndexLow as u64),
        size: ((information.nFileSizeHigh as u64) << 32) | information.nFileSizeLow as u64,
        // A tick is 100 ns since 1601, which is 11_644_473_600 s before 1970.
        modified: (ticks(information.ftLastWriteTime) - 116_444_736_000_000_000) * 100,
        changed: (ticks(information.ftCreationTime) - 116_444_736_000_000_000) * 100,
    })
}

#[cfg(not(windows))]
fn stamp_of(path: &Path, _metadata: &fs::Metadata) -> std::io::Result<Stamp> {
    use std::os::unix::ffi::OsStrExt;
    let name = std::ffi::CString::new(path.as_os_str().as_bytes()).map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidInput, error))?;
    let mut stat: libc::stat = unsafe { std::mem::zeroed() };
    // `lstat` so that a link is stamped as the link itself.
    if unsafe { libc::lstat(name.as_ptr(), &mut stat) } != 0 { return Err(std::io::Error::last_os_error()); }
    let seconds = |seconds: impl Into<i128>, nanos: impl Into<i128>| -> i128 { seconds.into() * 1_000_000_000 + nanos.into() };
    #[cfg(target_os = "linux")]
    let (modified, changed) = (seconds(stat.st_mtime as i64, stat.st_mtime_nsec as i64), seconds(stat.st_ctime as i64, stat.st_ctime_nsec as i64));
    #[cfg(not(target_os = "linux"))]
    let (modified, changed) = (seconds(stat.st_mtim.tv_sec as i64, stat.st_mtim.tv_nsec as i64), seconds(stat.st_ctim.tv_sec as i64, stat.st_ctim.tv_nsec as i64));
    Ok(Stamp {
        id: FileId(stat.st_dev as u64, stat.st_ino as u64),
        size: stat.st_size as u64,
        modified,
        changed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_file_keeps_its_id_while_renamed_and_a_new_file_with_its_name_gets_another() {
        let root = std::env::temp_dir().join(format!("pello-file-id-{}", crate::random_id()));
        fs::create_dir_all(&root).unwrap();
        let file = root.join("first.txt");
        fs::write(&file, "same length").unwrap();
        let Some((_, Some(before))) = inspect(&file) else { panic!("the file is missing") };
        let moved = root.join("second.txt");
        fs::rename(&file, &moved).unwrap();
        let Some((_, Some(after))) = inspect(&moved) else { panic!("the file is missing") };
        assert_eq!(before.id, after.id, "a renamed file is still the same file");
        fs::write(&file, "same length").unwrap();
        let Some((_, Some(other))) = inspect(&file) else { panic!("the file is missing") };
        assert_ne!(before.id, other.id, "a new file is another file");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_file_written_again_in_place_is_the_same_file_at_a_later_time() {
        let root = std::env::temp_dir().join(format!("pello-file-id-{}", crate::random_id()));
        fs::create_dir_all(&root).unwrap();
        let file = root.join("note.txt");
        fs::write(&file, "first").unwrap();
        let Some((_, Some(before))) = inspect(&file) else { panic!("the file is missing") };
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::write(&file, "again").unwrap();
        let Some((_, Some(after))) = inspect(&file) else { panic!("the file is missing") };
        assert_eq!(before.id, after.id);
        assert_ne!(before, after, "the stamp tells the two moments apart");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_missing_path_is_nothing_and_a_directory_and_a_file_are_told_apart() {
        let root = std::env::temp_dir().join(format!("pello-file-id-{}", crate::random_id()));
        fs::create_dir_all(&root).unwrap();
        assert!(inspect(&root.join("missing.txt")).is_none());
        assert_eq!(inspect(&root).map(|(kind, _)| kind), Some(Kind::Directory));
        fs::write(root.join("plain.txt"), "x").unwrap();
        assert_eq!(inspect(&root.join("plain.txt")).map(|(kind, _)| kind), Some(Kind::File));
        let _ = fs::remove_dir_all(root);
    }
}
