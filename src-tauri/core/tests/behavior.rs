//! Behavior checks for the Rust port. Each test names the Electron behavior it locks in.

use pello_core::paths::{prepare_data_directory, Paths};
use pello_core::store::{self, PlatformInfo};
use pello_core::workbench::Workbench;
use serde_json::json;
use std::fs;
use std::os::unix::fs::symlink;
use std::path::PathBuf;
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
    LOCK.get_or_init(|| Mutex::new(())).lock().expect("ssh env")
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
