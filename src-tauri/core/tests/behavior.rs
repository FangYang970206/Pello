//! Behavior checks for the Rust port. Each test names the Electron behavior it locks in.

use pello_core::paths::{prepare_data_directory, Paths};
use pello_core::preview::{pdf_wheel, WheelState};
use pello_core::store::{self, PlatformInfo};
use pello_core::workbench::Workbench;
use serde_json::json;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

/// A directory link the workbench must refuse to follow. POSIX uses a symlink;
/// Windows uses a junction, which needs no privilege and reports as a link.
fn link_dir(target: &Path, link: &Path) {
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, link).unwrap();
    #[cfg(windows)]
    {
        // `mklink` takes `/J` style switches, so a `/` in a path would split it.
        let _ = fs::remove_dir(link);
        let (link, target) = (link.to_string_lossy().replace('/', "\\"), target.to_string_lossy().replace('/', "\\"));
        let status = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(&link).arg(&target).output().unwrap();
        assert!(status.status.success(), "mklink /J failed: {}", String::from_utf8_lossy(&status.stderr));
    }
}

/// Remove a link without touching what it points at.
fn remove_link(link: &Path) {
    if !fs::symlink_metadata(link).map(|meta| meta.file_type().is_symlink()).unwrap_or(false) { return }
    #[cfg(unix)]
    fs::remove_file(link).unwrap();
    #[cfg(windows)]
    fs::remove_dir(link).unwrap();
}

/// Make a directory impossible to list, the way a mode-0 directory is on POSIX.
fn deny_listing(dir: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut mode = fs::metadata(dir).unwrap().permissions();
        mode.set_mode(0);
        fs::set_permissions(dir, mode).unwrap();
    }
    #[cfg(windows)]
    icacls(dir, &["/deny", &format!("{}:(OI)(CI)(RX)", whoami())]);
}

fn allow_listing(dir: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut mode = fs::metadata(dir).unwrap().permissions();
        mode.set_mode(0o755);
        fs::set_permissions(dir, mode).unwrap();
    }
    #[cfg(windows)]
    icacls(dir, &["/remove:d", &whoami()]);
}

#[cfg(windows)]
fn icacls(dir: &Path, args: &[&str]) {
    let status = std::process::Command::new("icacls").arg(dir).args(args).output().unwrap();
    assert!(status.status.success(), "icacls failed: {}", String::from_utf8_lossy(&status.stderr));
}

#[cfg(windows)]
fn whoami() -> String {
    let output = std::process::Command::new("whoami").output().unwrap();
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

/// Assert a file is reachable by its owner alone, the Windows counterpart of
/// mode 0o600: its access list is protected from inheritance and holds one
/// allow entry, for Owner Rights (`S-1-3-4`).
#[cfg(windows)]
fn assert_owner_only(path: &Path) {
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Authorization::{ConvertSidToStringSidW, GetSecurityInfo, SE_FILE_OBJECT};
    use windows_sys::Win32::Security::{GetAce, GetSecurityDescriptorControl, ACL, DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, SE_DACL_PROTECTED};
    use windows_sys::Win32::Storage::FileSystem::READ_CONTROL;

    fn check(path: &Path) -> Result<(), String> {
        // READ_CONTROL is all reading the access list needs.
        let file = std::fs::OpenOptions::new().read(true).access_mode(READ_CONTROL).open(path).map_err(|error| format!("{}: {error}", path.display()))?;
        let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        let mut dacl: *mut ACL = std::ptr::null_mut();
        let result = unsafe {
            GetSecurityInfo(file.as_raw_handle(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, std::ptr::null_mut(), std::ptr::null_mut(),
                &mut dacl, std::ptr::null_mut(), &mut descriptor)
        };
        if result != 0 { return Err(format!("GetSecurityInfo failed with {result}")) }
        struct Freed(PSECURITY_DESCRIPTOR);
        impl Drop for Freed {
            fn drop(&mut self) { unsafe { LocalFree(self.0 as *mut _) }; }
        }
        let _freed = Freed(descriptor);
        let mut control: u16 = 0;
        let mut revision: u32 = 0;
        if unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) } == 0 { return Err("GetSecurityDescriptorControl failed".into()) }
        if dacl.is_null() { return Err("the file has no access list, which denies everyone including its owner".into()) }
        let mut sids = Vec::new();
        for index in 0..unsafe { (*dacl).AceCount } as u32 {
            let mut ace = std::ptr::null_mut();
            if unsafe { GetAce(dacl, index, &mut ace) } == 0 { return Err(format!("GetAce failed for entry {index}")) }
            let header = unsafe { *(ace as *const windows_sys::Win32::Security::ACE_HEADER) };
            // ACCESS_ALLOWED_ACE_TYPE; the SID follows the header and mask.
            let allowed = header.AceType == 0x0;
            let sid = unsafe { ace.add(std::mem::size_of::<windows_sys::Win32::Security::ACE_HEADER>() + std::mem::size_of::<u32>()) } as PSID;
            let mut text: *mut u16 = std::ptr::null_mut();
            // The string is NUL-terminated; no length comes back with it.
            let name = if unsafe { ConvertSidToStringSidW(sid, &mut text) } != 0 && !text.is_null() {
                let mut units = Vec::new();
                let mut cursor = text;
                while unsafe { *cursor } != 0 {
                    units.push(unsafe { *cursor });
                    cursor = unsafe { cursor.add(1) };
                }
                unsafe { LocalFree(text as *mut _) };
                String::from_utf16_lossy(&units)
            } else {
                "?".to_string()
            };
            sids.push((allowed, name));
        }
        if control & SE_DACL_PROTECTED == 0 { return Err(format!("the access list inherits from the directory: {sids:?}")) }
        if sids.len() != 1 { return Err(format!("expected one access entry, found {}: {sids:?}", sids.len())) }
        let (allowed, name) = &sids[0];
        if !allowed || name != "S-1-3-4" { return Err(format!("expected Owner Rights alone, found {sids:?}")) }
        Ok(())
    }
    if let Err(error) = check(path) { panic!("{error}") }
}

/// True when `text` ends with these path components, whatever the separator.
fn path_ends_with(text: &str, parts: &[&str]) -> bool {
    let mut rest = Path::new(text);
    for part in parts.iter().rev() {
        if rest.file_name().and_then(|name| name.to_str()) != Some(*part) { return false }
        rest = rest.parent().unwrap_or(Path::new(""));
    }
    true
}
/// Copy a directory with its contents, for a restart that must read what the
/// first run wrote.
fn copy_tree(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for entry in fs::read_dir(from).unwrap().flatten() {
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() { copy_tree(&entry.path(), &target); } else { fs::copy(entry.path(), target).unwrap(); }
    }
}

/// How many entries the Recycle Bin of the drive holding `path` holds.
#[cfg(windows)]
fn recycle_bin_entries(path: &Path) -> i64 {
    use windows_sys::Win32::UI::Shell::{SHQueryRecycleBinW, SHQUERYRBINFO};
    // The bin is per drive; its root is the first component of the path.
    let mut drive = path.to_path_buf();
    while let Some(parent) = drive.parent() {
        if parent == drive { break }
        drive = parent.to_path_buf();
    }
    let wide: Vec<u16> = drive.to_string_lossy().encode_utf16().chain(Some(0)).collect();
    let mut info = SHQUERYRBINFO { cbSize: std::mem::size_of::<SHQUERYRBINFO>() as u32, i64Size: 0, i64NumItems: 0 };
    let result = unsafe { SHQueryRecycleBinW(wide.as_ptr(), &mut info) };
    assert!(result == 0, "SHQueryRecycleBinW failed for {}: {result}", drive.display());
    info.i64NumItems
}

fn temp_dir(name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!("pello-rust-{name}-{}", pello_core::random_id()));
    fs::create_dir_all(&path).unwrap();
    path
}

fn workbench(root: &std::path::Path) -> (Workbench, Arc<Mutex<Vec<serde_json::Value>>>) {
    let events = Arc::new(Mutex::new(Vec::new()));
    let emit_events = events.clone();
    let paths = Paths {
        installation: root.to_path_buf(),
        data: root.join("data"),
        legacy: root.join("missing-legacy"),
        config_file: root.join("pello.config.json"),
    };
    let bench = Workbench::open(paths, Arc::new(move |event| emit_events.lock().unwrap().push(event))).unwrap();
    (bench, events)
}

#[test]
fn fresh_database_defaults_to_chinese_light_theme_and_update_checks() {
    let root = temp_dir("defaults");
    let (bench, _) = workbench(&root);
    let state = bench.dispatch("db:get", &[]).unwrap();
    assert_eq!(state["db"]["settings"]["language"], "zh-CN");
    assert_eq!(state["db"]["settings"]["theme"], "light");
    assert_eq!(state["db"]["settings"]["autoCheckUpdates"], true);
    // A Linux host defaults to bash, any other to PowerShell.
    assert_eq!(state["db"]["settings"]["defShell"], if cfg!(unix) { "bash" } else { "pwsh" });
    assert_eq!(state["db"]["hosts"][0]["id"], "local");
    assert_eq!(state["db"]["hosts"][0]["name"], "本机");
    assert!(root.join("data").join("tmp").is_dir());
    assert!(root.join("data").join("logs").is_dir());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn migration_publishes_one_copy_and_does_not_overwrite_or_follow_links() {
    let root = temp_dir("migrate");
    let legacy = root.join("legacy");
    let data = root.join("data");
    fs::create_dir_all(legacy.join("nested")).unwrap();
    fs::write(legacy.join("workbench.json"), br#"{"settings":{"language":"en","theme":"dark"}}"#).unwrap();
    fs::write(legacy.join("keep.txt"), "保留").unwrap();
    fs::write(legacy.join("SingletonLock"), "skip").unwrap();
    fs::create_dir_all(root.join("elsewhere")).unwrap();
    link_dir(&root.join("elsewhere"), &legacy.join("linked"));
    let error = prepare_data_directory(&data, &legacy, "zh-CN").unwrap_err();
    assert!(error.contains("数据目录包含链接"));
    assert!(!data.exists());
    remove_link(&legacy.join("linked"));
    prepare_data_directory(&data, &legacy, "en").unwrap();
    assert_eq!(fs::read_to_string(data.join("keep.txt")).unwrap(), "保留");
    assert!(!data.join("SingletonLock").exists());
    assert!(legacy.join("keep.txt").exists(), "the old profile stays in place");
    fs::write(legacy.join("keep.txt"), "changed").unwrap();
    prepare_data_directory(&data, &legacy, "en").unwrap();
    assert_eq!(fs::read_to_string(data.join("keep.txt")).unwrap(), "保留");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn load_sanitizes_sessions_and_strips_passwords_from_memory() {
    let info = PlatformInfo::current();
    let raw = json!({
        "plugins": { "old": true },
        "settings": { "language": "en", "theme": "nope", "fontSize": 9, "defAgent": "missing" },
        "hosts": [{ "id": "local", "name": "", "password": "secret" }, { "id": "remote", "name": "box", "addr": "example", "user": "me" }],
        "projects": [{ "id": "p", "name": "Demo", "path": "/tmp/demo", "agent": "missing", "pinned": false }],
        "sessions": { "p": [{ "kind": "shell", "shell": "bash", "name": "  main\u{0001}  " }] }
    });
    let next = store::sanitize(&raw, info);
    assert_eq!(next["settings"]["language"], "en");
    assert_eq!(next["settings"]["theme"], "light");
    assert_eq!(next["settings"]["fontSize"], 13);
    assert_eq!(next["settings"]["defAgent"], "claude");
    assert_eq!(next["settings"]["autoCheckUpdates"], true);
    assert_eq!(next["projects"][0]["agent"], "shell");
    assert!(next["projects"][0].get("pinned").is_none());
    assert!(next.get("plugins").is_none());
    assert!(next["hosts"][0].get("password").is_none());
    assert_eq!(next["hosts"][0]["hasPassword"], false);
    assert_eq!(next["hosts"][0]["name"], "本机");
    assert_eq!(next["hosts"][1]["color"], "teal");
    let term = &next["sessions"]["p"][0];
    assert!(term["id"].as_str().unwrap().starts_with('t'));
    assert_eq!(term["name"], "main");
    assert_eq!(next["workSessions"]["p"][0]["name"], "会话一");
}

#[test]
fn settings_projects_and_temporary_sessions_persist_under_the_install_layout() {
    let root = temp_dir("persist");
    let (bench, _) = workbench(&root);
    let mut state = bench.dispatch("db:get", &[]).unwrap();
    state["db"]["settings"]["language"] = json!("en");
    state["db"]["settings"]["autoCheckUpdates"] = json!(false);
    let saved = bench.dispatch("db:settings", &[state["db"]["settings"].clone()]).unwrap();
    assert_eq!(saved["settings"]["language"], "en");
    assert_eq!(saved["settings"]["autoCheckUpdates"], false);
    let reloaded = store::load_database(&bench.database_path(), PlatformInfo::current()).0;
    assert_eq!(reloaded["settings"]["language"], "en");
    assert_eq!(reloaded["settings"]["autoCheckUpdates"], false);

    let directory = root.join("temps");
    let created = bench.dispatch("temporary:create", &[json!(directory.display().to_string())]).unwrap();
    let project_id = created["projectId"].as_str().unwrap().to_string();
    let project_path = PathBuf::from(created["database"]["projects"][0]["path"].as_str().unwrap());
    assert!(project_path.join("AGENTS.md").is_file());
    assert_eq!(fs::read_to_string(project_path.join("CLAUDE.md")).unwrap(), "@AGENTS.md\n");
    assert!(fs::read_to_string(project_path.join("AGENTS.md")).unwrap().contains(project_path.display().to_string().as_str()));
    let config: serde_json::Value = serde_json::from_str(&fs::read_to_string(root.join("pello.config.json")).unwrap()).unwrap();
    assert_eq!(config["temporarySessionsDirectory"], pello_core::real_path(&directory).unwrap().display().to_string());
    assert_eq!(bench.dispatch("temporary:directory", &[]).unwrap(), config["temporarySessionsDirectory"]);
    let again = bench.dispatch("temporary:create", &[]).unwrap();
    assert_ne!(again["projectId"], project_id);
    assert_eq!(again["database"]["projects"][1]["name"], "Temporary session 2");

    let hosts = json!([{ "id": "local", "name": "本机", "addr": "", "user": "", "os": "Linux", "on": true, "port": 22, "platform": "linux", "auth": "key", "password": "should-not-persist" }]);
    bench.dispatch("db:hosts", &[hosts]).unwrap();
    let text = fs::read_to_string(bench.database_path()).unwrap();
    assert!(!text.contains("should-not-persist"));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn file_writes_reject_conflicts_escapes_and_replacement() {
    let root = temp_dir("files");
    let project = root.join("project");
    fs::create_dir_all(project.join("sub")).unwrap();
    fs::write(project.join("note.txt"), "hello").unwrap();
    let (bench, _) = workbench(&root);
    bench.dispatch("db:projects", &[json!([{ "id": "p", "name": "P", "host": "local", "path": project.display().to_string(), "branch": "", "agent": "shell" }])]).unwrap();
    let read = bench.dispatch("git:read", &[json!("p"), json!("note.txt")]).unwrap();
    assert_eq!(read["text"], "hello");
    assert_eq!(read["missing"], false);
    let version = read["version"].as_str().unwrap().to_string();
    let saved = bench.dispatch("git:write", &[json!("p"), json!("note.txt"), json!("hello!"), json!(version)]).unwrap();
    assert_eq!(saved["text"], "hello!");
    assert_eq!(fs::read_to_string(project.join("note.txt")).unwrap(), "hello!");
    let conflict = bench.dispatch("git:write", &[json!("p"), json!("note.txt"), json!("nope"), json!(version)]).unwrap_err();
    assert!(conflict.contains("文件已被其他程序修改") || conflict.contains("File was modified"));
    fs::write(project.join("note.txt"), "hello!").unwrap();
    bench.dispatch("db:settings", &[json!({ "language": "en", "theme": "light", "fontSize": 13, "defShell": "bash", "defAgent": "claude", "restore": true, "confirmKill": true, "autoCheckUpdates": true })]).unwrap();
    let english = bench.dispatch("git:write", &[json!("p"), json!("note.txt"), json!("nope"), json!("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")]).unwrap_err();
    assert!(english.contains("modified by another program") || english.contains("文件已被其他程序修改"));
    let outside = bench.dispatch("git:read", &[json!("p"), json!("../pello.config.json")]).unwrap();
    assert_eq!(outside["missing"], true);
    fs::create_dir_all(root.join("elsewhere")).unwrap();
    link_dir(&root.join("elsewhere"), &project.join("escape"));
    let linked = bench.dispatch("git:read", &[json!("p"), json!("escape")]).unwrap();
    assert_eq!(linked["missing"], true);
    fs::write(project.join("keep.txt"), "stay").unwrap();
    fs::write(project.join("other.txt"), "other").unwrap();
    let rename_error = bench.dispatch("tree:rename", &[json!("p"), json!("keep.txt"), json!("other.txt"), json!(false)]).unwrap_err();
    assert!(!rename_error.is_empty());
    assert_eq!(fs::read_to_string(project.join("keep.txt")).unwrap(), "stay");
    assert_eq!(fs::read_to_string(project.join("other.txt")).unwrap(), "other");
    bench.dispatch("tree:create", &[json!("p"), json!("sub"), json!("fresh.txt"), json!(false)]).unwrap();
    assert!(project.join("sub/fresh.txt").is_file());
    let bad_ignore = bench.dispatch("tree:ignore-set", &[json!("p"), json!(["../secret"])]).unwrap_err();
    assert!(bad_ignore.contains("有效的目录名称") || bad_ignore.contains("valid directory"));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn windows_powershell_terminal_reaches_its_prompt() {
    // Windows PowerShell 5.1 fails at start when it is launched by a path in
    // the extended form that `fs::canonicalize` gives on Windows: the terminal
    // then says the shell could not start and ends at once. The Electron build
    // resolves the shell without that form, and PowerShell is what a default
    // terminal gets on Windows.
    if !cfg!(windows) { return }
    let root = temp_dir("pty-pwsh");
    let project = root.join("project");
    fs::create_dir_all(&project).unwrap();
    let (bench, events) = workbench(&root);
    bench.dispatch("db:projects", &[json!([{ "id": "p", "name": "P", "host": "local", "path": project.display().to_string(), "branch": "", "agent": "shell" }])]).unwrap();
    let info = bench.dispatch("pty:create", &[json!({ "id": "term-ps", "projectId": "p", "kind": "shell", "shell": "pwsh" })]).unwrap();
    assert_eq!(info["shell"], "pwsh");
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    let mut output = String::new();
    let mut seen = 0;
    let mut idle = false;
    let mut ended = false;
    while std::time::Instant::now() < deadline {
        // Each event is read once, so a failure prints what the terminal showed and not copies of it.
        let list = events.lock().unwrap();
        for event in list.iter().skip(seen) {
            if event["channel"] != "pty:event" || event["payload"]["id"] != "term-ps" { continue }
            output.push_str(event["payload"]["data"].as_str().unwrap_or(""));
            if event["payload"]["inputReady"] == true && event["payload"]["state"] == "idle" { idle = true }
            if event["payload"]["state"] == "exited" || event["payload"]["state"] == "failed" { ended = true }
        }
        seen = list.len();
        drop(list);
        if idle || ended { break }
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(!ended, "the PowerShell terminal ended at start:\n{output}");
    assert!(idle, "the PowerShell terminal did not reach its prompt:\n{output}");
    assert!(!output.contains("ServicePointManager"), "PowerShell failed at start:\n{output}");
    bench.dispatch("pty:close", &[json!("term-ps")]).unwrap();
    let _ = fs::remove_dir_all(root);
}

/// Windows: a terminal that starts an executor in PowerShell must actually run
/// its command, not only reach the prompt. The executor is the detached tree
/// fixture of the Electron shutdown regression (`session-tree.cjs`); the file
/// it writes is what tells the command ran, so a launch that is typed but
/// never submitted cannot pass.
#[test]
#[cfg(windows)]
fn windows_powershell_terminal_runs_the_executor_command() {
    let root = temp_dir("pty-pwsh-executor");
    let project = root.join("project");
    fs::create_dir_all(&project).unwrap();
    let (bench, events) = workbench(&root);
    bench.dispatch("db:projects", &[json!([{ "id": "p", "name": "P", "host": "local", "path": project.display().to_string(), "branch": "", "agent": "shell" }])]).unwrap();
    let pid_file = root.join("executor-pids.txt");
    let fixture = PathBuf::from(env!("CARGO_BIN_EXE_awb-session-tree"));
    // As the settings dialog writes a custom executor for PowerShell: the call
    // operator and the two paths in single quotes.
    let quote = |path: &Path| format!("'{}'", path.display().to_string().replace('\'', "''"));
    let cmd = format!("& {}", quote(&fixture));
    let args = quote(&pid_file);
    bench.dispatch("db:custom", &[json!([{ "id": "tree", "name": "Tree", "cmd": cmd, "args": args, "shell": "pwsh" }])]).unwrap();
    let info = bench.dispatch("pty:create", &[json!({ "id": "term-tree", "projectId": "p", "kind": "tree", "shell": "pwsh" })]).unwrap();
    assert_eq!(info["shell"], "pwsh");
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    let mut output = String::new();
    let mut seen = 0;
    while std::time::Instant::now() < deadline && tree_pids(&pid_file).is_empty() {
        // Each event is read once, so a failure prints what the terminal showed.
        let list = events.lock().unwrap();
        for event in list.iter().skip(seen) {
            if event["channel"] == "pty:event" && event["payload"]["id"] == "term-tree" { output.push_str(event["payload"]["data"].as_str().unwrap_or("")); }
        }
        seen = list.len();
        drop(list);
        std::thread::sleep(Duration::from_millis(50));
    }
    let pids = tree_pids(&pid_file);
    end_tree(&pid_file);
    bench.dispatch("pty:close", &[json!("term-tree")]).unwrap();
    let _ = fs::remove_dir_all(root);
    assert!(!pids.is_empty(), "the executor command did not run in the PowerShell terminal:\n{output}");
}

#[test]
fn local_shell_reports_prompt_idle_without_touching_user_shell_config() {
    let root = temp_dir("pty");
    let project = root.join("project");
    fs::create_dir_all(&project).unwrap();
    let home_rc = std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".bashrc"));
    let before = home_rc.as_ref().and_then(|path| fs::read(path).ok());
    let (bench, events) = workbench(&root);
    bench.dispatch("db:projects", &[json!([{ "id": "p", "name": "P", "host": "local", "path": project.display().to_string(), "branch": "", "agent": "shell" }])]).unwrap();
    let info = bench.dispatch("pty:create", &[json!({ "id": "term-1", "projectId": "p", "kind": "shell", "shell": "bash" })]).unwrap();
    assert_eq!(info["shell"], "bash");
    let deadline = std::time::Instant::now() + Duration::from_secs(8);
    let mut idle = false;
    while std::time::Instant::now() < deadline {
        let ready = events.lock().unwrap().iter().any(|event| event["channel"] == "pty:event" && event["payload"]["id"] == "term-1" && event["payload"]["inputReady"] == true && event["payload"]["state"] == "idle");
        if ready { idle = true; break }
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(idle, "shell prompt marker should mark the terminal idle");
    events.lock().unwrap().clear();
    bench.dispatch("pty:write", &[json!("term-1"), json!("printf 'PTY_OK'\n"), json!(false)]).unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(8);
    let mut saw = false;
    while std::time::Instant::now() < deadline {
        let hit = events.lock().unwrap().iter().any(|event| event["payload"]["data"].as_str().unwrap_or("").contains("PTY_OK"));
        if hit { saw = true; break }
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(saw, "local shell output is delivered to the terminal listener");
    bench.dispatch("pty:close", &[json!("term-1")]).unwrap();
    let rc = fs::read_to_string(root.join("data/shell/bashrc.sh")).unwrap();
    assert!(rc.contains("AWB_CWD"));
    assert!(rc.contains("$HOME/.bashrc"));
    if let Some(path) = home_rc {
        assert_eq!(fs::read(path).ok(), before, "managed shell startup must not rewrite the user bashrc");
    }
    let _ = fs::remove_dir_all(root);
}

#[test]
fn git_status_reads_a_real_repository() {
    let root = temp_dir("git");
    let project = root.join("repo");
    fs::create_dir_all(&project).unwrap();
    assert!(std::process::Command::new("git").arg("-C").arg(&project).args(["init"]).status().unwrap().success());
    fs::write(project.join("README.md"), "one\n").unwrap();
    assert!(std::process::Command::new("git").arg("-C").arg(&project).args(["add", "README.md"]).status().unwrap().success());
    assert!(std::process::Command::new("git").arg("-C").arg(&project).args(["-c", "user.email=test@example.com", "-c", "user.name=Test", "-c", "commit.gpgsign=false", "commit", "-m", "init"]).status().unwrap().success());
    fs::write(project.join("README.md"), "one\ntwo\n").unwrap();
    let (bench, _) = workbench(&root);
    bench.dispatch("db:projects", &[json!([{ "id": "p", "name": "Repo", "host": "local", "path": project.display().to_string(), "branch": "", "agent": "shell" }])]).unwrap();
    let status = bench.dispatch("git:status", &[json!("p"), json!(true)]).unwrap();
    assert_eq!(status["isRepo"], true);
    assert_eq!(status["files"][0]["path"], "README.md");
    assert_eq!(status["files"][0]["st"], "M");
    let diff = bench.dispatch("git:diff", &[json!("p"), json!("README.md"), json!(false)]).unwrap();
    assert!(diff["after"].as_str().unwrap().contains("two"));
    assert_eq!(diff["tooBig"], false);
    let saved = store::load_database(&bench.database_path(), PlatformInfo::current()).0;
    assert!(!saved["projects"][0]["branch"].as_str().unwrap().is_empty());
    let _ = fs::remove_dir_all(root);
}

fn drain_content(bench: &Workbench, id: &str) -> (Vec<serde_json::Value>, serde_json::Value) {
    let mut items = Vec::new();
    let mut last = json!({});
    for _ in 0..200 {
        last = bench.dispatch("content:search-next", &[json!(id)]).unwrap();
        if let Some(batch) = last["items"].as_array() { items.extend(batch.clone()); }
        if last["done"] == true { break }
    }
    (items, last)
}

#[test]
fn local_search_skips_dot_directories_limits_matches_and_names_files() {
    let root = temp_dir("search");
    let project = root.join("project");
    fs::create_dir_all(project.join("src")).unwrap();
    fs::create_dir_all(project.join(".hidden")).unwrap();
    fs::create_dir_all(project.join("node_modules/pkg")).unwrap();
    fs::write(project.join("src/App.tsx"), "export const View = 'PelloToken'\n").unwrap();
    fs::write(project.join("src/note.txt"), "Pello stands alone\n").unwrap();
    fs::write(project.join(".hidden/secret.txt"), "PelloToken\n").unwrap();
    fs::write(project.join("node_modules/pkg/index.js"), "PelloToken\n").unwrap();
    fs::write(project.join("binary.bin"), b"PelloToken\0more").unwrap();
    fs::write(project.join("huge.txt"), vec![b'a'; 2_000_001]).unwrap();
    fs::create_dir_all(root.join("elsewhere")).unwrap();
    link_dir(&root.join("elsewhere"), &project.join("escape"));
    fs::create_dir(project.join("locked")).unwrap();
    fs::write(project.join("locked/secret.txt"), "PelloToken\n").unwrap();
    deny_listing(&project.join("locked"));
    let mut big = String::new();
    for _ in 0..2000 { big.push_str("hit\n"); }
    fs::write(project.join("src/many.txt"), big).unwrap();
    fs::write(project.join("src/after.txt"), "hit\n").unwrap();
    for index in 0..40 {
        fs::write(project.join(format!("src/batch-{index:02}.txt")), "batch-token\n").unwrap();
    }
    let (bench, _) = workbench(&root);
    bench.dispatch("db:projects", &[json!([{ "id": "p", "name": "P", "host": "local", "path": project.display().to_string(), "branch": "", "agent": "shell" }])]).unwrap();

    bench.dispatch("content:search-start", &[json!("p"), json!("content-1"), json!("PelloToken"), json!(true), json!(false), json!(false)]).unwrap();
    let (items, last) = drain_content(&bench, "content-1");
    let paths: Vec<&str> = items.iter().filter_map(|item| item["path"].as_str()).collect();
    assert_eq!(paths, vec!["src/App.tsx"]);
    assert_eq!(items[0]["matches"][0]["line"], 1);
    assert!(items[0]["matches"][0]["match"] == "PelloToken");
    assert!(last["skipped"].as_u64().unwrap() >= 2, "binary and oversized files are counted as skipped");
    assert!(last["errors"].as_u64().unwrap() >= 1, "an unreadable directory is reported separately from skipped files");
    assert_eq!(last["limited"], false);

    bench.dispatch("content:search-start", &[json!("p"), json!("whole"), json!("Pello"), json!(true), json!(false), json!(true)]).unwrap();
    let (whole, _) = drain_content(&bench, "whole");
    let whole_paths: Vec<&str> = whole.iter().filter_map(|item| item["path"].as_str()).collect();
    assert!(whole_paths.contains(&"src/note.txt"));
    assert!(!whole_paths.contains(&"src/App.tsx"));

    bench.dispatch("content:search-start", &[json!("p"), json!("case"), json!("pellotoken"), json!(false), json!(false), json!(false)]).unwrap();
    let (folded, _) = drain_content(&bench, "case");
    assert!(folded.iter().any(|item| item["path"] == "src/App.tsx"));

    let invalid = bench.dispatch("content:search-start", &[json!("p"), json!("bad-re"), json!("("), json!(true), json!(true), json!(false)]).unwrap_err();
    assert!(invalid.contains("正则表达式无效"));
    bench.dispatch("db:settings", &[json!({ "language": "en" })]).unwrap();
    let english = bench.dispatch("content:search-start", &[json!("p"), json!("bad-re"), json!("("), json!(true), json!(true), json!(false)]).unwrap_err();
    assert_eq!(english, "Invalid regular expression");
    bench.dispatch("db:settings", &[json!({ "language": "zh-CN" })]).unwrap();

    bench.dispatch("content:search-start", &[json!("p"), json!("limit"), json!("hit"), json!(true), json!(false), json!(false)]).unwrap();
    let (limited_items, limited) = drain_content(&bench, "limit");
    let total: usize = limited_items.iter().map(|item| item["matches"].as_array().map(|list| list.len()).unwrap_or(0)).sum();
    assert_eq!(total, 2000);
    assert_eq!(limited["limited"], true);

    bench.dispatch("content:search-start", &[json!("p"), json!("batches"), json!("batch-token"), json!(true), json!(false), json!(false)]).unwrap();
    let first = bench.dispatch("content:search-next", &[json!("batches")]).unwrap();
    assert_eq!(first["done"], false);
    assert!(first["items"].as_array().unwrap().len() < 40);
    bench.dispatch("content:search-cancel", &[json!("batches")]).unwrap();
    let cancelled = bench.dispatch("content:search-next", &[json!("batches")]).unwrap();
    assert_eq!(cancelled["done"], true);
    assert!(cancelled["items"].as_array().unwrap().is_empty());

    let bad_id = bench.dispatch("tree:search-start", &[json!("p"), json!("bad id"), json!("app")]).unwrap_err();
    assert!(bad_id.contains("搜索参数无效"));
    bench.dispatch("tree:search-start", &[json!("p"), json!("locked"), json!("app")]).unwrap();
    let unreadable = bench.dispatch("tree:search-next", &[json!("locked")]).unwrap_err();
    // The system's own wording: "Permission denied", or "拒绝访问" on a
    // Chinese Windows.
    assert!(unreadable.contains("Permission denied") || unreadable.contains("权限") || unreadable.contains("拒绝访问"), "{unreadable}");
    allow_listing(&project.join("locked"));
    bench.dispatch("tree:search-start", &[json!("p"), json!("names"), json!("app")]).unwrap();
    let mut names = Vec::new();
    for _ in 0..20 {
        let batch = bench.dispatch("tree:search-next", &[json!("names")]).unwrap();
        if let Some(list) = batch["items"].as_array() { names.extend(list.clone()); }
        if batch["done"] == true { break }
    }
    assert_eq!(names.len(), 1);
    assert_eq!(names[0]["path"], "src/App.tsx");
    assert_eq!(names[0]["dir"], false);

    bench.dispatch("db:projects", &[json!([{ "id": "remote", "name": "R", "host": "ssh-1", "path": "/tmp", "branch": "", "agent": "shell" }])]).unwrap();
    let remote = bench.dispatch("content:search-start", &[json!("remote"), json!("remote-search"), json!("Pello"), json!(true), json!(false), json!(false)]).unwrap_err();
    assert!(remote.contains("主机不存在"), "{remote}");
    let _ = fs::remove_dir_all(root);
}

/// A server that accepts the connection and then says nothing never answers
/// the question asked of it. Nothing in the protocol itself gives up on such a
/// server, so the workbench must: within the time the Electron build waits for
/// a server to be ready, and with a message that names the cause.
#[test]
fn a_server_that_never_answers_is_given_up_within_the_ready_limit() {
    // The listener accepts and keeps every connection, and sends nothing.
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    let kept = Arc::new(std::sync::Mutex::new(Vec::new()));
    let holding = Arc::clone(&kept);
    std::thread::spawn(move || {
        for connection in listener.incoming() {
            if let Ok(connection) = connection { holding.lock().unwrap().push(connection) }
        }
    });
    let root = temp_dir("ssh-silent");
    let (bench, _) = workbench(&root);
    let local = bench.dispatch("db:get", &[]).unwrap()["db"]["hosts"][0].clone();
    let silent_host = json!({
        "id": "silent-box", "name": "Silent box", "addr": "127.0.0.1", "port": port, "user": "me",
        "auth": "password", "password": "s3cret-pass", "color": "blue", "on": false, "os": "", "platform": "linux"
    });
    let (done, finished) = std::sync::mpsc::channel();
    let hosts = json!([local, silent_host]);
    std::thread::spawn(move || {
        let _ = done.send(bench.dispatch("db:hosts", &[hosts]));
    });
    let started = std::time::Instant::now();
    // The limit is 12 s. Twice that leaves room for a slow machine and still
    // tells a limit from a question that is never answered.
    let outcome = match finished.recv_timeout(Duration::from_secs(30)) {
        Ok(outcome) => outcome,
        Err(_) => panic!("a server that says nothing was not given up within 30 s"),
    };
    let error = outcome.expect_err("a server that never says anything is not connected to");
    assert_eq!(error, "SSH 连接超时", "the message names the cause: {error}");
    assert_eq!(pello_core::i18n::translate("en", &error, &[] as &[String]), "SSH connection timed out", "the message is translated");
    let elapsed = started.elapsed();
    assert!(elapsed >= Duration::from_secs(10) && elapsed < Duration::from_secs(28), "the limit is 12 s; the answer came after {elapsed:?}");
    let _ = fs::remove_dir_all(root);
    drop(kept);
}

/// Most SSH servers in use offer an RSA host key. A client built without RSA
/// support cannot finish the key exchange with them, and nothing in the
/// exchange has a limit of its own, so the question of whether the host can
/// be saved would never be answered. Saving such a host must succeed within
/// a limit, and the fingerprint that was accepted must be the one offered.
#[test]
fn ssh_password_connects_to_a_server_with_an_rsa_host_key() {
    let password = "s3cret-pass";
    let fixture = pello_core::ssh::start_fixture_with(password, pello_core::ssh::HostKey::Rsa).expect("ssh fixture with an RSA host key");
    let root = temp_dir("ssh-rsa");
    let (bench, _) = workbench(&root);
    let local = bench.dispatch("db:get", &[]).unwrap()["db"]["hosts"][0].clone();
    let remote_host = json!({
        "id": "rsa-box", "name": "RSA box", "addr": "127.0.0.1", "port": fixture.port, "user": "me",
        "auth": "password", "password": password, "color": "blue", "on": false, "os": "", "platform": "linux"
    });
    // The save runs on its own thread, so a key exchange that never ends is a
    // failure here and not a test run that never ends.
    let (done, finished) = std::sync::mpsc::channel();
    let hosts = json!([local, remote_host]);
    std::thread::spawn(move || {
        let outcome = bench.dispatch("db:hosts", &[hosts]).map(|saved| saved["hosts"][1].clone());
        let _ = done.send(outcome);
    });
    let saved = match finished.recv_timeout(Duration::from_secs(20)) {
        Ok(saved) => saved,
        Err(_) => panic!("saving an RSA host key server did not answer within 20 s: the key exchange did not end"),
    };
    let stored = saved.expect("a password host behind an RSA host key should connect");
    assert_eq!(stored["hasPassword"], true);
    assert!(stored.get("password").is_none());
    let pinned: serde_json::Value = serde_json::from_str(&fs::read_to_string(root.join("data/ssh-host-keys.json")).unwrap()).unwrap();
    let fingerprints = pinned.as_object().expect("the pinned host keys are an object");
    assert_eq!(fingerprints.len(), 1, "one host was connected to: {pinned}");
    let (identity, fingerprint) = fingerprints.iter().next().unwrap();
    assert!(identity.contains("127.0.0.1") && identity.contains(&fixture.port.to_string()), "the identity is not this server: {identity}");
    assert_eq!(fingerprint.as_str().map(|value| value.len()), Some(64), "a SHA-256 fingerprint in hex has 64 characters: {fingerprint}");
    assert!(fingerprint.as_str().unwrap().chars().all(|char| char.is_ascii_hexdigit()), "not a fingerprint: {fingerprint}");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn ssh_password_pins_host_key_and_serves_remote_files() {
    let password = "s3cret-pass";
    let fixture = pello_core::ssh::start_fixture(password).expect("ssh fixture");
    let root = temp_dir("ssh");
    let project = root.join("project");
    fs::create_dir_all(project.join("src")).unwrap();
    fs::create_dir_all(project.join(".hidden")).unwrap();
    fs::write(project.join("src/note.txt"), "PelloToken\n").unwrap();
    fs::write(project.join(".hidden/secret.txt"), "HiddenToken\n").unwrap();
    let (bench, _) = workbench(&root);
    let local = bench.dispatch("db:get", &[]).unwrap()["db"]["hosts"][0].clone();
    let remote_host = json!({
        "id": "box", "name": "Box", "addr": "127.0.0.1", "port": fixture.port, "user": "me",
        "auth": "password", "password": password, "color": "blue", "on": false, "os": "", "platform": "linux"
    });
    let saved = bench.dispatch("db:hosts", &[json!([local, remote_host])]).expect("password host should connect");
    let stored = &saved["hosts"][1];
    assert_eq!(stored["hasPassword"], true);
    assert!(stored.get("password").is_none());
    assert_eq!(stored["platform"], "linux");
    let database = fs::read_to_string(bench.database_path()).unwrap();
    let credentials = fs::read_to_string(root.join("data/credentials.json")).unwrap();
    assert!(!database.contains(password), "workbench.json must not contain the password");
    assert!(!credentials.contains(password), "credentials.json stores ciphertext, not the password");
    // The key that decrypts the stored password is readable by this user alone.
    let key_file = root.join("data/credentials.key");
    #[cfg(unix)]
    {
        let key_mode = std::os::unix::fs::PermissionsExt::mode(&fs::metadata(&key_file).unwrap().permissions()) & 0o777;
        assert_eq!(key_mode, 0o600);
    }
    #[cfg(windows)]
    assert_owner_only(&key_file);
    let public = bench.dispatch("db:get", &[]).unwrap();
    assert!(public["db"]["hosts"][1].get("password").is_none());
    assert_eq!(public["db"]["hosts"][1]["hasPassword"], true);

    let copied = temp_dir("ssh-restart");
    copy_tree(&root.join("data"), &copied.join("data"));
    fs::copy(root.join("pello.config.json"), copied.join("pello.config.json")).ok();
    let (reloaded, _remote_events) = workbench(&copied);
    let again = reloaded.dispatch("db:get", &[]).unwrap();
    assert_eq!(again["db"]["hosts"][1]["hasPassword"], true);
    assert!(again["db"]["hosts"][1].get("password").is_none());
    // The fixture answers remote commands with a POSIX shell, which reads a
    // POSIX path. The file work is therefore verified on a POSIX host.
    #[cfg(unix)]
    let remote_events = _remote_events;
    #[cfg(unix)]
    {
    reloaded.dispatch("db:projects", &[json!([{ "id": "p", "name": "P", "host": "box", "path": project.display().to_string(), "branch": "", "agent": "shell" }])]).unwrap();
    let read = reloaded.dispatch("git:read", &[json!("p"), json!("src/note.txt")]).unwrap();
    assert_eq!(read["text"], "PelloToken\n");
    let version = read["version"].as_str().unwrap().to_string();
    let written = reloaded.dispatch("git:write", &[json!("p"), json!("src/note.txt"), json!("PelloToken\nupdated\n"), json!(version)]).unwrap();
    assert_eq!(written["text"], "PelloToken\nupdated\n");
    assert_eq!(fs::read_to_string(project.join("src/note.txt")).unwrap(), "PelloToken\nupdated\n");
    let listing = reloaded.dispatch("path:list", &[json!("box"), json!(project.display().to_string())]).unwrap();
    assert!(listing["dirs"].as_array().unwrap().iter().any(|dir| dir["name"] == "src"));
    reloaded.dispatch("content:search-start", &[json!("p"), json!("remote-content"), json!("PelloToken"), json!(true), json!(false), json!(false)]).unwrap();
    let (items, batch) = drain_content(&reloaded, "remote-content");
    assert_eq!(batch["errors"], 0);
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["path"], "src/note.txt");
    assert_eq!(items[0]["matches"][0]["match"], "PelloToken");
    reloaded.dispatch("tree:search-start", &[json!("p"), json!("remote-names"), json!("note.txt")]).unwrap();
    let names = reloaded.dispatch("tree:search-next", &[json!("remote-names")]).unwrap();
    assert_eq!(names["items"][0]["path"], "src/note.txt");
    let terminal = reloaded.dispatch("pty:create", &[json!({ "id": "remote-term", "projectId": "p", "kind": "shell", "shell": "bash" })]).unwrap();
    assert_eq!(terminal["shell"], "bash");
    let deadline = std::time::Instant::now() + Duration::from_secs(8);
    let mut idle = false;
    while std::time::Instant::now() < deadline {
        let ready = remote_events.lock().unwrap().iter().any(|event| event["payload"]["id"] == "remote-term" && event["payload"]["inputReady"] == true);
        if ready { idle = true; break }
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(idle, "remote shell prompt marker should mark the terminal idle");
    reloaded.dispatch("pty:close", &[json!("remote-term")]).unwrap();
    }

    let mut settings = reloaded.dispatch("db:get", &[]).unwrap()["db"]["settings"].clone();
    settings["language"] = json!("en");
    reloaded.dispatch("db:settings", &[settings]).unwrap();
    let identity = format!("[\"127.0.0.1\",{}]", fixture.port);
    fs::write(copied.join("data/ssh-host-keys.json"), format!("{{\"{}\":\"0000\"}}", identity.replace('"', "\\\""))).unwrap();
    let changed = reloaded.dispatch("host:test", &[again["db"]["hosts"][1].clone()]).unwrap();
    assert_eq!(changed["ok"], false);
    assert!(changed["error"].as_str().unwrap_or("").contains("SSH host key has changed"), "{changed}");
    fs::remove_file(copied.join("data/ssh-host-keys.json")).unwrap();
    let accepted = reloaded.dispatch("host:test", &[again["db"]["hosts"][1].clone()]).unwrap();
    assert_eq!(accepted["ok"], true, "{accepted}");

    let bad = json!({
        "id": "other", "name": "Other", "addr": "127.0.0.1", "port": fixture.port, "user": "me",
        "auth": "password", "password": "wrong-password", "color": "teal"
    });
    let hosts_now = reloaded.dispatch("db:get", &[]).unwrap()["db"]["hosts"].clone();
    let rejected = reloaded.dispatch("db:hosts", &[json!([hosts_now[0].clone(), hosts_now[1].clone(), bad])]).unwrap_err();
    assert!(!rejected.is_empty());
    let remaining = reloaded.dispatch("db:get", &[]).unwrap();
    assert_eq!(remaining["db"]["hosts"].as_array().unwrap().len(), 2);
    assert!(remaining["db"].to_string().contains("wrong-password") == false);
    let _ = fs::remove_dir_all(root);
    let _ = fs::remove_dir_all(copied);
}

struct VarGuard {
    key: &'static str,
    previous: Option<std::ffi::OsString>,
}

fn env_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(())).lock().unwrap_or_else(|error| error.into_inner())
}

fn var_guard(key: &'static str, value: &str) -> VarGuard {
    let previous = std::env::var_os(key);
    std::env::set_var(key, value);
    VarGuard { key, previous }
}

impl Drop for VarGuard {
    fn drop(&mut self) {
        match self.previous.take() {
            Some(value) => std::env::set_var(self.key, value),
            None => std::env::remove_var(self.key),
        }
    }
}

struct SshCall {
    sock: String,
    args: Vec<String>,
}

fn parse_ssh_calls(log: &str) -> Vec<SshCall> {
    log.lines().filter_map(|line| {
        let rest = line.strip_prefix("CALL\u{1e}")?;
        let mut parts = rest.split('\u{1e}');
        let sock = parts.next().unwrap_or("").to_string();
        Some(SshCall { sock, args: parts.map(|part| part.to_string()).collect() })
    }).collect()
}

/// Install the stand-in `ssh` the workbench is pointed at, and return its
/// path and the log it records every call in.
fn install_ssh_shim(root: &std::path::Path) -> (PathBuf, PathBuf) {
    let log = root.join("ssh.log");
    #[cfg(unix)]
    let shim = {
        let bin = root.join("bin");
        fs::create_dir_all(&bin).unwrap();
        let shim = bin.join("ssh");
        fs::write(bin.join("upload-op.py"), include_str!("upload-op.py")).unwrap();
        fs::write(&shim, BASH_SSH_SHIM).unwrap();
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(&shim).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&shim, permissions).unwrap();
        shim
    };
    // Windows cannot run the bash stand-in: a `.cmd` wrapper and the MSYS
    // runtime both rewrite arguments. A real executable keeps them verbatim.
    #[cfg(windows)]
    let shim = PathBuf::from(env!("CARGO_BIN_EXE_awb-fake-ssh"));
    (shim, log)
}

#[cfg(unix)]
const BASH_SSH_SHIM: &str = r#"#!/bin/bash
log="${AWB_SSH_LOG:?}"
{
  printf 'CALL\036%s' "${SSH_AUTH_SOCK-}"
  for arg in "$@"; do printf '\036%s' "$arg"; done
  printf '\n'
} >> "$log"
last="${@: -1}"
key=""
prev=""
for arg in "$@"; do
  if [[ "$prev" == -i ]]; then key="$arg"; fi
  prev="$arg"
done
if [[ -n "$key" ]]; then
  [[ -f "$key" ]] || exit 2
  grep -q "OPENSSH PRIVATE KEY" "$key" || exit 3
  printf '%s\0' "$@" | grep -q 'IdentitiesOnly=yes' || exit 4
else
  [[ -S "${SSH_AUTH_SOCK-}" ]] || exit 5
fi
if [[ "$last" == *"-EncodedCommand "* ]]; then
  encoded="${last##*-EncodedCommand }"
  encoded="${encoded%% *}"
  script=$(printf '%s' "$encoded" | base64 -d | iconv -f UTF-16LE -t UTF-8 || true)
  if [[ "$script" == *"AWB_UPLOAD_OP"* ]]; then
    op=$(printf '%s\n' "$script" | sed -n 's/.*AWB_UPLOAD_OP \([a-z]*\).*/\1/p' | head -1)
    exec python3 "$(dirname "$0")/upload-op.py" "$op"
  fi
  exit 0
fi
if [[ "$last" == *"uname -s"* ]]; then
  if [[ -n "${AWB_SSH_OS:-}" ]]; then printf '%s\n' "$AWB_SSH_OS"; else printf 'Linux\n'; fi
  exit 0
fi
bash -lc "$last"
"#;

/// Hold an agent endpoint open for the duration of a test, the way a running
/// `ssh-agent` would. The stand-in `ssh` refuses to connect without one.
/// POSIX uses a socket at `sock`; Windows uses a named pipe derived from it.
fn fake_agent(sock: &std::path::Path) -> Agent {
    #[cfg(unix)]
    {
        use std::os::unix::net::UnixListener;
        let _ = fs::remove_file(sock);
        Agent { _listener: UnixListener::bind(sock).unwrap(), address: sock.display().to_string() }
    }
    #[cfg(windows)]
    {
        let address = agent_pipe(sock);
        Agent { _listener: PipeListener::listen(&address), address }
    }
}

/// The address `SSH_AUTH_SOCK` carries to `ssh`: the socket path on POSIX and
/// the agent's named pipe on Windows. The endpoint lives as long as this does.
struct Agent {
    #[cfg(unix)]
    _listener: std::os::unix::net::UnixListener,
    #[cfg(windows)]
    _listener: PipeListener,
    address: String,
}

impl Agent {
    fn address(&self) -> &str { &self.address }
}

/// OpenSSH for Windows reaches its agent through a named pipe. The name is
/// derived from the socket path so every test keeps its own agent.
#[cfg(windows)]
fn agent_pipe(sock: &std::path::Path) -> String {
    use sha2::Digest;
    let digest = sha2::Sha256::digest(sock.display().to_string().as_bytes());
    format!(r"\\.\pipe\pello-test-agent-{}", digest[..8].iter().map(|byte| format!("{byte:02x}")).collect::<String>())
}

/// A named pipe with a thread that accepts every client and closes it at
/// once, so the pipe stays reachable for as long as this is held.
#[cfg(windows)]
struct PipeListener {
    name: String,
    stop: Arc<std::sync::atomic::AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

#[cfg(windows)]
impl PipeListener {
    fn listen(name: &str) -> Self {
        use std::io;
        use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
        use std::sync::atomic::{AtomicBool, Ordering};
        use windows_sys::Win32::Foundation::{HANDLE, INVALID_HANDLE_VALUE};
        use windows_sys::Win32::Storage::FileSystem::{FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_DUPLEX};
        use windows_sys::Win32::System::Pipes::{ConnectNamedPipe, CreateNamedPipeW, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES};

        fn serve(name: &str, first: bool) -> io::Result<OwnedHandle> {
            let wide: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
            let handle = unsafe {
                CreateNamedPipeW(wide.as_ptr(), PIPE_ACCESS_DUPLEX | if first { FILE_FLAG_FIRST_PIPE_INSTANCE } else { 0 },
                    PIPE_TYPE_BYTE | PIPE_REJECT_REMOTE_CLIENTS, PIPE_UNLIMITED_INSTANCES, 4096, 4096, 0, std::ptr::null())
            };
            if handle == INVALID_HANDLE_VALUE as HANDLE { return Err(io::Error::last_os_error()) }
            Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
        }

        let stop = Arc::new(AtomicBool::new(false));
        let running = stop.clone();
        let pipe = name.to_string();
        let thread = std::thread::spawn(move || {
            let mut first = true;
            while !running.load(Ordering::SeqCst) {
                let instance = match serve(&pipe, first) {
                    Ok(instance) => instance,
                    Err(error) => {
                        if !running.load(Ordering::SeqCst) { eprintln!("test agent pipe {pipe} failed: {error}") }
                        break;
                    }
                };
                first = false;
                if unsafe { ConnectNamedPipe(instance.as_raw_handle(), std::ptr::null_mut()) } == 0 {
                    // ERROR_PIPE_CONNECTED: a client arrived before the wait began.
                    if std::io::Error::last_os_error().raw_os_error() != Some(535) { break }
                }
            }
        });
        Self { name: name.to_string(), stop, thread: Some(thread) }
    }
}

#[cfg(windows)]
impl Drop for PipeListener {
    fn drop(&mut self) {
        use std::sync::atomic::Ordering;
        self.stop.store(true, Ordering::SeqCst);
        // A client connection is what wakes the waiting accept.
        if let Ok(mut client) = std::fs::OpenOptions::new().read(true).write(true).open(&self.name) {
            let _ = std::io::Write::write_all(&mut client, b"x");
        }
        if let Some(thread) = self.thread.take() { let _ = thread.join(); }
    }
}

fn ssh_env(home: &std::path::Path, shim: &std::path::Path, log: &std::path::Path, agent: &Agent) -> Vec<VarGuard> {
    vec![
        var_guard("AWB_SSH_HOME", &home.display().to_string()),
        var_guard("AWB_SSH_BIN", &shim.display().to_string()),
        var_guard("AWB_SSH_LOG", &log.display().to_string()),
        var_guard("SSH_AUTH_SOCK", agent.address()),
    ]
}

fn snap_status(bench: &Workbench, id: &str) -> (serde_json::Value, serde_json::Value) {
    let snap = bench.dispatch("pty:snapshot", &[json!(id)]).unwrap();
    let status = pello_core::pty::terminal_status(snap["kind"].as_str().unwrap_or(""), snap["agentKind"].as_str(), snap["state"].as_str().unwrap_or(""), snap["inputReady"].as_bool().unwrap_or(false));
    (snap, status)
}

fn wait_terminal(bench: &Workbench, id: &str, ready: bool, state: &str) -> serde_json::Value {
    let deadline = std::time::Instant::now() + Duration::from_secs(8);
    loop {
        let snap = bench.dispatch("pty:snapshot", &[json!(id)]).unwrap();
        if snap["inputReady"].as_bool() == Some(ready) && snap["state"] == state { return snap }
        if std::time::Instant::now() > deadline { panic!("timed out for {id} ready={ready} state={state}: {snap}") }
        std::thread::sleep(Duration::from_millis(40));
    }
}

fn post_hook(bench: &Workbench, id: &str, state: &str) {
    let hook = bench.dispatch("terminal:hook", &[json!(id)]).unwrap();
    let port = hook["port"].as_u64().unwrap() as u16;
    let token = hook["token"].as_str().unwrap();
    let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
    let request = format!("GET /{token}/{state} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
    std::io::Write::write_all(&mut stream, request.as_bytes()).unwrap();
    let mut buffer = [0u8; 128];
    let _ = std::io::Read::read(&mut stream, &mut buffer);
}

#[test]
fn ssh_key_and_agent_use_system_ssh_without_leaking_secrets() {
    let _env_lock = env_lock();
    let root = temp_dir("ssh-key");
    let home = root.join("home");
    let project = root.join("project");
    fs::create_dir_all(home.join(".ssh")).unwrap();
    fs::create_dir_all(&project).unwrap();
    let material = "PRIVATEKEYMATERIAL9f3a";
    let password = "do-not-leak-ssh-secret";
    fs::write(home.join(".ssh/id_ed25519"), format!("-----BEGIN OPENSSH PRIVATE KEY-----\n{material}\n-----END OPENSSH PRIVATE KEY-----\n")).unwrap();
    let (shim, log) = install_ssh_shim(&root);
    let sock = root.join("agent.sock");
    let agent = fake_agent(&sock);
    let _env = ssh_env(&home, &shim, &log, &agent);
    let (bench, _) = workbench(&root);
    let local = bench.dispatch("db:get", &[]).unwrap()["db"]["hosts"][0].clone();
    bench.dispatch("db:hosts", &[json!([
        local,
        { "id": "key", "name": "Key", "addr": "127.0.0.1", "port": 22, "user": "keyuser", "auth": "key", "password": password },
        { "id": "agent", "name": "Agent", "addr": "127.0.0.1", "port": 22, "user": "agentuser", "auth": "agent", "password": password }
    ])]).unwrap();
    let key_list = bench.dispatch("path:list", &[json!("key"), json!(project.display().to_string())]).unwrap();
    // A POSIX remote reads a POSIX path. The listing succeeds on a POSIX host;
    // on Windows the call still goes out and only its arguments are checked.
    #[cfg(unix)]
    assert!(key_list["error"].is_null(), "key login should run the remote command: {key_list}");
    #[cfg(windows)]
    assert!(!key_list["error"].as_str().unwrap_or_default().is_empty(), "{key_list}");
    let agent_list = bench.dispatch("path:list", &[json!("agent"), json!(project.display().to_string())]).unwrap();
    #[cfg(unix)]
    assert!(agent_list["error"].is_null(), "agent login should run the remote command: {agent_list}");
    #[cfg(windows)]
    assert!(!agent_list["error"].as_str().unwrap_or_default().is_empty(), "{agent_list}");
    let calls = parse_ssh_calls(&fs::read_to_string(&log).unwrap());
    let key_calls: Vec<_> = calls.iter().filter(|call| call.args.iter().any(|arg| arg.contains("keyuser@"))).collect();
    let agent_calls: Vec<_> = calls.iter().filter(|call| call.args.iter().any(|arg| arg.contains("agentuser@"))).collect();
    assert!(!key_calls.is_empty() && !agent_calls.is_empty());
    for call in &key_calls {
        assert!(call.args.iter().any(|arg| arg == "IdentitiesOnly=yes"), "{:?}", call.args);
        let index = call.args.iter().position(|arg| arg == "-i").expect("key login passes -i");
        assert!(call.args[index + 1].ends_with("id_ed25519"));
        assert!(call.args.iter().all(|arg| !arg.contains(material) && !arg.contains(password)));
    }
    for call in &agent_calls {
        assert!(call.args.iter().all(|arg| arg != "-i" && arg != "IdentitiesOnly=yes" && !arg.contains(material) && !arg.contains(password)), "{:?}", call.args);
        assert_eq!(call.sock, agent.address());
    }
    assert!(key_calls.iter().any(|call| call.args.last().is_some_and(|arg| arg.starts_with("'bash' '-lc'"))));
    assert!(agent_calls.iter().any(|call| call.args.last().is_some_and(|arg| arg.starts_with("'bash' '-lc'"))));
    let rendered = bench.dispatch("db:get", &[]).unwrap().to_string();
    assert!(!rendered.contains(password) && !rendered.contains(material) && !rendered.contains("BEGIN OPENSSH PRIVATE KEY"));
    let stored = fs::read_to_string(bench.database_path()).unwrap();
    assert!(!stored.contains(password) && !stored.contains(material));
    let credentials = root.join("data/credentials.json");
    if credentials.exists() {
        let text = fs::read_to_string(credentials).unwrap();
        assert!(!text.contains(password) && !text.contains(material));
    }
    let _ = fs::remove_dir_all(root);
}

/// Windows: the script a remote Windows host runs for a content search is the
/// one the Electron build sends, character for character. It is run here the
/// way the kernel runs it, with the query on stdin, over a project holding a
/// text file, a binary one, one that is not UTF-8, one past the size limit
/// and a junction to a directory outside the project, each with the marker in
/// it. Only the text file may be found; the rest are skipped, and the link is
/// not followed.
#[test]
#[cfg(windows)]
fn windows_remote_content_search_skips_binary_invalid_oversized_and_linked_files() {
    let root = temp_dir("remote-content");
    let project = root.join("project");
    let outside = root.join("outside");
    fs::create_dir_all(project.join(".hidden")).unwrap();
    fs::create_dir_all(&outside).unwrap();
    let marker = "RemoteNeedle内容";
    fs::write(project.join("note.txt"), format!("first {marker}\r\n")).unwrap();
    fs::write(project.join("binary.bin"), format!("abc\0{marker}")).unwrap();
    let mut invalid = vec![0xffu8, 0xfe, 0x41, 0x20];
    invalid.extend_from_slice(marker.as_bytes());
    fs::write(project.join("invalid.txt"), invalid).unwrap();
    fs::write(project.join("large.txt"), format!("{marker}{}", "x".repeat(2_000_001))).unwrap();
    fs::write(outside.join("linked.txt"), format!("{marker} linked\n")).unwrap();
    let status = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(project.join("external-link")).arg(&outside).output().unwrap();
    assert!(status.status.success(), "the junction was not made: {}", String::from_utf8_lossy(&status.stderr));
    fs::write(project.join(".hidden/secret.txt"), format!("{marker} hidden\n")).unwrap();
    let script = pello_core::search::windows_content_script().to_string();
    let payload = json!({ "root": project, "query": marker, "sensitive": false, "regex": false, "whole": false, "ignored": Vec::<String>::new() }).to_string();
    let run = |payload: &str| {
        use base64::Engine;
        let units: Vec<u16> = script.encode_utf16().collect();
        let encoded = base64::engine::general_purpose::STANDARD.encode(units.iter().flat_map(|unit| unit.to_le_bytes()).collect::<Vec<u8>>());
        let mut child = std::process::Command::new("powershell.exe").args(["-NoProfile", "-NonInteractive", "-EncodedCommand", &encoded])
            .stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).spawn().unwrap();
        child.stdin.take().unwrap().write_all(format!("{payload}\n").as_bytes()).unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(output.stdout.len() > 0, "the script printed nothing:\n{}", String::from_utf8_lossy(&output.stderr));
        output
    };
    let output = run(&payload);
    let text = String::from_utf8_lossy(&output.stdout).into_owned();
    let mut search = pello_core::search::ContentSearch::from_remote_output("p", "identity", &text, "en").unwrap();
    let batch = search.next("en").unwrap();
    let files = batch["items"].as_array().unwrap();
    let paths: Vec<&str> = files.iter().map(|file| file["path"].as_str().unwrap()).collect();
    assert_eq!(paths, ["note.txt"], "only the text file holds a searchable marker:\n{text}\n{}", String::from_utf8_lossy(&output.stderr));
    assert_eq!(files[0]["matches"][0]["line"], 1);
    assert_eq!(files[0]["matches"][0]["column"], 7, "columns are counted in UTF-16 units, one based");
    // Binary, not UTF-8 and past the size limit: three files skipped. The
    // junction is left alone rather than counted, and `.hidden` is not entered.
    assert_eq!(batch["skipped"], 3, "three files are skipped:\n{text}");
    assert_eq!(batch["errors"], 0, "no file failed to be read:\n{text}");
    assert_eq!(batch["done"], true);
    let _ = std::process::Command::new("cmd").args(["/C", "rmdir"]).arg(project.join("external-link")).output();
    let _ = fs::remove_dir_all(root);
}

/// A search by text and a search by pattern give the same answer for the same
/// files, each across more files than one batch holds. They run differently: a
/// pattern on a thread of its own, text where it is asked for, as on the
/// Electron build. The threads themselves are not counted here: a thread made
/// for one file and ended with it leaves nothing to see once the search is
/// over, so a count of threads would pass for either way of running.
#[test]
fn a_search_by_text_and_one_by_pattern_find_the_same_files() {
    let root = temp_dir("search-threads");
    let project = root.join("project");
    fs::create_dir_all(&project).unwrap();
    for index in 0..400 { fs::write(project.join(format!("file{index:04}.txt")), format!("line one\nneedle {index} here\nline three\n")).unwrap(); }
    fs::write(project.join("special.txt"), "a needle (1) [2] .3\n").unwrap();
    let (bench, _) = workbench(&root);
    bench.dispatch("db:projects", &[json!([{ "id": "p", "name": "P", "host": "local", "path": project, "branch": "", "agent": "shell" }])]).unwrap();
    let search = |id: &str, regex: bool| {
        bench.dispatch("content:search-start", &[json!("p"), json!(id), json!("needle (1) [2] .3"), json!(true), json!(regex), json!(false)]).unwrap();
        bench.dispatch("content:search-cancel", &[json!(id)]).unwrap();
        bench.dispatch("content:search-start", &[json!("p"), json!(id), json!("needle"), json!(true), json!(regex), json!(false)]).unwrap();
        let mut files = Vec::new();
        let mut matches = 0;
        let mut done = false;
        let mut batches = 0;
        while !done {
            let batch = bench.dispatch("content:search-next", &[json!(id)]).unwrap();
            for file in batch["items"].as_array().unwrap() {
                assert_eq!(file["matches"].as_array().unwrap().len(), 1, "one match in each file: {file}");
                // The needle is the whole of line 2 in the numbered files,
                // and three characters into the only line of the other.
                let special = file["path"] == "special.txt";
                assert_eq!(file["matches"][0]["line"], if special { 1 } else { 2 }, "{file}");
                assert_eq!(file["matches"][0]["column"], if special { 3 } else { 1 }, "{file}");
                matches += 1;
                files.push(file["path"].as_str().unwrap().to_string());
            }
            done = batch["done"] == true;
            batches += 1;
            assert!(batches < 200, "the search does not end");
        }
        (files, matches, batches)
    };
    let (text_files, text_matches, text_batches) = search("by-text", false);
    let (pattern_files, pattern_matches, pattern_batches) = search("by-pattern", true);
    let mut expected: Vec<String> = (0..400).map(|index| format!("file{index:04}.txt")).collect();
    expected.push("special.txt".to_string());
    expected.sort();
    assert_eq!(text_files, expected, "a search by text finds the text in every file");
    assert_eq!(pattern_files, expected, "a search by pattern finds the pattern in every file, the brackets and the dot included");
    assert_eq!((text_matches, pattern_matches), (401, 401));
    // More files than one batch of 32 holds, so the search is followed in
    // several batches, and both ways of running end the same way.
    assert!(text_batches > 1 && pattern_batches > 1, "{text_batches} and {pattern_batches} batches");
    bench.dispatch("content:search-cancel", &[json!("by-text")]).unwrap();
    bench.dispatch("content:search-cancel", &[json!("by-pattern")]).unwrap();
    let _ = fs::remove_dir_all(root);
}

/// A remote content search is followed as its results come, and stopping it
/// ends the command on the host: the channel is closed, and not left to run
/// until it has looked through every file. The stop takes effect while a
/// batch is still waiting for the host, as aborting does on the Electron
/// build, and the search then answers as finished instead of failing.
#[test]
fn remote_content_search_streams_and_cancel_closes_the_remote_channel() {
    let password = "s3cret-pass";
    let fixture = pello_core::ssh::start_fixture(password).expect("ssh fixture");
    let root = temp_dir("ssh-stream");
    let (bench, _) = workbench(&root);
    // The stop is sent from here while another thread waits for a batch, so
    // both hold the workbench.
    let bench = Arc::new(bench);
    let local = bench.dispatch("db:get", &[]).unwrap()["db"]["hosts"][0].clone();
    let remote_host = json!({
        "id": "stream-box", "name": "Stream box", "addr": "127.0.0.1", "port": fixture.port, "user": "me",
        "auth": "password", "password": password, "color": "blue", "on": false, "os": "", "platform": "linux"
    });
    // The save runs on its own thread, so a key exchange that never ends is a
    // failure here and not a test run that never ends.
    let (done, finished) = std::sync::mpsc::channel();
    let hosts = json!([local, remote_host]);
    let saving = Arc::clone(&bench);
    std::thread::spawn(move || {
        let _ = done.send(saving.dispatch("db:hosts", &[hosts]));
    });
    let saved = finished.recv_timeout(Duration::from_secs(20)).expect("saving the host did not answer within 20 s").expect("the fixture host should connect");
    assert_eq!(saved["hosts"][1]["hasPassword"], true);
    assert!(saved["hosts"][1].get("password").is_none(), "the password stays in the main process");
    bench.dispatch("db:projects", &[json!([{ "id": "remote", "name": "Remote", "host": "stream-box", "path": "/srv/app", "branch": "", "agent": "shell" }])]).unwrap();
    // The fixture holds a search for `hold`: it answers with one file and
    // then stays open until the channel is closed.
    // Saving the host opened and closed a channel of its own for its probe.
    let before = fixture.closed_channels();
    bench.dispatch("content:search-start", &[json!("remote"), json!("stream-1"), json!("hold"), json!(false)]).expect("the search starts on the host");
    // One batch holds at most 32 events, and the host has 40 and no end: the
    // batch comes back before the command has ended.
    let started = std::time::Instant::now();
    let batch = bench.dispatch("content:search-next", &[json!("stream-1")]).expect("the first batch is read from the stream");
    assert!(started.elapsed() < Duration::from_secs(5), "a batch comes back once it is full, without waiting for the command to end");
    let paths: Vec<String> = batch["items"].as_array().unwrap().iter().map(|file| file["path"].as_str().unwrap().to_string()).collect();
    assert_eq!(paths, (0..32).map(|index| format!("src/file{index}.txt")).collect::<Vec<String>>(), "the results come as they are sent, in order");
    assert_eq!(batch["done"], false, "the command has not ended, so the search has not either");
    assert_eq!(fixture.closed_channels(), before, "nothing is closed while the search is still followed");
    // The next batch waits for the host, which has nothing more to say. The
    // stop must reach it there, and quickly.
    let (done, finished) = std::sync::mpsc::channel();
    let waiting = Arc::clone(&bench);
    std::thread::spawn(move || {
        let _ = done.send(waiting.dispatch("content:search-next", &[json!("stream-1")]));
    });
    std::thread::sleep(Duration::from_millis(300));
    assert!(finished.try_recv().is_err(), "the batch is still waiting for the host");
    let started = std::time::Instant::now();
    bench.dispatch("content:search-cancel", &[json!("stream-1")]).unwrap();
    let settled = finished.recv_timeout(Duration::from_secs(5)).expect("the batch that was waiting for the host did not end within 5 s of the stop");
    assert!(started.elapsed() < Duration::from_secs(3), "the stop took {:?} to end the waiting batch", started.elapsed());
    let settled = settled.expect("a stopped search answers instead of failing");
    assert_eq!(settled["done"], true, "a stopped search answers as finished: {settled}");
    assert_eq!(settled["items"].as_array().unwrap().len(), 0, "a stopped search hands out nothing more");
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while fixture.closed_channels() <= before && std::time::Instant::now() < deadline { std::thread::sleep(Duration::from_millis(50)); }
    assert_eq!(fixture.closed_channels(), before + 1, "stopping the search must close the channel it was reading, so the command on the host ends");
    // A search that was stopped is gone: it answers as finished with nothing.
    let after = bench.dispatch("content:search-next", &[json!("stream-1")]).unwrap();
    assert_eq!(after["done"], true);
    assert_eq!(after["items"].as_array().unwrap().len(), 0);
    // A project has one live content search. Asking for another on the same
    // project ends the one that is running there, as on the Electron build,
    // so that typing a query does not leave a worker behind for every change.
    let closed = fixture.closed_channels();
    bench.dispatch("content:search-start", &[json!("remote"), json!("stream-2"), json!("hold"), json!(false)]).unwrap();
    bench.dispatch("content:search-next", &[json!("stream-2")]).unwrap();
    bench.dispatch("content:search-start", &[json!("remote"), json!("stream-3"), json!("hold"), json!(false)]).unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while fixture.closed_channels() <= closed && std::time::Instant::now() < deadline { std::thread::sleep(Duration::from_millis(50)); }
    assert_eq!(fixture.closed_channels(), closed + 1, "a new search on the same project closes the channel of the one it replaces");
    let replaced = bench.dispatch("content:search-next", &[json!("stream-2")]).unwrap();
    assert_eq!(replaced["done"], true, "the replaced search answers as finished");
    assert_eq!(replaced["items"].as_array().unwrap().len(), 0);
    // The same id asked for again ends the search that had it.
    bench.dispatch("content:search-cancel", &[json!("stream-3")]).unwrap();
    let _ = fs::remove_dir_all(root);
}

#[test]
fn windows_remote_script_translates_errors_and_keeps_the_command() {
    let _env_lock = env_lock();
    let root = temp_dir("ssh-win");
    let home = root.join("home");
    fs::create_dir_all(home.join(".ssh")).unwrap();
    fs::write(home.join(".ssh/id_ed25519"), "-----BEGIN OPENSSH PRIVATE KEY-----\nWINKEYMATERIAL\n-----END OPENSSH PRIVATE KEY-----\n").unwrap();
    let (shim, log) = install_ssh_shim(&root);
    let sock = root.join("agent.sock");
    let agent = fake_agent(&sock);
    let _env = ssh_env(&home, &shim, &log, &agent);
    let _os = var_guard("AWB_SSH_OS", "Windows_NT");
    let (bench, _) = workbench(&root);
    let local = bench.dispatch("db:get", &[]).unwrap()["db"]["hosts"][0].clone();
    bench.dispatch("db:hosts", &[json!([
        local,
        { "id": "win", "name": "Win", "addr": "127.0.0.1", "port": 22, "user": "win", "auth": "key", "password": "do-not-leak-win" }
    ])]).unwrap();
    let saved = bench.dispatch("db:get", &[]).unwrap();
    assert_eq!(saved["db"]["hosts"][1]["platform"], "windows");
    assert!(!saved.to_string().contains("do-not-leak-win"));
    assert!(!saved.to_string().contains("WINKEYMATERIAL"));
    bench.dispatch("db:projects", &[json!([{ "id": "p", "name": "P", "host": "win", "path": "C:\\项目", "branch": "", "agent": "shell" }])]).unwrap();
    bench.dispatch("tree:trash", &[json!("p"), json!("O'Brien/note.txt"), json!(true)]).unwrap();
    let mut settings = bench.dispatch("db:get", &[]).unwrap()["db"]["settings"].clone();
    settings["language"] = json!("en");
    bench.dispatch("db:settings", &[settings]).unwrap();
    bench.dispatch("tree:trash", &[json!("p"), json!("O'Brien/note.txt"), json!(true)]).unwrap();
    let scripts: Vec<String> = parse_ssh_calls(&fs::read_to_string(&log).unwrap()).iter().filter_map(|call| call.args.last().and_then(|arg| pello_core::ssh::decode_powershell_command(arg))).collect();
    assert_eq!(scripts.len(), 2, "{scripts:?}");
    let zh = &scripts[0];
    assert!(zh.contains("Get-Item") && zh.contains("Remove-Item") && zh.contains("Join-Path") && zh.contains("Get-ChildItem") && zh.contains("Resolve-Path"));
    assert!(zh.contains("不支持删除符号链接") && zh.contains("文件类型已更改") && zh.contains("目录包含符号链接"));
    assert!(zh.contains("C:\\项目") && zh.contains("'O''Brien'"));
    assert!(!zh.contains("Cannot delete symbolic links"));
    let en = &scripts[1];
    assert!(en.contains("Get-Item") && en.contains("Remove-Item") && en.contains("Join-Path"));
    assert!(en.contains("Cannot delete symbolic links") && en.contains("File type has changed") && en.contains("Directory contains symbolic links"));
    assert!(en.contains("C:\\项目") && en.contains("'O''Brien'"));
    assert!(!en.contains("不支持删除符号链接") && !en.contains("文件类型已更改") && !en.contains("目录包含符号链接"));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn terminal_panes_rename_restore_and_run_state() {
    let root = temp_dir("terms");
    let project = root.join("project");
    fs::create_dir_all(&project).unwrap();
    fs::write(project.join("marker.txt"), "stay").unwrap();
    let (bench, _) = workbench(&root);
    bench.dispatch("db:projects", &[json!([{ "id": "p", "name": "P", "host": "local", "path": project.display().to_string(), "branch": "", "agent": "shell" }])]).unwrap();
    bench.dispatch("db:sessions", &[json!("p"), json!([{ "id": "term-a", "kind": "shell", "shell": "bash", "name": "Alpha", "sessionId": "s1" }]), json!("term-a"), json!([{ "id": "s1", "name": "会话一" }]), json!("s1")]).unwrap();
    let created = bench.dispatch("pty:create", &[json!({ "id": "term-a", "projectId": "p", "kind": "shell", "shell": "bash" })]).unwrap();
    let born = created["born"].as_u64().unwrap();
    let idle = wait_terminal(&bench, "term-a", true, "idle");
    assert_eq!(idle["kind"], "shell");
    assert!(idle["agentKind"].is_null());
    let (_, status) = snap_status(&bench, "term-a");
    assert_eq!(status["color"], "inactive");
    assert_eq!(status["spinning"], false);
    bench.dispatch("pty:write", &[json!("term-a"), json!("sleep 2\n"), json!(false)]).unwrap();
    let running = wait_terminal(&bench, "term-a", false, "running");
    assert_eq!(running["born"].as_u64(), Some(born));
    let (_, running_status) = snap_status(&bench, "term-a");
    assert_eq!(running_status["color"], "inactive");
    assert_eq!(running_status["spinning"], false);
    std::thread::sleep(Duration::from_millis(300));
    let silent = bench.dispatch("pty:snapshot", &[json!("term-a")]).unwrap();
    assert_eq!(silent["state"], "running");
    assert_eq!(silent["inputReady"], false, "silence and a live process are not completion");
    let idle_again = wait_terminal(&bench, "term-a", true, "idle");
    assert_eq!(idle_again["born"].as_u64(), Some(born));
    let (_, idle_status) = snap_status(&bench, "term-a");
    assert_eq!(idle_status["color"], "inactive");

    let right = bench.dispatch("terminal:split", &[json!({ "projectId": "p", "sessionId": "s1", "termId": "term-a", "direction": "right" })]).unwrap();
    assert_eq!(right["born"].as_u64(), Some(born));
    assert_eq!(right["tiles"].as_array().unwrap().len(), 2);
    let blocked = bench.dispatch("terminal:split", &[json!({ "projectId": "p", "sessionId": "s1", "termId": "term-a", "direction": "right" })]).unwrap_err();
    assert!(blocked.contains("此方向已达到分栏上限"), "{blocked}");
    assert_eq!(bench.dispatch("pty:snapshot", &[json!("term-a")]).unwrap()["born"].as_u64(), Some(born));
    bench.dispatch("terminal:split", &[json!({ "projectId": "p", "sessionId": "s1", "termId": "term-a", "direction": "down" })]).unwrap();
    let other = right["tiles"].as_array().unwrap().iter().find(|tile| tile["id"] != "term-a").unwrap()["id"].as_str().unwrap().to_string();
    let full = bench.dispatch("terminal:split", &[json!({ "projectId": "p", "sessionId": "s1", "termId": other, "direction": "down" })]).unwrap();
    assert_eq!(full["tiles"].as_array().unwrap().len(), 4);
    let overflow = bench.dispatch("terminal:split", &[json!({ "projectId": "p", "sessionId": "s1", "termId": "term-a", "direction": "down" })]).unwrap_err();
    assert!(overflow.contains("最多支持四个终端分栏"), "{overflow}");
    for tile in full["tiles"].as_array().unwrap() {
        let id = tile["id"].as_str().unwrap();
        assert!(bench.dispatch("pty:snapshot", &[json!(id)]).unwrap()["born"].is_number(), "{id} was closed by a split");
    }
    assert_eq!(bench.dispatch("pty:snapshot", &[json!("term-a")]).unwrap()["born"].as_u64(), Some(born));
    let merged = bench.dispatch("terminal:merge", &[json!({ "projectId": "p", "sessionId": "s1", "termId": "term-a" })]).unwrap();
    assert_eq!(merged["tiles"].as_array().unwrap().len(), 0);
    assert_eq!(merged["born"].as_u64(), Some(born));
    assert_eq!(merged["focus"], "term-a");
    assert_eq!(bench.dispatch("pty:snapshot", &[json!("term-a")]).unwrap()["born"].as_u64(), Some(born));
    let renamed = bench.dispatch("terminal:rename", &[json!({ "projectId": "p", "termId": "term-a", "name": "  左侧\u{0001}  " })]).unwrap();
    assert_eq!(renamed["name"], "左侧");
    assert_eq!(renamed["focus"], "term-a");
    assert_eq!(renamed["cancelled"], false);
    assert_eq!(bench.dispatch("pty:snapshot", &[json!("term-a")]).unwrap()["born"].as_u64(), Some(born));
    let empty = bench.dispatch("terminal:rename", &[json!({ "projectId": "p", "termId": "term-a", "name": " \u{0001} " })]).unwrap_err();
    assert!(empty.contains("名称不能为空"), "{empty}");
    let cancelled = bench.dispatch("terminal:rename", &[json!({ "projectId": "p", "termId": "term-a", "name": "nope", "cancel": true })]).unwrap();
    assert_eq!(cancelled["cancelled"], true);
    assert_eq!(cancelled["focus"], "term-a");
    assert_eq!(cancelled["name"], "左侧");
    let record = bench.dispatch("db:get", &[]).unwrap();
    let term = record["db"]["sessions"]["p"].as_array().unwrap().iter().find(|term| term["id"] == "term-a").unwrap();
    assert_eq!(term["name"], "左侧");
    assert_eq!(term["kind"], "shell");
    assert_eq!(record["db"]["projects"][0]["path"], project.display().to_string());
    assert_eq!(fs::read_to_string(project.join("marker.txt")).unwrap(), "stay");
    assert!(!project.join("左侧").exists());

    pello_core::pty::save_history(&root.join("data"), "term-r", "上次输出\rline").unwrap();
    let replayed = bench.dispatch("pty:create", &[json!({ "id": "term-r", "projectId": "p", "kind": "shell", "shell": "bash" })]).unwrap();
    let replay = replayed["replay"].as_str().unwrap();
    assert!(replay.starts_with("\u{1b}[38;5;244m── 上次会话记录 ──\u{1b}[0m\r\n上次输出\r\nline\r\n"));
    assert!(replay.contains("── 会话已恢复，下面连接新进程 ──"));
    assert_eq!(pello_core::pty::load_history(&root.join("data"), "term-r"), "上次输出\rline");

    // A stand-in, never a real agent CLI: its command does not exist, so the
    // shell returns its own exit code to the prompt.
    bench.dispatch("db:custom", &[json!([{ "id": "absent", "name": "Absent", "cmd": "awb-no-such-agent-command", "args": "" }])]).unwrap();
    let agent = bench.dispatch("pty:create", &[json!({ "id": "agent-1", "projectId": "p", "kind": "absent", "shell": "bash", "agentSessionId": "session-1" })]).unwrap();
    assert_eq!(agent["agentKind"], "absent");
    let finished = wait_terminal(&bench, "agent-1", true, "failed");
    assert_eq!(finished["exitCode"], 127, "a missing agent command keeps its shell exit code");
    let (_, status) = snap_status(&bench, "agent-1");
    assert_eq!(status["color"], "failed");
    assert_eq!(status["spinning"], false);
    bench.dispatch("pty:feed", &[json!("agent-1"), json!("\u{1b}]9;4;1\u{7}")]).unwrap();
    let (_, progress) = snap_status(&bench, "agent-1");
    assert_eq!(progress["color"], "busy");
    assert_eq!(progress["spinning"], true);
    bench.dispatch("pty:feed", &[json!("agent-1"), json!("\u{1b}]7501;state=idle:app=claude:session=s1\u{7}")]).unwrap();
    let (native_idle, steady) = snap_status(&bench, "agent-1");
    assert_eq!(native_idle["agentKind"], "claude");
    assert_eq!(native_idle["agentSessionId"], "s1");
    assert_eq!(steady["color"], "ready");
    assert_eq!(steady["spinning"], false);
    bench.dispatch("pty:feed", &[json!("agent-1"), json!("\u{1b}]9;4;1\u{7}")]).unwrap();
    let (_, still_ready) = snap_status(&bench, "agent-1");
    assert_eq!(still_ready["color"], "ready", "OSC 7501 keeps a later OSC 9;4 from marking the agent busy");
    bench.dispatch("pty:feed", &[json!("agent-1"), json!("\u{1b}]7501;state=working:app=claude:session=s1\u{7}")]).unwrap();
    bench.dispatch("pty:feed", &[json!("agent-1"), json!("\u{1b}]9;4;0\u{7}")]).unwrap();
    bench.dispatch("pty:write", &[json!("agent-1"), json!("\n"), json!(false)]).unwrap();
    std::thread::sleep(Duration::from_millis(300));
    let (working, spinning) = snap_status(&bench, "agent-1");
    assert_eq!(working["state"], "running");
    assert_eq!(working["inputReady"], false);
    assert_eq!(spinning["color"], "busy");
    assert_eq!(spinning["spinning"], true);
    post_hook(&bench, "agent-1", "waiting");
    let (_, hooked) = snap_status(&bench, "agent-1");
    assert_eq!(hooked["color"], "ready");
    assert_eq!(hooked["spinning"], false);
    post_hook(&bench, "agent-1", "working");
    let (_, hooked_busy) = snap_status(&bench, "agent-1");
    assert_eq!(hooked_busy["color"], "busy");
    assert_eq!(hooked_busy["spinning"], true);
    bench.dispatch("pty:feed", &[json!("agent-1"), json!("\u{1b}]7501;state=idle:app=claude:session=s1\u{7}")]).unwrap();
    bench.dispatch("pty:feed", &[json!("agent-1"), json!("\u{1b}]7501;state=working:id=child:app=codex\u{7}")]).unwrap();
    let (child, child_status) = snap_status(&bench, "agent-1");
    assert_eq!(child["agentKind"], "claude");
    assert_eq!(child["inputReady"], true);
    assert_eq!(child_status["color"], "ready");
    let token = bench.dispatch("terminal:hook", &[json!("agent-1")]).unwrap()["token"].as_str().unwrap().to_string();
    assert!(!bench.dispatch("db:get", &[]).unwrap().to_string().contains(&token));

    let missing = root.join("missing-dir");
    bench.dispatch("db:projects", &[json!([
        { "id": "p", "name": "P", "host": "local", "path": project.display().to_string(), "branch": "", "agent": "shell" },
        { "id": "gone", "name": "Gone", "host": "local", "path": missing.display().to_string(), "branch": "", "agent": "shell" }
    ])]).unwrap();
    bench.dispatch("db:sessions", &[json!("gone"), json!([{ "id": "term-gone", "kind": "shell", "shell": "bash", "name": "保留", "sessionId": "s2" }]), json!("term-gone"), json!([{ "id": "s2", "name": "会话一" }]), json!("s2")]).unwrap();
    pello_core::pty::save_history(&root.join("data"), "term-gone", "保留下来的历史").unwrap();
    let failed = bench.dispatch("pty:create", &[json!({ "id": "term-gone", "projectId": "gone", "kind": "shell", "shell": "bash" })]).unwrap_err();
    assert!(failed.contains("目录不存在"), "{failed}");
    assert_eq!(pello_core::pty::load_history(&root.join("data"), "term-gone"), "保留下来的历史");
    let kept = bench.dispatch("db:get", &[]).unwrap();
    assert!(kept["db"]["sessions"]["gone"].as_array().unwrap().iter().any(|term| term["id"] == "term-gone"));
    assert!(bench.dispatch("pty:snapshot", &[json!("term-gone")]).unwrap().is_null());
    let notice = bench.dispatch("terminal:failure", &[json!("term-gone")]).unwrap();
    assert_eq!(notice["reconnect"], true);
    assert!(notice["notice"].as_str().unwrap().contains("重新连接"), "{notice}");
    let mut settings = kept["db"]["settings"].clone();
    settings["language"] = json!("en");
    bench.dispatch("db:settings", &[settings]).unwrap();
    bench.dispatch("db:sessions", &[json!("gone"), json!([
        { "id": "term-gone", "kind": "shell", "shell": "bash", "name": "保留", "sessionId": "s2" },
        { "id": "term-gone-en", "kind": "shell", "shell": "bash", "name": "Kept", "sessionId": "s2" }
    ]), json!("term-gone"), json!([{ "id": "s2", "name": "会话一" }]), json!("s2")]).unwrap();
    pello_core::pty::save_history(&root.join("data"), "term-gone-en", "kept history").unwrap();
    let english = bench.dispatch("pty:create", &[json!({ "id": "term-gone-en", "projectId": "gone", "kind": "shell", "shell": "bash" })]).unwrap_err();
    assert!(english.contains("Directory does not exist"), "{english}");
    let english_notice = bench.dispatch("terminal:failure", &[json!("term-gone-en")]).unwrap();
    assert_eq!(english_notice["reconnect"], true);
    assert!(english_notice["notice"].as_str().unwrap().contains("Right-click the terminal to reconnect"), "{english_notice}");
    assert_eq!(pello_core::pty::load_history(&root.join("data"), "term-gone-en"), "kept history");
    assert!(bench.dispatch("db:get", &[]).unwrap()["db"]["sessions"]["gone"].as_array().unwrap().iter().any(|term| term["id"] == "term-gone-en"));
    bench.dispatch("pty:close", &[json!("term-a")]).unwrap();
    bench.dispatch("pty:close", &[json!("term-r")]).unwrap();
    bench.dispatch("pty:close", &[json!("agent-1")]).unwrap();
    let _ = fs::remove_dir_all(root);
}

#[test]
fn mcp_and_skills_keep_native_config_and_do_not_execute() {
    let _lock = env_lock();
    let root = temp_dir("resources");
    let home = root.join("home");
    let xdg = root.join("xdg");
    fs::create_dir_all(home.join(".config/opencode")).unwrap();
    fs::write(home.join(".config/opencode/opencode.jsonc"), b"{ /* keep */ }\n").unwrap();
    fs::create_dir_all(home.join(".claude/skills")).unwrap();
    let _home = var_guard("AWB_RESOURCE_HOME", home.to_str().unwrap());
    let _xdg = var_guard("XDG_DATA_HOME", xdg.to_str().unwrap());
    #[cfg(windows)]
    let recycle_bin_before = recycle_bin_entries(&root);
    let _open = var_guard("AWB_OPEN_SKILL", "0");
    let (bench, _) = workbench(&root);
    let targets = bench.dispatch("resources:targets", &[]).unwrap();
    let target = |id: &str| targets.as_array().unwrap().iter().find(|item| item["id"] == id).unwrap().clone();
    assert!(path_ends_with(target("claude")["mcpPath"].as_str().unwrap(), &[".claude.json"]), "{}", target("claude"));
    assert!(path_ends_with(target("claude")["skillPath"].as_str().unwrap(), &[".claude", "skills"]));
    assert_eq!(target("claude")["skillAdapter"], "claude");
    assert!(path_ends_with(target("codex")["mcpPath"].as_str().unwrap(), &[".codex", "config.toml"]));
    assert!(path_ends_with(target("codex")["skillPath"].as_str().unwrap(), &[".agents", "skills"]));
    assert!(path_ends_with(target("opencode")["mcpPath"].as_str().unwrap(), &["opencode.jsonc"]));
    assert!(path_ends_with(target("pi")["mcpPath"].as_str().unwrap(), &[".pi", "agent", "mcp.json"]));
    assert!(path_ends_with(target("pi")["skillPath"].as_str().unwrap(), &[".pi", "agent", "skills"]));
    assert!(path_ends_with(target("omp")["mcpPath"].as_str().unwrap(), &[".omp", "agent", "mcp.json"]));
    assert!(path_ends_with(target("omp")["skillConfigPath"].as_str().unwrap(), &[".omp", "agent", "config.yml"]));

    let original = "{\n  // keep-theme\n  \"theme\": \"dark\",\n  \"mcpServers\": {\n    \"keep\": { \"command\": \"stay\", \"args\": [] },\n    \"leak\": { \"url\": \"https://user:secret-pass@example.com/mcp?token=abc\", \"headers\": { \"Authorization\": \"Bearer secret-token\" } }\n  }\n}\n";
    let claude_file = home.join(".claude.json");
    fs::write(&claude_file, original).unwrap();
    let codex_file = home.join(".codex/config.toml");
    fs::create_dir_all(codex_file.parent().unwrap()).unwrap();
    let codex_original = "# keep this comment\nmodel = \"kept\"\n\n[mcp_servers.keep]\ncommand = \"stay\"\n";
    fs::write(&codex_file, codex_original).unwrap();
    let portable = root.join("portable-skills");
    fs::create_dir_all(&portable).unwrap();
    bench.dispatch("db:custom", &[json!([{
        "id": "box", "name": "Box", "cmd": "echo", "args": "", "letter": "B", "color": "#336699", "shell": "pwsh", "env": [],
        "resources": { "mcpPath": root.join("box-mcp.json").display().to_string(), "skillPath": portable.display().to_string(), "format": "standard", "skillAdapter": "portable" }
    }])]).unwrap();

    let added = bench.dispatch("resources:mcp", &[json!("docs"), json!({ "command": "tool", "args": ["--flag"], "env": { "TOKEN": "mcp-secret-value" } }), json!(["claude", "codex", "missing"])]).unwrap();
    for (agent, ok) in [("claude", true), ("codex", true), ("missing", false)] {
        assert_eq!(added.as_array().unwrap().iter().find(|item| item["agent"] == agent).unwrap()["ok"], ok, "{added}");
    }
    let claude_now = fs::read_to_string(&claude_file).unwrap();
    assert!(claude_now.contains("// keep-theme"), "{claude_now}");
    assert!(claude_now.contains("\"theme\": \"dark\""), "{claude_now}");
    assert!(claude_now.contains("\"command\": \"stay\""), "{claude_now}");
    assert!(!claude_now.contains("\"enabled\""), "{claude_now}");
    assert_eq!(fs::read_to_string(format!("{}.awb-backup", claude_file.display())).unwrap(), original);
    let codex_now = fs::read_to_string(&codex_file).unwrap();
    assert!(codex_now.contains("# keep this comment") && codex_now.contains("model = \"kept\"") && codex_now.contains("[mcp_servers.docs]"), "{codex_now}");
    assert_eq!(fs::read_to_string(format!("{}.awb-backup", codex_file.display())).unwrap(), codex_original);
    let again = bench.dispatch("resources:mcp", &[json!("docs"), json!({ "command": "other" }), json!(["claude", "codex"])]).unwrap();
    for item in again.as_array().unwrap() {
        assert_eq!(item["ok"], false, "{item}");
        assert!(item["error"].as_str().unwrap().contains("已存在同名"), "{item}");
    }
    assert_eq!(fs::read_to_string(&claude_file).unwrap(), claude_now);
    assert_eq!(fs::read_to_string(&codex_file).unwrap(), codex_now);

    let listed = bench.dispatch("resources:list", &[json!("mcp"), json!("claude"), json!(1), json!("")]).unwrap();
    assert!(!listed.to_string().contains("secret-pass"), "{listed}");
    assert!(!listed.to_string().contains("secret-token") && !listed.to_string().contains("mcp-secret-value"), "{listed}");
    let docs = listed["items"].as_array().unwrap().iter().find(|item| item["name"] == "docs").unwrap().clone();
    assert_eq!(docs["enabled"], true);
    assert_eq!(docs["description"], "tool");
    assert!(docs.get("command").is_none() && docs.get("env").is_none());
    let leak = listed["items"].as_array().unwrap().iter().find(|item| item["name"] == "leak").unwrap().clone();
    assert_eq!(leak["description"], "https://example.com/mcp");
    let detail = bench.dispatch("resources:detail", &[json!("mcp"), json!("claude"), docs.clone()]).unwrap();
    assert!(detail["content"].as_str().unwrap().contains("********"), "{detail}");
    assert!(!detail.to_string().contains("mcp-secret-value"), "{detail}");
    assert!(detail["notice"].as_str().unwrap().contains("已隐藏"));
    let leak_detail = bench.dispatch("resources:detail", &[json!("mcp"), json!("claude"), leak]).unwrap();
    assert!(!leak_detail.to_string().contains("secret-pass") && !leak_detail.to_string().contains("secret-token"), "{leak_detail}");
    assert!(leak_detail["content"].as_str().unwrap().contains("https://example.com/mcp"), "{leak_detail}");
    assert!(!bench.dispatch("db:get", &[]).unwrap().to_string().contains("mcp-secret-value"));
    assert!(!fs::read_to_string(root.join("data/workbench.json")).unwrap().contains("mcp-secret-value"));

    bench.dispatch("resources:toggle", &[json!("mcp"), json!("claude"), docs.clone(), json!(false)]).unwrap();
    let disabled = fs::read_to_string(&claude_file).unwrap();
    assert!(disabled.contains("// keep-theme") && disabled.contains("\"theme\": \"dark\"") && disabled.contains("awbDisabledMcp"), "{disabled}");
    assert!(!disabled.contains("\"enabled\""), "{disabled}");
    assert!(disabled.contains("mcp-secret-value") && disabled.contains("\"command\": \"stay\""));
    let listed = bench.dispatch("resources:list", &[json!("mcp"), json!("claude"), json!(1), json!("")]).unwrap();
    let docs = listed["items"].as_array().unwrap().iter().find(|item| item["name"] == "docs").unwrap().clone();
    assert_eq!(docs["enabled"], false);
    let planted = disabled.replacen("\"mcpServers\": {", "\"mcpServers\": {\n    \"docs\": { \"command\": \"newer\" },", 1);
    fs::write(&claude_file, &planted).unwrap();
    let refused = bench.dispatch("resources:toggle", &[json!("mcp"), json!("claude"), docs, json!(true)]).unwrap_err();
    assert!(refused.contains("已有同名 MCP"), "{refused}");
    assert_eq!(fs::read_to_string(&claude_file).unwrap(), planted);
    assert!(planted.contains("\"command\": \"newer\""));

    let source = root.join("skill-src");
    let sentinel = root.join("skill-ran");
    for (name, description) in [("demo-skill", "Copies files only"), ("note-skill", "Second skill")] {
        let folder = source.join(name);
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join("SKILL.md"), format!("---\nname: {name}\ndescription: {description}\n---\nbody\n")).unwrap();
        fs::write(folder.join("run.sh"), format!("#!/bin/sh\ntouch {}\n", sentinel.display())).unwrap();
    }
    let imported = bench.dispatch("resources:skills", &[json!(source.display().to_string()), json!(["claude", "box"]), json!(["demo-skill", "note-skill"])]).unwrap();
    assert_eq!(imported.as_array().unwrap().len(), 4, "{imported}");
    for item in imported.as_array().unwrap() {
        assert_eq!(item["ok"], true, "{item}");
        assert!(item["name"] == "demo-skill" || item["name"] == "note-skill", "{item}");
    }
    assert!(!sentinel.exists(), "imported scripts must not run");
    assert_eq!(fs::read_to_string(home.join(".claude/skills/demo-skill/run.sh")).unwrap(), fs::read_to_string(source.join("demo-skill/run.sh")).unwrap());
    let demo_body = fs::read_to_string(home.join(".claude/skills/demo-skill/SKILL.md")).unwrap();
    let again = bench.dispatch("resources:skills", &[json!(source.display().to_string()), json!(["claude", "box"]), json!(["demo-skill"])]).unwrap();
    assert!(again.as_array().unwrap().iter().all(|item| item["ok"] == false && item["error"].as_str().unwrap_or("").contains("已存在")), "{again}");
    assert_eq!(fs::read_to_string(home.join(".claude/skills/demo-skill/SKILL.md")).unwrap(), demo_body);

    let skills = bench.dispatch("resources:list", &[json!("skills"), json!("claude"), json!(1), json!("")]).unwrap();
    let demo = skills["items"].as_array().unwrap().iter().find(|item| item["name"] == "demo-skill").unwrap().clone();
    assert_eq!(demo["enabled"], true);
    assert!(demo["description"].as_str().unwrap().contains("Copies files only"));
    bench.dispatch("resources:toggle", &[json!("skills"), json!("claude"), demo.clone(), json!(false)]).unwrap();
    let settings = fs::read_to_string(home.join(".claude/settings.json")).unwrap();
    assert!(settings.contains("skillOverrides") && settings.contains("\"off\""), "{settings}");
    assert!(!settings.contains("\"enabled\""), "{settings}");
    assert_eq!(fs::read_to_string(home.join(".claude/skills/demo-skill/SKILL.md")).unwrap(), demo_body);
    let opened = bench.dispatch("resources:skill-open", &[json!("claude"), demo]).unwrap();
    let opened = opened.as_str().unwrap();
    assert_eq!(pello_core::real_path(opened).unwrap(), pello_core::real_path(home.join(".claude/skills/demo-skill")).unwrap());
    assert!(fs::read_to_string(Path::new(opened).join("SKILL.md")).unwrap().contains("demo-skill"));

    let box_skills = bench.dispatch("resources:list", &[json!("skills"), json!("box"), json!(1), json!("")]).unwrap();
    let note = box_skills["items"].as_array().unwrap().iter().find(|item| item["name"] == "note-skill").unwrap().clone();
    bench.dispatch("resources:toggle", &[json!("skills"), json!("box"), note.clone(), json!(false)]).unwrap();
    assert!(!portable.join("note-skill/SKILL.md").exists());
    assert_eq!(fs::read_to_string(portable.join("note-skill/SKILL.md.awb-disabled")).unwrap().contains("note-skill"), true);
    fs::write(portable.join("note-skill/SKILL.md"), "---\nname: note-skill\ndescription: replacement\n---\nnew\n").unwrap();
    let refused = bench.dispatch("resources:toggle", &[json!("skills"), json!("box"), note.clone(), json!(true)]).unwrap_err();
    assert!(refused.contains("目标文件已存在"), "{refused}");
    assert!(fs::read_to_string(portable.join("note-skill/SKILL.md")).unwrap().contains("replacement"));
    assert!(portable.join("note-skill/SKILL.md.awb-disabled").is_file());
    bench.dispatch("resources:skill-delete", &[json!("box"), note]).unwrap();
    assert!(!portable.join("note-skill").exists());
    assert!(portable.join("demo-skill/SKILL.md").is_file());
    assert!(portable.is_dir());
    // Where the skill went. A POSIX host has a free-desktop trash to read.
    #[cfg(unix)]
    {
        let trashed = fs::read_dir(xdg.join("Trash/files")).unwrap().any(|entry| entry.unwrap().file_name().to_string_lossy().contains("note-skill"));
        assert!(trashed, "the skill moves to trash");
    }
    // Windows: the system Recycle Bin holds one entry more than before, so the
    // folder was recycled rather than deleted for good.
    #[cfg(windows)]
    assert_eq!(recycle_bin_entries(&root) - recycle_bin_before, 1, "the skill moves to the Recycle Bin");

    let outside = root.join("outside-skill");
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("SKILL.md"), "---\nname: outside-skill\ndescription: stays outside\n---\nsecret-outside\n").unwrap();
    link_dir(&outside, &home.join(".claude/skills/outside-skill"));
    let listed = bench.dispatch("resources:list", &[json!("skills"), json!("claude"), json!(1), json!("")]).unwrap();
    let outside_item = listed["items"].as_array().unwrap().iter().find(|item| item["name"] == "outside-skill").unwrap().clone();
    let opened = bench.dispatch("resources:skill-open", &[json!("claude"), outside_item.clone()]).unwrap();
    assert_eq!(pello_core::real_path(opened.as_str().unwrap()).unwrap(), pello_core::real_path(&outside).unwrap());
    let refused = bench.dispatch("resources:skill-delete", &[json!("claude"), outside_item]).unwrap_err();
    assert!(refused.contains("超出") || refused.contains("符号链接"), "{refused}");
    assert!(fs::read_to_string(outside.join("SKILL.md")).unwrap().contains("secret-outside"));
    assert!(home.join(".claude/skills").is_dir());

    let slip = root.join("slip.zip");
    fs::write(&slip, store_zip(&[ZipEntry { name: "../escape.txt", data: b"nope", size: 4 }])).unwrap();
    let error = bench.dispatch("resources:skills", &[json!(slip.display().to_string()), json!(["box"])]).unwrap_err();
    assert!(error.contains("不安全路径"), "{error}");
    assert!(!root.join("escape.txt").exists());
    assert!(!std::env::temp_dir().join("escape.txt").exists());
    let bomb = root.join("bomb.zip");
    fs::write(&bomb, store_zip(&[ZipEntry { name: "bomb/SKILL.md", data: b"", size: 40_000_000 }])).unwrap();
    let error = bench.dispatch("resources:skills", &[json!(bomb.display().to_string()), json!(["box"])]).unwrap_err();
    assert!(error.contains("32 MB"), "{error}");
    assert!(!portable.join("bomb").exists());
    let packed = root.join("packed.zip");
    let skill = b"---\nname: packed-skill\ndescription: from zip\n---\nzipped\n";
    let script = format!("#!/bin/sh\ntouch {}\n", sentinel.display());
    fs::write(&packed, store_zip(&[
        ZipEntry { name: "packed/SKILL.md", data: skill, size: skill.len() as u32 },
        ZipEntry { name: "packed/run.sh", data: script.as_bytes(), size: script.len() as u32 },
    ])).unwrap();
    let imported = bench.dispatch("resources:skills", &[json!(packed.display().to_string()), json!(["box"]), json!(["packed-skill"])]).unwrap();
    assert_eq!(imported[0]["ok"], true, "{imported}");
    assert!(!sentinel.exists());
    assert_eq!(fs::read(portable.join("packed-skill/run.sh")).unwrap(), script.as_bytes());
    let linked_src = root.join("linked-src");
    fs::create_dir_all(linked_src.join("bad-skill")).unwrap();
    fs::write(linked_src.join("bad-skill/SKILL.md"), "---\nname: bad-skill\ndescription: link\n---\nno\n").unwrap();
    // A link whose target is missing: a POSIX symlink, or a Windows junction,
    // which may also point at nothing and still reports as a link.
    link_dir(&root.join("missing-target"), &linked_src.join("bad-skill/link"));
    let error = bench.dispatch("resources:skills", &[json!(linked_src.display().to_string()), json!(["box"])]).unwrap_err();
    assert!(error.contains("符号链接"), "{error}");
    assert!(!portable.join("bad-skill").exists());
    let scan_file = root.join("scan.json");
    fs::write(&scan_file, br#"{"mcpServers":{"scan":{"command":"echo","env":{"TOKEN":"scan-secret-value"}}}}"#).unwrap();
    let scanned = bench.dispatch("resources:scan", &[json!("mcp"), json!(scan_file.display().to_string())]).unwrap();
    assert!(!scanned.to_string().contains("scan-secret-value"), "{scanned}");
    assert_eq!(scanned[0]["name"], "scan");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn previews_keep_markdown_and_sandbox_project_assets() {
    let _lock = env_lock();
    let root = temp_dir("preview");
    let project = root.join("project");
    let outside = root.join("outside");
    fs::create_dir_all(&project).unwrap();
    fs::create_dir_all(&outside).unwrap();
    let markdown = "---\n# 标题\n\n保持原文\n";
    fs::write(project.join("note.md"), markdown).unwrap();
    let stamp = fs::metadata(project.join("note.md")).unwrap().modified().unwrap();
    let (bench, _) = workbench(&root);
    bench.dispatch("db:projects", &[json!([{ "id": "p", "name": "P", "path": project.display().to_string(), "host": "local" }])]).unwrap();
    let read = bench.dispatch("git:read", &[json!("p"), json!("note.md")]).unwrap();
    assert!(read["text"].as_str().unwrap().contains("保持原文"));
    assert_eq!(fs::read_to_string(project.join("note.md")).unwrap(), markdown);
    assert_eq!(fs::metadata(project.join("note.md")).unwrap().modified().unwrap(), stamp);

    let page = "<!doctype html><head></head><body>page</body>";
    fs::write(project.join("page.html"), page).unwrap();
    fs::write(project.join("pic.png"), b"\x89PNG\r\n").unwrap();
    fs::write(project.join("doc.pdf"), b"%PDF-1.4\n").unwrap();
    for ext in ["jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "avif"] {
        fs::write(project.join(format!("f.{ext}")), b"img").unwrap();
    }
    fs::write(outside.join("secret.txt"), b"outside-secret-bytes").unwrap();
    // A file link needs a privilege this Windows machine does not have; a
    // directory link is covered by `escape` above. POSIX keeps the file-link check.
    #[cfg(unix)]
    symlink(outside.join("secret.txt"), project.join("linked.png")).unwrap();
    let big = project.join("big.pdf");
    fs::File::create(&big).unwrap().set_len(12_000_001).unwrap();

    let url = bench.dispatch("file:preview-url", &[json!("p"), json!("note.md")]).unwrap();
    let url = url.as_str().unwrap();
    assert!(url.starts_with("http://127.0.0.1:"), "{url}");
    let (status, headers, body) = http("GET", url);
    assert_eq!(status, 200, "{headers}");
    assert!(headers.to_ascii_lowercase().contains("nosniff"));
    assert!(body.contains("保持原文"));
    assert_eq!(fs::read_to_string(project.join("note.md")).unwrap(), markdown);
    assert_eq!(fs::metadata(project.join("note.md")).unwrap().modified().unwrap(), stamp);

    let draft_url = bench.dispatch("file:preview-url", &[json!("p"), json!("page.html"), json!("<p>draft only</p>")]).unwrap();
    let draft_url = draft_url.as_str().unwrap().to_string();
    let (status, headers, body) = http("GET", &format!("{draft_url}&workbenchWheel=1"));
    assert_eq!(status, 200, "{headers}");
    assert!(body.contains("draft only") && body.contains("pello-preview-zoom"), "{body}");
    assert!(!body.contains("window.awb") && !body.contains("invoke(") && !body.contains("require("), "{body}");
    assert!(headers.to_ascii_lowercase().contains("nosniff") && headers.to_ascii_lowercase().contains("no-referrer"));
    assert_eq!(fs::read_to_string(project.join("page.html")).unwrap(), page);
    let (_, _, plain) = http("GET", &draft_url);
    assert!(!plain.contains("pello-preview-zoom"));
    let (status, _, _) = http("POST", &draft_url);
    assert_eq!(status, 405);
    assert_eq!(fs::read_to_string(project.join("page.html")).unwrap(), page);

    for (name, mime) in [("pic.png", "image/png"), ("doc.pdf", "application/pdf"), ("f.jpg", "image/jpeg"), ("f.jpeg", "image/jpeg"), ("f.gif", "image/gif"), ("f.webp", "image/webp"), ("f.bmp", "image/bmp"), ("f.svg", "image/svg+xml"), ("f.ico", "image/x-icon"), ("f.avif", "image/avif")] {
        let before = fs::read(project.join(name)).unwrap();
        let media = bench.dispatch("file:preview-url", &[json!("p"), json!(name)]).unwrap();
        let (status, headers, _) = http("GET", media.as_str().unwrap());
        assert_eq!(status, 200, "{name} {headers}");
        assert!(headers.to_ascii_lowercase().contains(&mime.to_ascii_lowercase()), "{name} {headers}");
        assert_eq!(fs::read(project.join(name)).unwrap(), before);
    }
    let escaped = bench.dispatch("file:preview-url", &[json!("p"), json!("../outside/secret.txt")]).unwrap_err();
    assert!(!escaped.contains("outside-secret"), "{escaped}");
    #[cfg(unix)]
    let linked = bench.dispatch("file:preview-url", &[json!("p"), json!("linked.png")]).unwrap_err();
    #[cfg(unix)]
    assert!(linked.contains("符号链接"), "{linked}");
    #[cfg(unix)]
    assert!(!linked.contains("outside-secret"), "{linked}");
    let oversized = bench.dispatch("file:preview-url", &[json!("p"), json!("big.pdf")]).unwrap_err();
    assert!(oversized.contains("12 MB"), "{oversized}");
    assert_eq!(fs::metadata(&big).unwrap().len(), 12_000_001);

    let zoomed = pdf_wheel(WheelState { page: 2, zoom: 1.0, pending: 0.0 }, 5, true, true, -8.0);
    assert_eq!(zoomed.page, 2);
    assert!((zoomed.zoom - 1.1).abs() < 0.0001);
    assert!((pdf_wheel(WheelState { page: 1, zoom: 4.0, pending: 0.0 }, 5, true, true, -8.0).zoom - 4.0).abs() < 0.0001);
    assert!((pdf_wheel(WheelState { page: 1, zoom: 0.25, pending: 0.0 }, 5, true, true, 8.0).zoom - 0.25).abs() < 0.0001);
    let holding = pdf_wheel(WheelState { page: 1, zoom: 1.0, pending: 0.0 }, 5, true, false, 30.0);
    assert_eq!(holding.page, 1);
    assert_eq!(pdf_wheel(holding, 5, true, false, 40.0).page, 2);
    assert_eq!(pdf_wheel(WheelState { page: 2, zoom: 1.0, pending: 0.0 }, 5, false, false, 80.0).page, 2);
    assert_eq!(pdf_wheel(WheelState { page: 1, zoom: 1.0, pending: 0.0 }, 5, true, false, -80.0).page, 1);
    assert_eq!(pdf_wheel(WheelState { page: 5, zoom: 1.0, pending: 0.0 }, 5, true, false, 80.0).page, 5);
    let ctrl = pdf_wheel(WheelState { page: 2, zoom: 1.0, pending: 0.0 }, 5, true, true, 80.0);
    assert_eq!(ctrl.page, 2);
    assert!(ctrl.zoom < 1.0);

    // The external diagram renderer is checked through a `/bin/sh` stand-in
    // and a `/tmp` sentinel, which only a POSIX host provides.
    #[cfg(unix)]
    {
    let log = root.join("diagram.log");
    let env_log = root.join("diagram.env");
    let stdin_log = root.join("diagram.stdin");
    let shim = root.join("diagram.sh");
    fs::write(&shim, format!("#!/bin/sh\nprintf '%s\\n' \"$0\" \"$@\" > {}\nenv > {}\ninput=$(cat)\nprintf '%s' \"$input\" > {}\ncase \"$input\" in\n  *SLEEP*) i=0; while [ \"$i\" -lt 300 ]; do i=$((i+1)); sleep 0.1; done ;;\nesac\nprintf '<svg xmlns=\"http://www.w3.org/2000/svg\" id=\"diagram\"></svg>'\n", shell_quote(&log), shell_quote(&env_log), shell_quote(&stdin_log))).unwrap();
    fs::set_permissions(&shim, fs::Permissions::from_mode(0o755)).unwrap();
    let _bin = var_guard("AWB_DIAGRAM_BIN", shim.to_str().unwrap());
    let _secret = var_guard("AWB_USER_DATA", "workbench-secret-token");
    let source = "flowchart TD\nA[\"$(touch /tmp/pello-should-not-run)\"]";
    let svg = bench.dispatch("diagram:mermaid", &[json!(source)]).unwrap();
    assert!(svg.as_str().unwrap().contains("<svg"), "{svg}");
    let recorded = fs::read_to_string(&log).unwrap();
    let lines: Vec<&str> = recorded.lines().collect();
    assert!(lines.iter().any(|line| *line == "--security-level") && lines.iter().any(|line| *line == "strict"), "{recorded}");
    assert!(lines.iter().any(|line| *line == "--sandbox") && lines.iter().any(|line| *line == "--no-node") && lines.iter().any(|line| *line == "--no-workbench"), "{recorded}");
    assert!(lines.iter().all(|line| *line != "node" && !line.ends_with("/node")), "{recorded}");
    assert!(!recorded.contains("flowchart"), "{recorded}");
    let child_env = fs::read_to_string(&env_log).unwrap();
    assert!(!child_env.contains("workbench-secret-token") && !child_env.contains("AWB_USER_DATA"), "{child_env}");
    assert_eq!(fs::read_to_string(&stdin_log).unwrap(), source);
    assert!(!Path::new("/tmp/pello-should-not-run").exists());
    fs::remove_file(&log).unwrap();
    let oversized = bench.dispatch("diagram:mermaid", &[json!("x".repeat(100_001))]).unwrap_err();
    assert!(oversized.contains("100000"), "{oversized}");
    assert!(!log.exists());
    std::thread::scope(|scope| {
        let handle = scope.spawn(|| bench.dispatch("diagram:mermaid", &[json!("SLEEP")]));
        std::thread::sleep(Duration::from_millis(200));
        bench.dispatch("diagram:cancel", &[]).unwrap();
        let cancelled = handle.join().unwrap().unwrap_err();
        assert!(cancelled.contains("取消"), "{cancelled}");
    });
    }
    assert_eq!(fs::read_to_string(project.join("note.md")).unwrap(), markdown);
    let _ = fs::remove_dir_all(root);
}

fn http(method: &str, url: &str) -> (u16, String, String) {
    let rest = url.trim_start_matches("http://");
    let (addr, path) = rest.split_once('/').unwrap();
    let mut stream = None;
    for _ in 0..50 {
        if let Ok(connected) = std::net::TcpStream::connect(addr) { stream = Some(connected); break; }
        std::thread::sleep(Duration::from_millis(20));
    }
    let mut stream = stream.expect("preview server");
    stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
    write!(stream, "{method} /{path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n").unwrap();
    let mut bytes = Vec::new();
    let _ = stream.read_to_end(&mut bytes);
    let text = String::from_utf8_lossy(&bytes);
    let (head, body) = text.split_once("\r\n\r\n").unwrap_or((text.as_ref(), ""));
    let status = head.split_whitespace().nth(1).unwrap_or("0").parse().unwrap_or(0);
    (status, head.to_string(), body.to_string())
}

#[cfg(unix)]
fn shell_quote(path: &Path) -> String { format!("'{}'", path.display().to_string().replace('\'', "'\\''")) }

struct ZipEntry<'a> { name: &'a str, data: &'a [u8], size: u32 }

fn store_zip(entries: &[ZipEntry<'_>]) -> Vec<u8> {
    fn crc(data: &[u8]) -> u32 {
        let mut value = 0xffff_ffffu32;
        for byte in data {
            value ^= *byte as u32;
            for _ in 0..8 { value = if value & 1 == 1 { (value >> 1) ^ 0xedb8_8320 } else { value >> 1 }; }
        }
        !value
    }
    let mut local = Vec::new();
    let mut central = Vec::new();
    for entry in entries {
        let checksum = crc(entry.data);
        let offset = local.len() as u32;
        local.extend_from_slice(&0x04034b50u32.to_le_bytes());
        local.extend_from_slice(&20u16.to_le_bytes());
        local.extend_from_slice(&0u16.to_le_bytes());
        local.extend_from_slice(&0u16.to_le_bytes());
        local.extend_from_slice(&0u16.to_le_bytes());
        local.extend_from_slice(&0u16.to_le_bytes());
        local.extend_from_slice(&checksum.to_le_bytes());
        local.extend_from_slice(&(entry.data.len() as u32).to_le_bytes());
        local.extend_from_slice(&entry.size.to_le_bytes());
        local.extend_from_slice(&(entry.name.len() as u16).to_le_bytes());
        local.extend_from_slice(&0u16.to_le_bytes());
        local.extend_from_slice(entry.name.as_bytes());
        local.extend_from_slice(entry.data);
        central.extend_from_slice(&0x02014b50u32.to_le_bytes());
        central.extend_from_slice(&20u16.to_le_bytes());
        central.extend_from_slice(&20u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&checksum.to_le_bytes());
        central.extend_from_slice(&(entry.data.len() as u32).to_le_bytes());
        central.extend_from_slice(&entry.size.to_le_bytes());
        central.extend_from_slice(&(entry.name.len() as u16).to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u32.to_le_bytes());
        central.extend_from_slice(&offset.to_le_bytes());
        central.extend_from_slice(entry.name.as_bytes());
    }
    let start = local.len() as u32;
    let mut out = local;
    out.extend_from_slice(&central);
    out.extend_from_slice(&0x06054b50u32.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&(central.len() as u32).to_le_bytes());
    out.extend_from_slice(&start.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out
}

fn skill_page(name: &str) -> String {
    format!("---\nname: {name}\ndescription: Keep notes in this session folder\n---\nSKILL-BODY-KEEP\n")
}

#[test]
fn native_skill_switches_edit_agent_overrides_and_leave_skill_md() {
    let _lock = env_lock();
    let root = temp_dir("skill-switches");
    let home = root.join("home");
    fs::create_dir_all(home.join(".codex/skills/notes")).unwrap();
    fs::create_dir_all(home.join(".config/opencode/skills/notes")).unwrap();
    fs::create_dir_all(home.join(".pi/agent/skills/notes")).unwrap();
    fs::create_dir_all(home.join(".omp/agent/skills/notes")).unwrap();
    fs::create_dir_all(home.join(".omp/agent/skills/blocked")).unwrap();
    let body = skill_page("notes");
    fs::write(home.join(".codex/skills/notes/SKILL.md"), &body).unwrap();
    fs::write(home.join(".config/opencode/skills/notes/SKILL.md"), &body).unwrap();
    fs::write(home.join(".pi/agent/skills/notes/SKILL.md"), &body).unwrap();
    fs::write(home.join(".omp/agent/skills/notes/SKILL.md"), &body).unwrap();
    fs::write(home.join(".omp/agent/skills/blocked/SKILL.md"), "---\nname: blocked\ndescription: Stopped in the skill file\nenabled: false\n---\nSKILL-BODY-KEEP\n").unwrap();
    fs::write(home.join(".codex/config.toml"), "# keep-codex\nmodel = \"kept\"\n").unwrap();
    fs::write(home.join(".config/opencode/opencode.json"), "{\n  // keep-opencode\n  \"permission\": { \"bash\": \"allow\" }\n}\n").unwrap();
    fs::write(home.join(".pi/agent/settings.json"), "{\n  // keep-pi\n  \"theme\": \"light\"\n}\n").unwrap();
    fs::write(home.join(".omp/agent/config.yml"), "# keep-omp\ntheme: dark\ndisabledExtensions:\n  - other\n").unwrap();
    let _home = var_guard("AWB_RESOURCE_HOME", home.to_str().unwrap());
    let (bench, _) = workbench(&root);
    let toggle = |agent: &str, enabled: bool| {
        let listed = bench.dispatch("resources:list", &[json!("skills"), json!(agent), json!(1), json!("")]).unwrap();
        let item = listed["items"].as_array().unwrap().iter().find(|item| item["name"] == "notes").unwrap().clone();
        bench.dispatch("resources:toggle", &[json!("skills"), json!(agent), item, json!(enabled)]).unwrap();
    };
    toggle("codex", false);
    let codex = fs::read_to_string(home.join(".codex/config.toml")).unwrap();
    assert!(codex.contains("# keep-codex") && codex.contains("model = \"kept\""), "{codex}");
    assert!(codex.contains("[[skills.config]]") && codex.contains("enabled = false"), "{codex}");
    assert!(!home.join(".codex/skills/notes/SKILL.md.awb-disabled").exists());
    assert_eq!(fs::read_to_string(home.join(".codex/skills/notes/SKILL.md")).unwrap(), body);
    let codex_list = bench.dispatch("resources:list", &[json!("skills"), json!("codex"), json!(1), json!("")]).unwrap();
    assert_eq!(codex_list["items"].as_array().unwrap().iter().find(|item| item["name"] == "notes").unwrap()["enabled"], false);
    toggle("codex", true);
    assert!(fs::read_to_string(home.join(".codex/config.toml")).unwrap().contains("enabled = true"));
    assert_eq!(fs::read_to_string(home.join(".codex/skills/notes/SKILL.md")).unwrap(), body);

    toggle("opencode", false);
    let opencode = fs::read_to_string(home.join(".config/opencode/opencode.json")).unwrap();
    assert!(opencode.contains("// keep-opencode") && opencode.contains("\"bash\": \"allow\""), "{opencode}");
    assert!(opencode.contains("\"notes\"") && opencode.contains("\"deny\""), "{opencode}");
    assert!(!home.join(".config/opencode/skills/notes/SKILL.md.awb-disabled").exists());
    assert_eq!(fs::read_to_string(home.join(".config/opencode/skills/notes/SKILL.md")).unwrap(), body);
    toggle("opencode", true);
    assert!(fs::read_to_string(home.join(".config/opencode/opencode.json")).unwrap().contains("\"allow\""));

    fs::write(home.join(".config/opencode/opencode.json"), "{\n  \"providers\": {},\n  \"permissions\": [{ \"action\": \"skill\", \"resource\": \"other\", \"effect\": \"allow\" }]\n}\n").unwrap();
    toggle("opencode", false);
    let v2 = fs::read_to_string(home.join(".config/opencode/opencode.json")).unwrap();
    assert!(v2.contains("\"resource\": \"notes\"") || v2.contains("\"resource\":\"notes\""), "{v2}");
    assert!(v2.contains("\"deny\""), "{v2}");
    assert_eq!(fs::read_to_string(home.join(".config/opencode/skills/notes/SKILL.md")).unwrap(), body);
    fs::write(home.join(".config/opencode/opencode.json"), "{\n  \"providers\": {},\n  \"permissions\": \"nope\"\n}\n").unwrap();
    let invalid = bench.dispatch("resources:list", &[json!("skills"), json!("opencode"), json!(1), json!("")]).unwrap_err();
    assert!(invalid.contains("OpenCode V2 permissions 必须是数组"), "{invalid}");
    assert_eq!(fs::read_to_string(home.join(".config/opencode/skills/notes/SKILL.md")).unwrap(), body);
    fs::write(home.join(".config/opencode/opencode.json"), "{\n  // keep-opencode\n  \"permission\": { \"bash\": \"allow\" }\n}\n").unwrap();

    toggle("pi", false);
    let pi = fs::read_to_string(home.join(".pi/agent/settings.json")).unwrap();
    assert!(pi.contains("// keep-pi") && pi.contains("\"theme\": \"light\""), "{pi}");
    // The override names the skill file by its path, with separators escaped
    // in the JSON text; read the values back rather than compare the text.
    let skill_file = home.join(".pi").join("agent").join("skills").join("notes").join("SKILL.md");
    let settings_text = pi.lines().filter(|line| !line.trim_start().starts_with("//")).collect::<Vec<_>>().join("\n");
    let disabled: Vec<String> = serde_json::from_str::<serde_json::Value>(&settings_text).unwrap()["skills"].as_array().unwrap().iter().map(|item| item.as_str().unwrap().to_string()).collect();
    assert_eq!(disabled, vec![format!("-{}", skill_file.display())], "{pi}");
    assert!(!home.join(".pi/agent/skills/notes/SKILL.md.awb-disabled").exists());
    assert_eq!(fs::read_to_string(home.join(".pi/agent/skills/notes/SKILL.md")).unwrap(), body);
    let pi_list = bench.dispatch("resources:list", &[json!("skills"), json!("pi"), json!(1), json!("")]).unwrap();
    assert_eq!(pi_list["items"].as_array().unwrap().iter().find(|item| item["name"] == "notes").unwrap()["enabled"], false);
    toggle("pi", true);
    assert!(!fs::read_to_string(home.join(".pi/agent/settings.json")).unwrap().contains(".awb-disabled"));

    toggle("omp", false);
    let omp = fs::read_to_string(home.join(".omp/agent/config.yml")).unwrap();
    assert!(omp.contains("# keep-omp") && omp.contains("theme: dark") && omp.contains("skill:notes"), "{omp}");
    assert!(!home.join(".omp/agent/skills/notes/SKILL.md.awb-disabled").exists());
    assert_eq!(fs::read_to_string(home.join(".omp/agent/skills/notes/SKILL.md")).unwrap(), body);
    let omp_list = bench.dispatch("resources:list", &[json!("skills"), json!("omp"), json!(1), json!("")]).unwrap();
    assert_eq!(omp_list["items"].as_array().unwrap().iter().find(|item| item["name"] == "notes").unwrap()["enabled"], false);
    let blocked = omp_list["items"].as_array().unwrap().iter().find(|item| item["name"] == "blocked").unwrap().clone();
    let refused = bench.dispatch("resources:toggle", &[json!("skills"), json!("omp"), blocked, json!(true)]).unwrap_err();
    assert!(refused.contains("此 Skill 受 Oh My Pi 全局筛选或 SKILL.md 停用限制"), "{refused}");
    assert_eq!(fs::read_to_string(home.join(".omp/agent/skills/blocked/SKILL.md")).unwrap().contains("enabled: false"), true);
    assert_eq!(fs::read_to_string(home.join(".omp/agent/config.yml")).unwrap(), omp);
    toggle("omp", true);
    assert!(!fs::read_to_string(home.join(".omp/agent/config.yml")).unwrap().contains("skill:notes"));
    assert_eq!(fs::read_to_string(home.join(".omp/agent/skills/notes/SKILL.md")).unwrap(), body);
    let _ = fs::remove_dir_all(root);
}

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Condvar;

/// A stand-in for the shell's hidden renderer. It records what it was asked,
/// can be told to hang, fail or answer at once, and counts its resets.
struct StandIn {
    asked: Mutex<Vec<String>>,
    mode: Mutex<&'static str>,
    resets: AtomicU64,
    /// Set while a render is hanging; the test waits for it before cancelling,
    /// so the cancel always meets a render that has already begun.
    hanging: (Mutex<usize>, Condvar),
    /// Counts resets. A hanging render returns once the count moves past the
    /// value it started with, so a reset never has to be undone.
    resets_seen: (Mutex<u64>, Condvar),
}

impl StandIn {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            asked: Mutex::new(Vec::new()),
            mode: Mutex::new("ok"),
            resets: AtomicU64::new(0),
            hanging: (Mutex::new(0), Condvar::new()),
            resets_seen: (Mutex::new(0), Condvar::new()),
        })
    }
}

impl pello_core::preview::DiagramRenderer for StandIn {
    fn render(&self, source: &str, generation: u64) -> Result<String, String> {
        self.asked.lock().unwrap().push(source.to_string());
        match *self.mode.lock().unwrap() {
            "fail" => Err("renderer broke".into()),
            // Hangs until a reset lets it go, the way a window that stopped
            // answering does; the generation it started with is now obsolete.
            "hang" => {
                let before = *self.resets_seen.0.lock().unwrap();
                {
                    let mut hanging = self.hanging.0.lock().unwrap();
                    *hanging += 1;
                    self.hanging.1.notify_all();
                }
                let moved = self.resets_seen.1
                    .wait_timeout_while(self.resets_seen.0.lock().unwrap(), Duration::from_secs(10), |seen| *seen == before)
                    .unwrap()
                    .0;
                *self.hanging.0.lock().unwrap() -= 1;
                if *moved == before { return Err("the stand-in was never reset".into()) }
                Err(format!("abandoned at generation {generation}"))
            }
            _ => Ok(format!("<svg>{source}</svg>")),
        }
    }

    fn reset(&self) {
        self.resets.fetch_add(1, Ordering::SeqCst);
        *self.resets_seen.0.lock().unwrap() += 1;
        self.resets_seen.1.notify_all();
    }
}

/// The rules around a diagram that do not depend on the window that draws it,
/// the ones the Electron build keeps in `renderMermaid`: a limit on the size,
/// a cache per source, a cancel that reaches the renderer, and no result kept
/// from a renderer that failed. Without a renderer the message is clear; no
/// browser is looked for on the system.
#[test]
fn diagrams_are_limited_cached_cancelled_and_need_the_shell_renderer() {
    let root = temp_dir("diagrams");
    let (bench, _) = workbench(&root);
    let unavailable = bench.dispatch("diagram:mermaid", &[json!("flowchart TD\nA-->B")]).unwrap_err();
    assert!(unavailable.contains("图表渲染器不可用"), "{unavailable}");

    let stand_in = StandIn::new();
    bench.set_diagram_renderer(stand_in.clone());
    let asked = |stand_in: &Arc<StandIn>| stand_in.asked.lock().unwrap().clone();

    // Too large or empty: refused before the renderer is involved. Both
    // break the same rule, so the message names the limit for either.
    let oversized = bench.dispatch("diagram:mermaid", &[json!("x".repeat(100_001))]).unwrap_err();
    assert!(oversized.contains("100000"), "{oversized}");
    assert!(bench.dispatch("diagram:mermaid", &[json!("   ")]).unwrap_err().contains("100000"));
    assert!(asked(&stand_in).is_empty(), "{:?}", asked(&stand_in));

    // The same source is drawn once and answered from the cache afterwards.
    let source = "flowchart TD\nA[Hello]-->B[World]";
    let first = bench.dispatch("diagram:mermaid", &[json!(source)]).unwrap();
    assert_eq!(first, json!(format!("<svg>{source}</svg>")));
    let again = bench.dispatch("diagram:mermaid", &[json!(source)]).unwrap();
    assert_eq!(again, first);
    assert_eq!(asked(&stand_in), vec![source.to_string()]);

    // A renderer that fails returns its error and leaves nothing in the cache.
    *stand_in.mode.lock().unwrap() = "fail";
    let broken = bench.dispatch("diagram:mermaid", &[json!("pie\n\"a\": 1")]).unwrap_err();
    assert_eq!(broken, "renderer broke");
    assert_eq!(stand_in.resets.load(Ordering::SeqCst), 0, "a failure is not a cancel");

    // A cancel reaches the renderer and reports the diagram as cancelled.
    *stand_in.mode.lock().unwrap() = "hang";
    let before = asked(&stand_in).len();
    std::thread::scope(|scope| {
        let handle = scope.spawn(|| bench.dispatch("diagram:mermaid", &[json!("sequenceDiagram\nA->>B: hi")]));
        // Only a render that is already hanging is cancelled; a cancel that
        // runs first would be refused before the renderer is involved.
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while *stand_in.hanging.0.lock().unwrap() == 0 && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(*stand_in.hanging.0.lock().unwrap(), 1, "the renderer was not asked to draw");
        bench.dispatch("diagram:cancel", &[]).unwrap();
        let cancelled = handle.join().unwrap().unwrap_err();
        assert!(cancelled.contains("取消"), "{cancelled}");
    });
    assert_eq!(asked(&stand_in).len(), before + 1);
    assert_eq!(stand_in.resets.load(Ordering::SeqCst), 1, "the renderer in flight is reset");
    assert_eq!(*stand_in.hanging.0.lock().unwrap(), 0, "the hanging render returned");

    // What was cancelled is not kept; a later diagram works again.
    *stand_in.mode.lock().unwrap() = "ok";
    let after = bench.dispatch("diagram:mermaid", &[json!("graph LR\nC --> D")]).unwrap();
    assert!(after.as_str().unwrap().contains("<svg>"), "{after}");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn updates_stay_manual_and_keep_install_data() {
    let _lock = env_lock();
    let root = temp_dir("updates");
    let feed = root.join("feed");
    fs::create_dir_all(&feed).unwrap();
    fs::write(feed.join("latest.yml"), "version: 2.0.0\npath: Pello-2.0.0-win-x64-setup.exe\n").unwrap();
    fs::write(feed.join("Pello-2.0.0-win-x64-setup.exe"), b"installer-bytes").unwrap();
    fs::write(feed.join("Pello-2.0.0-win-x64-setup.exe.blockmap"), b"blockmap-bytes").unwrap();
    let _feed = var_guard("AWB_UPDATE_FEED", feed.to_str().unwrap());
    let _version = var_guard("AWB_APP_VERSION", "1.0.0");
    let (bench, events) = workbench(&root);
    fs::write(root.join("pello.config.json"), "{}\n").unwrap();
    fs::write(root.join("data").join("keep.txt"), "keep-data").unwrap();
    assert_eq!(bench.dispatch("app:update-state", &[]).unwrap()["phase"], "idle");
    assert!(!bench.poll_updates(14_999));
    assert_eq!(bench.update_automatic_checks(), 0);
    assert!(bench.poll_updates(15_000));
    let state = bench.dispatch("app:update-state", &[]).unwrap();
    assert_eq!(state["phase"], "available");
    assert_eq!(state["version"], "2.0.0");
    assert!(!root.join("data/updates/Pello-2.0.0-win-x64-setup.exe").exists(), "automatic checks do not download");
    assert!(!bench.update_installs_on_quit());
    let mut settings = bench.dispatch("db:get", &[]).unwrap()["db"]["settings"].clone();
    settings["autoCheckUpdates"] = json!(false);
    bench.dispatch("db:settings", &[settings]).unwrap();
    assert!(!bench.poll_updates(15_000 + 6 * 60 * 60 * 1000));
    assert_eq!(bench.update_automatic_checks(), 1);
    let manual = bench.dispatch("app:update-check", &[]).unwrap();
    assert_eq!(manual["phase"], "available");
    assert_eq!(bench.update_automatic_checks(), 1);
    fs::rename(feed.join("Pello-2.0.0-win-x64-setup.exe"), feed.join("missing.exe")).unwrap();
    let failed = bench.dispatch("app:update-download", &[]).unwrap();
    assert_eq!(failed["phase"], "error");
    assert_eq!(failed["failed"], "download");
    fs::rename(feed.join("missing.exe"), feed.join("Pello-2.0.0-win-x64-setup.exe")).unwrap();
    let downloaded = bench.dispatch("app:update-download", &[]).unwrap();
    assert_eq!(downloaded["phase"], "downloaded");
    assert_eq!(fs::read(root.join("data/updates/Pello-2.0.0-win-x64-setup.exe")).unwrap(), b"installer-bytes");
    assert_eq!(fs::read(root.join("data/updates/Pello-2.0.0-win-x64-setup.exe.blockmap")).unwrap(), b"blockmap-bytes");
    assert!(events.lock().unwrap().iter().any(|event| event["channel"] == "app:update" && event["payload"]["percent"] == 100));
    bench.dispatch("files:dirty", &[json!(true)]).unwrap();
    assert!(!bench.dispatch("app:update-install", &[]).unwrap().as_bool().unwrap());
    bench.dispatch("files:dirty", &[json!(false)]).unwrap();
    assert!(bench.dispatch("app:update-install", &[]).unwrap().as_bool().unwrap());
    assert!(!bench.update_installs_on_quit());
    assert_eq!(fs::read_to_string(root.join("data/keep.txt")).unwrap(), "keep-data");
    assert!(root.join("pello.config.json").is_file());
    assert!(root.join("data/updates/install-requested").is_file());
    let (reloaded, _) = workbench(&root);
    assert_eq!(reloaded.dispatch("db:get", &[]).unwrap()["db"]["settings"]["autoCheckUpdates"], false);
    assert!(!reloaded.poll_updates(1_000_000));
    assert_eq!(reloaded.update_automatic_checks(), 0);
    assert_eq!(reloaded.dispatch("app:update-check", &[]).unwrap()["phase"], "available");
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let nsh = fs::read_to_string(repo.join("assets/installer.nsh")).unwrap();
    assert!(nsh.contains("$R1 != \"data\"") && nsh.contains("pello.config.json"), "{nsh}");
    let builder = fs::read_to_string(repo.join("electron-builder.yml")).unwrap();
    assert!(builder.contains("provider: github") && builder.contains("differentialPackage: true"), "{builder}");
    assert!(builder.contains("deleteAppDataOnUninstall: false") && builder.contains("setup.${ext}"), "{builder}");
    let settings_ui = fs::read_to_string(repo.join("src/renderer/AppUpdate.tsx")).unwrap();
    assert!(settings_ui.contains("app-update-settings") && settings_ui.contains("自动检查更新"));
    assert!(settings_ui.contains("检查更新") && settings_ui.contains("下载最新版本") && settings_ui.contains("安装并重启"));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn agent_resume_uses_each_terminals_session_and_exports_full_history() {
    let _lock = env_lock();
    let root = temp_dir("resume");
    let home = root.join("home");
    let project = root.join("project");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&project).unwrap();
    let _home = var_guard("HOME", home.to_str().unwrap());
    let _resource = var_guard("AWB_RESOURCE_HOME", home.to_str().unwrap());
    let (bench, _) = workbench(&root);
    bench.dispatch("db:projects", &[json!([{ "id": "p", "name": "P", "host": "local", "path": project.display().to_string(), "branch": "", "agent": "shell" }])]).unwrap();
    bench.dispatch("db:sessions", &[json!("p"), json!([
        { "id": "t-claude", "kind": "claude", "shell": "bash", "sessionId": "g1", "agentSessionId": "claude-real" },
        { "id": "t-codex", "kind": "codex", "shell": "bash", "sessionId": "g2", "agentSessionId": "codex-real" },
        { "id": "t-open", "kind": "opencode", "shell": "bash", "sessionId": "g1", "agentSessionId": "open-real" },
        { "id": "t-pi", "kind": "pi", "shell": "bash", "sessionId": "g2", "agentSessionId": "pi-real" },
        { "id": "t-omp", "kind": "omp", "shell": "bash", "sessionId": "g1", "agentSessionId": "omp-real" }
    ]), json!("t-claude"), json!([{ "id": "g1", "name": "一组" }, { "id": "g2", "name": "二组" }]), json!("g1")]).unwrap();
    let saved = bench.dispatch("db:get", &[]).unwrap();
    assert_eq!(saved["db"]["workSessions"]["p"].as_array().unwrap().len(), 2);
    let groups = saved["db"].to_string();
    assert!(groups.contains("一组") && groups.contains("二组") && groups.contains("claude-real") && groups.contains("codex-real"), "{groups}");
    let claude = bench.dispatch("pty:create", &[json!({ "id": "t-claude", "projectId": "p", "kind": "claude", "shell": "bash", "agentSessionId": "claude-real" })]).unwrap();
    let codex = bench.dispatch("pty:create", &[json!({ "id": "t-codex", "projectId": "p", "kind": "codex", "shell": "bash", "agentSessionId": "codex-real" })]).unwrap();
    let open = bench.dispatch("pty:create", &[json!({ "id": "t-open", "projectId": "p", "kind": "opencode", "shell": "bash", "agentSessionId": "open-real" })]).unwrap();
    let pi = bench.dispatch("pty:create", &[json!({ "id": "t-pi", "projectId": "p", "kind": "pi", "shell": "bash", "agentSessionId": "pi-real" })]).unwrap();
    let omp = bench.dispatch("pty:create", &[json!({ "id": "t-omp", "projectId": "p", "kind": "omp", "shell": "bash", "agentSessionId": "omp-real" })]).unwrap();
    assert!(claude["launchCommand"].as_str().unwrap().contains("--resume") && claude["launchCommand"].as_str().unwrap().contains("claude-real"), "{}", claude["launchCommand"]);
    assert!(!claude["launchCommand"].as_str().unwrap().contains("codex-real"));
    assert!(codex["launchCommand"].as_str().unwrap().contains("resume") && codex["launchCommand"].as_str().unwrap().contains("codex-real") && codex["launchCommand"].as_str().unwrap().contains("--no-daemon"), "{}", codex["launchCommand"]);
    assert!(open["launchCommand"].as_str().unwrap().contains("--session") && open["launchCommand"].as_str().unwrap().contains("open-real"), "{}", open["launchCommand"]);
    assert!(pi["launchCommand"].as_str().unwrap().contains("--session") && pi["launchCommand"].as_str().unwrap().contains("pi-real"), "{}", pi["launchCommand"]);
    assert!(omp["launchCommand"].as_str().unwrap().contains("--resume") && omp["launchCommand"].as_str().unwrap().contains("omp-real"), "{}", omp["launchCommand"]);
    let fresh_pi = bench.dispatch("pty:create", &[json!({ "id": "t-pi-new", "projectId": "p", "kind": "pi", "shell": "bash" })]).unwrap();
    let fresh_omp = bench.dispatch("pty:create", &[json!({ "id": "t-omp-new", "projectId": "p", "kind": "omp", "shell": "bash" })]).unwrap();
    let pi_dir = root.join("data/agent-sessions").join(pello_core::pty::history_name("t-pi-new"));
    let omp_dir = root.join("data/agent-sessions").join(pello_core::pty::history_name("t-omp-new"));
    assert!(pi_dir.is_dir() && omp_dir.is_dir());
    // The shell is bash: the directory is spelled the way it reads a path.
    let pi_spelled = pi_dir.to_string_lossy().replace('\\', "/");
    let omp_spelled = omp_dir.to_string_lossy().replace('\\', "/");
    assert!(fresh_pi["launchCommand"].as_str().unwrap().contains("--session-dir") && fresh_pi["launchCommand"].as_str().unwrap().contains(&pi_spelled), "{}", fresh_pi["launchCommand"]);
    assert!(fresh_omp["launchCommand"].as_str().unwrap().contains(&omp_spelled), "{}", fresh_omp["launchCommand"]);
    assert_eq!(fresh_pi["agentSessionId"], "pello:directory");
    assert!(!fresh_pi["launchCommand"].as_str().unwrap().contains("pi-real"));
    assert!(!home.join(".pi").exists() && !home.join(".omp").exists() && !home.join(".codex").exists() && !home.join(".claude").exists());
    let fresh_claude = bench.dispatch("pty:create", &[json!({ "id": "t-claude-new", "projectId": "p", "kind": "claude", "shell": "bash" })]).unwrap();
    let fresh_open = bench.dispatch("pty:create", &[json!({ "id": "t-open-new", "projectId": "p", "kind": "opencode", "shell": "bash" })]).unwrap();
    assert!(fresh_claude["launchCommand"].as_str().unwrap().contains("--session-id"), "{}", fresh_claude["launchCommand"]);
    assert!(fresh_open["launchCommand"].as_str().unwrap().starts_with("opencode --session "), "{}", fresh_open["launchCommand"]);
    assert_ne!(fresh_claude["agentSessionId"], "claude-real");
    assert!(!fresh_open["agentSessionId"].as_str().unwrap().contains("open-real"));
    let marker = "FULL-HISTORY-MARKER-";
    let payload = marker.repeat(4_000);
    bench.dispatch("pty:feed", &[json!("t-claude"), json!(payload)]).unwrap();
    bench.dispatch("pty:feed", &[json!("t-codex"), json!("OTHER-TERMINAL")] ).unwrap();
    let exported = root.join("exported.ansi");
    bench.dispatch("terminal:export", &[json!("t-claude"), json!(exported.display().to_string())]).unwrap();
    let text = fs::read_to_string(&exported).unwrap();
    assert!(text.contains(&payload) && !text.contains("OTHER-TERMINAL"), "the export keeps the whole recording");
    assert!(root.join("data/terminal-history").join(format!("{}.ansi", pello_core::pty::history_name("t-codex"))).is_file());
    for id in ["t-claude", "t-codex", "t-open", "t-pi", "t-omp", "t-pi-new", "t-omp-new", "t-claude-new", "t-open-new"] {
        bench.dispatch("pty:close", &[json!(id)]).unwrap();
    }
    let _ = fs::remove_dir_all(root);
}

#[test]
fn content_search_regex_matches_javascript_and_stays_off_the_command_line() {
    let _lock = env_lock();
    let root = temp_dir("js-search");
    let project = root.join("project");
    fs::create_dir_all(project.join("src")).unwrap();
    fs::write(project.join("src/note.txt"), "汉字 keeps Pello\n第二行 #token\n").unwrap();
    fs::write(project.join("src/slow.txt"), format!("{}!\n", "a".repeat(28))).unwrap();
    let (bench, _) = workbench(&root);
    bench.dispatch("db:projects", &[json!([{ "id": "p", "name": "P", "host": "local", "path": project.display().to_string(), "branch": "", "agent": "shell" }])]).unwrap();
    // A search runs in this process; the query never becomes a command line.
    let query = "UNIQUE_QUERY_TOKEN";
    bench.dispatch("content:search-start", &[json!("p"), json!("plain"), json!(query), json!(true), json!(true), json!(false)]).unwrap();
    assert!(!pello_core::search::remote_content_shell().contains(query));
    bench.dispatch("content:search-start", &[json!("p"), json!("han"), json!(r"\p{Script=Han}+"), json!(true), json!(true), json!(false)]).unwrap();
    let (han, _) = drain_content(&bench, "han");
    assert!(han.iter().any(|item| item["matches"].as_array().unwrap().iter().any(|found| found["match"] == "汉字")), "{han:?}");
    bench.dispatch("content:search-start", &[json!("p"), json!("look"), json!(r"(?<=#)\w+"), json!(true), json!(true), json!(false)]).unwrap();
    let (look, _) = drain_content(&bench, "look");
    assert!(look.iter().any(|item| item["matches"].as_array().unwrap().iter().any(|found| found["match"] == "token")), "{look:?}");
    // An unfinished class is invalid in every regex engine; `a++` is not.
    let invalid = bench.dispatch("content:search-start", &[json!("p"), json!("plus"), json!("["), json!(true), json!(true), json!(false)]).unwrap_err();
    assert!(invalid.contains("正则表达式无效"), "{invalid}");
    bench.dispatch("db:settings", &[json!({ "language": "en" })]).unwrap();
    assert_eq!(bench.dispatch("content:search-start", &[json!("p"), json!("plus-en"), json!("["), json!(true), json!(true), json!(false)]).unwrap_err(), "Invalid regular expression");
    bench.dispatch("db:settings", &[json!({ "language": "zh-CN" })]).unwrap();
    // A lookahead keeps the engine on its backtracking path, where this
    // pattern outruns any budget; plain nested quantifiers are settled by the
    // engine's linear pre-filter and never reach it.
    bench.dispatch("content:search-start", &[json!("p"), json!("slow"), json!("(?=a)(a|aa)+$"), json!(true), json!(true), json!(false)]).unwrap();
    // The slow file may wait for a later batch; a batch never holds the
    // error back once the file is reached.
    let mut timed = String::new();
    for _ in 0..20 {
        match bench.dispatch("content:search-next", &[json!("slow")]) {
            Err(error) => { timed = error; break }
            Ok(batch) => assert_ne!(batch["done"], true, "the search finished without reporting the timeout: {batch}"),
        }
    }
    assert!(timed.contains("正则表达式执行超时"), "{timed}");
    // The Linux remote script answers a syntax error and a timeout as JSON on
    // its own, before the workbench translates it.
    #[cfg(unix)]
    {
    let remote_root = root.join("remote-project");
    fs::create_dir_all(&remote_root).unwrap();
    fs::write(remote_root.join("note.txt"), "Pello remote\n").unwrap();
    let mut child = std::process::Command::new("python3");
    child.arg("-u").arg("-c").arg(pello_core::search::LINUX_CONTENT_SEARCH);
    child.stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped());
    let mut child = child.spawn().unwrap();
    let payload = json!({ "root": remote_root.display().to_string(), "query": "(?<=#bad", "sensitive": true, "regex": true, "whole": false, "ignored": [] }).to_string();
    assert!(!child.stdin.is_none());
    use std::io::Write;
    child.stdin.as_mut().unwrap().write_all(payload.as_bytes()).unwrap();
    drop(child.stdin.take());
    let output = child.wait_with_output().unwrap();
    let text = String::from_utf8_lossy(&output.stdout);
    assert!(text.contains("\"error\": \"invalid\"") || text.contains("\"error\":\"invalid\""), "{text}");
    let message = match pello_core::search::ContentSearch::from_remote_output("p", "id", &text, "zh-CN") { Err(error) => error, Ok(_) => panic!("remote syntax error was accepted") };
    assert!(message.contains("正则表达式无效"), "{message}");
    let mut slow = std::process::Command::new("python3");
    slow.arg("-u").arg("-c").arg(pello_core::search::LINUX_CONTENT_SEARCH);
    slow.stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped());
    let mut slow = slow.spawn().unwrap();
    fs::write(remote_root.join("slow.txt"), format!("{}!\n", "a".repeat(28))).unwrap();
    let slow_payload = json!({ "root": remote_root.display().to_string(), "query": "(a+)+$", "sensitive": true, "regex": true, "whole": false, "ignored": [] }).to_string();
    assert!(!format!("python3 -u -c").contains("(a+)+$"));
    slow.stdin.as_mut().unwrap().write_all(slow_payload.as_bytes()).unwrap();
    drop(slow.stdin.take());
    let slow_output = slow.wait_with_output().unwrap();
    let slow_text = String::from_utf8_lossy(&slow_output.stdout);
    assert!(slow_text.contains("timeout"), "{slow_text}");
    let slow_message = match pello_core::search::ContentSearch::from_remote_output("p", "id", &slow_text, "en") { Err(error) => error, Ok(_) => panic!("remote timeout was accepted") };
    assert_eq!(slow_message, "Regular expression timed out. Simplify the expression.");
    }
    let _ = fs::remove_dir_all(root);
}

fn wait_upload(events: &Arc<Mutex<Vec<serde_json::Value>>>, id: &str, state: &str) -> serde_json::Value {
    let deadline = std::time::Instant::now() + Duration::from_secs(8);
    loop {
        let found = events.lock().unwrap().iter().rev().find(|event| event["channel"] == "transfer:update" && event["payload"]["id"] == id && event["payload"]["state"] == state).cloned();
        if let Some(found) = found { return found; }
        if std::time::Instant::now() > deadline { panic!("upload {id} did not reach {state}: {:?}", events.lock().unwrap()); }
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
#[cfg(unix)]
fn upload_replaces_same_names_after_staging_and_keeps_the_source() {
    let _lock = env_lock();
    let root = temp_dir("upload");
    let project = root.join("project");
    let sources = root.join("sources");
    fs::create_dir_all(project.join("same folder")).unwrap();
    fs::write(project.join("same.txt"), "old file").unwrap();
    fs::write(project.join("same folder/note.txt"), "old note").unwrap();
    fs::write(project.join("same folder/old-only.txt"), "old-only").unwrap();
    fs::create_dir_all(sources.join("same folder/empty")).unwrap();
    fs::write(sources.join("same.txt"), "new file").unwrap();
    fs::write(sources.join("same folder/note.txt"), "new note 中文").unwrap();
    symlink(&sources.join("same.txt"), sources.join("link.txt")).unwrap();
    let home = root.join("home");
    fs::create_dir_all(home.join(".ssh")).unwrap();
    fs::write(home.join(".ssh/id_ed25519"), "-----BEGIN OPENSSH PRIVATE KEY-----\nUPLOADKEY\n-----END OPENSSH PRIVATE KEY-----\n").unwrap();
    let (shim, log) = install_ssh_shim(&root);
    let sock = root.join("agent.sock");
    let agent = fake_agent(&sock);
    let _env = ssh_env(&home, &shim, &log, &agent);
    let hold = root.join("hold");
    let publish = root.join("publish");
    let _hold = var_guard("AWB_UPLOAD_HOLD", hold.to_str().unwrap());
    let _publish = var_guard("AWB_UPLOAD_PUBLISH_HOLD", publish.to_str().unwrap());
    let (bench, events) = workbench(&root);
    let local = bench.dispatch("db:get", &[]).unwrap()["db"]["hosts"][0].clone();
    bench.dispatch("db:hosts", &[json!([local, { "id": "remote", "name": "Remote", "addr": "127.0.0.1", "port": 22, "user": "up", "auth": "key", "on": true, "platform": "linux" }])]).unwrap();
    bench.dispatch("db:projects", &[json!([{ "id": "p", "name": "Upload", "host": "remote", "path": project.display().to_string(), "branch": "", "agent": "shell" }])]).unwrap();
    let project_before = bench.dispatch("db:get", &[]).unwrap()["db"]["projects"].clone();
    bench.dispatch("files:dirty", &[json!(true)]).unwrap();
    let denied = bench.dispatch("transfer:drop", &[json!("p"), json!(""), json!([sources.join("same.txt").display().to_string()])]).unwrap();
    let denied_id = denied.as_str().unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(8);
    while !events.lock().unwrap().iter().any(|event| event["channel"] == "file:replacement" && event["payload"]["id"] == denied_id) {
        if std::time::Instant::now() > deadline { panic!("missing draft confirmation"); }
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(fs::read_to_string(project.join("same.txt")).unwrap(), "old file");
    assert!(fs::read_dir(&project).unwrap().flatten().all(|entry| !entry.file_name().to_string_lossy().starts_with(".awb-upload-")));
    bench.dispatch("file:replacement-ready", &[json!(denied_id), json!(false)]).unwrap();
    let denied_done = wait_upload(&events, denied_id, "cancelled");
    assert!(denied_done["payload"]["state"] != "conflicts");
    assert_eq!(fs::read_to_string(project.join("same.txt")).unwrap(), "old file");
    bench.dispatch("files:dirty", &[json!(false)]).unwrap();
    let folder = bench.dispatch("transfer:drop", &[json!("p"), json!(""), json!([sources.join("same folder").display().to_string(), sources.join("same.txt").display().to_string()])]).unwrap();
    let folder_id = folder.as_str().unwrap().to_string();
    let ready = hold.with_extension("ready");
    let deadline = std::time::Instant::now() + Duration::from_secs(8);
    while !ready.exists() {
        if std::time::Instant::now() > deadline { panic!("stage was not published to a temporary directory: {}", fs::read_to_string(&log).unwrap_or_default()); }
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(fs::read_to_string(project.join("same folder/old-only.txt")).unwrap(), "old-only");
    assert_eq!(fs::read_to_string(sources.join("same folder/note.txt")).unwrap(), "new note 中文");
    assert!(fs::read_dir(&project).unwrap().flatten().any(|entry| entry.file_name().to_string_lossy().starts_with(".awb-upload-tree-")));
    let publishing = publish.with_extension("publishing");
    fs::write(hold.with_extension("go"), "1").unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(8);
    while !publishing.exists() {
        if std::time::Instant::now() > deadline { panic!("publish phase did not start"); }
        std::thread::sleep(Duration::from_millis(20));
    }
    let blocked = bench.dispatch("transfer:cancel", &[json!(folder_id)]).unwrap_err();
    assert!(blocked.contains("正在完成上传"), "{blocked}");
    assert_eq!(fs::read_to_string(project.join("same folder/old-only.txt")).unwrap(), "old-only");
    fs::write(publish.with_extension("go"), "1").unwrap();
    let done = wait_upload(&events, &folder_id, "completed");
    assert_eq!(done["payload"]["phase"], "done");
    assert_eq!(done["payload"]["successDismissMs"], 2000);
    assert!(done["payload"]["items"].as_array().unwrap().iter().all(|item| item["status"] == "done"));
    assert!(events.lock().unwrap().iter().all(|event| event["payload"]["state"] != "conflicts"));
    assert_eq!(fs::read_to_string(project.join("same.txt")).unwrap(), "new file");
    assert_eq!(fs::read_to_string(project.join("same folder/note.txt")).unwrap(), "new note 中文");
    assert!(!project.join("same folder/old-only.txt").exists());
    assert!(project.join("same folder/empty").is_dir());
    assert_eq!(fs::read_to_string(sources.join("same.txt")).unwrap(), "new file");
    let _ = fs::remove_file(&ready);
    let _ = fs::remove_file(hold.with_extension("go"));
    let _ = fs::remove_file(&publishing);
    let _ = fs::remove_file(publish.with_extension("go"));
    let again = bench.dispatch("transfer:drop", &[json!("p"), json!(""), json!([sources.join("same.txt").display().to_string()])]).unwrap();
    let again_id = again.as_str().unwrap().to_string();
    let deadline = std::time::Instant::now() + Duration::from_secs(8);
    while !ready.exists() {
        if std::time::Instant::now() > deadline { panic!("second stage missing"); }
        std::thread::sleep(Duration::from_millis(20));
    }
    fs::write(project.join("same.txt"), "changed during upload").unwrap();
    fs::write(hold.with_extension("go"), "1").unwrap();
    fs::write(publish.with_extension("go"), "1").unwrap();
    let failed = wait_upload(&events, &again_id, "completed");
    assert_eq!(failed["payload"]["items"][0]["status"], "failed");
    assert!(failed["payload"]["items"][0]["error"].as_str().unwrap().contains("原对象已保留"), "{failed}");
    assert_eq!(fs::read_to_string(project.join("same.txt")).unwrap(), "changed during upload");
    assert!(fs::read_dir(&project).unwrap().flatten().all(|entry| !entry.file_name().to_string_lossy().starts_with(".awb-upload-")));
    let root_error = bench.dispatch("transfer:drop", &[json!("p"), json!(".."), json!([sources.join("same.txt").display().to_string()])]).unwrap_err();
    assert!(root_error.contains("不能替换项目根目录"), "{root_error}");
    let link_id = bench.dispatch("transfer:drop", &[json!("p"), json!(""), json!([sources.join("link.txt").display().to_string()])]).unwrap();
    let link_done = wait_upload(&events, link_id.as_str().unwrap(), "completed");
    assert!(link_done["payload"]["items"][0]["error"].as_str().unwrap().contains("不上传符号链接"));
    assert_eq!(fs::read_to_string(project.join("same.txt")).unwrap(), "changed during upload");
    let conflict = bench.dispatch("transfer:decide", &[json!("x"), json!("skip"), json!(false)]).unwrap_err();
    assert!(conflict.contains("不再询问同名处理"), "{conflict}");
    assert_eq!(bench.dispatch("db:get", &[]).unwrap()["db"]["projects"], project_before);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn native_menu_translates_labels_and_project_actions_keep_the_record() {
    let _lock = env_lock();
    let root = temp_dir("menu");
    let project = root.join("项目");
    fs::create_dir_all(&project).unwrap();
    let (bench, _) = workbench(&root);
    bench.dispatch("db:projects", &[json!([{ "id": "p", "name": "P", "host": "local", "path": project.display().to_string(), "branch": "", "agent": "shell" }])]).unwrap();
    bench.dispatch("db:sessions", &[json!("p"), json!([{ "id": "term-1", "kind": "shell", "shell": "bash" }]), json!("term-1"), json!([]), json!("")]).unwrap();
    let saved = bench.dispatch("db:get", &[]).unwrap()["db"].clone();
    let menu = bench.dispatch("menu:project", &[json!("p")]).unwrap();
    let labels: Vec<String> = menu.as_array().unwrap().iter().map(|item| item["label"].as_str().unwrap().to_string()).collect();
    assert!(labels.iter().any(|label| label == "复制路径"));
    assert!(labels.iter().any(|label| label == "在资源管理器中打开"));
    assert!(labels.iter().all(|label| label != "新建文件" && label != "新建文件夹"));
    assert!(menu.as_array().unwrap().iter().all(|item| item["id"] != "create-file" && item["id"] != "create-directory"));
    let app = bench.dispatch("menu:app", &[]).unwrap();
    assert_eq!(app[0]["label"], "文件");
    let mut settings = saved["settings"].clone();
    settings["language"] = json!("en");
    bench.dispatch("db:settings", &[settings]).unwrap();
    let english = bench.dispatch("menu:project", &[json!("p")]).unwrap();
    assert!(english.as_array().unwrap().iter().any(|item| item["label"] == "Copy path"));
    assert_eq!(bench.dispatch("menu:app", &[]).unwrap()[0]["label"], "File");
    let copied = bench.dispatch("tree:action", &[json!("p"), json!(""), json!(true), json!("copy-full")]).unwrap();
    assert_eq!(copied.as_str().unwrap(), pello_core::real_path(&project).unwrap().to_str().unwrap());
    let open_log = root.join("open.log");
    let save_log = root.join("save.log");
    let save_path = root.join("history.ansi");
    let _open_bin = var_guard("AWB_OPEN_BIN", "true");
    let _open_log = var_guard("AWB_OPEN_LOG", open_log.to_str().unwrap());
    let _save_path = var_guard("AWB_SAVE_PATH", save_path.to_str().unwrap());
    let _save_log = var_guard("AWB_SAVE_LOG", save_log.to_str().unwrap());
    bench.dispatch("tree:action", &[json!("p"), json!(""), json!(true), json!("reveal")]).unwrap();
    assert_eq!(fs::read_to_string(&open_log).unwrap(), pello_core::real_path(&project).unwrap().display().to_string());
    let history = root.join("data/terminal-history").join(format!("{}.ansi", pello_core::pty::history_name("term-1")));
    fs::create_dir_all(history.parent().unwrap()).unwrap();
    fs::write(&history, "recorded-history").unwrap();
    bench.dispatch("terminal:export", &[json!("term-1")]).unwrap();
    assert_eq!(fs::read_to_string(&save_path).unwrap(), "recorded-history");
    let dialog = fs::read_to_string(&save_log).unwrap();
    assert!(dialog.contains("ANSI terminal history") && dialog.contains("terminal-history.ansi"), "{dialog}");
    let create = bench.dispatch("tree:action", &[json!("p"), json!(""), json!(true), json!("create-file")]).unwrap_err();
    assert!(create.contains("does not create") || create.contains("不提供新建"), "{create}");
    let after = bench.dispatch("db:get", &[]).unwrap()["db"]["projects"].clone();
    assert_eq!(after[0]["path"], project.display().to_string());
    assert_eq!(after[0]["name"], "P");
    assert_eq!(after[0]["host"], "local");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn windows_shutdown_kills_descendants_before_serial_roots() {
    use pello_core::pty::{shutdown_is_serial, windows_shutdown_plan, ProcessRow, ShutdownStep};
    let rows = [
        ProcessRow { pid: 2, parent: 1 },
        ProcessRow { pid: 3, parent: 2 },
        ProcessRow { pid: 4, parent: 1 },
        ProcessRow { pid: 6, parent: 5 },
    ];
    let steps = windows_shutdown_plan(&rows, &[1, 5], true);
    assert_eq!(steps, vec![
        ShutdownStep::KillDescendant(3),
        ShutdownStep::KillDescendant(2),
        ShutdownStep::KillDescendant(4),
        ShutdownStep::KillDescendant(6),
        ShutdownStep::EndRoot(1),
        ShutdownStep::WaitNativeExit(1),
        ShutdownStep::EndRoot(5),
        ShutdownStep::WaitNativeExit(5),
    ]);
    assert!(shutdown_is_serial(&steps));
    let fallback = windows_shutdown_plan(&rows, &[1, 5], false);
    assert_eq!(fallback, vec![ShutdownStep::EndRoot(1), ShutdownStep::WaitNativeExit(1), ShutdownStep::EndRoot(5), ShutdownStep::WaitNativeExit(5)]);
    assert!(shutdown_is_serial(&fallback));
    assert!(steps.iter().all(|step| !matches!(step, ShutdownStep::EndRoot(_) if false)));
}

#[test]
#[cfg(unix)]
fn remote_directory_picker_ignores_stale_listings_and_blocks_confirm_on_error() {
    let _lock = env_lock();
    let root = temp_dir("picker");
    let project = root.join("remote-root");
    fs::create_dir_all(project.join("alpha")).unwrap();
    fs::create_dir_all(project.join("beta")).unwrap();
    let home = root.join("home");
    fs::create_dir_all(home.join(".ssh")).unwrap();
    fs::write(home.join(".ssh/id_ed25519"), "-----BEGIN OPENSSH PRIVATE KEY-----\nPICKERKEY\n-----END OPENSSH PRIVATE KEY-----\n").unwrap();
    let (shim, log) = install_ssh_shim(&root);
    let sock = root.join("agent.sock");
    let agent = fake_agent(&sock);
    let _env = ssh_env(&home, &shim, &log, &agent);
    let (bench, _) = workbench(&root);
    let local = bench.dispatch("db:get", &[]).unwrap()["db"]["hosts"][0].clone();
    bench.dispatch("db:hosts", &[json!([local, { "id": "remote", "name": "Remote", "addr": "127.0.0.1", "port": 22, "user": "pick", "auth": "key", "on": true, "platform": "linux" }])]).unwrap();
    bench.dispatch("db:projects", &[json!([{ "id": "p", "name": "P", "host": "remote", "path": project.display().to_string(), "branch": "", "agent": "shell" }])]).unwrap();
    let opened = bench.dispatch("dialog:picker", &[json!({ "op": "open", "hostId": "remote", "initial": project.display().to_string(), "formPath": "/keep/this" })]).unwrap();
    assert_eq!(opened["canConfirm"], true, "{opened}");
    assert!(opened["dirs"].as_array().unwrap().iter().any(|entry| entry["name"] == "alpha"), "{opened}");
    let id = opened["id"].as_str().unwrap();
    let selected = bench.dispatch("dialog:picker", &[json!({ "op": "click", "id": id, "path": project.join("alpha").display().to_string() })]).unwrap();
    assert_eq!(selected["selected"], project.join("alpha").display().to_string());
    assert_eq!(selected["path"], opened["path"]);
    let entered = bench.dispatch("dialog:picker", &[json!({ "op": "enter", "id": id, "path": project.join("beta").display().to_string() })]).unwrap();
    assert!(entered["path"].as_str().unwrap().ends_with("beta"), "{entered}");
    assert_eq!(entered["canBack"], true);
    let back = bench.dispatch("dialog:picker", &[json!({ "op": "back", "id": id })]).unwrap();
    assert!(back["path"].as_str().unwrap().ends_with("remote-root"), "{back}");
    let forward = bench.dispatch("dialog:picker", &[json!({ "op": "forward", "id": id })]).unwrap();
    assert!(forward["path"].as_str().unwrap().ends_with("beta"), "{forward}");
    let parent = bench.dispatch("dialog:picker", &[json!({ "op": "parent", "id": id })]).unwrap();
    assert!(parent["path"].as_str().unwrap().ends_with("remote-root"), "{parent}");
    let filtered = bench.dispatch("dialog:picker", &[json!({ "op": "filter", "id": id, "query": "alp" })]).unwrap();
    assert!(filtered["dirs"].as_array().unwrap().iter().all(|entry| entry["name"].as_str().unwrap().contains("alp")), "{filtered}");
    let generation = filtered["generation"].as_u64().unwrap();
    let begun = bench.dispatch("dialog:picker", &[json!({ "op": "begin", "id": id, "path": "/first" })]).unwrap();
    let newer = bench.dispatch("dialog:picker", &[json!({ "op": "begin", "id": id, "path": "/second" })]).unwrap();
    assert!(newer["generation"].as_u64().unwrap() > begun["generation"].as_u64().unwrap());
    let stale = bench.dispatch("dialog:picker", &[json!({ "op": "apply", "id": id, "generation": generation, "listing": { "path": "/stale", "parent": "/", "dirs": [], "error": "" } })]).unwrap();
    assert_eq!(stale["address"], "/second");
    assert_eq!(stale["loading"], true);
    let failed = bench.dispatch("dialog:picker", &[json!({ "op": "apply", "id": id, "generation": newer["generation"].as_u64().unwrap(), "listing": { "path": "/second", "parent": "/", "dirs": [], "error": "无法读取目录" } })]).unwrap();
    assert_eq!(failed["canConfirm"], false, "{failed}");
    assert_eq!(failed["error"], "无法读取目录");
    let closed = bench.dispatch("dialog:picker", &[json!({ "op": "esc", "id": id })]).unwrap();
    assert_eq!(closed["closed"], true);
    assert_eq!(closed["formPath"], "/keep/this");
    let projects = bench.dispatch("db:get", &[]).unwrap()["db"]["projects"].clone();
    assert_eq!(projects[0]["path"], project.display().to_string());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn windows_remote_scripts_translate_only_the_fixed_errors() {
    let _lock = env_lock();
    let root = temp_dir("win-scripts");
    let home = root.join("home");
    fs::create_dir_all(home.join(".ssh")).unwrap();
    fs::write(home.join(".ssh/id_ed25519"), "-----BEGIN OPENSSH PRIVATE KEY-----\nWINKEYMATERIAL\n-----END OPENSSH PRIVATE KEY-----\n").unwrap();
    let (shim, log) = install_ssh_shim(&root);
    let sock = root.join("agent.sock");
    let agent = fake_agent(&sock);
    let _env = ssh_env(&home, &shim, &log, &agent);
    let _os = var_guard("AWB_SSH_OS", "Windows_NT");
    let (bench, _) = workbench(&root);
    let local = bench.dispatch("db:get", &[]).unwrap()["db"]["hosts"][0].clone();
    bench.dispatch("db:hosts", &[json!([local, { "id": "win", "name": "Win", "addr": "127.0.0.1", "port": 22, "user": "win", "auth": "key", "password": "do-not-leak" }])]).unwrap();
    bench.dispatch("db:projects", &[json!([{ "id": "p", "name": "P", "host": "win", "path": "C:\\项目", "branch": "", "agent": "shell" }])]).unwrap();
    bench.dispatch("tree:create", &[json!("p"), json!("O'Brien"), json!("note.txt"), json!(false)]).unwrap();
    bench.dispatch("tree:rename", &[json!("p"), json!("O'Brien/note.txt"), json!("next.txt"), json!(false)]).unwrap();
    bench.dispatch("tree:move", &[json!("p"), json!("O'Brien/note.txt"), json!("dest"), json!(false)]).unwrap();
    let _ = bench.dispatch("git:read", &[json!("p"), json!("O'Brien/note.txt")]);
    let _ = bench.dispatch("git:write", &[json!("p"), json!("O'Brien/note.txt"), json!("hello"), json!("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")]);
    let _ = bench.dispatch("git:tree", &[json!("p"), json!("O'Brien")]);
    let _ = bench.dispatch("path:list", &[json!("win"), json!("C:\\项目")]);
    bench.dispatch("content:search-start", &[json!("p"), json!("search-win"), json!("UNIQUE_QUERY_值"), json!(true), json!(true), json!(false)]).unwrap();
    let mut settings = bench.dispatch("db:get", &[]).unwrap()["db"]["settings"].clone();
    settings["language"] = json!("en");
    bench.dispatch("db:settings", &[settings]).unwrap();
    bench.dispatch("tree:create", &[json!("p"), json!("O'Brien"), json!("note.txt"), json!(false)]).unwrap();
    let scripts: Vec<String> = parse_ssh_calls(&fs::read_to_string(&log).unwrap()).iter().filter_map(|call| call.args.last().and_then(|arg| pello_core::ssh::decode_powershell_command(arg))).collect();
    assert!(scripts.len() >= 8, "count={} first={}", scripts.len(), scripts.first().map(|script| script.chars().take(180).collect::<String>()).unwrap_or_default());
    let joined = scripts.join("\n");
    assert!(joined.contains("Get-Item") && joined.contains("Join-Path") && (joined.contains("New-Item") || joined.contains("[IO.File]::Open")) && joined.contains("Get-ChildItem"), "flags item={} join={} child={} lens={:?}", joined.contains("Get-Item"), joined.contains("Join-Path"), joined.contains("Get-ChildItem"), scripts.iter().map(|script| script.len()).collect::<Vec<_>>());
    assert!(joined.contains("[IO.File]::Move") || joined.contains("[IO.Directory]::Move") || joined.contains("[IO.File]::Replace") || joined.contains("[IO.File]::Open"));
    assert!(joined.contains("O''Brien") && joined.contains("C:\\项目"));
    assert!(joined.contains("不支持链接目录") || joined.contains("Linked directories are not supported"));
    assert!(scripts.iter().any(|script| script.contains("不支持链接目录") && !script.contains("Linked directories")));
    assert!(scripts.last().unwrap().contains("Linked directories are not supported") && !scripts.last().unwrap().contains("不支持链接目录"));
    let search = scripts.iter().find(|script| script.contains("FromMilliseconds(500)")).expect("content search script");
    assert!(!search.contains("UNIQUE_QUERY_值"), "{search}");
    assert!(search.contains("Get-ChildItem") && search.contains("ConvertFrom-Json") && search.contains("[Console]::In.ReadToEnd()"));
    assert!(!joined.contains("do-not-leak") && !joined.contains("WINKEYMATERIAL"));
    let _ = fs::remove_dir_all(root);
}

fn assert_implemented(value: Result<serde_json::Value, String>) -> serde_json::Value {
    match value {
        Ok(value) => value,
        Err(error) => {
            assert!(!error.contains("尚未在 Rust 移植中实现") && !error.contains("尚未实现"), "{error}");
            panic!("{error}");
        }
    }
}

#[test]
fn wired_channels_do_real_work() {
    let _lock = env_lock();
    let root = temp_dir("wired");
    let project = root.join("project");
    let remote_root = root.join("remote");
    fs::create_dir_all(project.join("docs")).unwrap();
    fs::create_dir_all(&remote_root).unwrap();
    fs::write(project.join("docs/page.html"), "<p>hello</p>").unwrap();
    fs::write(project.join("docs/note.txt"), "quoted").unwrap();
    fs::write(remote_root.join("payload.txt"), "remote-bytes").unwrap();
    let source = root.join("incoming.txt");
    fs::write(&source, "picked").unwrap();
    let home = root.join("home");
    fs::create_dir_all(home.join(".ssh")).unwrap();
    fs::write(home.join(".ssh/id_ed25519"), "-----BEGIN OPENSSH PRIVATE KEY-----\nWIREKEY\n-----END OPENSSH PRIVATE KEY-----\n").unwrap();
    let (shim, log) = install_ssh_shim(&root);
    let sock = root.join("agent.sock");
    let agent = fake_agent(&sock);
    let _env = ssh_env(&home, &shim, &log, &agent);
    let save = root.join("saved-payload.txt");
    let open_log = root.join("open.log");
    let _save = var_guard("AWB_SAVE_PATH", save.to_str().unwrap());
    let _open_log = var_guard("AWB_OPEN_LOG", open_log.to_str().unwrap());
    let _open_bin = var_guard("AWB_OPEN_BIN", "true");
    let _pick = var_guard("AWB_PICK_PATHS", source.to_str().unwrap());
    let (bench, _) = workbench(&root);
    let local = bench.dispatch("db:get", &[]).unwrap()["db"]["hosts"][0].clone();
    bench.dispatch("db:hosts", &[json!([local, { "id": "remote", "name": "Remote", "addr": "127.0.0.1", "port": 22, "user": "wire", "auth": "key", "on": true, "platform": "linux" }])]).unwrap();
    bench.dispatch("db:projects", &[json!([
        { "id": "p", "name": "P", "host": "local", "path": project.display().to_string(), "branch": "", "agent": "shell" },
        { "id": "r", "name": "R", "host": "remote", "path": remote_root.display().to_string(), "branch": "", "agent": "shell" }
    ])]).unwrap();
    bench.dispatch("db:custom", &[json!([{ "id": "mine", "name": "Mine", "command": "echo" }])]).unwrap();
    let picked = assert_implemented(bench.dispatch("transfer:pick", &[json!("p"), json!(""), json!("files")]));
    assert!(picked.as_str().is_some(), "{picked}");
    // A Linux remote cannot be reached from a Windows host; the download must
    // report the failure rather than claim a file.
    #[cfg(windows)]
    {
        let failed = bench.dispatch("transfer:download", &[json!("r"), json!("payload.txt"), json!(false)]).unwrap_err();
        assert!(!failed.is_empty(), "a download that cannot run must not succeed");
    }
    #[cfg(unix)]
    let downloaded = assert_implemented(bench.dispatch("transfer:download", &[json!("r"), json!("payload.txt"), json!(false)]));
    #[cfg(unix)]
    assert_eq!(fs::read_to_string(downloaded.as_str().unwrap()).unwrap(), "remote-bytes");
    let opened = assert_implemented(bench.dispatch("file:open-html", &[json!("p"), json!("docs/page.html")]));
    assert!(opened.as_str().unwrap_or("").contains("page.html"), "{opened}");
    assert!(fs::read_to_string(&open_log).unwrap().contains("page.html"));
    let linked = assert_implemented(bench.dispatch("file:link", &[json!("p"), json!("docs/page.html"), json!("note.txt#part")]));
    assert_eq!(linked["path"], "docs/note.txt");
    assert_eq!(linked["anchor"], "part");
    let external = assert_implemented(bench.dispatch("file:link", &[json!("p"), json!("docs/page.html"), json!("https://example.com/docs")]));
    assert!(external.is_null());
    let quoted = assert_implemented(bench.dispatch("tree:reference", &[json!("p"), json!("docs/note.txt"), json!("shell"), json!("bash")]));
    assert!(quoted.as_str().unwrap_or("").contains("note.txt"), "{quoted}");
    let resource = assert_implemented(bench.dispatch("resources:pick", &[json!("config")]));
    assert_eq!(resource, json!(source.display().to_string()));
    // A resource path must be absolute in the host's own terms.
    let (mcp_path, skill_path) = (root.join("mcp.json").display().to_string(), root.join("skills").display().to_string());
    assert_implemented(bench.dispatch("resources:target", &[json!({ "id": "mine", "mcpPath": mcp_path, "skillPath": skill_path, "format": "standard" })]));
    // The record is JSON, where a path's separators are escaped; read it back.
    assert!(fs::read_to_string(root.join("data/resource-targets.json")).unwrap().contains(&mcp_path.replace('\\', "\\\\")));
    let builtin = bench.dispatch("resources:target", &[json!({ "id": "claude", "mcpPath": mcp_path, "format": "standard" })]).unwrap_err();
    assert!(builtin.contains("仅自定义 Agent"));
    let flushed = assert_implemented(bench.dispatch("terminal:history-flushed", &[]));
    assert!(flushed.is_null());
    let rejected = bench.dispatch("file:open-html", &[json!("p"), json!("docs/note.txt")]).unwrap_err();
    assert!(!rejected.contains("尚未"), "{rejected}");
    let _ = fs::remove_dir_all(root);
}

#[test]
#[cfg(unix)]
fn linux_remote_create_rename_and_move() {
    let _lock = env_lock();
    let root = temp_dir("linux-tree");
    let project = root.join("project");
    fs::create_dir_all(&project).unwrap();
    let home = root.join("home");
    fs::create_dir_all(home.join(".ssh")).unwrap();
    fs::write(home.join(".ssh/id_ed25519"), "-----BEGIN OPENSSH PRIVATE KEY-----\nTREEKEY\n-----END OPENSSH PRIVATE KEY-----\n").unwrap();
    let (shim, log) = install_ssh_shim(&root);
    let sock = root.join("agent.sock");
    let agent = fake_agent(&sock);
    let _env = ssh_env(&home, &shim, &log, &agent);
    let (bench, _) = workbench(&root);
    let local = bench.dispatch("db:get", &[]).unwrap()["db"]["hosts"][0].clone();
    bench.dispatch("db:hosts", &[json!([local, { "id": "remote", "name": "Remote", "addr": "127.0.0.1", "port": 22, "user": "tree", "auth": "key", "on": true, "platform": "linux" }])]).unwrap();
    bench.dispatch("db:projects", &[json!([{ "id": "p", "name": "P", "host": "remote", "path": project.display().to_string(), "branch": "", "agent": "shell" }])]).unwrap();
    let created = assert_implemented(bench.dispatch("tree:create", &[json!("p"), json!(""), json!("note.txt"), json!(false)]));
    assert_eq!(created, json!("note.txt"));
    assert!(project.join("note.txt").is_file());
    let renamed = assert_implemented(bench.dispatch("tree:rename", &[json!("p"), json!("note.txt"), json!("renamed.txt"), json!(false)]));
    assert_eq!(renamed, json!("renamed.txt"));
    assert!(project.join("renamed.txt").is_file());
    assert_implemented(bench.dispatch("tree:create", &[json!("p"), json!(""), json!("box"), json!(true)]));
    let moved = assert_implemented(bench.dispatch("tree:move", &[json!("p"), json!("renamed.txt"), json!("box"), json!(false)]));
    assert_eq!(moved, json!("box/renamed.txt"));
    assert!(project.join("box/renamed.txt").is_file());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn windows_remote_upload_publishes_with_powershell_and_keeps_the_old_directory() {
    let _lock = env_lock();
    let root = temp_dir("win-upload");
    let project = root.join("project");
    let sources = root.join("sources");
    fs::create_dir_all(project.join("same folder")).unwrap();
    fs::write(project.join("same folder/old-only.txt"), "keep-me").unwrap();
    fs::create_dir_all(sources.join("same folder")).unwrap();
    fs::write(sources.join("same folder/note.txt"), "new").unwrap();
    let home = root.join("home");
    fs::create_dir_all(home.join(".ssh")).unwrap();
    fs::write(home.join(".ssh/id_ed25519"), "-----BEGIN OPENSSH PRIVATE KEY-----\nWINUPKEY\n-----END OPENSSH PRIVATE KEY-----\n").unwrap();
    let (shim, log) = install_ssh_shim(&root);
    let sock = root.join("agent.sock");
    let agent = fake_agent(&sock);
    let _env = ssh_env(&home, &shim, &log, &agent);
    let hold = root.join("hold");
    let _os = var_guard("AWB_SSH_OS", "Windows_NT");
    let _hold = var_guard("AWB_UPLOAD_HOLD", hold.to_str().unwrap());
    let (bench, events) = workbench(&root);
    let local = bench.dispatch("db:get", &[]).unwrap()["db"]["hosts"][0].clone();
    bench.dispatch("db:hosts", &[json!([local, { "id": "remote", "name": "Remote", "addr": "127.0.0.1", "port": 22, "user": "up", "auth": "key", "on": true, "platform": "windows" }])]).unwrap();
    bench.dispatch("db:projects", &[json!([{ "id": "p", "name": "P", "host": "remote", "path": project.display().to_string(), "branch": "", "agent": "shell" }])]).unwrap();
    let started = assert_implemented(bench.dispatch("transfer:drop", &[json!("p"), json!(""), json!([sources.join("same folder").display().to_string()])]));
    let id = started.as_str().unwrap().to_string();
    let ready = hold.with_extension("ready");
    // Before the upload waits here, a Windows remote has started PowerShell
    // twice over ssh, to ask whether the target exists and then to stage.
    // Each start costs a second or two, more when the machine is busy, so
    // the same eight seconds as the POSIX case would at times run out while
    // the staging was still going.
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    while !ready.exists() {
        if std::time::Instant::now() > deadline {
            let last = events.lock().unwrap().iter().rev().find(|event| event["channel"] == "transfer:update" && event["payload"]["id"] == id).map(|event| event["payload"].to_string()).unwrap_or_default();
            panic!("stage did not finish: {last}");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(fs::read_to_string(project.join("same folder/old-only.txt")).unwrap(), "keep-me");
    fs::write(hold.with_extension("cancel"), "1").unwrap();
    let done = wait_upload(&events, &id, "cancelled");
    assert_eq!(done["payload"]["phase"], "cancelled");
    assert_eq!(fs::read_to_string(project.join("same folder/old-only.txt")).unwrap(), "keep-me");
    assert!(fs::read_dir(&project).unwrap().flatten().all(|entry| !entry.file_name().to_string_lossy().starts_with(".awb-upload-")));
    let scripts: Vec<String> = parse_ssh_calls(&fs::read_to_string(&log).unwrap()).iter().filter_map(|call| call.args.last().and_then(|arg| pello_core::ssh::decode_powershell_command(arg))).collect();
    let joined = scripts.join("\n");
    assert!(joined.contains("Get-AwbEntryVersion") && joined.contains("Move-AwbEntry") && joined.contains("Remove-AwbStage"), "decoded={} log={}", scripts.len(), fs::read_to_string(&log).unwrap_or_default().chars().take(500).collect::<String>());
    assert!(!joined.contains("python3 -c"), "{joined}");
    let _ = fs::remove_dir_all(root);
}

/// POSIX: a background job under the shell, found through the parent
/// chain. Windows has no such chain for a Git Bash job, so it has its own
/// case below with a tree that can be told apart.
#[test]
#[cfg(unix)]
fn pty_close_kills_the_leaf_before_the_root() {
    let root = temp_dir("close-order");
    let project = root.join("project");
    fs::create_dir_all(&project).unwrap();
    let log = root.join("shutdown.log");
    // The log is named by an environment variable, which is the whole process's:
    // tests that set it run one at a time.
    let _lock = env_lock();
    let _log = var_guard("AWB_SHUTDOWN_LOG", log.to_str().unwrap());
    let (bench, _) = workbench(&root);
    bench.dispatch("db:projects", &[json!([{ "id": "p", "name": "P", "host": "local", "path": project.display().to_string(), "branch": "", "agent": "shell" }])]).unwrap();
    let info = bench.dispatch("pty:create", &[json!({ "id": "term-close", "projectId": "p", "kind": "shell", "shell": "bash" })]).unwrap();
    let root_pid = info["rootPid"].as_u64().unwrap() as u32;
    wait_terminal(&bench, "term-close", true, "idle");
    bench.dispatch("pty:write", &[json!("term-close"), json!("sleep 40 &\n"), json!(false)]).unwrap();
    let sleep_pid = wait_descendant(root_pid, "sleep");
    bench.dispatch("pty:close", &[json!("term-close")]).unwrap();
    let text = fs::read_to_string(&log).unwrap_or_default();
    let kill_at = text.find(&format!("kill {sleep_pid}")).unwrap_or_else(|| panic!("missing leaf kill:\n{text}"));
    let end_at = text.find(&format!("end {root_pid}")).unwrap_or_else(|| panic!("missing root end:\n{text}"));
    let wait_at = text.find(&format!("wait {root_pid}")).unwrap_or_else(|| panic!("missing native wait:\n{text}"));
    assert!(kill_at < end_at && end_at < wait_at, "{text}");
    assert!(!process_alive(sleep_pid), "the leaf outlived the terminal");
    assert!(bench.dispatch("pty:snapshot", &[json!("term-close")]).unwrap().is_null());
    let _ = fs::remove_dir_all(root);
}

/// Windows: closing every terminal at once reads the process table once. Each
/// read starts a shell and takes longer than a second, so one per terminal is
/// seconds per terminal when the window closes on many. The descendants of
/// all terminals end before the first root, and none outlives the closing.
#[test]
#[cfg(windows)]
fn closing_the_workbench_takes_one_process_snapshot_for_every_terminal() {
    let root = temp_dir("close-all");
    let project = root.join("project");
    fs::create_dir_all(&project).unwrap();
    let log = root.join("shutdown.log");
    // The log is named by an environment variable, which is the whole process's:
    // tests that set it run one at a time.
    let _lock = env_lock();
    let _log = var_guard("AWB_SHUTDOWN_LOG", log.to_str().unwrap());
    let (bench, _) = workbench(&root);
    bench.dispatch("db:projects", &[json!([{ "id": "p", "name": "P", "host": "local", "path": project.display().to_string(), "branch": "", "agent": "shell" }])]).unwrap();
    let fixture = PathBuf::from(env!("CARGO_BIN_EXE_awb-session-tree"));
    // One executor per terminal, each running the tree fixture on its own pid
    // file, as three terminals of one Agent would each run their own process.
    let executors: Vec<serde_json::Value> = (0..3).map(|index| {
        let pid_file = root.join(format!("close-all-pids-{index}.txt"));
        json!({ "id": format!("tree-{index}"), "name": "Tree", "cmd": shell_word(&fixture), "args": shell_word(&pid_file), "shell": "bash" })
    }).collect();
    bench.dispatch("db:custom", &[json!(executors)]).unwrap();
    let mut roots = Vec::new();
    let mut pid_files = Vec::new();
    for index in 0..3 {
        let pid_file = root.join(format!("close-all-pids-{index}.txt"));
        pid_files.push(pid_file.clone());
        let info = bench.dispatch("pty:create", &[json!({ "id": format!("term-all-{index}"), "projectId": "p", "kind": format!("tree-{index}"), "shell": "bash" })]).unwrap();
        roots.push(info["rootPid"].as_u64().unwrap() as u32);
    }
    // Every tree is up before the closing, so each has leaves to be ended.
    for pid_file in &pid_files { wait_tree(pid_file, &root); }
    bench.shutdown_sessions();
    let text = fs::read_to_string(&log).unwrap_or_default();
    // Whatever the assertions find, the trees must not outlive the test.
    for pid_file in &pid_files { end_tree(pid_file); }
    let _ = fs::remove_dir_all(root);
    let snapshots = text.lines().filter(|line| *line == "snapshot").count();
    assert_eq!(snapshots, 1, "closing three terminals read the process table {snapshots} times:\n{text}");
    let lines: Vec<&str> = text.lines().collect();
    let first_end = lines.iter().position(|line| line.starts_with("end ")).unwrap_or_else(|| panic!("no root was ended:\n{text}"));
    let kills: Vec<usize> = lines.iter().enumerate().filter(|(_, line)| line.starts_with("kill ")).map(|(at, _)| at).collect();
    assert!(!kills.is_empty(), "no descendant was ended:\n{text}");
    assert!(kills.iter().all(|at| *at < first_end), "a descendant was ended after the first root:\n{text}");
    for pid in roots {
        assert!(!process_alive(pid), "root {pid} outlived the closing:\n{text}");
    }
}

/// Windows: closing ends the leaves first and the root last, and leaves
/// nothing behind. The tree is the detached three-level one of the Electron
/// shutdown regression (`session-tree.cjs`): its pids come from the file the
/// fixture writes, so a broken lookup in the product cannot hide behind itself.
#[test]
#[cfg(windows)]
fn pty_close_ends_a_detached_tree_leaf_first_and_quickly() {
    let root = temp_dir("close-tree");
    let project = root.join("project");
    fs::create_dir_all(&project).unwrap();
    let log = root.join("shutdown.log");
    // The log is named by an environment variable, which is the whole process's:
    // tests that set it run one at a time.
    let _lock = env_lock();
    let _log = var_guard("AWB_SHUTDOWN_LOG", log.to_str().unwrap());
    let (bench, _) = workbench(&root);
    bench.dispatch("db:projects", &[json!([{ "id": "p", "name": "P", "host": "local", "path": project.display().to_string(), "branch": "", "agent": "shell" }])]).unwrap();
    let pid_file = root.join("tree-pids.txt");
    let fixture = PathBuf::from(env!("CARGO_BIN_EXE_awb-session-tree"));
    bench.dispatch("db:custom", &[json!([{ "id": "tree", "name": "Tree", "cmd": shell_word(&fixture), "args": shell_word(&pid_file) }])]).unwrap();
    let info = bench.dispatch("pty:create", &[json!({ "id": "term-close", "projectId": "p", "kind": "tree", "shell": "bash" })]).unwrap();
    let root_pid = info["rootPid"].as_u64().unwrap() as u32;
    let leaves = wait_tree(&pid_file, &root);
    let started = std::time::Instant::now();
    bench.dispatch("pty:close", &[json!("term-close")]).unwrap();
    let close_ms = started.elapsed().as_millis();
    let text = fs::read_to_string(&log).unwrap_or_default();
    // Whatever the assertions find, the tree must not outlive the test.
    let left: Vec<u32> = leaves.iter().copied().filter(|pid| process_alive(*pid)).collect();
    end_tree(&pid_file);
    let end_at = text.find(&format!("end {root_pid}")).unwrap_or_else(|| panic!("missing root end:\n{text}"));
    let wait_at = text.find(&format!("wait {root_pid}")).unwrap_or_else(|| panic!("missing native wait:\n{text}"));
    assert!(end_at < wait_at, "{text}");
    // Every leaf the snapshot found ends before the root. One it missed is
    // still gone afterwards, so a missing `kill` line is not a failure alone.
    for pid in &leaves {
        if let Some(at) = text.find(&format!("kill {pid}\n")) {
            assert!(at < end_at, "leaf {pid} ended after the root:\n{text}");
        }
    }
    assert!(left.is_empty(), "leaves outlived the terminal: {left:?}\n{text}");
    assert!(!process_alive(root_pid), "the root outlived the terminal:\n{text}");
    // One `taskkill` per leaf cost more than a second each; the Electron build
    // ends the leaves directly and closes a terminal in about a second.
    assert!(close_ms < 8000, "closing took {close_ms} ms:\n{text}");
    assert!(bench.dispatch("pty:snapshot", &[json!("term-close")]).unwrap().is_null());
    let _ = fs::remove_dir_all(root);
}

/// The pids the fixture noted, once all three are alive.
#[cfg(windows)]
fn wait_tree(pid_file: &Path, root: &Path) -> Vec<u32> {
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        let pids = tree_pids(pid_file);
        if pids.len() == 3 && pids.iter().all(|pid| process_alive(*pid)) { return pids }
        if std::time::Instant::now() > deadline {
            end_tree(pid_file);
            let _ = fs::remove_dir_all(root);
            panic!("the process tree did not start: {pids:?}");
        }
        std::thread::sleep(Duration::from_millis(40));
    }
}

#[cfg(windows)]
fn tree_pids(pid_file: &Path) -> Vec<u32> {
    fs::read_to_string(pid_file).unwrap_or_default().split_whitespace().filter_map(|pid| pid.parse().ok()).collect()
}

/// End whatever of the tree is still there, by pid file and by image, so a
/// failure cannot leave processes behind on the machine running the tests.
#[cfg(windows)]
fn end_tree(pid_file: &Path) {
    let pids = tree_pids(pid_file);
    for pid in &pids {
        if process_alive(*pid) { let _ = std::process::Command::new("taskkill").args(["/F", "/T", "/PID", &pid.to_string()]).output(); }
    }
    let _ = std::process::Command::new("taskkill").args(["/F", "/IM", "awb-session-tree.exe"]).output();
    for _ in 0..100 {
        if pids.iter().all(|pid| !process_alive(*pid)) { return }
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[cfg(unix)]
fn wait_descendant(root: u32, name: &str) -> u32 {
    let deadline = std::time::Instant::now() + Duration::from_secs(8);
    loop {
        if let Some(pid) = find_descendant(root, name) { return pid }
        if std::time::Instant::now() > deadline { panic!("no {name} under {root}") }
        std::thread::sleep(Duration::from_millis(40));
    }
}

/// The process table read independently of the workbench, as `pid, parent,
/// name` rows, so a broken lookup in the product cannot hide behind itself.
#[cfg(unix)]
fn process_rows() -> Vec<(u32, u32, String)> {
    #[cfg(unix)]
    {
        let mut rows = Vec::new();
        let Ok(entries) = fs::read_dir("/proc") else { return rows };
        for entry in entries.flatten() {
            let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else { continue };
            let Ok(stat) = fs::read_to_string(entry.path().join("stat")) else { continue };
            let Some(end) = stat.rfind(')') else { continue };
            let start = stat.find('(').unwrap_or(0);
            let mut fields = stat[end + 1..].split_whitespace();
            let _state = fields.next();
            let parent = fields.next().and_then(|value| value.parse().ok()).unwrap_or(0);
            rows.push((pid, parent, stat[start + 1..end].to_string()));
        }
        rows
    }
    #[cfg(windows)]
    {
        // Parent ids come from the one table that records them; names come
        // from a separate query so the two cannot agree by sharing a mistake.
        let query = r#"$p = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name; $n = Get-Process | Select-Object Id,ProcessName; [pscustomobject]@{ p = $p; n = $n } | ConvertTo-Json -Compress -Depth 4"#;
        let output = std::process::Command::new("powershell.exe").args(["-NoProfile", "-Command", query]).output().expect("the process table can be read");
        let value: serde_json::Value = serde_json::from_slice(&output.stdout).expect("the process table is JSON");
        let names: std::collections::HashMap<u64, String> = value["n"].as_array().into_iter().flatten()
            .filter_map(|row| Some((row["Id"].as_u64()?, row["ProcessName"].as_str()?.to_string()))).collect();
        value["p"].as_array().into_iter().flatten().filter_map(|row| {
            let pid = row["ProcessId"].as_u64()?;
            let parent = row["ParentProcessId"].as_u64()?;
            Some((pid as u32, parent as u32, names.get(&pid).cloned().unwrap_or_default()))
        }).collect()
    }
}

#[cfg(unix)]
fn find_descendant(root: u32, name: &str) -> Option<u32> {
    let mut children: std::collections::HashMap<u32, Vec<u32>> = std::collections::HashMap::new();
    let mut names = std::collections::HashMap::new();
    for (pid, parent, process) in process_rows() {
        names.insert(pid, process);
        children.entry(parent).or_default().push(pid);
    }
    let mut stack = children.get(&root).cloned().unwrap_or_default();
    while let Some(pid) = stack.pop() {
        if names.get(&pid).map(|value| value == name).unwrap_or(false) { return Some(pid) }
        stack.extend(children.get(&pid).cloned().unwrap_or_default());
    }
    None
}

/// True while the process still exists, asked of the system rather than of a
/// path under `/proc`.
fn process_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        Path::new(&format!("/proc/{pid}")).exists()
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{CloseHandle, WAIT_TIMEOUT};
        use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject};
        let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
        if handle.is_null() { return false }
        // With a zero wait this only asks whether the process has exited.
        let alive = unsafe { WaitForSingleObject(handle, 0) } == WAIT_TIMEOUT;
        unsafe { CloseHandle(handle) };
        alive
    }
}

#[test]
fn context_menus_return_real_items_and_startup_installs_the_bar() {
    let root = temp_dir("menus");
    let project = root.join("project");
    fs::create_dir_all(&project).unwrap();
    let (bench, _) = workbench(&root);
    bench.dispatch("db:projects", &[json!([{ "id": "p", "name": "P", "host": "local", "path": project.display().to_string(), "branch": "", "agent": "shell" }])]).unwrap();
    let tree = assert_implemented(bench.dispatch("tree:menu", &[json!("p"), json!(""), json!(true)]));
    assert!(tree.as_array().unwrap().iter().any(|item| item["id"] == "create-file"), "{tree}");
    let file = assert_implemented(bench.dispatch("file:menu", &[json!({ "visual": false, "undo": true, "redo": false, "editable": true })]));
    assert!(file.as_array().unwrap().iter().any(|item| item["id"] == "save"), "{file}");
    let terminal = assert_implemented(bench.dispatch("terminal:menu", &[json!({ "horizontal": true, "vertical": false, "merge": false })]));
    assert!(terminal.as_array().unwrap().iter().any(|item| item["id"] == "export-history"), "{terminal}");
    let shell = include_str!("../../src/lib.rs");
    assert!(shell.contains("install_app_menu"));
    assert!(shell.contains("app.set_menu"));
    assert!(shell.contains("try_recv()"));
    assert!(!shell.contains("from_secs(120)"));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn the_folder_dialog_is_the_system_one_for_a_local_project_and_the_page_picker_for_a_remote_one() {
    let _lock = env_lock();
    let root = temp_dir("picker-local");
    let project = root.join("project");
    fs::create_dir_all(project.join("alpha")).unwrap();
    let (bench, _) = workbench(&root);
    // A test names what the system dialog would have answered: a folder, or
    // nothing when it was dismissed. Either way that is the whole answer, and
    // no second picker is opened in its place.
    let chosen = project.display().to_string();
    let _answered = var_guard("AWB_DIRECTORY", &chosen);
    let picked = assert_implemented(bench.dispatch("dialog:directory", &[]));
    assert_eq!(picked.as_str().unwrap_or(""), chosen, "{picked}");
    drop(_answered);
    let _dismissed = var_guard("AWB_DIRECTORY", "");
    let picked = assert_implemented(bench.dispatch("dialog:directory", &[]));
    assert!(picked.is_null(), "{picked}");
    drop(_dismissed);
    // A local project's "browse" asks the system, as the Electron build's
    // dialog does; a remote machine's directory cannot be chosen that way, so
    // that one opens the page's own picker, which lists through `path:list`.
    let dialogs = include_str!("../../../src/renderer/Dialogs.tsx");
    assert!(dialogs.contains("window.awb.pickDirectory()"));
    let browse = dialogs.split("data-a=\"browse\"").nth(1).unwrap();
    let local_first = browse.find("host.id === 'local'").unwrap() < browse.find("setBrowsing(true)").unwrap();
    assert!(local_first, "the local case must come before the picker is opened");
    let browser = include_str!("../../../src/renderer/DirectoryBrowser.tsx");
    assert!(browser.contains("window.awb.listDir("));
    assert!(!browser.contains("window.awb.picker("));
    // The kernel's own picker is kept for Linux without a desktop dialog; on
    // the other systems the system dialog is asked instead.
    let workbench = include_str!("../src/workbench.rs");
    assert!(workbench.contains("rfd::FileDialog::new()"));
    assert!(workbench.contains("#[cfg(target_os = \"linux\")]"));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn pane_split_keeps_the_terminal_and_claude_gets_settings() {
    let root = temp_dir("split-settings");
    let project = root.join("project");
    fs::create_dir_all(&project).unwrap();
    let (bench, _) = workbench(&root);
    bench.dispatch("db:projects", &[json!([{ "id": "p", "name": "P", "host": "local", "path": project.display().to_string(), "branch": "", "agent": "claude" }])]).unwrap();
    let original = bench.dispatch("pty:create", &[json!({ "id": "term-split", "projectId": "p", "kind": "shell", "shell": "bash" })]).unwrap();
    let born = original["born"].clone();
    // A program in the terminal sees the variables the workbench sets for it.
    // The shell prints them, which holds for every shell the workbench starts.
    wait_terminal(&bench, "term-split", true, "idle");
    let shell = original["shell"].as_str().unwrap_or("bash").to_string();
    let print = if shell == "pwsh" { "Write-Output \"AWB_ENV:$env:PI_PROGRAM_STATUS\"
" } else { "echo AWB_ENV:$PI_PROGRAM_STATUS
" };
    bench.dispatch("pty:write", &[json!("term-split"), json!(print), json!(false)]).unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    let mut printed = String::new();
    while std::time::Instant::now() < deadline {
        printed = pello_core::pty::load_journal(&root.join("data"), "term-split");
        // The shell echoes the command, which holds the name and not the
        // value; the output is the second time the marker is printed.
        if printed.matches("AWB_ENV:").count() >= 2 { break }
        std::thread::sleep(Duration::from_millis(50));
    }
    // The value is the rest of the line the shell printed it on.
    let value = printed.rsplit("AWB_ENV:").next().unwrap_or("").lines().next().unwrap_or("").trim().to_string();
    assert_eq!(value, "1", "the terminal must start Pi's native status reporting: {printed:?}");
    wait_terminal(&bench, "term-split", true, "idle");
    let split = assert_implemented(bench.dispatch("terminal:split", &[json!({ "projectId": "p", "sessionId": "s", "termId": "term-split", "direction": "right" })]));
    assert_ne!(split["id"], "term-split");
    assert_eq!(bench.dispatch("pty:snapshot", &[json!("term-split")]).unwrap()["born"], born);
    assert!(bench.dispatch("pty:snapshot", &[json!(split["id"].as_str().unwrap())]).unwrap()["id"] == split["id"]);
    let claude = assert_implemented(bench.dispatch("pty:create", &[json!({ "id": "claude-1", "projectId": "p", "kind": "claude", "shell": "bash" })]));
    let command = claude["launchCommand"].as_str().unwrap_or("");
    assert!(command.contains("--settings"), "{command}");
    let settings = command.split("--settings").nth(1).unwrap_or("").trim().trim_matches('\'').trim_matches('"');
    let body = fs::read_to_string(settings).unwrap_or_else(|error| panic!("{error}: {settings} from {command}"));
    assert!(body.contains("127.0.0.1") && body.contains("hooks") && body.contains("SessionStart"), "{body}");
    let app = include_str!("../../../src/renderer/App.tsx");
    let handler = app.split("onSplitTerm={async").nth(1).unwrap().split("onClose").next().unwrap();
    assert!(handler.contains("terminalSplit"));
    assert!(!handler.contains("ptyCreate") && !handler.contains("openTerm"));
    bench.dispatch("pty:close", &[json!("term-split")]).unwrap();
    bench.dispatch("pty:close", &[json!(split["id"].as_str().unwrap())]).unwrap();
    bench.dispatch("pty:close", &[json!("claude-1")]).unwrap();
    let _ = fs::remove_dir_all(root);
}

#[test]
fn legacy_history_uses_the_unique_message_and_keeps_failures() {
    let _lock = env_lock();
    let root = temp_dir("legacy");
    let project = root.join("project");
    fs::create_dir_all(&project).unwrap();
    let claude = root.join("claude");
    let marker = "unique-legacy-marker-alpha-one-23456789";
    let other = "different-legacy-marker-beta-two-987654321";
    let project_path = pello_core::real_path(&project).unwrap();
    let session_dir = claude.join("projects").join("one");
    fs::create_dir_all(&session_dir).unwrap();
    let cwd = project_path.display().to_string();
    let row = |id: &str, text: &str| {
        let value = json!({ "sessionId": id, "cwd": cwd, "message": { "role": "user", "content": text } });
        format!("{value}\n")
    };
    fs::write(session_dir.join("old.jsonl"), row("old-session-id", marker)).unwrap();
    fs::write(session_dir.join("new.jsonl"), row("new-session-id", other)).unwrap();
    let _claude = var_guard("CLAUDE_CONFIG_DIR", claude.to_str().unwrap());
    let (bench, _) = workbench(&root);
    bench.dispatch("db:projects", &[json!([{ "id": "p", "name": "P", "host": "local", "path": project.display().to_string(), "branch": "", "agent": "claude" }])]).unwrap();
    bench.dispatch("terminal:history-save", &[json!("old-term"), json!(marker)]).unwrap();
    let resumed = assert_implemented(bench.dispatch("pty:create", &[json!({ "id": "old-term", "projectId": "p", "kind": "claude", "shell": "bash" })]));
    assert_eq!(resumed["agentSessionId"], "old-session-id");
    assert!(resumed["launchCommand"].as_str().unwrap_or("").contains("--resume"));
    assert!(!resumed["launchCommand"].as_str().unwrap_or("").contains("new-session-id"));
    bench.dispatch("pty:close", &[json!("old-term")]).unwrap();
    bench.dispatch("terminal:history-save", &[json!("both-term"), json!(format!("{marker}\n{other}"))]).unwrap();
    let multiple = bench.dispatch("pty:create", &[json!({ "id": "both-term", "projectId": "p", "kind": "claude", "shell": "bash" })]).unwrap_err();
    assert!(multiple.contains("无法唯一定位旧 Agent 对话"), "{multiple}");
    assert!(bench.dispatch("pty:snapshot", &[json!("both-term")]).unwrap().is_null());
    assert!(fs::read_to_string(root.join("data/terminal-history").join(format!("{}.log", pello_core::pty::history_name("both-term")))).unwrap().contains(marker));
    bench.dispatch("terminal:history-save", &[json!("none-term"), json!("this history matches nothing at all in the store")]).unwrap();
    let missing = bench.dispatch("pty:create", &[json!({ "id": "none-term", "projectId": "p", "kind": "claude", "shell": "bash" })]).unwrap_err();
    assert!(missing.contains("无法唯一定位旧 Agent 对话"), "{missing}");
    assert!(bench.dispatch("pty:snapshot", &[json!("none-term")]).unwrap().is_null());
    let pi = root.join("pi-sessions");
    fs::create_dir_all(&pi).unwrap();
    let original = pi.join("chat.jsonl");
    fs::write(&original, row("pi-session", marker)).unwrap();
    let _pi = var_guard("PI_CODING_AGENT_SESSION_DIR", pi.to_str().unwrap());
    bench.dispatch("terminal:history-save", &[json!("pi-term"), json!(marker)]).unwrap();
    let copied = assert_implemented(bench.dispatch("pty:create", &[json!({ "id": "pi-term", "projectId": "p", "kind": "pi", "shell": "bash" })]));
    assert_eq!(copied["agentSessionId"], "pello:directory");
    let command = copied["launchCommand"].as_str().unwrap_or("");
    assert!(command.contains("--session-dir") && command.contains("--continue"), "{command}");
    assert_eq!(fs::read_to_string(&original).unwrap(), row("pi-session", marker));
    let destination = root.join("data/agent-sessions").join(pello_core::pty::history_name("pi-term")).join("chat.jsonl");
    assert_eq!(fs::read_to_string(&destination).unwrap(), fs::read_to_string(&original).unwrap());
    bench.dispatch("pty:close", &[json!("pi-term")]).unwrap();
    let home = root.join("home");
    fs::create_dir_all(home.join(".ssh")).unwrap();
    fs::write(home.join(".ssh/id_ed25519"), "-----BEGIN OPENSSH PRIVATE KEY-----\nLEGACYKEY\n-----END OPENSSH PRIVATE KEY-----\n").unwrap();
    let (shim, log) = install_ssh_shim(&root);
    let sock = root.join("agent.sock");
    let agent = fake_agent(&sock);
    let _env = ssh_env(&home, &shim, &log, &agent);
    let local = bench.dispatch("db:get", &[]).unwrap()["db"]["hosts"][0].clone();
    bench.dispatch("db:hosts", &[json!([local, { "id": "remote", "name": "Remote", "addr": "127.0.0.1", "port": 22, "user": "legacy", "auth": "key", "on": true, "platform": "linux" }])]).unwrap();
    bench.dispatch("db:projects", &[json!([{ "id": "remote-project", "name": "R", "host": "remote", "path": project.display().to_string(), "branch": "", "agent": "claude" }])]).unwrap();
    bench.dispatch("terminal:history-save", &[json!("remote-term"), json!(marker)]).unwrap();
    let remote = bench.dispatch("pty:create", &[json!({ "id": "remote-term", "projectId": "remote-project", "kind": "claude", "shell": "bash" })]).unwrap_err();
    assert!(remote.contains("旧远程 Agent 会话缺少原生 ID"), "{remote}");
    assert!(bench.dispatch("pty:snapshot", &[json!("remote-term")]).unwrap().is_null());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn git_comparison_base_restores_the_worktree_without_rewriting_head() {
    let root = temp_dir("git-restore");
    let project = root.join("project");
    fs::create_dir_all(&project).unwrap();
    let original = "alpha\nmiddle\nomega\n";
    fs::write(project.join("fixture.txt"), original).unwrap();
    fs::write(project.join("deleted.txt"), "deleted original\n").unwrap();
    let git = |args: &[&str]| {
        let status = std::process::Command::new("git").arg("-C").arg(&project).args(args).status().unwrap();
        assert!(status.success(), "{args:?}");
    };
    git(&["init"]);
    git(&["config", "user.email", "t@example.com"]);
    git(&["config", "user.name", "t"]);
    git(&["add", "."]);
    git(&["commit", "-m", "base"]);
    let head = std::process::Command::new("git").arg("-C").arg(&project).args(["rev-parse", "HEAD"]).output().unwrap();
    let head = String::from_utf8_lossy(&head.stdout).trim().to_string();
    fs::write(project.join("fixture.txt"), "alpha\nomega\nextra at end\n").unwrap();
    fs::remove_file(project.join("deleted.txt")).unwrap();
    let (bench, _) = workbench(&root);
    bench.dispatch("db:projects", &[json!([{ "id": "p", "name": "P", "host": "local", "path": project.display().to_string(), "branch": "", "agent": "shell" }])]).unwrap();
    let read = bench.dispatch("git:read", &[json!("p"), json!("fixture.txt")]).unwrap();
    let restored = bench.dispatch("git:write", &[json!("p"), json!("fixture.txt"), json!(original), json!(read["version"].as_str().unwrap())]).unwrap();
    assert_eq!(restored["text"], original);
    assert_eq!(fs::read_to_string(project.join("fixture.txt")).unwrap(), original);
    let after = std::process::Command::new("git").arg("-C").arg(&project).args(["rev-parse", "HEAD"]).output().unwrap();
    assert_eq!(String::from_utf8_lossy(&after.stdout).trim(), head);
    let shown = std::process::Command::new("git").arg("-C").arg(&project).args(["show", "HEAD:fixture.txt"]).output().unwrap();
    assert_eq!(String::from_utf8_lossy(&shown.stdout), original);
    fs::write(project.join("deleted.txt"), "concurrent creation\n").unwrap();
    let raced = bench.dispatch("git:write", &[json!("p"), json!("deleted.txt"), json!("deleted original\n"), json!(null)]).unwrap_err();
    assert!(!raced.contains("尚未"), "{raced}");
    assert_eq!(fs::read_to_string(project.join("deleted.txt")).unwrap(), "concurrent creation\n");
    fs::remove_file(project.join("deleted.txt")).unwrap();
    let recreated = bench.dispatch("git:write", &[json!("p"), json!("deleted.txt"), json!("deleted original\n"), json!(null)]).unwrap();
    assert_eq!(recreated["text"], "deleted original\n");
    let shown_deleted = std::process::Command::new("git").arg("-C").arg(&project).args(["show", "HEAD:deleted.txt"]).output().unwrap();
    assert_eq!(String::from_utf8_lossy(&shown_deleted.stdout), "deleted original\n");
    let final_head = std::process::Command::new("git").arg("-C").arg(&project).args(["rev-parse", "HEAD"]).output().unwrap();
    assert_eq!(String::from_utf8_lossy(&final_head.stdout).trim(), head);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn same_name_menu_stays_refused() {
    let root = temp_dir("same-name");
    let (bench, _) = workbench(&root);
    for channel in ["transfer:decide", "transfer:keep-both"] {
        let error = bench.dispatch(channel, &[json!("p"), json!("upload"), json!("overwrite")]).unwrap_err();
        assert!(error.contains("上传不再询问同名处理"), "{channel} {error}");
        assert!(!error.contains("尚未"), "{error}");
    }
    let _ = fs::remove_dir_all(root);
}

/// Electron `gitDiscard` in `src/main/git.ts` restores the whole file with
/// `git restore --source=HEAD --worktree --staged` (or `git checkout HEAD --`)
/// and removes untracked files with `git clean -f`. It does not apply a hunk
/// and it does not rewrite the commit. Hunk restore stays on `git:write`.
#[test]
fn electron_git_discard_restores_the_whole_file_and_keeps_head() {
    let root = temp_dir("electron-discard");
    let project = root.join("project");
    fs::create_dir_all(&project).unwrap();
    fs::write(project.join("fixture.txt"), "alpha\nmiddle\nomega\n").unwrap();
    git_commit(&project);
    let head = head_sha(&project);
    fs::write(project.join("fixture.txt"), "only the worktree\n").unwrap();
    fs::write(project.join("extra.txt"), "untracked\n").unwrap();
    let (bench, _) = workbench(&root);
    bench.dispatch("db:projects", &[json!([{ "id": "p", "name": "P", "host": "local", "path": project.display().to_string(), "branch": "", "agent": "shell" }])]).unwrap();
    assert_implemented(bench.dispatch("git:discard", &[json!("p"), json!("fixture.txt"), json!(false)]));
    assert_eq!(fs::read_to_string(project.join("fixture.txt")).unwrap(), "alpha\nmiddle\nomega\n");
    assert_implemented(bench.dispatch("git:discard", &[json!("p"), json!("extra.txt"), json!(true)]));
    assert!(!project.join("extra.txt").exists());
    assert_eq!(head_sha(&project), head);
    let shown = std::process::Command::new("git").arg("-C").arg(&project).args(["show", "HEAD:fixture.txt"]).output().unwrap();
    assert_eq!(String::from_utf8_lossy(&shown.stdout), "alpha\nmiddle\nomega\n");
    let _ = fs::remove_dir_all(root);
}

#[test]
#[cfg(unix)]
fn remote_git_diff_and_discard_match_the_local_commands() {
    let _lock = env_lock();
    let remote = remote_linux("remote-git");
    fs::write(remote.project.join("fixture.txt"), "alpha\nmiddle\nomega\n").unwrap();
    git_commit(&remote.project);
    let head = head_sha(&remote.project);
    fs::write(remote.project.join("fixture.txt"), "alpha\nomega\nextra at end\n").unwrap();
    fs::write(remote.project.join("extra.txt"), "untracked\n").unwrap();
    let diff = assert_implemented(remote.bench.dispatch("git:diff", &[json!("p"), json!("fixture.txt"), json!(false)]));
    assert_eq!(diff["st"], "M");
    assert_eq!(diff["before"], "alpha\nmiddle\nomega\n");
    assert_eq!(diff["after"], "alpha\nomega\nextra at end\n");
    assert_eq!(diff["binary"], false);
    let added = assert_implemented(remote.bench.dispatch("git:diff", &[json!("p"), json!("extra.txt"), json!(true)]));
    assert_eq!(added["st"], "A");
    assert_eq!(added["before"], "");
    assert_eq!(added["after"], "untracked\n");
    assert_implemented(remote.bench.dispatch("git:discard", &[json!("p"), json!("fixture.txt"), json!(false)]));
    assert_eq!(fs::read_to_string(remote.project.join("fixture.txt")).unwrap(), "alpha\nmiddle\nomega\n");
    assert_implemented(remote.bench.dispatch("git:discard", &[json!("p"), json!("extra.txt"), json!(true)]));
    assert!(!remote.project.join("extra.txt").exists());
    assert_eq!(head_sha(&remote.project), head);
    let _ = fs::remove_dir_all(&remote.root);
}

#[test]
#[cfg(unix)]
fn remote_hunk_restore_writes_the_comparison_base_without_rewriting_head() {
    let _lock = env_lock();
    let remote = remote_linux("remote-hunk");
    let original = "alpha\nmiddle\nomega\n";
    fs::write(remote.project.join("fixture.txt"), original).unwrap();
    fs::write(remote.project.join("deleted.txt"), "deleted original\n").unwrap();
    git_commit(&remote.project);
    let head = head_sha(&remote.project);
    fs::write(remote.project.join("fixture.txt"), "alpha\nomega\nextra at end\n").unwrap();
    fs::remove_file(remote.project.join("deleted.txt")).unwrap();
    let read = assert_implemented(remote.bench.dispatch("git:read", &[json!("p"), json!("fixture.txt")]));
    let restored = assert_implemented(remote.bench.dispatch("git:write", &[json!("p"), json!("fixture.txt"), json!(original), json!(read["version"].as_str().unwrap())]));
    assert_eq!(restored["text"], original);
    assert_eq!(fs::read_to_string(remote.project.join("fixture.txt")).unwrap(), original);
    assert_eq!(head_sha(&remote.project), head);
    let shown = std::process::Command::new("git").arg("-C").arg(&remote.project).args(["show", "HEAD:fixture.txt"]).output().unwrap();
    assert_eq!(String::from_utf8_lossy(&shown.stdout), original);
    fs::write(remote.project.join("deleted.txt"), "concurrent creation\n").unwrap();
    let raced = remote.bench.dispatch("git:write", &[json!("p"), json!("deleted.txt"), json!("deleted original\n"), json!(null)]).unwrap_err();
    assert!(!raced.contains("尚未"), "{raced}");
    assert_eq!(fs::read_to_string(remote.project.join("deleted.txt")).unwrap(), "concurrent creation\n");
    fs::remove_file(remote.project.join("deleted.txt")).unwrap();
    let recreated = assert_implemented(remote.bench.dispatch("git:write", &[json!("p"), json!("deleted.txt"), json!("deleted original\n"), json!(null)]));
    assert_eq!(recreated["text"], "deleted original\n");
    let shown_deleted = std::process::Command::new("git").arg("-C").arg(&remote.project).args(["show", "HEAD:deleted.txt"]).output().unwrap();
    assert_eq!(String::from_utf8_lossy(&shown_deleted.stdout), "deleted original\n");
    assert_eq!(head_sha(&remote.project), head);
    let _ = fs::remove_dir_all(&remote.root);
}

#[test]
#[cfg(unix)]
fn remote_preview_url_serves_the_sandbox_without_writing_the_draft() {
    let _lock = env_lock();
    let remote = remote_linux("remote-preview");
    let _open = var_guard("AWB_OPEN_BIN", "true");
    let page = "<!doctype html><head></head><body>remote page</body>";
    fs::write(remote.project.join("page.html"), page).unwrap();
    let stamp = fs::metadata(remote.project.join("page.html")).unwrap().modified().unwrap();
    let outside = remote.root.join("outside");
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("secret.txt"), b"outside-secret-bytes").unwrap();
    symlink(outside.join("secret.txt"), remote.project.join("linked.html")).unwrap();
    let big = remote.project.join("big.html");
    fs::File::create(&big).unwrap().set_len(12_000_001).unwrap();

    let url = assert_implemented(remote.bench.dispatch("file:preview-url", &[json!("p"), json!("page.html")]));
    let url = url.as_str().unwrap();
    assert!(url.starts_with("http://127.0.0.1:"), "{url}");
    let (status, _headers, body) = http("GET", url);
    assert_eq!(status, 200);
    assert!(body.contains("remote page"), "{body}");
    assert_eq!(fs::read_to_string(remote.project.join("page.html")).unwrap(), page);

    let draft_url = assert_implemented(remote.bench.dispatch("file:preview-url", &[json!("p"), json!("page.html"), json!("<p>draft only</p>")]));
    let draft_url = draft_url.as_str().unwrap();
    let (status, _headers, body) = http("GET", draft_url);
    assert_eq!(status, 200);
    assert!(body.contains("draft only"), "{body}");
    assert!(!body.contains("remote page"), "{body}");
    assert_eq!(fs::read_to_string(remote.project.join("page.html")).unwrap(), page);
    assert_eq!(fs::metadata(remote.project.join("page.html")).unwrap().modified().unwrap(), stamp);

    let opened = assert_implemented(remote.bench.dispatch("file:open-html", &[json!("p"), json!("page.html")]));
    let opened = opened.as_str().unwrap();
    assert!(opened.starts_with("http://127.0.0.1:") && opened.contains("page.html"), "{opened}");
    let (status, _headers, body) = http("GET", opened);
    assert_eq!(status, 200);
    assert!(body.contains("remote page"), "{body}");
    let refused = remote.bench.dispatch("file:open-html", &[json!("p"), json!("note.txt")]).unwrap_err();
    assert!(refused.contains("仅支持在浏览器中预览 HTML 文件"), "{refused}");

    let escaped = remote.bench.dispatch("file:preview-url", &[json!("p"), json!("../outside/secret.txt")]).unwrap_err();
    assert!(!escaped.contains("outside-secret") && !escaped.contains("尚未"), "{escaped}");
    let linked = remote.bench.dispatch("file:preview-url", &[json!("p"), json!("linked.html")]).unwrap_err();
    assert!(linked.contains("符号链接"), "{linked}");
    assert!(!linked.contains("outside-secret"), "{linked}");
    let oversized = remote.bench.dispatch("file:preview-url", &[json!("p"), json!("big.html")]).unwrap_err();
    assert!(oversized.contains("12 MB"), "{oversized}");
    let _ = fs::remove_dir_all(&remote.root);
}

fn git_commit(project: &Path) {
    let git = |args: &[&str]| {
        let status = std::process::Command::new("git").arg("-C").arg(project).args(args).status().unwrap();
        assert!(status.success(), "{args:?}");
    };
    git(&["init"]);
    git(&["config", "user.email", "t@example.com"]);
    git(&["config", "user.name", "t"]);
    // Keep the committed bytes as written: a machine-wide `autocrlf=true`
    // would otherwise restore the file with CRLF and the content would differ.
    git(&["config", "core.autocrlf", "false"]);
    git(&["add", "."]);
    git(&["commit", "-m", "base"]);
}

fn head_sha(project: &Path) -> String {
    let head = std::process::Command::new("git").arg("-C").arg(project).args(["rev-parse", "HEAD"]).output().unwrap();
    assert!(head.status.success());
    String::from_utf8_lossy(&head.stdout).trim().to_string()
}

#[cfg(unix)]
struct RemoteLinux {
    root: PathBuf,
    project: PathBuf,
    bench: Workbench,
    _env: Vec<VarGuard>,
    _agent: Agent,
}

#[cfg(unix)]
fn remote_linux(name: &str) -> RemoteLinux {
    let root = temp_dir(name);
    let project = root.join("project");
    fs::create_dir_all(&project).unwrap();
    let home = root.join("home");
    fs::create_dir_all(home.join(".ssh")).unwrap();
    fs::write(home.join(".ssh/id_ed25519"), "-----BEGIN OPENSSH PRIVATE KEY-----\nREMOTEKEY\n-----END OPENSSH PRIVATE KEY-----\n").unwrap();
    let (shim, log) = install_ssh_shim(&root);
    let sock = root.join("agent.sock");
    let agent = fake_agent(&sock);
    let env = ssh_env(&home, &shim, &log, &agent);
    let (bench, _) = workbench(&root);
    let local = bench.dispatch("db:get", &[]).unwrap()["db"]["hosts"][0].clone();
    bench.dispatch("db:hosts", &[json!([local, { "id": "remote", "name": "Remote", "addr": "127.0.0.1", "port": 22, "user": "git", "auth": "key", "on": true, "platform": "linux" }])]).unwrap();
    bench.dispatch("db:projects", &[json!([{ "id": "p", "name": "P", "host": "remote", "path": project.display().to_string(), "branch": "", "agent": "shell" }])]).unwrap();
    RemoteLinux { root, project, bench, _env: env, _agent: agent }
}

static REPLY_LOCK: Mutex<()> = Mutex::new(());

/// A native CLI asks the terminal which status protocol it speaks and starts
/// reporting only once the terminal answers. The stand-in prints a marker when
/// the answer arrives, so the test sees the reply the way the CLI does.
#[test]
fn terminal_answers_the_native_status_capability_query() {
    let root = temp_dir("status-reply");
    let project = root.join("project");
    fs::create_dir_all(&project).unwrap();
    let fixture = PathBuf::from(env!("CARGO_BIN_EXE_awb-program-status"));
    let custom = json!([{ "id": "probe", "name": "Probe", "cmd": shell_word(&fixture), "args": "probe" }]);
    let projects = json!([{ "id": "p", "name": "P", "host": "local", "path": project.display().to_string(), "branch": "", "agent": "shell" }]);
    // The helper path is a process-wide setting, so the whole test holds the lock.
    let _held = REPLY_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    // The test program is not the installed one, so it names the helper itself.
    std::env::set_var("AWB_CONSOLE_REPLY_BIN", PathBuf::from(env!("CARGO_BIN_EXE_awb-console-reply")));
    let (bench, events) = workbench(&root);
    bench.dispatch("db:projects", &[projects.clone()]).unwrap();
    bench.dispatch("db:custom", &[custom.clone()]).unwrap();

    // The answer reaches the CLI, which then reports its state.
    bench.dispatch("pty:create", &[json!({ "id": "answered", "projectId": "p", "kind": "probe", "shell": "bash" })]).unwrap();
    let shown = |events: &Arc<Mutex<Vec<serde_json::Value>>>, text: &str| events.lock().unwrap().iter().any(|event| event["payload"]["data"].as_str().unwrap_or("").contains(text));
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    while !shown(&events, "STATUS_PROBE_OK") && std::time::Instant::now() < deadline { std::thread::sleep(Duration::from_millis(50)); }
    assert!(shown(&events, "STATUS_PROBE_OK"), "the terminal must answer the capability query; a CLI that gets no answer never reports its state");
    // An Agent that reports itself idle takes input; its dot is still, so the
    // session keeps the running state that separates it from a Shell.
    let snapshot = |bench: &Workbench| bench.dispatch("pty:snapshot", &[json!("answered")]).unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    while snapshot(&bench)["inputReady"] != true && std::time::Instant::now() < deadline { std::thread::sleep(Duration::from_millis(50)); }
    let idle = snapshot(&bench);
    assert_eq!((idle["inputReady"].clone(), idle["state"].clone()), (json!(true), json!("running")), "{idle}");
    // A report from the CLI alone moves the state: working withdraws the input,
    // idle offers it again.
    events.lock().unwrap().clear();
    bench.dispatch("pty:write", &[json!("answered"), json!("work\n"), json!(false)]).unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    while snapshot(&bench)["inputReady"] != false && std::time::Instant::now() < deadline { std::thread::sleep(Duration::from_millis(50)); }
    let working = snapshot(&bench);
    assert_eq!((working["inputReady"].clone(), working["state"].clone()), (json!(false), json!("running")), "{working}");
    bench.dispatch("pty:write", &[json!("answered"), json!("idle\n"), json!(false)]).unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    while snapshot(&bench)["inputReady"] != true && std::time::Instant::now() < deadline { std::thread::sleep(Duration::from_millis(50)); }
    let back = snapshot(&bench);
    assert_eq!(back["inputReady"], true, "{back}");
    bench.dispatch("pty:close", &[json!("answered")]).unwrap();

    // Without an answer the same CLI stays silent. That is what a terminal
    // which drops the reply looks like, so the first part cannot pass on its own.
    std::env::set_var("AWB_CONSOLE_REPLY_BIN", root.join("absent-console-reply"));
    let (quiet, quiet_events) = workbench(&root);
    quiet.dispatch("db:projects", &[projects.clone()]).unwrap();
    quiet.dispatch("db:custom", &[custom.clone()]).unwrap();
    quiet.dispatch("pty:create", &[json!({ "id": "unanswered", "projectId": "p", "kind": "probe", "shell": "bash" })]).unwrap();
    // The CLI did start and did ask. The terminal journal holds its whole
    // output; the status reports are kept out of what the screen shows.
    const ASKED: &[u8] = b"7501;?";
    let asked = || pello_core::pty::load_journal(&root.join("data"), "unanswered").as_bytes().windows(ASKED.len()).any(|window| window == ASKED);
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    while !asked() && std::time::Instant::now() < deadline { std::thread::sleep(Duration::from_millis(50)); }
    assert!(asked(), "the CLI must have asked, for the terminal to be able to drop the reply");
    // Longer than the answer takes to arrive when it is delivered.
    std::thread::sleep(Duration::from_secs(3));
    std::env::remove_var("AWB_CONSOLE_REPLY_BIN");
    let quiet_snapshot = quiet.dispatch("pty:snapshot", &[json!("unanswered")]).unwrap();
    // Silent: no marker, and no idle report, so the terminal takes no input.
    assert!(!shown(&quiet_events, "STATUS_PROBE_OK") && quiet_snapshot["inputReady"] == false && quiet_snapshot["state"] == "running", "a CLI whose query is not answered must stay silent: {quiet_snapshot}");
    quiet.dispatch("pty:close", &[json!("unanswered")]).unwrap();
    let _ = fs::remove_dir_all(root);
}

/// One shell word for a path, quoted the way POSIX shells read it.
fn shell_word(path: &Path) -> String {
    format!("'{}'", path.display().to_string().replace('\\', "/"))
}

#[test]
fn saves_pass_the_gate_in_the_order_they_were_sent_and_the_file_matches() {
    let _lock = env_lock();
    let root = temp_dir("save-order");
    let bench = std::sync::Arc::new(workbench(&root).0);
    let start = bench.dispatch("db:get", &[]).unwrap()["db"]["settings"].clone();
    // Each save sends the settings as its change saw them, laid on what the
    // saves before it left; the second has the first change in it as well.
    let mut first = start.clone();
    first["fontSize"] = json!(18);
    let mut second = first.clone();
    second["uiFontSize"] = json!(15);
    let order = bench.save_order();
    // The places are taken as the saves are sent, as the shell takes them
    // when each call arrives. The threads are started with the second save
    // first, which is how a thread pool may run two saves sent one after
    // the other.
    let [first_ticket, second_ticket] = [order.ticket(), order.ticket()];
    let (sent, seen) = std::sync::mpsc::channel();
    let mut handles = Vec::new();
    for (number, settings, ticket) in [(1, second, second_ticket), (0, first, first_ticket)] {
        let bench = std::sync::Arc::clone(&bench);
        let sent = sent.clone();
        handles.push(std::thread::spawn(move || {
            let passed = ticket.wait();
            let saved = bench.dispatch("db:settings", &[settings]).unwrap();
            sent.send((number, saved["settings"]["fontSize"].clone(), saved["settings"]["uiFontSize"].clone())).unwrap();
            drop(passed);
        }));
    }
    drop(sent);
    let mut results: Vec<_> = seen.into_iter().take(2).collect();
    results.sort_by_key(|(number, _, _)| *number);
    assert_eq!(results, vec![(0, json!(18), json!(13)), (1, json!(18), json!(15))]);
    for handle in handles { handle.join().unwrap(); }
    let on_disk = fs::read_to_string(bench.paths.data.join("workbench.json")).unwrap();
    let on_disk: serde_json::Value = serde_json::from_str(&on_disk).unwrap();
    assert_eq!(on_disk["settings"]["fontSize"], json!(18));
    assert_eq!(on_disk["settings"]["uiFontSize"], json!(15));
    let in_app = bench.dispatch("db:get", &[]).unwrap()["db"]["settings"].clone();
    assert_eq!(in_app["fontSize"], json!(18));
    assert_eq!(in_app["uiFontSize"], json!(15));
}

#[test]
fn saves_made_from_many_threads_at_once_all_succeed_and_leave_a_whole_file() {
    let _lock = env_lock();
    let root = temp_dir("save-many");
    let bench = Arc::new(workbench(&root).0);
    fs::create_dir_all(root.join("project")).unwrap();
    bench.dispatch("db:projects", &[json!([{ "id": "p", "name": "P", "host": "local", "path": root.join("project").display().to_string(), "branch": "", "agent": "shell" }])]).unwrap();
    let project = "p".to_string();
    let mut handles = Vec::new();
    for index in 0..24u32 {
        let bench = Arc::clone(&bench);
        let project = project.clone();
        handles.push(std::thread::spawn(move || {
            for step in 0..12 {
                if (index + step) % 2 == 0 {
                    bench.dispatch("db:settings", &[json!({ "fontSize": 10 + (index % 15) })]).unwrap();
                } else {
                    bench.dispatch("db:branch", &[json!(project), json!(format!("branch-{index}-{step}"))]).unwrap();
                }
                let text = fs::read_to_string(bench.paths.data.join("workbench.json")).unwrap();
                serde_json::from_str::<serde_json::Value>(&text).unwrap_or_else(|error| panic!("file not whole after save {index}/{step}: {error}"));
            }
        }));
    }
    for handle in handles { handle.join().unwrap(); }
    let text = fs::read_to_string(bench.paths.data.join("workbench.json")).unwrap();
    let on_disk: serde_json::Value = serde_json::from_str(&text).unwrap();
    let in_app = bench.dispatch("db:get", &[]).unwrap()["db"].clone();
    assert_eq!(on_disk["projects"][0]["branch"], in_app["projects"][0]["branch"]);
    assert_eq!(on_disk["settings"]["fontSize"], in_app["settings"]["fontSize"]);
}
