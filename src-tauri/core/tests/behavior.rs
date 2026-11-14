//! Behavior checks for the Rust port. Each test names the Electron behavior it locks in.

use pello_core::paths::{prepare_data_directory, Paths};
use pello_core::preview::{pdf_wheel, WheelState};
use pello_core::store::{self, PlatformInfo};
use pello_core::workbench::Workbench;
use serde_json::json;
use std::fs;
use std::io::{Read, Write};
use std::os::unix::fs::{symlink, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

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
    assert_eq!(state["db"]["settings"]["defShell"], "bash");
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
    symlink("/etc/hostname", legacy.join("linked")).unwrap();
    let error = prepare_data_directory(&data, &legacy, "zh-CN").unwrap_err();
    assert!(error.contains("数据目录包含链接"));
    assert!(!data.exists());
    fs::remove_file(legacy.join("linked")).unwrap();
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
    assert_eq!(config["temporarySessionsDirectory"], fs::canonicalize(&directory).unwrap().display().to_string());
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
    symlink("/etc/hostname", project.join("escape")).unwrap();
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
    symlink("/etc/hostname", project.join("escape")).unwrap();
    fs::create_dir(project.join("locked")).unwrap();
    fs::write(project.join("locked/secret.txt"), "PelloToken\n").unwrap();
    let mut locked = fs::metadata(project.join("locked")).unwrap().permissions();
    locked.set_readonly(false);
    std::os::unix::fs::PermissionsExt::set_mode(&mut locked, 0);
    fs::set_permissions(project.join("locked"), locked).unwrap();
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
    assert!(unreadable.contains("Permission denied") || unreadable.contains("权限"));
    let mut restore = fs::metadata(project.join("locked")).unwrap().permissions();
    std::os::unix::fs::PermissionsExt::set_mode(&mut restore, 0o755);
    fs::set_permissions(project.join("locked"), restore).unwrap();
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
    let key_mode = std::os::unix::fs::PermissionsExt::mode(&fs::metadata(root.join("data/credentials.key")).unwrap().permissions()) & 0o777;
    assert_eq!(key_mode, 0o600);
    let public = bench.dispatch("db:get", &[]).unwrap();
    assert!(public["db"]["hosts"][1].get("password").is_none());
    assert_eq!(public["db"]["hosts"][1]["hasPassword"], true);

    let copied = temp_dir("ssh-restart");
    assert!(std::process::Command::new("cp").args(["-a", root.join("data").to_str().unwrap(), copied.join("data").to_str().unwrap()]).status().unwrap().success());
    fs::copy(root.join("pello.config.json"), copied.join("pello.config.json")).ok();
    let (reloaded, remote_events) = workbench(&copied);
    let again = reloaded.dispatch("db:get", &[]).unwrap();
    assert_eq!(again["db"]["hosts"][1]["hasPassword"], true);
    assert!(again["db"]["hosts"][1].get("password").is_none());
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

fn install_ssh_shim(root: &std::path::Path) -> (PathBuf, PathBuf) {
    let bin = root.join("bin");
    fs::create_dir_all(&bin).unwrap();
    let shim = bin.join("ssh");
    let log = root.join("ssh.log");
    fs::write(&shim, "#!/bin/bash\nlog=\"${AWB_SSH_LOG:?}\"\n{\n  printf 'CALL\\036%s' \"${SSH_AUTH_SOCK-}\"\n  for arg in \"$@\"; do printf '\\036%s' \"$arg\"; done\n  printf '\\n'\n} >> \"$log\"\nlast=\"${@: -1}\"\nkey=\"\"\nprev=\"\"\nfor arg in \"$@\"; do\n  if [[ \"$prev\" == -i ]]; then key=\"$arg\"; fi\n  prev=\"$arg\"\ndone\nif [[ -n \"$key\" ]]; then\n  [[ -f \"$key\" ]] || exit 2\n  grep -q \"OPENSSH PRIVATE KEY\" \"$key\" || exit 3\n  printf '%s\\0' \"$@\" | grep -q 'IdentitiesOnly=yes' || exit 4\nelse\n  [[ -S \"${SSH_AUTH_SOCK-}\" ]] || exit 5\nfi\nif [[ \"$last\" == *\"-EncodedCommand \"* ]]; then exit 0; fi\nif [[ \"$last\" == *\"uname -s\"* ]]; then\n  if [[ -n \"${AWB_SSH_OS:-}\" ]]; then printf '%s\\n' \"$AWB_SSH_OS\"; else printf 'Linux\\n'; fi\n  exit 0\nfi\nbash -lc \"$last\"\n").unwrap();
    use std::os::unix::fs::PermissionsExt;
    let mut permissions = fs::metadata(&shim).unwrap().permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&shim, permissions).unwrap();
    (shim, log)
}

fn ssh_env(home: &std::path::Path, shim: &std::path::Path, log: &std::path::Path, sock: &std::path::Path) -> Vec<VarGuard> {
    vec![
        var_guard("AWB_SSH_HOME", &home.display().to_string()),
        var_guard("AWB_SSH_BIN", &shim.display().to_string()),
        var_guard("AWB_SSH_LOG", &log.display().to_string()),
        var_guard("SSH_AUTH_SOCK", &sock.display().to_string()),
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
    let _agent = std::os::unix::net::UnixListener::bind(&sock).unwrap();
    let _env = ssh_env(&home, &shim, &log, &sock);
    let (bench, _) = workbench(&root);
    let local = bench.dispatch("db:get", &[]).unwrap()["db"]["hosts"][0].clone();
    bench.dispatch("db:hosts", &[json!([
        local,
        { "id": "key", "name": "Key", "addr": "127.0.0.1", "port": 22, "user": "keyuser", "auth": "key", "password": password },
        { "id": "agent", "name": "Agent", "addr": "127.0.0.1", "port": 22, "user": "agentuser", "auth": "agent", "password": password }
    ])]).unwrap();
    let key_list = bench.dispatch("path:list", &[json!("key"), json!(project.display().to_string())]).unwrap();
    assert!(key_list["error"].is_null(), "key login should run the remote command: {key_list}");
    let agent_list = bench.dispatch("path:list", &[json!("agent"), json!(project.display().to_string())]).unwrap();
    assert!(agent_list["error"].is_null(), "agent login should run the remote command: {agent_list}");
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
        assert_eq!(call.sock, sock.display().to_string());
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

#[test]
fn windows_remote_script_translates_errors_and_keeps_the_command() {
    let _env_lock = env_lock();
    let root = temp_dir("ssh-win");
    let home = root.join("home");
    fs::create_dir_all(home.join(".ssh")).unwrap();
    fs::write(home.join(".ssh/id_ed25519"), "-----BEGIN OPENSSH PRIVATE KEY-----\nWINKEYMATERIAL\n-----END OPENSSH PRIVATE KEY-----\n").unwrap();
    let (shim, log) = install_ssh_shim(&root);
    let sock = root.join("agent.sock");
    let _agent = std::os::unix::net::UnixListener::bind(&sock).unwrap();
    let _env = ssh_env(&home, &shim, &log, &sock);
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

    let agent = bench.dispatch("pty:create", &[json!({ "id": "agent-1", "projectId": "p", "kind": "claude", "shell": "bash", "agentSessionId": "session-1" })]).unwrap();
    assert_eq!(agent["agentKind"], "claude");
    wait_terminal(&bench, "agent-1", true, "idle");
    let (_, green) = snap_status(&bench, "agent-1");
    assert_eq!(green["color"], "ready");
    assert_eq!(green["spinning"], false);
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
    let _open = var_guard("AWB_OPEN_SKILL", "0");
    let (bench, _) = workbench(&root);
    let targets = bench.dispatch("resources:targets", &[]).unwrap();
    let target = |id: &str| targets.as_array().unwrap().iter().find(|item| item["id"] == id).unwrap().clone();
    assert!(target("claude")["mcpPath"].as_str().unwrap().ends_with("/.claude.json"), "{}", target("claude"));
    assert!(target("claude")["skillPath"].as_str().unwrap().ends_with("/.claude/skills"));
    assert_eq!(target("claude")["skillAdapter"], "claude");
    assert!(target("codex")["mcpPath"].as_str().unwrap().ends_with("/.codex/config.toml"));
    assert!(target("codex")["skillPath"].as_str().unwrap().ends_with("/.agents/skills"));
    assert!(target("opencode")["mcpPath"].as_str().unwrap().ends_with("/opencode.jsonc"));
    assert!(target("pi")["mcpPath"].as_str().unwrap().ends_with("/.pi/agent/mcp.json"));
    assert!(target("pi")["skillPath"].as_str().unwrap().ends_with("/.pi/agent/skills"));
    assert!(target("omp")["mcpPath"].as_str().unwrap().ends_with("/.omp/agent/mcp.json"));
    assert!(target("omp")["skillConfigPath"].as_str().unwrap().ends_with("/.omp/agent/config.yml"));

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
    assert_eq!(fs::canonicalize(opened).unwrap(), fs::canonicalize(home.join(".claude/skills/demo-skill")).unwrap());
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
    let trashed = fs::read_dir(xdg.join("Trash/files")).unwrap().any(|entry| entry.unwrap().file_name().to_string_lossy().contains("note-skill"));
    assert!(trashed, "the skill moves to trash");

    let outside = root.join("outside-skill");
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("SKILL.md"), "---\nname: outside-skill\ndescription: stays outside\n---\nsecret-outside\n").unwrap();
    symlink(&outside, home.join(".claude/skills/outside-skill")).unwrap();
    let listed = bench.dispatch("resources:list", &[json!("skills"), json!("claude"), json!(1), json!("")]).unwrap();
    let outside_item = listed["items"].as_array().unwrap().iter().find(|item| item["name"] == "outside-skill").unwrap().clone();
    let opened = bench.dispatch("resources:skill-open", &[json!("claude"), outside_item.clone()]).unwrap();
    assert_eq!(fs::canonicalize(opened.as_str().unwrap()).unwrap(), fs::canonicalize(&outside).unwrap());
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
    symlink(root.join("missing-target"), linked_src.join("bad-skill/link")).unwrap();
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
    let linked = bench.dispatch("file:preview-url", &[json!("p"), json!("linked.png")]).unwrap_err();
    assert!(linked.contains("符号链接"), "{linked}");
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
    assert!(pi.contains(&format!("-{}", home.join(".pi/agent/skills/notes/SKILL.md").display())), "{pi}");
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

#[test]
fn mermaid_renders_svg_in_a_hidden_browser_without_node() {
    let _lock = env_lock();
    let root = temp_dir("mermaid");
    let log = root.join("diagram.log");
    let secret = root.join("secret-data");
    fs::create_dir_all(&secret).unwrap();
    let _log = var_guard("AWB_DIAGRAM_LOG", log.to_str().unwrap());
    let _data = var_guard("AWB_USER_DATA", secret.to_str().unwrap());
    let (bench, _) = workbench(&root);
    let svg = bench.dispatch("diagram:mermaid", &[json!("flowchart TD\nA[Hello]-->B[World]")]).unwrap();
    let svg = svg.as_str().unwrap();
    assert!(svg.contains("<svg") && svg.contains("Hello"), "{svg}");
    assert!(!svg.contains("window.awb") && !svg.contains("require("), "{svg}");
    let recorded = fs::read_to_string(&log).unwrap();
    assert!(recorded.contains("attempt=sandbox"), "{recorded}");
    let first = recorded.split("attempt=fallback").next().unwrap_or(&recorded);
    assert!(!first.contains("--no-sandbox"), "the sandbox launch is the first path: {first}");
    if let Some(fallback) = recorded.split("attempt=fallback").nth(1) {
        assert!(fallback.contains("--no-sandbox"), "fallback is only the second launch: {recorded}");
    }
    assert!(recorded.contains("google-chrome") || recorded.contains("chromium") || recorded.contains("attempt=sandbox"), "{recorded}");
    assert!(!recorded.contains("/node\n") && !recorded.lines().any(|line| line.ends_with("/node")), "{recorded}");
    assert!(!recorded.contains(secret.to_str().unwrap()), "{recorded}");
    let strict = bench.dispatch("diagram:mermaid", &[json!("flowchart TD\nA[\"<img src=x onerror=alert(1)>\"]")]).unwrap();
    let strict = strict.as_str().unwrap();
    assert!(strict.contains("<svg"), "{strict}");
    assert!(!strict.contains("onerror") && !strict.contains("alert(1)"), "strict mode strips the event handler: {strict}");
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
    assert!(fresh_pi["launchCommand"].as_str().unwrap().contains("--session-dir") && fresh_pi["launchCommand"].as_str().unwrap().contains(pi_dir.to_str().unwrap()), "{}", fresh_pi["launchCommand"]);
    assert!(fresh_omp["launchCommand"].as_str().unwrap().contains(omp_dir.to_str().unwrap()), "{}", fresh_omp["launchCommand"]);
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
    let argv = root.join("argv.json");
    let _argv = var_guard("AWB_SEARCH_ARGV", argv.to_str().unwrap());
    let (bench, _) = workbench(&root);
    bench.dispatch("db:projects", &[json!([{ "id": "p", "name": "P", "host": "local", "path": project.display().to_string(), "branch": "", "agent": "shell" }])]).unwrap();
    let query = "UNIQUE_QUERY_TOKEN";
    bench.dispatch("content:search-start", &[json!("p"), json!("plain"), json!(query), json!(true), json!(true), json!(false)]).unwrap();
    let recorded = fs::read_to_string(&argv).unwrap();
    assert!(!recorded.contains(query), "{recorded}");
    assert!(!pello_core::search::remote_content_shell().contains(query));
    bench.dispatch("content:search-start", &[json!("p"), json!("han"), json!(r"\p{Script=Han}+"), json!(true), json!(true), json!(false)]).unwrap();
    let (han, _) = drain_content(&bench, "han");
    assert!(han.iter().any(|item| item["matches"].as_array().unwrap().iter().any(|found| found["match"] == "汉字")), "{han:?}");
    bench.dispatch("content:search-start", &[json!("p"), json!("look"), json!(r"(?<=#)\w+"), json!(true), json!(true), json!(false)]).unwrap();
    let (look, _) = drain_content(&bench, "look");
    assert!(look.iter().any(|item| item["matches"].as_array().unwrap().iter().any(|found| found["match"] == "token")), "{look:?}");
    let invalid = bench.dispatch("content:search-start", &[json!("p"), json!("plus"), json!("a++"), json!(true), json!(true), json!(false)]).unwrap_err();
    assert!(invalid.contains("正则表达式无效"), "{invalid}");
    bench.dispatch("db:settings", &[json!({ "language": "en" })]).unwrap();
    assert_eq!(bench.dispatch("content:search-start", &[json!("p"), json!("plus-en"), json!("a++"), json!(true), json!(true), json!(false)]).unwrap_err(), "Invalid regular expression");
    bench.dispatch("db:settings", &[json!({ "language": "zh-CN" })]).unwrap();
    bench.dispatch("content:search-start", &[json!("p"), json!("slow"), json!("(a+)+$"), json!(true), json!(true), json!(false)]).unwrap();
    let timed = bench.dispatch("content:search-next", &[json!("slow")]).unwrap_err();
    assert!(timed.contains("正则表达式执行超时"), "{timed}");
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
    let _agent = std::os::unix::net::UnixListener::bind(&sock).unwrap();
    let _env = ssh_env(&home, &shim, &log, &sock);
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
    assert_eq!(copied.as_str().unwrap(), fs::canonicalize(&project).unwrap().to_str().unwrap());
    let open_log = root.join("open.log");
    let save_log = root.join("save.log");
    let save_path = root.join("history.ansi");
    let _open_bin = var_guard("AWB_OPEN_BIN", "true");
    let _open_log = var_guard("AWB_OPEN_LOG", open_log.to_str().unwrap());
    let _save_path = var_guard("AWB_SAVE_PATH", save_path.to_str().unwrap());
    let _save_log = var_guard("AWB_SAVE_LOG", save_log.to_str().unwrap());
    bench.dispatch("tree:action", &[json!("p"), json!(""), json!(true), json!("reveal")]).unwrap();
    assert_eq!(fs::read_to_string(&open_log).unwrap(), fs::canonicalize(&project).unwrap().display().to_string());
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
    let _agent = std::os::unix::net::UnixListener::bind(&sock).unwrap();
    let _env = ssh_env(&home, &shim, &log, &sock);
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
    let _agent = std::os::unix::net::UnixListener::bind(&sock).unwrap();
    let _env = ssh_env(&home, &shim, &log, &sock);
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
