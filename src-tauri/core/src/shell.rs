//! What the workbench asks of the desktop: opening a file with whatever the
//! system opens it with, a link in the browser, showing a file in its folder,
//! and the clipboard a copied path is written to. It stands for the Electron
//! build's `shell` and `clipboard` modules, on the system calls of each
//! platform.
//!
//! `AWB_OPEN_BIN` replaces the desktop with a program in tests: what is
//! opened is passed to it, and its failure is the failure reported. `true`
//! stands for one that does nothing, and only then does the workbench write
//! `AWB_OPEN_LOG` itself: a program that runs writes what it was given there
//! in its own way, and nothing is written twice. `AWB_CLIPBOARD_FILE` is a
//! clipboard kept in a file, so that a test neither reads nor writes the
//! user's own.

use crate::i18n::translate;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;

/// True when a program stands in for the desktop, as a test sets one up.
fn standing_in() -> bool {
    std::env::var_os("AWB_OPEN_BIN").is_some()
}

/// True when that stand-in is the one that does nothing.
fn does_nothing() -> bool {
    let program = std::env::var("AWB_OPEN_BIN").unwrap_or_default();
    program == "true" || Path::new(&program).file_name().and_then(|name| name.to_str()) == Some("true")
}

/// Write what was opened to the log: on a line of its own, or on its own
/// where one thing is read back, as a file shown in its folder is.
fn note(target: &str, on_its_own: bool) {
    let Ok(log) = std::env::var("AWB_OPEN_LOG") else { return };
    if on_its_own {
        let _ = std::fs::write(&log, target);
    } else if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&log) {
        use io::Write;
        let _ = writeln!(file, "{target}");
    }
}

/// What a stand-in said when it refused, or why when it said nothing.
fn refused(output: &Output, language: &str) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let detail = if !stderr.is_empty() { stderr } else { stdout };
    if detail.is_empty() { translate(language, "无法在资源管理器中打开", &[] as &[String]) } else { detail }
}

use std::process::Output;

/// Open a file or a folder with what the system opens it with, as
/// `shell.openPath` does: saying why when the system refuses.
pub fn open_path(path: &Path, language: &str) -> Result<(), String> {
    let target = path.as_os_str().to_string_lossy().into_owned();
    if standing_in() {
        // A stand-in that does nothing leaves the note to the workbench; one
        // that runs writes the log itself, and is not written twice.
        if does_nothing() {
            note(&target, false);
            return Ok(());
        }
        let program = std::env::var("AWB_OPEN_BIN").unwrap_or_default();
        let output = Command::new(program).arg(path).output().map_err(|error| error.to_string())?;
        return if output.status.success() { Ok(()) } else { Err(refused(&output, language)) };
    }
    system_open(&target, language)
}

/// Open a web link in the browser, as `shell.openExternal` does. Nothing is
/// said of a failure: the browser's own is the user's to see.
pub fn open_external(target: &str) {
    if standing_in() {
        if does_nothing() {
            note(target, false);
            return;
        }
        let _ = Command::new(std::env::var("AWB_OPEN_BIN").unwrap_or_default()).arg(target).status();
        return;
    }
    let _ = system_open(target, "en");
}

/// Show a file selected in its folder, as `shell.showItemInFolder` does.
pub fn show_in_folder(path: &Path) {
    let target = path.as_os_str().to_string_lossy().into_owned();
    if standing_in() {
        if does_nothing() {
            note(&target, true);
            return;
        }
        let _ = Command::new(std::env::var("AWB_OPEN_BIN").unwrap_or_default()).arg(path).status();
        return;
    }
    #[cfg(windows)]
    {
        // How the shell itself tells Explorer to open on one item.
        let _ = Command::new("explorer.exe").args(["/select,", &target]).spawn();
    }
    #[cfg(not(windows))]
    {
        let _ = open_path(path.parent().unwrap_or(path), "en");
    }
}

#[cfg(windows)]
fn wide(text: &str) -> io::Result<Vec<u16>> {
    if text.contains('\0') { return Err(io::Error::new(io::ErrorKind::InvalidInput, "text contains a NUL byte")) }
    Ok(text.encode_utf16().chain(Some(0)).collect())
}

/// The system's own way of opening something, whatever it is.
#[cfg(windows)]
fn system_open(target: &str, language: &str) -> Result<(), String> {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let file = wide(target).map_err(|error| error.to_string())?;
    let operation = wide("open").expect("a fixed verb");
    // Above 32 is success; the values below name what went wrong, and the
    // shell may already have shown what it had to say about it.
    let code = unsafe { ShellExecuteW(std::ptr::null_mut::<_>() as HWND, operation.as_ptr(), file.as_ptr(), std::ptr::null(), std::ptr::null(), SW_SHOWNORMAL) } as isize;
    if code > 32 { Ok(()) } else { Err(translate(language, "无法在资源管理器中打开", &[] as &[String])) }
}

#[cfg(not(windows))]
fn system_open(target: &str, language: &str) -> Result<(), String> {
    let program = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
    match Command::new(program).arg(target).output() {
        Ok(output) if output.status.success() => Ok(()),
        Ok(output) => Err(refused(&output, language)),
        Err(error) => Err(error.to_string()),
    }
}

/// Put text on the clipboard. Nothing is said when the clipboard is held by
/// another and stays so: the copy is then simply not made, as `writeText`
/// does not fail either.
pub fn set_clipboard_text(text: &str) {
    if let Some(file) = std::env::var_os("AWB_CLIPBOARD_FILE") {
        let _ = std::fs::write(&file, text);
        return;
    }
    #[cfg(windows)]
    {
        windows_set_clipboard(text);
    }
    #[cfg(not(windows))]
    {
        let _ = text;
    }
}

/// Read back what a copy put on the clipboard. Only the clipboard a test
/// keeps in a file is read: the user's own is never read back.
pub fn read_clipboard() -> Option<String> {
    let file = std::env::var_os("AWB_CLIPBOARD_FILE")?;
    std::fs::read_to_string(file).ok()
}

#[cfg(windows)]
fn windows_set_clipboard(text: &str) {
    use windows_sys::Win32::Foundation::{GlobalFree, HWND};
    use windows_sys::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData};
    use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    use windows_sys::Win32::System::Ole::CF_UNICODETEXT;
    let units: Vec<u16> = text.encode_utf16().chain(Some(0)).collect();
    unsafe {
        let memory = GlobalAlloc(GMEM_MOVEABLE, units.len() * 2);
        if memory.is_null() { return }
        let target = GlobalLock(memory) as *mut u16;
        if target.is_null() { GlobalFree(memory); return }
        std::ptr::copy_nonoverlapping(units.as_ptr(), target, units.len());
        GlobalUnlock(memory);
        // Another window may hold the clipboard just now; it is asked a few
        // times before the copy is given up.
        let mut opened = false;
        for _ in 0..8 {
            if OpenClipboard(std::ptr::null_mut::<_>() as HWND) != 0 { opened = true; break }
            std::thread::sleep(std::time::Duration::from_millis(15));
        }
        if !opened { GlobalFree(memory); return }
        let taken = EmptyClipboard() != 0 && !SetClipboardData(CF_UNICODETEXT as u32, memory).is_null();
        // The clipboard is closed whether or not it took the text, and the
        // memory is freed only when it did not: once taken, it is the system's.
        CloseClipboard();
        if !taken { GlobalFree(memory); }
    }
}

/// An editor the workbench may open a file with: the name it is offered
/// under, the program that was found for it and the arguments it takes before
/// the file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Editor {
    pub id: &'static str,
    pub name: &'static str,
    pub file: PathBuf,
    pub args: &'static [&'static str],
}

/// The extensions a file may have for an editor to be offered for it, as the
/// Electron build's `installedEditors` lists them.
const TEXT_EXTENSIONS: &[&str] = &[
    "txt", "md", "mdx", "markdown", "json", "jsonc", "jsonl", "yaml", "yml", "toml", "ini", "conf", "config", "xml", "html", "htm", "css", "scss", "less", "js", "jsx",
    "mjs", "cjs", "ts", "tsx", "vue", "svelte", "py", "pyi", "rb", "php", "go", "rs", "c", "h", "cpp", "hpp", "cs", "java", "kt", "swift", "sh", "bash", "zsh", "ps1",
    "bat", "cmd", "sql", "graphql", "proto", "csv", "tsv", "log", "env", "gitignore", "gitattributes", "dockerfile",
];

/// Where an editor is looked for: its executable on Windows, the folder it is
/// installed in under a programs root, and what it is called on the PATH of
/// Linux and macOS. Notepad++ has no name there, and is not offered.
struct Specification {
    id: &'static str,
    name: &'static str,
    exe: &'static str,
    linux: &'static str,
    folders: &'static [&'static str],
    args: &'static [&'static str],
}

const SPECIFICATIONS: &[Specification] = &[
    Specification { id: "vscode", name: "Visual Studio Code", exe: "Code.exe", linux: "code", folders: &["Microsoft VS Code"], args: &["--new-window"] },
    Specification { id: "cursor", name: "Cursor", exe: "Cursor.exe", linux: "cursor", folders: &["cursor", "Cursor"], args: &["--new-window"] },
    Specification { id: "windsurf", name: "Windsurf", exe: "Windsurf.exe", linux: "windsurf", folders: &["Windsurf"], args: &["--new-window"] },
    Specification { id: "sublime", name: "Sublime Text", exe: "sublime_text.exe", linux: "subl", folders: &["Sublime Text", "Sublime Text 3"], args: &[] },
    Specification { id: "notepad-plus", name: "Notepad++", exe: "notepad++.exe", linux: "", folders: &["Notepad++"], args: &[] },
];

/// The editors installed for a file, found by their executable files alone:
/// never through a shell, nor a batch wrapper that is on the PATH. A file
/// whose extension is not one of the text extensions has none.
pub fn installed_editors(filename: &Path, platform: &str, environment: &dyn Fn(&str) -> Option<String>) -> Vec<Editor> {
    // As `path.extname` reads it: nothing for a name that is only an
    // extension, and the part after the last dot otherwise.
    let name = filename.file_name().and_then(|name| name.to_str()).unwrap_or("");
    let extension = name.rsplit_once('.').filter(|(stem, _)| !stem.is_empty()).map(|(_, extension)| extension.to_ascii_lowercase()).unwrap_or_default();
    if !extension.is_empty() && !TEXT_EXTENSIONS.contains(&extension.as_str()) { return Vec::new() }
    let windows = platform == "win32";
    let roots: Vec<PathBuf> = if windows {
        let mut roots = Vec::new();
        if let Some(local) = environment("LOCALAPPDATA") { roots.push(Path::new(&local).join("Programs")) }
        for variable in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(root) = environment(variable) { roots.push(PathBuf::from(root)) }
        }
        roots
    } else {
        Vec::new()
    };
    let search: Vec<String> = environment("PATH").map(|path| if windows { path.split(';') } else { path.split(':') }.filter(|part| !part.is_empty()).map(str::to_string).collect()).unwrap_or_default();
    SPECIFICATIONS.iter().filter_map(|specification| {
        let mut candidates: Vec<PathBuf> = Vec::new();
        if windows {
            candidates.extend(roots.iter().flat_map(|root| specification.folders.iter().map(move |folder| root.join(folder).join(specification.exe))));
            candidates.extend(search.iter().map(|root| Path::new(root).join(specification.exe)));
        } else if !specification.linux.is_empty() {
            candidates.extend(search.iter().map(|root| Path::new(root).join(specification.linux)));
        }
        let file = candidates.into_iter().find(|candidate| executable_file(candidate))?;
        let file = crate::real_path(&file).unwrap_or(file);
        Some(Editor { id: specification.id, name: specification.name, file, args: specification.args })
    }).collect()
}

/// True when the path is a file that can be run.
fn executable_file(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else { return false };
    if !meta.is_file() { return false }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(windows)]
    {
        true
    }
}

/// Open a file with an editor, which is started on its own and outlives the
/// workbench: nothing waits for it.
pub fn launch_editor(editor: &Editor, file: &Path) -> Result<(), String> {
    let mut command = Command::new(&editor.file);
    command.args(editor.args).arg(file).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    // No window of its own on Windows: an editor is a window already.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command.spawn().map(|_| ()).map_err(|error| error.to_string())
}

/// What became of a copy to a new name.
#[derive(Debug, PartialEq, Eq)]
pub enum Copy {
    /// The file is at the new name, whole: it was published only once the
    /// entire copy had been made.
    Copied,
    /// Something is at the new name already; it was left as it was.
    Taken,
}

/// Copy a file to a name that must be free. The copy is made beside the
/// destination under a name of its own and moved into place only once it is
/// complete, so a file that is there already is never replaced, and never
/// seen half-made.
pub fn copy_to_new_file(source: &Path, destination: &Path) -> std::io::Result<Copy> {
    let folder = destination.parent().unwrap_or_else(|| Path::new("."));
    let temporary = folder.join(format!(".awb-copy-{}.tmp", crate::random_id()));
    // Created first and alone, so two copies never share a name.
    std::fs::File::create_new(&temporary)?;
    let outcome = (|| {
        std::fs::copy(source, &temporary)?;
        match crate::sys::rename_noreplace(&temporary, destination) {
            Ok(()) => Ok(Copy::Copied),
            // `EEXIST`, as the Electron build reads it: the destination appeared meanwhile.
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(Copy::Taken),
            Err(error) => Err(error),
        }
    })();
    // The temporary file goes whether the copy was published or not.
    let _ = std::fs::remove_file(&temporary);
    outcome
}
