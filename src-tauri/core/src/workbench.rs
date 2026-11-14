//! Command dispatch shared by the Tauri shell and the behavior tests.
//! Channel names match the Electron IPC names in `src/preload/index.ts`.

use crate::files::{self, default_ignore};
use crate::git;
use crate::i18n::{self, translate};
use crate::paths::Paths;
use crate::pty::{self, Manager};
use crate::search::{self, ContentSearch, TreeSearch};
use crate::shells::{self, installed_agents};
use crate::store::{self, apply_saved_settings, host_color, public_host, PlatformInfo};
use crate::temporary;
use crate::{random_id, uid};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::process::Command;
use std::sync::{Arc, Mutex};

type Emit = Arc<dyn Fn(Value) + Send + Sync>;

pub struct Workbench {
    pub paths: Paths,
    db: Mutex<Value>,
    passwords: Mutex<HashMap<String, String>>,
    pty: Manager,
    dirty: Mutex<bool>,
    content_searches: Mutex<HashMap<String, ContentSearch>>,
    tree_searches: Mutex<HashMap<String, TreeSearch>>,
    emit: Emit,
}

impl Workbench {
    pub fn open(paths: Paths, emit: Emit) -> Result<Self, String> {
        paths.prepare()?;
        let file = paths.data.join("workbench.json");
        let (mut db, rewrite) = store::load_database(&file, PlatformInfo::current());
        if rewrite {
            store::save_database(&file, &db)?;
        }
        let ids = session_ids(&db);
        pty::prune_history(&paths.data, &ids);
        if !db["settings"]["language"].is_string() {
            db["settings"]["language"] = json!("zh-CN");
        }
        Ok(Self { paths, db: Mutex::new(db), passwords: Mutex::new(HashMap::new()), pty: Manager::new(), dirty: Mutex::new(false), content_searches: Mutex::new(HashMap::new()), tree_searches: Mutex::new(HashMap::new()), emit })
    }

    pub fn database_path(&self) -> std::path::PathBuf { self.paths.data.join("workbench.json") }

    pub fn dispatch(&self, channel: &str, args: &[Value]) -> Result<Value, String> {
        let language = self.language();
        match channel {
            "db:get" => Ok(json!({ "db": self.db.lock().expect("db").clone(), "installed": installed_agents() })),
            "shells:local" => Ok(Value::Array(shells::discover().into_iter().map(|shell| json!({ "id": shell.id, "label": shell.label, "path": shell.path.display().to_string() })).collect())),
            "db:settings" => self.save_settings(args.first().cloned().unwrap_or(json!({}))),
            "db:projects" => self.save_projects(args.first().cloned().unwrap_or(json!([]))),
            "db:custom" => self.save_custom(args.first().cloned().unwrap_or(json!([]))),
            "db:hosts" => self.save_hosts(args.first().cloned().unwrap_or(json!([]))),
            "db:sessions" => self.save_sessions(args),
            "db:branch" => self.save_branch(str_arg(args, 0), str_arg(args, 1)),
            "files:dirty" => { *self.dirty.lock().expect("dirty") = args.first().and_then(|value| value.as_bool()).unwrap_or(false); Ok(Value::Null) }
            "temporary:directory" => Ok(temporary::read_directory(&self.paths.config_file).map(|path| json!(path.display().to_string())).unwrap_or(Value::Null)),
            "temporary:configure" => temporary::write_directory(&self.paths.config_file, Path::new(str_arg(args, 0).trim()), &language).map(|path| json!(path.display().to_string())),
            "temporary:create" => self.create_temporary(args.first().and_then(|value| value.as_str())),
            "path:check" => self.local_only(&str_arg(args, 0), &language).map(|_| files::check_path(str_arg(args, 1), &language)),
            "path:list" => self.local_only(&str_arg(args, 0), &language).map(|_| files::list_dir(str_arg(args, 1))),
            "git:status" => self.git_status(&str_arg(args, 0), &language),
            "git:diff" => self.with_local(&str_arg(args, 0), &language, |root| git::diff(root, str_arg(args, 1), args.get(2).and_then(|value| value.as_bool()).unwrap_or(false), &language)),
            "git:discard" => self.with_local(&str_arg(args, 0), &language, |root| git::discard(root, str_arg(args, 1), args.get(2).and_then(|value| value.as_bool()).unwrap_or(false), &language).map(|_| json!(true))),
            "git:tree" => self.with_local(&str_arg(args, 0), &language, |root| files::list_tree(root, str_arg(args, 1), &self.ignores(&str_arg(args, 0)), &language)),
            "git:read" => self.with_local(&str_arg(args, 0), &language, |root| files::read_local(root, str_arg(args, 1), &language)),
            "git:write" => self.with_local(&str_arg(args, 0), &language, |root| files::write_local(root, str_arg(args, 1), str_arg(args, 2), args.get(3).and_then(|value| value.as_str()), &language)),
            "tree:ignore-get" => { self.project(&str_arg(args, 0), &language)?; Ok(Value::Array(self.ignores(&str_arg(args, 0)).into_iter().map(Value::String).collect())) }
            "tree:ignore-set" => self.set_ignores(&str_arg(args, 0), args.get(1).cloned().unwrap_or(json!([])), &language),
            "tree:create" => self.with_local(&str_arg(args, 0), &language, |root| files::create_entry(root, str_arg(args, 1), str_arg(args, 2), bool_arg(args, 3)?, &language).map(|path| json!(path))),
            "tree:rename" => self.with_local(&str_arg(args, 0), &language, |root| files::rename_entry(root, str_arg(args, 1), str_arg(args, 2), bool_arg(args, 3)?, &language).map(|path| json!(path))),
            "tree:move" => self.with_local(&str_arg(args, 0), &language, |root| files::move_entry(root, str_arg(args, 1), str_arg(args, 2), bool_arg(args, 3)?, &language).map(|path| json!(path))),
            "tree:trash" => self.with_local(&str_arg(args, 0), &language, |root| files::trash_entry(root, str_arg(args, 1), bool_arg(args, 2)?, &language).map(|_| Value::Null)),
            "content:search-start" => self.content_start(args, &language),
            "content:search-cancel" => { self.content_cancel(str_arg(args, 0)); Ok(Value::Null) }
            "content:search-next" => self.content_next(str_arg(args, 0), &language),
            "tree:search-start" => self.tree_start(args, &language),
            "tree:search-cancel" => { self.tree_cancel(str_arg(args, 0)); Ok(Value::Null) }
            "tree:search-next" => self.tree_next(str_arg(args, 0), &language),
            "pty:create" => self.pty_create(args.first().cloned().unwrap_or(json!({})), &language),
            "pty:write" => { let bytes = pty_bytes(str_arg(args, 1), args.get(2).and_then(|value| value.as_bool()).unwrap_or(false)); self.pty.write(str_arg(args, 0), &bytes, &self.emit); Ok(Value::Null) }
            "pty:resize" => { self.pty.resize(str_arg(args, 0), number_arg(args, 1) as u16, number_arg(args, 2) as u16); Ok(Value::Null) }
            "pty:interrupt" => Ok(json!(self.pty.interrupt(str_arg(args, 0), &self.emit))),
            "pty:kill" | "pty:close" => { self.pty.close(str_arg(args, 0)); Ok(Value::Null) }
            "pty:restart" => self.pty_restart(str_arg(args, 0), &language),
            "terminal:history" => Ok(json!(pty::load_history(&self.paths.data, str_arg(args, 0)))),
            "terminal:history-save" => pty::save_history(&self.paths.data, str_arg(args, 0), str_arg(args, 1)).map(|_| Value::Null),
            "exec:test" => self.test_exec(args.first().cloned().unwrap_or(json!({})), &language),
            "host:test" => Ok(test_host(args.first().unwrap_or(&Value::Null), &language)),
            "app:update-state" | "app:update-check" | "app:update-download" => Ok(json!({ "phase": "unsupported" })),
            "app:update-install" => Ok(json!(false)),
            "app:meta" => Ok(json!({ "capture": std::env::var("AWB_CAPTURE").ok().as_deref() == Some("1"), "platform": node_platform(), "shots": std::env::var_os("AWB_SHOTS").is_some() })),
            "app:shot" => Ok(json!(false)),
            "dialog:directory" => Ok(pick_directory()),
            "tree:menu" | "file:menu" | "terminal:menu" => Ok(Value::Null),
            "resources:targets" => Ok(json!([])),
            _ => Err(translate(&language, "此功能尚未在 Rust 移植中实现：{{0}}", &[channel.to_string()])),
        }
    }

    fn language(&self) -> String { i18n::language_of(&self.db.lock().expect("db")) }

    fn persist(&self) -> Result<Value, String> {
        let db = self.db.lock().expect("db").clone();
        store::save_database(&self.database_path(), &db)?;
        Ok(db)
    }

    fn save_settings(&self, settings: Value) -> Result<Value, String> {
        self.db.lock().expect("db")["settings"] = apply_saved_settings(settings);
        self.persist()
    }

    fn save_projects(&self, projects: Value) -> Result<Value, String> {
        let mut db = self.db.lock().expect("db");
        db["projects"] = projects.clone();
        if let Some(ignores) = db.get_mut("treeIgnores").and_then(|value| value.as_object_mut()) {
            let ids: Vec<String> = projects.as_array().map(|list| list.iter().filter_map(|project| project["id"].as_str().map(|id| id.to_string())).collect()).unwrap_or_default();
            ignores.retain(|id, _| ids.iter().any(|kept| kept == id));
        }
        drop(db);
        self.persist()
    }

    fn save_custom(&self, custom: Value) -> Result<Value, String> {
        let language = self.language();
        for executor in custom.as_array().cloned().unwrap_or_default() {
            validate_resources(&executor["resources"], &language)?;
        }
        self.db.lock().expect("db")["custom"] = custom;
        self.persist()
    }

    fn save_hosts(&self, hosts: Value) -> Result<Value, String> {
        let language = self.language();
        let current = self.db.lock().expect("db").clone();
        let mut next = Vec::new();
        for mut host in hosts.as_array().cloned().unwrap_or_default() {
            if host["id"] != "local" {
                let old = current["hosts"].as_array().and_then(|list| list.iter().find(|item| item["id"] == host["id"]));
                let changed = old.is_none() || ["addr", "port", "user", "auth"].iter().any(|key| old.unwrap().get(*key) != host.get(*key)) || host.get("password").is_some();
                if changed {
                    let result = test_host(&host, &language);
                    if result["ok"] != true {
                        return Err(result["error"].as_str().unwrap_or("连接失败").to_string());
                    }
                    host["on"] = json!(true);
                    host["os"] = result["os"].clone();
                    host["platform"] = result["platform"].clone();
                }
            }
            if host["id"] == "local" {
                host["on"] = json!(true);
                if host["os"].as_str().unwrap_or("").is_empty() { host["os"] = json!(store::os_label()); }
            }
            remember_password(&mut self.passwords.lock().expect("passwords"), &host);
            host["color"] = json!(host_color(&host["color"]));
            let mut clean = public_host(host);
            let key = host_identity(&clean);
            clean["hasPassword"] = json!(self.passwords.lock().expect("passwords").contains_key(&key));
            next.push(clean);
        }
        self.db.lock().expect("db")["hosts"] = Value::Array(next);
        self.persist()
    }

    fn save_sessions(&self, args: &[Value]) -> Result<Value, String> {
        let project_id = str_arg(args, 0).to_string();
        let active = match args.get(2) {
            None => None,
            Some(value) if value.is_null() => Some(String::new()),
            Some(value) => Some(value.as_str().unwrap_or("").to_string()),
        };
        let selected = args.get(4).and_then(|value| value.as_str());
        let mut db = self.db.lock().expect("db");
        let draft = db.as_object_mut().expect("database");
        store::write_sessions(draft, &project_id, args.get(1).unwrap_or(&json!([])), active.as_deref(), args.get(3), selected);
        drop(db);
        self.persist()
    }

    fn save_branch(&self, project_id: &str, branch: &str) -> Result<Value, String> {
        let mut db = self.db.lock().expect("db");
        if let Some(projects) = db["projects"].as_array_mut() {
            if let Some(project) = projects.iter_mut().find(|project| project["id"] == project_id) {
                project["branch"] = json!(branch);
            }
        }
        drop(db);
        self.persist()
    }

    fn create_temporary(&self, root: Option<&str>) -> Result<Value, String> {
        let language = self.language();
        let base = if let Some(root) = root {
            temporary::write_directory(&self.paths.config_file, Path::new(root.trim()), &language)?
        } else {
            temporary::resolve_directory(temporary::read_directory(&self.paths.config_file).as_deref(), &language)?
        };
        let id = random_id();
        let directory = base.join(&id);
        fs::create_dir(&directory).map_err(|error| error.to_string())?;
        fs::OpenOptions::new().write(true).create_new(true).open(directory.join("AGENTS.md")).map_err(|error| error.to_string())?;
        fs::write(directory.join("AGENTS.md"), temporary::agents_markdown(&directory)).map_err(|error| error.to_string())?;
        fs::OpenOptions::new().write(true).create_new(true).open(directory.join("CLAUDE.md")).map_err(|error| error.to_string())?;
        fs::write(directory.join("CLAUDE.md"), "@AGENTS.md\n").map_err(|error| error.to_string())?;
        let mut db = self.db.lock().expect("db");
        let count = db["projects"].as_array().map(|list| list.iter().filter(|project| project["temporary"] == true).count()).unwrap_or(0) + 1;
        let agent = db["settings"]["defAgent"].as_str().unwrap_or("claude").to_string();
        let name = translate(&language, "临时会话 {{0}}", &[count.to_string()]);
        db["projects"].as_array_mut().expect("projects").push(json!({
            "id": id, "name": name, "host": "local", "path": directory.display().to_string(), "branch": "", "agent": agent, "temporary": true
        }));
        drop(db);
        let database = self.persist()?;
        Ok(json!({ "database": database, "projectId": id }))
    }

    fn project(&self, id: &str, language: &str) -> Result<Value, String> {
        self.db.lock().expect("db")["projects"].as_array().and_then(|list| list.iter().find(|project| project["id"] == id).cloned())
            .ok_or_else(|| translate(language, "项目不存在", &[] as &[String]))
    }

    fn local_root(&self, id: &str, language: &str) -> Result<std::path::PathBuf, String> {
        let project = self.project(id, language)?;
        if project["host"] != "local" && !project["host"].as_str().unwrap_or("").is_empty() {
            return Err(translate(language, "远程项目的该操作尚未在 Rust 移植中实现", &[] as &[String]));
        }
        Ok(std::path::PathBuf::from(project["path"].as_str().unwrap_or("")))
    }

    fn local_only(&self, host_id: &str, language: &str) -> Result<(), String> {
        if host_id.is_empty() || host_id == "local" { Ok(()) } else { Err(translate(language, "远程项目的该操作尚未在 Rust 移植中实现", &[] as &[String])) }
    }

    fn with_local(&self, project_id: &str, language: &str, run: impl FnOnce(&Path) -> Result<Value, String>) -> Result<Value, String> {
        let root = self.local_root(project_id, language)?;
        run(&root)
    }

    fn ignores(&self, project_id: &str) -> Vec<String> {
        self.db.lock().expect("db")["treeIgnores"][project_id].as_array().map(|list| list.iter().filter_map(|item| item.as_str().map(|item| item.to_string())).collect()).unwrap_or_else(default_ignore)
    }

    fn set_ignores(&self, project_id: &str, rules: Value, language: &str) -> Result<Value, String> {
        self.project(project_id, language)?;
        if !store::valid_tree_ignores(&rules) { return Err(translate(language, "请输入有效的目录名称", &[] as &[String])) }
        let mut unique = Vec::new();
        for rule in rules.as_array().cloned().unwrap_or_default() {
            if !unique.contains(&rule) { unique.push(rule); }
        }
        let mut db = self.db.lock().expect("db");
        if !db["treeIgnores"].is_object() { db["treeIgnores"] = json!({}); }
        db["treeIgnores"][project_id] = Value::Array(unique);
        drop(db);
        self.persist().map(|_| Value::Null)
    }

    fn git_status(&self, project_id: &str, language: &str) -> Result<Value, String> {
        let root = self.local_root(project_id, language)?;
        let mut panel = git::status(&root, language)?;
        if panel["isRepo"] == true {
            let branch = panel["branch"].as_str().unwrap_or("").to_string();
            if !branch.is_empty() {
                let changed = {
                    let mut db = self.db.lock().expect("db");
                    db["projects"].as_array_mut().and_then(|list| list.iter_mut().find(|project| project["id"] == project_id)).is_some_and(|project| {
                        let differs = project["branch"] != branch;
                        if differs { project["branch"] = json!(branch); }
                        differs
                    })
                };
                if changed { let _ = self.persist(); }
            }
        }
        if panel.get("untracked").is_none() { panel["untracked"] = json!({}); }
        Ok(panel)
    }

    fn pty_create(&self, request: Value, language: &str) -> Result<Value, String> {
        let id = request["id"].as_str().filter(|id| !id.is_empty()).map(|id| id.to_string()).unwrap_or_else(|| uid("t"));
        let project = self.project(request["projectId"].as_str().unwrap_or(""), language)?;
        if project["host"] != "local" {
            return Err(translate(language, "远程项目的该操作尚未在 Rust 移植中实现", &[] as &[String]));
        }
        let kind = request["kind"].as_str().unwrap_or("shell");
        let shell = request["shell"].as_str().unwrap_or("bash");
        let command = if kind == "shell" { String::new() } else { agent_command(kind, &self.db.lock().expect("db")) };
        let agent_session = request["agentSessionId"].as_str();
        let restore = self.db.lock().expect("db")["settings"]["restore"] != false;
        let mut info = self.pty.create(&self.paths.data, &id, Path::new(project["path"].as_str().unwrap_or("")), kind, shell, &command, agent_session, restore, language, self.emit.clone())?;
        info.as_object_mut().expect("session").remove("type");
        Ok(info)
    }

    fn pty_restart(&self, id: &str, language: &str) -> Result<Value, String> {
        let Some((cwd, kind, shell, command)) = self.pty.launch_meta(id) else { return Ok(Value::Null) };
        self.pty.close(id);
        let restore = self.db.lock().expect("db")["settings"]["restore"] != false;
        self.pty.create(&self.paths.data, id, &cwd, &kind, &shell, &command, None, restore, language, self.emit.clone()).map(|_| Value::Null)
    }

    fn test_exec(&self, request: Value, language: &str) -> Result<Value, String> {
        let cmd = request["cmd"].as_str().unwrap_or("");
        let args = request["args"].as_str().unwrap_or("");
        let cwd = request["cwd"].as_str().filter(|cwd| !cwd.is_empty());
        let mut command = Command::new("bash");
        command.arg("-lc").arg(format!("{cmd} {args}"));
        if let Some(cwd) = cwd { command.current_dir(cwd); }
        if let Some(env) = request["env"].as_array() {
            for item in env {
                if let (Some(key), Some(value)) = (item["k"].as_str(), item["v"].as_str()) {
                    if !key.is_empty() { command.env(key, value); }
                }
            }
        }
        let _ = language;
        match command.output() {
            Ok(output) => Ok(json!({ "text": format!("{}{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr)), "code": output.status.code() })),
            Err(error) => Err(error.to_string()),
        }
    }

    fn content_start(&self, args: &[Value], language: &str) -> Result<Value, String> {
        let id = str_arg(args, 1);
        if !search::valid_search_id(id) { return Err(translate(language, "搜索参数无效", &[] as &[String])) }
        let sensitive = args.get(3).and_then(|value| value.as_bool()).ok_or_else(|| translate(language, "搜索参数无效", &[] as &[String]))?;
        if args.get(4).is_some_and(|value| !value.is_null() && !value.is_boolean()) || args.get(5).is_some_and(|value| !value.is_null() && !value.is_boolean()) {
            return Err(translate(language, "搜索参数无效", &[] as &[String]));
        }
        let regex = args.get(4).and_then(|value| value.as_bool()).unwrap_or(false);
        let whole = args.get(5).and_then(|value| value.as_bool()).unwrap_or(false);
        let project_id = str_arg(args, 0);
        let (root, identity) = self.search_root(project_id, language)?;
        let ignored = self.ignores(project_id);
        let job = ContentSearch::start(&root, project_id, &identity, str_arg(args, 2), sensitive, regex, whole, &ignored, language)?;
        self.content_searches.lock().expect("content").insert(id.to_string(), job);
        Ok(Value::Null)
    }

    fn content_cancel(&self, id: &str) {
        if let Some(job) = self.content_searches.lock().expect("content").get_mut(id) { job.cancel(); }
        self.content_searches.lock().expect("content").remove(id);
    }

    fn content_next(&self, id: &str, language: &str) -> Result<Value, String> {
        let located = self.content_searches.lock().expect("content").get(id).map(|job| (job.project_id().to_string(), job.identity().to_string()));
        let Some((project_id, identity)) = located else {
            return Ok(json!({ "items": [], "done": true, "limited": false, "skipped": 0, "errors": 0 }));
        };
        if let Err(error) = self.confirm_identity(&project_id, &identity, language) {
            self.content_cancel(id);
            return Err(error);
        }
        let mut searches = self.content_searches.lock().expect("content");
        let Some(job) = searches.get_mut(id) else {
            return Ok(json!({ "items": [], "done": true, "limited": false, "skipped": 0, "errors": 0 }));
        };
        match job.next(language) {
            Ok(batch) => {
                if batch["done"] == true { searches.remove(id); }
                Ok(batch)
            }
            Err(error) => {
                searches.remove(id);
                Err(error)
            }
        }
    }

    fn tree_start(&self, args: &[Value], language: &str) -> Result<Value, String> {
        let id = str_arg(args, 1);
        let query = str_arg(args, 2);
        if !search::valid_search_id(id) || query.trim().is_empty() || query.len() > 500 {
            return Err(translate(language, "搜索参数无效", &[] as &[String]));
        }
        let project_id = str_arg(args, 0);
        let (root, identity) = self.search_root(project_id, language)?;
        let ignored = self.ignores(project_id);
        let job = TreeSearch::start(&root, project_id, &identity, query, &ignored, language)?;
        self.tree_searches.lock().expect("tree").insert(id.to_string(), job);
        Ok(Value::Null)
    }

    fn tree_cancel(&self, id: &str) {
        if let Some(job) = self.tree_searches.lock().expect("tree").get_mut(id) { job.cancel(); }
        self.tree_searches.lock().expect("tree").remove(id);
    }

    fn tree_next(&self, id: &str, language: &str) -> Result<Value, String> {
        let located = self.tree_searches.lock().expect("tree").get(id).map(|job| (job.project_id().to_string(), job.identity().to_string()));
        let Some((project_id, identity)) = located else { return Ok(json!({ "items": [], "done": true })) };
        if let Err(error) = self.confirm_identity(&project_id, &identity, language) {
            self.tree_cancel(id);
            return Err(error);
        }
        let mut searches = self.tree_searches.lock().expect("tree");
        let Some(job) = searches.get_mut(id) else { return Ok(json!({ "items": [], "done": true })) };
        match job.next(language) {
            Ok(batch) => {
                if batch["done"] == true { searches.remove(id); }
                Ok(batch)
            }
            Err(error) => {
                searches.remove(id);
                Err(error)
            }
        }
    }

    fn search_root(&self, project_id: &str, language: &str) -> Result<(std::path::PathBuf, String), String> {
        let project = self.project(project_id, language)?;
        let host = project["host"].as_str().unwrap_or("local");
        if host != "local" {
            return Err(translate(language, "远程项目的该操作尚未在 Rust 移植中实现", &[] as &[String]));
        }
        let path = project["path"].as_str().unwrap_or("").to_string();
        Ok((std::path::PathBuf::from(&path), format!("{host}|{path}")))
    }

    fn confirm_identity(&self, project_id: &str, identity: &str, language: &str) -> Result<(), String> {
        let project = self.project(project_id, language)?;
        let host = project["host"].as_str().unwrap_or("local");
        let path = project["path"].as_str().unwrap_or("");
        if format!("{host}|{path}") != identity {
            return Err(translate(language, "项目环境已更改", &[] as &[String]));
        }
        Ok(())
    }
}

fn session_ids(db: &Value) -> Vec<String> {
    let mut ids = Vec::new();
    if let Some(sessions) = db["sessions"].as_object() {
        for terms in sessions.values() {
            if let Some(terms) = terms.as_array() {
                for term in terms {
                    if let Some(id) = term["id"].as_str() { ids.push(id.to_string()); }
                }
            }
        }
    }
    ids
}

fn agent_command(kind: &str, db: &Value) -> String {
    const PRESETS: &[(&str, &str)] = &[("claude", "claude"), ("codex", "codex"), ("opencode", "opencode"), ("pi", "pi"), ("omp", "omp")];
    if let Some((_, cmd)) = PRESETS.iter().find(|(id, _)| *id == kind) { return (*cmd).to_string() }
    db["custom"].as_array().and_then(|list| list.iter().find(|item| item["id"] == kind)).map(|item| {
        [item["cmd"].as_str().unwrap_or(""), item["args"].as_str().unwrap_or("")].into_iter().filter(|part| !part.is_empty()).collect::<Vec<_>>().join(" ")
    }).unwrap_or_default()
}

fn validate_resources(target: &Value, language: &str) -> Result<(), String> {
    if target.is_null() || !target.is_object() { return Ok(()) }
    for key in ["mcpPath", "skillPath", "skillConfigPath"] {
        if let Some(value) = target.get(key).and_then(|value| value.as_str()) {
            if !value.is_empty() && !Path::new(value).is_absolute() {
                return Err(translate(language, "资源目录和配置文件必须使用绝对路径", &[] as &[String]));
            }
        }
    }
    let format = target["format"].as_str().unwrap_or("");
    let adapter = target["skillAdapter"].as_str().unwrap_or("portable");
    if !["standard", "codex", "opencode"].contains(&format) || !["portable", "claude", "codex", "opencode", "pi", "omp"].contains(&adapter) {
        return Err(translate(language, "请选择支持的资源格式", &[] as &[String]));
    }
    Ok(())
}

fn remember_password(memory: &mut HashMap<String, String>, host: &Value) {
    if host["auth"] != "password" || host.get("password").is_none() { return }
    let key = host_identity(host);
    match host["password"].as_str() {
        Some(password) if !password.is_empty() => { memory.insert(key, password.to_string()); }
        _ => { memory.remove(&key); }
    }
}

fn host_identity(host: &Value) -> String {
    let port = host["port"].as_i64().filter(|port| *port > 0).unwrap_or(22);
    format!("[\"{}\",{},\"{}\"]", host["addr"].as_str().unwrap_or(""), port, host["user"].as_str().unwrap_or(""))
}

fn test_host(host: &Value, language: &str) -> Value {
    let addr = host["addr"].as_str().unwrap_or("");
    let user = host["user"].as_str().unwrap_or("");
    if addr.is_empty() || user.is_empty() {
        return json!({ "ok": false, "error": translate(language, "请填写用户和地址", &[] as &[String]) });
    }
    if host["auth"] == "password" {
        return json!({ "ok": false, "error": translate(language, "密码登录的主机校验尚未在 Rust 移植中实现，未保存机器", &[] as &[String]) });
    }
    let port = host["port"].as_i64().unwrap_or(22).to_string();
    let mut command = Command::new("ssh");
    command.arg("-T").arg("-o").arg("BatchMode=yes").arg("-p").arg(&port)
        .arg("-o").arg("StrictHostKeyChecking=accept-new")
        .arg("-o").arg("ConnectTimeout=8")
        .arg("-o").arg("ServerAliveInterval=15");
    if host["auth"] != "agent" {
        if let Some(home) = std::env::var_os("HOME") {
            let key = Path::new(&home).join(".ssh/id_ed25519");
            if key.is_file() {
                command.arg("-o").arg("IdentitiesOnly=yes").arg("-i").arg(key);
            }
        }
    }
    command.arg(format!("{user}@{addr}")).arg("uname -s 2>/dev/null || ver");
    match command.output() {
        Ok(output) if output.status.success() => {
            let text = String::from_utf8_lossy(&output.stdout);
            let line = text.lines().filter(|line| !line.trim().is_empty()).last().unwrap_or("").trim();
            let linux = line.to_ascii_lowercase().contains("linux");
            json!({ "ok": true, "os": line.chars().take(80).collect::<String>(), "platform": if linux { "linux" } else { "windows" } })
        }
        Ok(output) => {
            let message = String::from_utf8_lossy(&output.stderr);
            let line = message.lines().filter(|line| !line.trim().is_empty()).last().unwrap_or("连接失败");
            json!({ "ok": false, "error": line.chars().take(240).collect::<String>() })
        }
        Err(error) => json!({ "ok": false, "error": error.to_string() }),
    }
}

fn pick_directory() -> Value {
    let output = Command::new("zenity").args(["--file-selection", "--directory"]).output();
    match output {
        Ok(output) if output.status.success() => {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if path.is_empty() { Value::Null } else { json!(path) }
        }
        _ => Value::Null,
    }
}

fn node_platform() -> &'static str {
    match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        other => other,
    }
}

fn str_arg(args: &[Value], index: usize) -> &str {
    args.get(index).and_then(|value| value.as_str()).unwrap_or("")
}

fn number_arg(args: &[Value], index: usize) -> u64 {
    args.get(index).and_then(|value| value.as_u64()).unwrap_or(0)
}

fn bool_arg(args: &[Value], index: usize) -> Result<bool, String> {
    args.get(index).and_then(|value| value.as_bool()).ok_or_else(|| "invalid argument".into())
}

fn pty_bytes(data: &str, binary: bool) -> Vec<u8> {
    if !binary { return data.as_bytes().to_vec() }
    data.chars().map(|char| (char as u32 & 0xff) as u8).collect()
}
