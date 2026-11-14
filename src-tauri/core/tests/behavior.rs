//! Behavior checks for the Rust port. Each test names the Electron behavior it locks in.

use pello_core::paths::{prepare_data_directory, Paths};
use pello_core::store::{self, PlatformInfo};
use pello_core::workbench::Workbench;
use serde_json::json;
use std::fs;
use std::os::unix::fs::symlink;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
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
    assert!(remote.contains("远程") || remote.contains("remote"));
    let _ = fs::remove_dir_all(root);
}
