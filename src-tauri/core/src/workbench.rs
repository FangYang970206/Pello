//! Command dispatch shared by the Tauri shell and the behavior tests.
//! Channel names match the Electron IPC names in `src/preload/index.ts`.

use crate::files::{self, default_ignore};
use crate::git;
use crate::i18n::{self, translate};
use crate::layout::{self, Tile};
use crate::legacy;
use crate::menu;
use crate::paths::Paths;
use crate::picker::Session as Picker;
use crate::preview;
use crate::pty::{self, Manager};
use crate::resources;
use crate::search::{self, ContentSearch, TreeSearch};
use crate::shells::{self, installed_agents};
use crate::ssh;
use crate::store::{self, apply_saved_settings, host_color, public_host, PlatformInfo};
use crate::temporary;
use crate::updates;
use crate::upload;
use crate::{random_id, uid};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};

type Emit = Arc<dyn Fn(Value) + Send + Sync>;

pub struct Workbench {
    pub paths: Paths,
    db: Mutex<Value>,
    pty: Manager,
    dirty: Mutex<bool>,
    content_searches: Mutex<HashMap<String, ContentSearch>>,
    tree_searches: Mutex<HashMap<String, TreeSearch>>,
    layouts: Mutex<HashMap<String, Vec<Tile>>>,
    restore_failures: Mutex<HashMap<String, String>>,
    preview: preview::Service,
    resources: resources::Resources,
    updates: Mutex<updates::Service>,
    uploads: upload::Service,
    pickers: Mutex<HashMap<String, Picker>>,
    history_flushed: Mutex<bool>,
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
        let updates = updates::Service::new(db["settings"]["autoCheckUpdates"] != false);
        Ok(Self { paths, db: Mutex::new(db), pty: Manager::new(), dirty: Mutex::new(false), content_searches: Mutex::new(HashMap::new()), tree_searches: Mutex::new(HashMap::new()), layouts: Mutex::new(HashMap::new()), restore_failures: Mutex::new(HashMap::new()), preview: preview::Service::new(), resources: resources::Resources::new(), updates: Mutex::new(updates), uploads: upload::Service::new(), pickers: Mutex::new(HashMap::new()), history_flushed: Mutex::new(false), emit })
    }

    pub fn database_path(&self) -> std::path::PathBuf { self.paths.data.join("workbench.json") }

    fn public_database(&self) -> Value {
        let mut db = self.db.lock().expect("db").clone();
        if let Some(hosts) = db["hosts"].as_array_mut() {
            for host in hosts.iter_mut() {
                if let Some(object) = host.as_object_mut() { object.remove("password"); }
                host["hasPassword"] = json!(ssh::has_password(&self.paths.data, host));
            }
        }
        db
    }

    pub fn dispatch(&self, channel: &str, args: &[Value]) -> Result<Value, String> {
        let language = self.language();
        match channel {
            "db:get" => Ok(json!({ "db": self.public_database(), "installed": installed_agents() })),
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
            "path:check" => self.path_check(str_arg(args, 0), str_arg(args, 1), &language),
            "path:list" => self.path_list(str_arg(args, 0), str_arg(args, 1), &language),
            "git:status" => self.git_status(&str_arg(args, 0), &language),
            "git:diff" => self.git_diff_command(args, &language),
            "git:discard" => self.git_discard_command(args, &language),
            "git:tree" => self.git_tree(&str_arg(args, 0), str_arg(args, 1), &language),
            "git:read" => self.git_read(&str_arg(args, 0), str_arg(args, 1), &language),
            "git:write" => self.git_write(&str_arg(args, 0), str_arg(args, 1), str_arg(args, 2), args.get(3).and_then(|value| value.as_str()), &language),
            "tree:ignore-get" => { self.project(&str_arg(args, 0), &language)?; Ok(Value::Array(self.ignores(&str_arg(args, 0)).into_iter().map(Value::String).collect())) }
            "tree:ignore-set" => self.set_ignores(&str_arg(args, 0), args.get(1).cloned().unwrap_or(json!([])), &language),
            "tree:create" => self.tree_create(args, &language),
            "tree:rename" => self.tree_rename(args, &language),
            "tree:move" => self.tree_move(args, &language),
            "tree:trash" => self.trash(args, &language),
            "content:search-start" => self.content_start(args, &language),
            "content:search-cancel" => { self.content_cancel(str_arg(args, 0)); Ok(Value::Null) }
            "content:search-next" => self.content_next(str_arg(args, 0), &language),
            "tree:search-start" => self.tree_start(args, &language),
            "tree:search-cancel" => { self.tree_cancel(str_arg(args, 0)); Ok(Value::Null) }
            "tree:search-next" => self.tree_next(str_arg(args, 0), &language),
            "pty:create" => self.pty_create(args.first().cloned().unwrap_or(json!({})), &language),
            "pty:snapshot" => Ok(self.pty.snapshot_of(str_arg(args, 0)).unwrap_or(Value::Null)),
            "pty:feed" => { self.pty.feed(str_arg(args, 0), str_arg(args, 1), &self.emit); Ok(Value::Null) }
            "terminal:split" => self.split_terminal(args.first().cloned().unwrap_or(json!({})), &language),
            "terminal:merge" => self.merge_terminal(args.first().cloned().unwrap_or(json!({})), &language),
            "terminal:rename" => self.rename_terminal(args.first().cloned().unwrap_or(json!({})), &language),
            "terminal:failure" => Ok(self.terminal_failure(str_arg(args, 0))),
            "terminal:hook" => Ok(self.terminal_hook(str_arg(args, 0))),
            "pty:write" => { let bytes = pty_bytes(str_arg(args, 1), args.get(2).and_then(|value| value.as_bool()).unwrap_or(false)); self.pty.write(str_arg(args, 0), &bytes, &self.emit); Ok(Value::Null) }
            "pty:resize" => { self.pty.resize(str_arg(args, 0), number_arg(args, 1) as u16, number_arg(args, 2) as u16); Ok(Value::Null) }
            "pty:interrupt" => Ok(json!(self.pty.interrupt(str_arg(args, 0), &self.emit))),
            "pty:kill" | "pty:close" => { self.pty.close(str_arg(args, 0)); Ok(Value::Null) }
            "pty:restart" => self.pty_restart(str_arg(args, 0), &language),
            "terminal:history" => Ok(json!(pty::load_history(&self.paths.data, str_arg(args, 0)))),
            "terminal:history-save" => pty::save_history(&self.paths.data, str_arg(args, 0), str_arg(args, 1)).map(|_| Value::Null),
            "terminal:export" => self.export_terminal(str_arg(args, 0), args.get(1).and_then(|value| value.as_str()).unwrap_or(""), &language),
            "terminal:history-flushed" => {
                *self.history_flushed.lock().expect("flush") = true;
                Ok(Value::Null)
            }
            "transfer:pick" => self.transfer_pick(args, &language),
            "transfer:download" => self.transfer_download(args, &language),
            "transfer:drop" => self.transfer_drop(args, &language),
            "transfer:cancel" => self.uploads.cancel(str_arg(args, 0), &language),
            "transfer:retry" => self.transfer_retry(str_arg(args, 0), &language),
            "transfer:dismiss" => self.uploads.dismiss(str_arg(args, 0)),
            "transfer:decide" | "transfer:keep-both" => Err(translate(&language, "上传不再询问同名处理", &[] as &[String])),
            "file:replacement-ready" => { self.uploads.confirm(str_arg(args, 0), args.get(1).and_then(|value| value.as_bool()).unwrap_or(false)); Ok(Value::Null) }
            "exec:test" => self.test_exec(args.first().cloned().unwrap_or(json!({})), &language),
            "host:test" => Ok(ssh::test_connection(&self.paths.data, args.first().unwrap_or(&Value::Null), &language)),
            "app:update-state" => Ok(self.updates.lock().expect("updates").state()),
            "app:update-check" => self.update_check(),
            "app:update-download" => self.update_download(),
            "app:update-install" => Ok(json!(self.update_install())),
            "app:meta" => Ok(json!({ "capture": std::env::var("AWB_CAPTURE").ok().as_deref() == Some("1"), "platform": node_platform(), "shots": std::env::var_os("AWB_SHOTS").is_some() })),
            "app:shot" => Ok(json!(false)),
            "dialog:directory" => self.pick_directory(&language),
            "dialog:picker" => self.picker(args.first().cloned().unwrap_or(json!({})), &language),
            "menu:app" => Ok(menu::app_menu(&language)),
            "menu:project" => self.project_menu(str_arg(args, 0), &language),
            "menu:file" => Ok(menu::file_menu(&language, args.first().unwrap_or(&Value::Null))),
            "menu:terminal" => Ok(menu::terminal_menu(&language, args.first().unwrap_or(&Value::Null))),
            "menu:tree" => self.tree_template(str_arg(args, 0), str_arg(args, 1), bool_arg(args, 2).unwrap_or(false), &language),
            "menu:save" => Ok(menu::save_dialog(&language, str_arg(args, 0))),
            "tree:menu" => self.tree_template(str_arg(args, 0), str_arg(args, 1), bool_arg(args, 2).unwrap_or(false), &language),
            "file:menu" => Ok(menu::file_menu(&language, args.first().unwrap_or(&Value::Null))),
            "terminal:menu" => Ok(menu::terminal_menu(&language, args.first().unwrap_or(&Value::Null))),
            "tree:action" => self.tree_action(str_arg(args, 0), str_arg(args, 1), bool_arg(args, 2).unwrap_or(false), str_arg(args, 3), &language),
            "resources:targets" => Ok(Value::Array(resources::targets(&self.paths.data, &self.custom()))),
            "resources:target" => resources::save_target(&self.paths.data, &self.custom(), args.first().unwrap_or(&Value::Null), &language).map(|_| Value::Null),
            "resources:pick" => Ok(menu::choose_open_path(str_arg(args, 0))),
            "resources:list" => resources::list(&self.paths.data, &self.custom(), str_arg(args, 0), str_arg(args, 1), json_usize(args.get(2)), str_arg(args, 3), &language),
            "resources:toggle" => resources::toggle(&self.paths.data, &self.custom(), str_arg(args, 0), str_arg(args, 1), args.get(2).unwrap_or(&Value::Null), args.get(3).and_then(|value| value.as_bool()), &language).map(|_| Value::Null),
            "resources:detail" => resources::detail(&self.paths.data, &self.custom(), str_arg(args, 0), str_arg(args, 1), args.get(2).unwrap_or(&Value::Null), &language),
            "resources:skill-open" => resources::open_skill(&self.paths.data, &self.custom(), str_arg(args, 0), args.get(1).unwrap_or(&Value::Null), &language),
            "resources:skill-delete" => resources::delete_skill(&self.paths.data, &self.custom(), str_arg(args, 0), args.get(1).unwrap_or(&Value::Null), &language),
            "resources:mcp" => resources::add_mcp(&self.resources, &self.paths.data, &self.custom(), str_arg(args, 0), args.get(1).unwrap_or(&Value::Null), args.get(2).and_then(|value| value.as_array()).map(|list| list.as_slice()).unwrap_or(&[]), true, &language),
            "resources:scan" => resources::scan(&self.paths.data, &self.custom(), str_arg(args, 0), str_arg(args, 1), &language),
            "resources:import-mcp" => resources::import_mcp(&self.resources, &self.paths.data, &self.custom(), str_arg(args, 0), args.get(1).and_then(|value| value.as_array()).map(|list| list.as_slice()).unwrap_or(&[]), args.get(2).and_then(|value| value.as_array()).map(|list| list.as_slice()).unwrap_or(&[]), &language),
            "resources:skills" => {
                let names = args.get(2).and_then(|value| value.as_array()).map(|list| list.iter().filter_map(|item| item.as_str().map(|item| item.to_string())).collect::<Vec<_>>());
                resources::import_skills(&self.resources, &self.paths.data, &self.custom(), str_arg(args, 0), args.get(1).and_then(|value| value.as_array()).map(|list| list.as_slice()).unwrap_or(&[]), names.as_ref(), &language)
            }
            "file:preview-url" => self.preview_url(args, &language),
            "file:open-html" => self.open_html(str_arg(args, 0), str_arg(args, 1), &language),
            "file:link" => self.file_link(str_arg(args, 0), str_arg(args, 1), str_arg(args, 2), &language),
            "tree:reference" => self.tree_reference(str_arg(args, 0), str_arg(args, 1), str_arg(args, 3), str_arg(args, 2), &language),
            "diagram:mermaid" => self.preview.render_mermaid(str_arg(args, 0), &language).map(|svg| json!(svg)),
            "diagram:cancel" => { self.preview.cancel(); Ok(Value::Null) },
            _ => Err(translate(&language, "此功能尚未在 Rust 移植中实现：{{0}}", &[channel.to_string()])),
        }
    }

    fn language(&self) -> String { i18n::language_of(&self.db.lock().expect("db")) }

    fn custom(&self) -> Value { self.db.lock().expect("db")["custom"].clone() }

    fn preview_url(&self, args: &[Value], language: &str) -> Result<Value, String> {
        if let Ok(delay) = std::env::var("AWB_PREVIEW_URL_DELAY") {
            if let Ok(millis) = delay.parse::<u64>() {
                if (1..=5_000).contains(&millis) { std::thread::sleep(std::time::Duration::from_millis(millis)); }
            }
        }
        let id = str_arg(args, 0).to_string();
        let draft = args.get(2).and_then(|value| value.as_str());
        if let Some((host, path)) = self.remote_place(&id, language)? {
            return self.preview.url_remote(&id, &self.paths.data, &host, &path, str_arg(args, 1), draft, language).map(|url| json!(url));
        }
        let root = self.local_root(&id, language)?;
        self.preview.url(&id, &root, str_arg(args, 1), draft, language).map(|url| json!(url))
    }

    fn git_diff_command(&self, args: &[Value], language: &str) -> Result<Value, String> {
        let id = str_arg(args, 0);
        let relative = str_arg(args, 1);
        let untracked = args.get(2).and_then(|value| value.as_bool()).unwrap_or(false);
        if let Some((host, path)) = self.remote_place(id, language)? {
            return git::diff_remote(&self.paths.data, &host, &path, relative, untracked, language);
        }
        self.with_local(id, language, |root| git::diff(root, relative, untracked, language))
    }

    fn git_discard_command(&self, args: &[Value], language: &str) -> Result<Value, String> {
        let id = str_arg(args, 0);
        let relative = str_arg(args, 1);
        let untracked = args.get(2).and_then(|value| value.as_bool()).unwrap_or(false);
        if let Some((host, path)) = self.remote_place(id, language)? {
            git::discard_remote(&self.paths.data, &host, &path, relative, untracked, language)?;
            return Ok(json!(true));
        }
        self.with_local(id, language, |root| git::discard(root, relative, untracked, language).map(|_| json!(true)))
    }

    fn persist(&self) -> Result<Value, String> {
        let db = self.db.lock().expect("db").clone();
        store::save_database(&self.database_path(), &db)?;
        Ok(db)
    }

    fn save_settings(&self, settings: Value) -> Result<Value, String> {
        let settings = apply_saved_settings(settings);
        self.updates.lock().expect("updates").set_enabled(settings["autoCheckUpdates"] != false);
        self.db.lock().expect("db")["settings"] = settings;
        self.persist()
    }

    pub fn poll_updates(&self, now: u64) -> bool {
        let fired = self.updates.lock().expect("updates").poll(now);
        if fired {
            let state = self.updates.lock().expect("updates").state();
            (self.emit)(json!({ "channel": "app:update", "payload": state }));
        }
        fired
    }

    pub fn update_automatic_checks(&self) -> u64 { self.updates.lock().expect("updates").automatic_checks() }
    pub fn update_installs_on_quit(&self) -> bool { self.updates.lock().expect("updates").installs_on_quit() }

    fn update_check(&self) -> Result<Value, String> {
        let state = self.updates.lock().expect("updates").check();
        (self.emit)(json!({ "channel": "app:update", "payload": state }));
        Ok(state)
    }

    fn update_download(&self) -> Result<Value, String> {
        let started = self.updates.lock().expect("updates").begin_download();
        if started["phase"] != "downloading" { return Ok(started); }
        (self.emit)(json!({ "channel": "app:update", "payload": started }));
        let finished = self.updates.lock().expect("updates").finish_download(&self.paths.data);
        if finished["phase"] == "downloaded" {
            (self.emit)(json!({ "channel": "app:update", "payload": { "phase": "downloading", "version": finished["version"], "percent": 100 } }));
        }
        (self.emit)(json!({ "channel": "app:update", "payload": finished }));
        Ok(finished)
    }

    fn update_install(&self) -> bool {
        let dirty = *self.dirty.lock().expect("dirty");
        let started = self.updates.lock().expect("updates").install(&self.paths.data, dirty);
        let state = self.updates.lock().expect("updates").state();
        (self.emit)(json!({ "channel": "app:update", "payload": state }));
        started
    }

    fn export_terminal(&self, id: &str, destination: &str, language: &str) -> Result<Value, String> {
        if !self.term_saved(id) { return Err(translate(language, "终端不存在", &[] as &[String])); }
        let source = self.paths.data.join("terminal-history").join(format!("{}.ansi", pty::history_name(id)));
        if !source.is_file() { return Err(translate(language, "此终端尚无完整记录", &[] as &[String])); }
        let destination = if destination.is_empty() {
            match menu::choose_save_path(language, "history")? {
                Some(path) => path,
                None => return Ok(Value::Null),
            }
        } else {
            destination.to_string()
        };
        let destination = Path::new(&destination);
        if let Some(parent) = destination.parent() { fs::create_dir_all(parent).map_err(|error| error.to_string())?; }
        fs::copy(&source, destination).map_err(|error| error.to_string())?;
        Ok(Value::Null)
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
                    let result = ssh::test_connection(&self.paths.data, &host, &language);
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
            ssh::remember_password(&self.paths.data, &host);
            host["color"] = json!(host_color(&host["color"]));
            let mut clean = public_host(host);
            clean["hasPassword"] = json!(ssh::has_password(&self.paths.data, &clean));
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
        Ok(std::path::PathBuf::from(project["path"].as_str().unwrap_or("")))
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
        if let Some((host, path)) = self.remote_place(project_id, language)? {
            let mut panel = git::status_remote(&self.paths.data, &host, &path, language)?;
            self.remember_branch(project_id, &panel);
            if panel.get("untracked").is_none() { panel["untracked"] = json!({}); }
            return Ok(panel);
        }
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

    fn remember_branch(&self, project_id: &str, panel: &Value) {
        if panel["isRepo"] != true { return }
        let branch = panel["branch"].as_str().unwrap_or("").to_string();
        if branch.is_empty() { return }
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

    fn git_read(&self, project_id: &str, rel: &str, language: &str) -> Result<Value, String> {
        if let Some((host, path)) = self.remote_place(project_id, language)? {
            return git::read_remote(&self.paths.data, &host, &path, rel, language);
        }
        files::read_local(&self.local_root(project_id, language)?, rel, language)
    }

    fn git_write(&self, project_id: &str, rel: &str, text: &str, version: Option<&str>, language: &str) -> Result<Value, String> {
        if let Some((host, path)) = self.remote_place(project_id, language)? {
            return git::write_remote(&self.paths.data, &host, &path, rel, text, version, language);
        }
        files::write_local(&self.local_root(project_id, language)?, rel, text, version, language)
    }

    fn git_tree(&self, project_id: &str, rel: &str, language: &str) -> Result<Value, String> {
        let ignored = self.ignores(project_id);
        if let Some((host, path)) = self.remote_place(project_id, language)? {
            return git::list_remote(&self.paths.data, &host, &path, rel, &ignored, language);
        }
        files::list_tree(&self.local_root(project_id, language)?, rel, &ignored, language)
    }

    fn path_check(&self, host_id: &str, input: &str, language: &str) -> Result<Value, String> {
        let Some(host) = self.optional_host(host_id)? else { return Ok(files::check_path(input, language)) };
        let value = input.trim();
        if value.is_empty() { return Ok(json!({ "kind": "empty" })) }
        if !value.starts_with('/') || value.contains('\0') { return Ok(json!({ "kind": "invalid" })) }
        let quoted = ssh::bash_quote(value);
        let exists = ssh::run(&self.paths.data, &host, &format!("if [ -d {quoted} ]; then echo yes; fi"), None, language).unwrap_or_default();
        if exists.trim() != "yes" { return Ok(json!({ "kind": "missing" })) }
        let inside = ssh::run(&self.paths.data, &host, &format!("git -C {quoted} rev-parse --is-inside-work-tree"), None, language).unwrap_or_default();
        if inside.trim() != "true" { return Ok(json!({ "kind": "plain" })) }
        let branch = ssh::run(&self.paths.data, &host, &format!("git -C {quoted} rev-parse --abbrev-ref HEAD"), None, language).unwrap_or_default();
        Ok(json!({ "kind": "git", "branch": branch.trim() }))
    }

    fn path_list(&self, host_id: &str, input: &str, language: &str) -> Result<Value, String> {
        let Some(host) = self.optional_host(host_id)? else { return Ok(files::list_dir(input)) };
        if host["platform"] == "windows" {
            let current = input.trim();
            let script = if current.is_empty() { ssh::windows_home_dir_script(language) } else { ssh::windows_dir_script(current, language) };
            let text = match ssh::run(&self.paths.data, &host, &script, None, language) {
                Ok(text) => text,
                Err(error) => return Ok(json!({ "path": current, "parent": Value::Null, "dirs": [], "error": error })),
            };
            let parsed: Value = serde_json::from_str(text.trim()).unwrap_or(json!({}));
            let path = parsed["path"].as_str().unwrap_or(current).to_string();
            let dirs = parsed["dirs"].as_array().cloned().unwrap_or_default().into_iter().filter_map(|name| name.as_str().map(|name| json!({ "name": name, "path": format!("{path}\\{name}") }))).collect::<Vec<_>>();
            let parent = if path.len() <= 3 { Value::Null } else { json!(path.rsplit_once('\\').map(|(parent, _)| parent).unwrap_or(&path)) };
            return Ok(json!({ "path": path, "parent": parent, "dirs": dirs }));
        }
        let mut current = input.trim().to_string();
        if current.is_empty() {
            current = ssh::run(&self.paths.data, &host, "printf %s \"$HOME\"", None, language).unwrap_or_else(|_| "/".into());
            if current.trim().is_empty() { current = "/".into(); }
        }
        let quoted = ssh::bash_quote(current.trim());
        let script = format!(r#"cd -P -- {quoted} || exit 1; printf '%s\0' "$PWD"; for dir in ./* ./.[!.]* ./..?*; do [ -d "$dir" ] || continue; printf '%s\0' "${{dir#./}}"; done"#);
        let text = match ssh::run(&self.paths.data, &host, &script, None, language) {
            Ok(text) => text,
            Err(error) => return Ok(json!({ "path": current, "parent": Value::Null, "dirs": [], "error": error })),
        };
        let mut parts = text.split('\0').filter(|part| !part.is_empty());
        let path = parts.next().unwrap_or(current.trim()).to_string();
        let dirs: Vec<Value> = parts.filter(|name| !files::default_ignore().iter().any(|rule| rule == name)).map(|name| json!({ "name": name, "path": format!("{path}/{name}") })).collect();
        let parent = if path == "/" { Value::Null } else { json!(path.rsplit_once('/').map(|(parent, _)| if parent.is_empty() { "/" } else { parent }).unwrap_or("/")) };
        Ok(json!({ "path": path, "parent": parent, "dirs": dirs }))
    }

    fn pty_create(&self, request: Value, language: &str) -> Result<Value, String> {
        let id = request["id"].as_str().filter(|id| !id.is_empty()).map(|id| id.to_string()).unwrap_or_else(|| uid("t"));
        match self.pty_create_inner(request, &id, language) {
            Ok(info) => {
                self.restore_failures.lock().expect("restore").remove(&id);
                Ok(info)
            }
            Err(error) => {
                if self.term_saved(&id) {
                    let notice = translate(language, "[无法恢复会话：{{0}}。右键终端可选择重新连接。]", &[error.clone()]);
                    self.restore_failures.lock().expect("restore").insert(id, notice);
                }
                Err(error)
            }
        }
    }

    fn pty_create_inner(&self, request: Value, id: &str, language: &str) -> Result<Value, String> {
        let project = self.project(request["projectId"].as_str().unwrap_or(""), language)?;
        if let Some(host) = self.optional_host(project["host"].as_str().unwrap_or("local"))? {
        let kind = request["kind"].as_str().unwrap_or("shell");
        let shell = request["shell"].as_str().unwrap_or("bash");
        let requested = request["agentSessionId"].as_str().filter(|value| !value.is_empty());
        let session = self.resolve_legacy(id, kind, project["path"].as_str().unwrap_or(""), requested, true, language)?;
        let (command, session) = self.resume_launch(id, kind, shell, session.as_deref());
        let restore = self.db.lock().expect("db")["settings"]["restore"] != false;
        let mut info = self.pty.create_remote(&self.paths.data, id, project["path"].as_str().unwrap_or(""), kind, shell, &command, session.as_deref(), restore, &host, language, self.emit.clone())?;
        info.as_object_mut().expect("session").remove("type");
        if info.get("launchCommand").and_then(|value| value.as_str()).unwrap_or("").is_empty() {
            info["launchCommand"] = json!(command);
        }
        return Ok(info);
    }
    let kind = request["kind"].as_str().unwrap_or("shell");
    let shell = request["shell"].as_str().unwrap_or("bash");
    let requested = request["agentSessionId"].as_str().filter(|value| !value.is_empty());
    let session = self.resolve_legacy(id, kind, project["path"].as_str().unwrap_or(""), requested, false, language)?;
    let (command, session) = self.resume_launch(id, kind, shell, session.as_deref());
    let restore = self.db.lock().expect("db")["settings"]["restore"] != false;
    let mut info = self.pty.create(&self.paths.data, id, Path::new(project["path"].as_str().unwrap_or("")), kind, shell, &command, session.as_deref(), restore, language, self.emit.clone())?;
    info.as_object_mut().expect("session").remove("type");
    if info.get("launchCommand").and_then(|value| value.as_str()).unwrap_or("").is_empty() {
        info["launchCommand"] = json!(command);
    }
    Ok(info)
}

    fn resolve_legacy(&self, id: &str, kind: &str, cwd: &str, requested: Option<&str>, remote: bool, language: &str) -> Result<Option<String>, String> {
        if kind == "shell" { return Ok(None) }
        if let Some(requested) = requested { return Ok(Some(requested.to_string())) }
        let history = pty::load_history(&self.paths.data, id);
        if history.is_empty() { return Ok(None) }
        if remote { return Err(translate(language, "旧远程 Agent 会话缺少原生 ID，原终端历史已保留；未创建空白对话", &[] as &[String])) }
        match legacy::locate(kind, cwd, &history, &self.paths.data, id, language)? {
            Some(found) => Ok(Some(found)),
            None => Err(translate(language, "无法唯一定位旧 Agent 对话，原终端历史已保留；未创建空白对话", &[] as &[String])),
        }
    }

fn resume_launch(&self, id: &str, kind: &str, shell: &str, requested: Option<&str>) -> (String, Option<String>) {
    if kind == "shell" { return (String::new(), None); }
    let base = agent_command(kind, &self.db.lock().expect("db"));
    let directory = self.paths.data.join("agent-sessions").join(pty::history_name(id));
    let launch = pty::resume_command(kind, &base, requested, &directory, shell);
    if launch.0.contains("--session-dir") {
        let _ = fs::create_dir_all(&directory);
    }
    launch
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
        let job = if let Some((host, path)) = self.remote_place(project_id, language)? {
            let payload = json!({ "root": path, "query": str_arg(args, 2), "sensitive": sensitive, "regex": regex, "whole": whole, "ignored": ignored });
            let script = if host["platform"] == "windows" { search::windows_content_script().to_string() } else { search::remote_content_shell() };
            let output = ssh::run(&self.paths.data, &host, &script, Some(payload.to_string().as_bytes()), language)?;
            ContentSearch::from_remote_output(project_id, &identity, &output, language)?
        } else {
            ContentSearch::start(&root, project_id, &identity, str_arg(args, 2), sensitive, regex, whole, &ignored, language)?
        };
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
        let job = if let Some((host, path)) = self.remote_place(project_id, language)? {
            let payload = json!({ "root": path, "query": query, "ignored": ignored });
            let script = format!("python3 -u -c {}", ssh::bash_quote(search::LINUX_TREE_SEARCH));
            let output = ssh::run(&self.paths.data, &host, &script, Some(payload.to_string().as_bytes()), language)?;
            let items: Vec<Value> = serde_json::from_str(output.trim()).map_err(|error| error.to_string())?;
            TreeSearch::from_matches(project_id, &identity, items)
        } else {
            TreeSearch::start(&root, project_id, &identity, query, &ignored, language)?
        };
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
        let path = project["path"].as_str().unwrap_or("").to_string();
        Ok((std::path::PathBuf::from(&path), format!("{host}|{path}")))
    }

    fn optional_host(&self, host_id: &str) -> Result<Option<Value>, String> {
        if host_id.is_empty() || host_id == "local" { return Ok(None) }
        self.db.lock().expect("db")["hosts"].as_array().and_then(|list| list.iter().find(|host| host["id"] == host_id).cloned()).map(Some)
            .ok_or_else(|| "主机不存在".to_string())
    }

    fn remote_place(&self, project_id: &str, language: &str) -> Result<Option<(Value, String)>, String> {
        let project = self.project(project_id, language)?;
        let host_id = project["host"].as_str().unwrap_or("local");
        let path = project["path"].as_str().unwrap_or("").to_string();
        Ok(self.optional_host(host_id)?.map(|host| (host, path)))
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

    fn trash(&self, args: &[Value], language: &str) -> Result<Value, String> {
        let project_id = str_arg(args, 0);
        let relative = str_arg(args, 1).to_string();
        let directory = bool_arg(args, 2)?;
        if let Some((host, path)) = self.remote_place(project_id, language)? {
            let script = ssh::remove_remote_script(host["platform"].as_str().unwrap_or("linux"), &path, &relative, directory, language)?;
            ssh::run(&self.paths.data, &host, &script, None, language)?;
            return Ok(Value::Null);
        }
        self.with_local(project_id, language, |root| files::trash_entry(root, &relative, directory, language).map(|_| Value::Null))
    }

    fn tree_create(&self, args: &[Value], language: &str) -> Result<Value, String> {
        let project_id = str_arg(args, 0);
        let parent = str_arg(args, 1);
        let name = str_arg(args, 2);
        let directory = bool_arg(args, 3)?;
        if let Some((host, root)) = self.remote_place(project_id, language)? {
            files::validate_entry_name(name, true, language)?;
            let relative_parent = files::clean_relative(parent, language)?;
            let relative = if relative_parent.is_empty() { name.to_string() } else { format!("{relative_parent}/{name}") };
            let script = if host["platform"] == "windows" {
                let parent_abs = if relative_parent.is_empty() { root.clone() } else { format!("{root}\\{}", relative_parent.replace('/', "\\")) };
                let dest_abs = format!("{root}\\{}", relative.replace('/', "\\"));
                ssh::windows_create_script(&root, &parent_abs, &dest_abs, directory, language)
            } else {
                ssh::linux_create_command(&root, &relative_parent, name, directory, language)
            };
            ssh::run(&self.paths.data, &host, &script, None, language)?;
            return Ok(json!(relative));
        }
        self.with_local(project_id, language, |root| files::create_entry(root, parent, name, directory, language).map(|path| json!(path)))
    }

    fn tree_rename(&self, args: &[Value], language: &str) -> Result<Value, String> {
        let project_id = str_arg(args, 0);
        let rel = str_arg(args, 1);
        let name = str_arg(args, 2);
        let directory = bool_arg(args, 3)?;
        if let Some((host, root)) = self.remote_place(project_id, language)? {
            let relative = files::clean_relative(rel, language)?;
            let parent = relative.rsplit_once('/').map(|(parent, _)| parent).unwrap_or("");
            let script = if host["platform"] == "windows" {
                ssh::windows_rename_script(&root, &relative, name, parent, directory, language)?
            } else {
                ssh::linux_rename_command(&root, &relative, name, directory, parent, language)
            };
            ssh::run(&self.paths.data, &host, &script, None, language)?;
            let next = if parent.is_empty() { name.to_string() } else { format!("{parent}/{name}") };
            return Ok(json!(next));
        }
        self.with_local(project_id, language, |root| files::rename_entry(root, rel, name, directory, language).map(|path| json!(path)))
    }

    fn tree_move(&self, args: &[Value], language: &str) -> Result<Value, String> {
        let project_id = str_arg(args, 0);
        let rel = str_arg(args, 1);
        let destination = str_arg(args, 2);
        let directory = bool_arg(args, 3)?;
        if let Some((host, root)) = self.remote_place(project_id, language)? {
            let relative = files::clean_relative(rel, language)?;
            let name = relative.rsplit_once('/').map(|(_, name)| name).unwrap_or(&relative).to_string();
            let parent = files::clean_relative(destination, language)?;
            let script = if host["platform"] == "windows" {
                ssh::windows_rename_script(&root, &relative, &name, &parent, directory, language)?
            } else {
                ssh::linux_rename_command(&root, &relative, &name, directory, &parent, language)
            };
            ssh::run(&self.paths.data, &host, &script, None, language)?;
            let next = if parent.is_empty() { name } else { format!("{parent}/{name}") };
            return Ok(json!(next));
        }
        self.with_local(project_id, language, |root| files::move_entry(root, rel, destination, directory, language).map(|path| json!(path)))
    }

    fn transfer_drop(&self, args: &[Value], language: &str) -> Result<Value, String> {
        let project_id = str_arg(args, 0).to_string();
        let parent = str_arg(args, 1).to_string();
        let sources = args.get(2).and_then(|value| value.as_array()).map(|list| list.iter().filter_map(|item| item.as_str().map(|item| item.to_string())).collect::<Vec<_>>()).unwrap_or_default();
        let project = self.project(&project_id, language)?;
        let root = project["path"].as_str().unwrap_or("").to_string();
        let host = self.optional_host(project["host"].as_str().unwrap_or("local"))?;
        let dirty = *self.dirty.lock().expect("dirty");
        self.uploads.start(self.paths.data.clone(), host, project_id, root, parent, sources, dirty, language.to_string(), self.emit.clone())
    }

    fn transfer_retry(&self, id: &str, language: &str) -> Result<Value, String> {
        let project_id = self.uploads.project_id(id).unwrap_or_default();
        let host = if project_id.is_empty() { None } else { self.optional_host(self.project(&project_id, language)?["host"].as_str().unwrap_or("local"))? };
        self.uploads.retry(self.paths.data.clone(), host, language.to_string(), self.emit.clone(), id)
    }

    fn project_menu(&self, project_id: &str, language: &str) -> Result<Value, String> {
        let project = self.project(project_id, language)?;
        let before = project.clone();
        let local = project["host"].as_str().unwrap_or("local") == "local" || project["host"].as_str().unwrap_or("").is_empty();
        let menu = menu::project_menu(language, local);
        let after = self.project(project_id, language)?;
        if before != after { return Err(translate(language, "项目记录被意外修改", &[] as &[String])); }
        Ok(menu)
    }

    fn tree_template(&self, project_id: &str, rel: &str, directory: bool, language: &str) -> Result<Value, String> {
        let project = self.project(project_id, language)?;
        let local = project["host"].as_str().unwrap_or("local") == "local" || project["host"].as_str().unwrap_or("").is_empty();
        let root = files::clean_relative(rel, language).unwrap_or_default().is_empty();
        Ok(menu::tree_menu(language, directory, local, root))
    }

    fn tree_action(&self, project_id: &str, rel: &str, _directory: bool, action: &str, language: &str) -> Result<Value, String> {
        let before = self.project(project_id, language)?;
        let root = before["path"].as_str().unwrap_or("");
        let relative = files::clean_relative(rel, language).unwrap_or_default();
        let local = before["host"].as_str().unwrap_or("local") == "local" || before["host"].as_str().unwrap_or("").is_empty();
        let full = if relative.is_empty() {
            if local { fs::canonicalize(root).map(|path| path.display().to_string()).unwrap_or_else(|_| root.to_string()) } else { root.to_string() }
        } else if root.contains('\\') {
            format!("{}\\{}", root.trim_end_matches('\\'), relative.replace('/', "\\"))
        } else {
            format!("{}/{}", root.trim_end_matches('/'), relative)
        };
        let result = match action {
            "copy-full" => Ok(json!(full)),
            "copy-relative" => Ok(json!(if relative.is_empty() { "." } else { &relative })),
            "reveal" if local => menu::reveal_path(Path::new(&full), language).map(|_| json!(full)),
            "reveal" => Err(translate(language, "远程项目不支持本机打开", &[] as &[String])),
            "create-file" | "create-directory" => Err(translate(language, "项目菜单不提供新建文件或文件夹", &[] as &[String])),
            _ => Err(translate(language, "不支持此操作", &[] as &[String])),
        }?;
        let after = self.project(project_id, language)?;
        if before != after { return Err(translate(language, "项目记录被意外修改", &[] as &[String])); }
        Ok(result)
    }

    fn picker(&self, request: Value, language: &str) -> Result<Value, String> {
        let op = request["op"].as_str().unwrap_or("");
        if op == "open" {
            let id = uid("pick");
            let host_id = request["hostId"].as_str().unwrap_or("").to_string();
            let initial = request["initial"].as_str().unwrap_or("").to_string();
            let form_path = request["formPath"].as_str().unwrap_or("").to_string();
            let mut session = Picker::open(id.clone(), host_id.clone(), initial.clone(), form_path);
            let generation = session.navigate(initial, None);
            let listing = self.path_list(&host_id, session.address.as_str(), language).unwrap_or_else(|error| json!({ "path": session.address, "parent": Value::Null, "dirs": [], "error": error }));
            session.apply(generation, listing);
            let view = session.view();
            self.pickers.lock().expect("picker").insert(id, session);
            return Ok(view);
        }
        let id = request["id"].as_str().unwrap_or("").to_string();
        let mut pickers = self.pickers.lock().expect("picker");
        let Some(session) = pickers.get_mut(&id) else { return Err(translate(language, "目录选择器已关闭", &[] as &[String])); };
        if op == "esc" {
            let form = session.esc();
            return Ok(json!({ "closed": true, "formPath": form }));
        }
        if op == "confirm" {
            return Ok(json!(session.confirm()));
        }
        if op == "begin" {
            session.navigate(request["path"].as_str().unwrap_or("").to_string(), None);
            return Ok(session.view());
        }
        if op == "click" { session.click(request["path"].as_str().unwrap_or("")); return Ok(session.view()); }
        if op == "filter" { session.filter(request["query"].as_str().unwrap_or("").to_string()); return Ok(session.view()); }
        if op == "apply" {
            let generation = request["generation"].as_u64().unwrap_or(0);
            session.apply(generation, request["listing"].clone());
            return Ok(session.view());
        }
        let host_id = session.host_id.clone();
        let generation = match op {
            "enter" => session.enter(request["path"].as_str().unwrap_or("")),
            "back" => session.back(),
            "forward" => session.forward(),
            "parent" => session.parent(),
            "home" => Some(session.home()),
            "go" => Some(session.navigate(request["path"].as_str().unwrap_or("").to_string(), None)),
            _ => None,
        };
        if let Some(generation) = generation {
            let address = session.address.clone();
            drop(pickers);
            let listing = self.path_list(&host_id, &address, language).unwrap_or_else(|error| json!({ "path": address, "parent": Value::Null, "dirs": [], "error": error }));
            let mut pickers = self.pickers.lock().expect("picker");
            if let Some(session) = pickers.get_mut(&id) { session.apply(generation, listing); }
            return Ok(pickers.get(&id).map(|session| session.view()).unwrap_or(Value::Null));
        }
        Ok(session.view())
    }

    fn term_saved(&self, id: &str) -> bool {
        let db = self.db.lock().expect("db");
        db["sessions"].as_object().is_some_and(|map| map.values().any(|list| list.as_array().is_some_and(|terms| terms.iter().any(|term| term["id"] == id))))
    }

    fn term_kind(&self, project_id: &str, term_id: &str) -> (String, String) {
        let db = self.db.lock().expect("db");
        let term = db["sessions"][project_id].as_array().and_then(|list| list.iter().find(|term| term["id"] == term_id));
        let kind = term.and_then(|term| term["kind"].as_str()).unwrap_or("shell").to_string();
        let shell = term.and_then(|term| term["shell"].as_str()).unwrap_or("bash").to_string();
        (kind, shell)
    }

    fn append_term(&self, project_id: &str, id: &str, kind: &str, shell: &str, session_id: &str) -> Result<Value, String> {
        let (terms, active, groups, selected) = {
            let db = self.db.lock().expect("db");
            let mut terms = db["sessions"][project_id].as_array().cloned().unwrap_or_default();
            terms.push(json!({ "id": id, "kind": kind, "shell": shell, "sessionId": session_id }));
            let active = db["activeTab"][project_id].as_str().unwrap_or("").to_string();
            let groups = db["workSessions"][project_id].clone();
            let selected = db["activeSession"][project_id].clone();
            (terms, active, groups, selected)
        };
        self.save_sessions(&[json!(project_id), Value::Array(terms), json!(active), groups, selected])
    }

    fn split_terminal(&self, request: Value, language: &str) -> Result<Value, String> {
        let project_id = request["projectId"].as_str().unwrap_or("").to_string();
        let session_id = request["sessionId"].as_str().unwrap_or("").to_string();
        let term_id = request["termId"].as_str().unwrap_or("").to_string();
        let direction = request["direction"].as_str().unwrap_or("");
        self.project(&project_id, language)?;
        let key = format!("{project_id}:{session_id}");
        let current = self.layouts.lock().expect("layout").get(&key).cloned().unwrap_or_else(|| vec![Tile::full(&term_id)]);
        let next_id = uid("t");
        let tiles = layout::split_tile(&current, &term_id, &next_id, direction, language)?;
        let born = self.pty.born(&term_id);
        let (kind, shell) = self.term_kind(&project_id, &term_id);
        self.pty_create(json!({ "id": next_id, "projectId": project_id, "kind": kind, "shell": shell }), language)?;
        if self.pty.born(&term_id) != born {
            return Err(translate(language, "终端已关闭", &[] as &[String]));
        }
        self.append_term(&project_id, &next_id, &kind, &shell, &session_id)?;
        self.layouts.lock().expect("layout").insert(key, tiles.clone());
        Ok(json!({ "id": next_id, "born": born, "tiles": tiles.iter().map(Tile::to_json).collect::<Vec<_>>() }))
    }

    fn merge_terminal(&self, request: Value, _language: &str) -> Result<Value, String> {
        let project_id = request["projectId"].as_str().unwrap_or("");
        let session_id = request["sessionId"].as_str().unwrap_or("");
        let kept = request["termId"].as_str().unwrap_or("");
        self.layouts.lock().expect("layout").remove(&format!("{project_id}:{session_id}"));
        Ok(json!({ "tiles": [], "born": self.pty.born(kept), "focus": kept }))
    }

    fn rename_terminal(&self, request: Value, language: &str) -> Result<Value, String> {
        let project_id = request["projectId"].as_str().unwrap_or("");
        let term_id = request["termId"].as_str().unwrap_or("");
        let cancel = request["cancel"].as_bool().unwrap_or(false);
        let mut db = self.db.lock().expect("db");
        let terms = db["sessions"][project_id].as_array_mut().ok_or_else(|| translate(language, "终端已关闭", &[] as &[String]))?;
        let term = terms.iter_mut().find(|term| term["id"] == term_id).ok_or_else(|| translate(language, "终端已关闭", &[] as &[String]))?;
        if cancel {
            return Ok(json!({ "focus": term_id, "cancelled": true, "name": term["name"].clone() }));
        }
        let cleaned = layout::display_name(request["name"].as_str().unwrap_or(""));
        if cleaned.is_empty() { return Err(translate(language, "名称不能为空", &[] as &[String])); }
        term["name"] = json!(cleaned.clone());
        drop(db);
        self.persist()?;
        Ok(json!({ "focus": term_id, "cancelled": false, "name": cleaned }))
    }

    fn terminal_failure(&self, id: &str) -> Value {
        match self.restore_failures.lock().expect("restore").get(id) {
            Some(notice) => json!({ "reconnect": true, "notice": notice }),
            None => json!({ "reconnect": false }),
        }
    }

    fn terminal_hook(&self, id: &str) -> Value {
        match self.pty.hook(id) {
            Some((port, token)) => json!({ "port": port, "token": token }),
            None => Value::Null,
        }
    }
    fn transfer_pick(&self, args: &[Value], language: &str) -> Result<Value, String> {
        let kind = str_arg(args, 2);
        if kind != "files" && kind != "directory" { return Err(translate(language, "导入参数无效", &[] as &[String])) }
        let paths = menu::choose_open_paths(kind);
        if paths.is_empty() { return Ok(Value::Null) }
        let project = str_arg(args, 0);
        let parent = str_arg(args, 1);
        let sources = Value::Array(paths.into_iter().map(|path| json!(path)).collect());
        self.transfer_drop(&[json!(project), json!(parent), sources], language)
    }

    fn transfer_download(&self, args: &[Value], language: &str) -> Result<Value, String> {
        let Some((host, root)) = self.remote_place(str_arg(args, 0), language)? else { return Err(translate(language, "请选择远程对象", &[] as &[String])) };
        let relative = files::clean_relative(str_arg(args, 1), language)?;
        if relative.is_empty() { return Err(translate(language, "请选择远程对象", &[] as &[String])) }
        let directory = bool_arg(args, 2).map_err(|_| translate(language, "下载参数无效", &[] as &[String]))?;
        let name = relative.rsplit('/').next().unwrap_or(&relative);
        let Some(chosen) = menu::choose_save_path(language, "download")? else { return Ok(Value::Null) };
        let destination = PathBuf::from(chosen);
        if destination.as_os_str().is_empty() { return Ok(Value::Null) }
        if destination.exists() { return Err(translate(language, "目标已存在，请选择新的文件名或目录", &[] as &[String])) }
        let remote = format!("{root}/{}", relative);
        let script = if directory {
            format!("tar -C {} -cf - {}", ssh::bash_quote(&remote.rsplit_once('/').map(|(parent, _)| parent).unwrap_or(&root)), ssh::bash_quote(name))
        } else {
            format!("cat -- {}", ssh::bash_quote(&remote))
        };
        let bytes = ssh::run(&self.paths.data, &host, &script, None, language).map_err(|_| translate(language, "下载失败", &[] as &[String]))?;
        if let Some(parent) = destination.parent() { std::fs::create_dir_all(parent).map_err(|error| error.to_string())?; }
        std::fs::write(&destination, bytes.as_bytes()).map_err(|_| translate(language, "下载失败", &[] as &[String]))?;
        Ok(json!(destination.display().to_string()))
    }

    fn open_html(&self, project_id: &str, relative: &str, language: &str) -> Result<Value, String> {
        let lower = relative.to_ascii_lowercase();
        if !lower.ends_with(".html") && !lower.ends_with(".htm") { return Err(translate(language, "仅支持在浏览器中预览 HTML 文件", &[] as &[String])) }
        let url = self.preview_url(&[json!(project_id), json!(relative), Value::Null], language)?;
        let href = url.as_str().unwrap_or("").to_string();
        menu::open_external(&href);
        Ok(json!(href))
    }

    fn file_link(&self, project_id: &str, source: &str, href: &str, language: &str) -> Result<Value, String> {
        if href.len() > 8192 { return Err(translate(language, "无效的链接", &[] as &[String])) }
        let trimmed = href.trim();
        if trimmed.contains("://") || trimmed.starts_with("//") {
            if !web_link(trimmed) { return Err(translate(language, "仅支持网页链接和项目内文件链接", &[] as &[String])) }
            menu::open_external(trimmed);
            return Ok(Value::Null);
        }
        let project = self.project(project_id, language)?;
        let root = PathBuf::from(project["path"].as_str().unwrap_or(""));
        let base = root.join(source);
        let (path_part, anchor) = trimmed.split_once('#').map(|(path, anchor)| (path, Some(anchor.to_string()))).unwrap_or((trimmed, None));
        let path_part = path_part.split('?').next().unwrap_or("");
        let decoded = percent_decode(path_part);
        let joined = if decoded.starts_with('/') { root.join(decoded.trim_start_matches('/')) } else { base.parent().unwrap_or(&root).join(decoded) };
        let relative = joined.strip_prefix(&root).map_err(|_| translate(language, "仅支持网页链接和项目内文件链接", &[] as &[String]))?;
        Ok(json!({ "path": relative.to_string_lossy().replace('\\', "/"), "anchor": anchor }))
    }

    fn tree_reference(&self, project_id: &str, relative: &str, shell: &str, kind: &str, language: &str) -> Result<Value, String> {
        if relative.chars().any(|ch| (ch as u32) < 32 || ch as u32 == 127) { return Err(translate(language, "此路径包含终端控制字符，无法引用", &[] as &[String])) }
        let project = self.project(project_id, language)?;
        let path = PathBuf::from(project["path"].as_str().unwrap_or("")).join(relative);
        if project["host"] == "local" && !path.is_file() { return Err(translate(language, "请选择文件", &[] as &[String])) }
        if kind != "shell" { return Ok(json!(path.display().to_string())) }
        let text = path.display().to_string();
        let quoted = match shell {
            "pwsh" => ssh::ps_quote(&text),
            "cmd" => {
                if text.contains(['%', '!', '"']) { return Err(translate(language, "此路径无法安全引用到 CMD", &[] as &[String])) }
                format!("\"{text}\"")
            }
            "bash" | "zsh" => ssh::bash_quote(&text.replace('\\', "/")),
            _ => return Err(translate(language, "不支持此终端", &[] as &[String])),
        };
        Ok(json!(quoted))
    }

    fn pick_directory(&self, language: &str) -> Result<Value, String> {
        if let Ok(value) = std::env::var("AWB_DIRECTORY") {
            return Ok(if value.is_empty() { Value::Null } else { json!(value) });
        }
        if std::env::var("AWB_SKIP_ZENITY").ok().as_deref() != Some("1") {
            for program in ["zenity", "kdialog"] {
                let mut command = std::process::Command::new(program);
                if program == "zenity" { command.args(["--file-selection", "--directory"]); }
                else { command.args(["--getexistingdirectory", &std::env::var("HOME").unwrap_or_else(|_| "/".into())]); }
                if let Ok(output) = command.output() {
                    if output.status.success() {
                        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                        if !path.is_empty() { return Ok(json!(path)) }
                    }
                }
            }
        }
        self.picker(json!({ "op": "open", "hostId": "local", "initial": std::env::var("HOME").unwrap_or_else(|_| "/".into()) }), language)
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


fn web_link(href: &str) -> bool {
    let rest = href.strip_prefix("https://").or_else(|| href.strip_prefix("http://"));
    let Some(rest) = rest else { return false };
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    !host.is_empty() && !host.contains('@')
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(std::str::from_utf8(&bytes[index + 1..index + 3]).unwrap_or(""), 16) {
                out.push(byte);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn node_platform() -> &'static str {
    match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        other => other,
    }
}

fn json_usize(value: Option<&Value>) -> usize {
    value.and_then(|item| item.as_u64().or_else(|| item.as_f64().map(|number| number as u64))).unwrap_or(1) as usize
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
