//! Command dispatch shared by the Tauri shell and the behavior tests.
//! Channel names match the Electron IPC names in `src/preload/index.ts`.

use crate::download;
use crate::files::{self, default_ignore};
use crate::gate::Gate;
use crate::git;
use crate::i18n::{self, translate};
use crate::import;
use crate::legacy;
use crate::menu;
use crate::paths::Paths;
use crate::picker::Session as Picker;
use crate::preview;
use crate::pty::{self, Manager};
use crate::resources;
use crate::search::{self, ContentSearch, TreeSearch};
use crate::shell;
use crate::shells::{self, installed_agents};
use crate::ssh;
use crate::store::{self, apply_saved_settings, host_color, public_host, PlatformInfo};
use crate::temporary;
use crate::templates;
use crate::updates;
use crate::upload;
use crate::{random_id, uid};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

type Emit = Arc<dyn Fn(Value) + Send + Sync>;

/// Where an entry of a project's tree is, as the Electron build's `treePath`
/// resolves it: the path on its machine and the relative one. `root` is the
/// real path of the entry on this machine, and the project's path joined
/// with the relative one on another.
struct TreePlace {
    local: bool,
    root: String,
    relative: String,
    platform: String,
}

pub struct Workbench {
    pub paths: Paths,
    /// Passes the calls that write the database one at a time, in the order
    /// they were sent in.
    saves: Arc<Gate>,
    db: Mutex<Value>,
    pty: Manager,
    dirty: Arc<Mutex<bool>>,
    content_searches: Mutex<HashMap<String, ContentSearch>>,
    /// The stop flag of each content search, kept apart from the search so
    /// that a search can be stopped while its next batch is being waited
    /// for, which holds the lock on the searches.
    content_stops: Mutex<HashMap<String, crate::ssh::CancelFlag>>,
    tree_searches: Mutex<HashMap<String, TreeSearch>>,
    restore_failures: Mutex<HashMap<String, String>>,
    preview: preview::Service,
    resources: resources::Resources,
    updates: Mutex<updates::Service>,
    uploads: upload::Service,
    downloads: download::Service,
    imports: import::Imports,
    pickers: Mutex<HashMap<String, Picker>>,
    history_flushed: Mutex<bool>,
    closing: AtomicBool,
    emit: Emit,
}

fn fixture_directory(input: &str) -> Result<Value, String> {
    if input == "/slow" { std::thread::sleep(std::time::Duration::from_millis(500)); }
    let current = if input.is_empty() { "/home/tester" } else { input };
    if current == "/throws" { return Err("Connection lost".into()); }
    if current == "/denied" {
        return Ok(json!({ "path": current, "parent": "/", "dirs": [], "error": "Permission denied" }));
    }
    let dirs = if current == "/empty" {
        Vec::new()
    } else {
        vec![
            json!({ "name": "projects", "path": "/home/tester/projects" }),
            json!({ "name": "下载", "path": "/home/tester/下载" }),
        ]
    };
    Ok(json!({ "path": current, "parent": if current == "/" { Value::Null } else { json!("/") }, "dirs": dirs }))
}

impl Workbench {
    pub fn open(paths: Paths, emit: Emit) -> Result<Self, String> {
        paths.prepare()?;
        let file = paths.data.join("workbench.json");
        let (mut db, rewrite) = store::load_database(&file, PlatformInfo::current());
        // Templates and their bindings are kept as they were written, and a
        // database from before there were templates has each custom
        // executor's own paths turned into one, once.
        let raw = fs::read(&file).ok().and_then(|bytes| String::from_utf8(bytes).ok()).and_then(|text| serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}')).ok());
        let old_targets = fs::read(paths.data.join("resource-targets.json")).ok()
            .map(|bytes| String::from_utf8_lossy(&bytes).trim_start_matches('\u{feff}').to_string())
            .and_then(|text| serde_json::from_str::<Value>(&text).ok()).unwrap_or_else(|| json!({}));
        if templates::adopt(&mut db, raw.as_ref(), &old_targets, "zh-CN") || rewrite {
            store::save_database(&file, &db)?;
        }
        let ids = session_ids(&db);
        pty::prune_history(&paths.data, &ids);
        if !db["settings"]["language"].is_string() {
            db["settings"]["language"] = json!("zh-CN");
        }
        let updates = updates::Service::new(db["settings"]["autoCheckUpdates"] != false);
        Ok(Self { paths, saves: Arc::new(Gate::new()), db: Mutex::new(db), pty: Manager::new(), dirty: Arc::new(Mutex::new(false)), content_searches: Mutex::new(HashMap::new()), content_stops: Mutex::new(HashMap::new()), tree_searches: Mutex::new(HashMap::new()), restore_failures: Mutex::new(HashMap::new()), preview: preview::Service::new(), resources: resources::Resources::new(), updates: Mutex::new(updates), uploads: upload::Service::new(),
            downloads: download::Service::new(), imports: import::Imports::new(), pickers: Mutex::new(HashMap::new()), history_flushed: Mutex::new(false), closing: AtomicBool::new(false), emit })
    }

    /// The shell renders a diagram in a hidden window of its own, as the
    /// Electron build does, and installs that renderer here once it is ready.
    /// Until then a diagram fails with a clear message instead of launching a
    /// browser that is not there.
    pub fn set_diagram_renderer(&self, renderer: preview::Renderer) {
        self.preview.set_renderer(renderer);
    }

    /// A call that saves a whole section of the database takes a place in line
    /// here, before it goes to its thread, and waits for the calls before it.
    pub fn save_order(&self) -> std::sync::Arc<crate::gate::Gate> {
        std::sync::Arc::clone(&self.saves)
    }

    /// The calls that pass the gate: each sends a whole section as the page
    /// drew it, so one written over a later one would carry changes back.
    /// A save of the machines does not pass it: it tests connections first,
    /// as the Electron build does outside its `mutate`.
    pub const SAVED_CHANNELS: [&'static str; 6] = ["db:settings", "db:projects", "db:custom", "templates:save", "templates:bind", "templates:delete"];

    /// The window close handler calls this once. Later terminal creates fail
    /// while the existing sessions are still being closed.
    pub fn begin_shutdown(&self) -> bool {
        self.closing.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_ok()
    }

    pub fn shutdown_sessions(&self) {
        // The renderer owns the visible scrollback. Wait for its snapshot,
        // the same way Electron waits for terminal:history-flushed, then
        // close every PTY before the process exits.
        *self.history_flushed.lock().expect("flush") = false;
        (self.emit)(json!({ "channel": "terminal:history-flush" }));
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while std::time::Instant::now() < deadline {
            if *self.history_flushed.lock().expect("flush") { break }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        // Electron closes the sessions and the transfers side by side and
        // waits for both. A transfer that does not stop does not keep the
        // window from closing: the wait has an end, and the process exits
        // either way.
        std::thread::scope(|scope| {
            let transfers = scope.spawn(|| {
                self.downloads.shutdown(std::time::Duration::from_secs(10));
                self.uploads.shutdown(std::time::Duration::from_secs(10)) | self.imports.shutdown(std::time::Duration::from_secs(10))
            });
            self.pty.close_all();
            let _ = transfers.join();
        });
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
            "db:custom" => self.save_custom(args.first().cloned().unwrap_or(json!([])), args.get(1).cloned().unwrap_or(json!([])), &language),
            "db:hosts" => self.save_hosts(args.first().cloned().unwrap_or(json!([]))),
            "templates:save" => self.save_template(args.first().cloned().unwrap_or(json!({})), &language),
            "templates:bind" => self.bind_template(args.first().cloned().unwrap_or(json!({})), str_arg(args, 1), &language),
            "templates:delete" => self.delete_template(str_arg(args, 0), &language),
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
            "git:refresh" => Ok(self.git_refresh(&str_arg(args, 0), str_arg(args, 1), args.get(2).and_then(|value| value.as_str()), &language)?.unwrap_or(Value::Null)),
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
            "terminal:failure" => Ok(self.terminal_failure(str_arg(args, 0))),
            "terminal:hook" => Ok(self.terminal_hook(str_arg(args, 0))),
            // While the workbench is closing, nothing more is asked of a
            // terminal: what is written, resized or ended is ignored, and an
            // interrupt is answered as the signal the Electron build answers.
            "pty:write" if self.closing.load(Ordering::SeqCst) => Ok(Value::Null),
            "pty:write" => { let bytes = pty_bytes(str_arg(args, 1), args.get(2).and_then(|value| value.as_bool()).unwrap_or(false)); self.pty.write(str_arg(args, 0), &bytes, &self.emit); Ok(Value::Null) }
            "pty:shift-enter" => { if !self.closing.load(Ordering::SeqCst) { self.pty.shift_enter(str_arg(args, 0), &self.emit); } Ok(Value::Null) }
            "pty:resize" => { if !self.closing.load(Ordering::SeqCst) { self.pty.resize(str_arg(args, 0), number_arg(args, 1) as u16, number_arg(args, 2) as u16); } Ok(Value::Null) }
            "pty:interrupt" => {
                if self.closing.load(Ordering::SeqCst) { return Ok(json!("signal")) }
                Ok(json!(self.pty.interrupt(str_arg(args, 0), &self.emit)))
            }
            // Ending what runs keeps the terminal; closing ends the terminal.
            "pty:kill" => { if !self.closing.load(Ordering::SeqCst) { self.pty.force_kill(str_arg(args, 0), &self.emit); } Ok(Value::Null) }
            // Closing one terminal while the workbench closes closes them
            // all; otherwise it closes that one and deletes its history, as
            // the tab is closed for good.
            "pty:close" => {
                if self.closing.load(Ordering::SeqCst) { self.pty.close_all(); return Ok(Value::Null) }
                let id = str_arg(args, 0);
                self.pty.close(&id);
                pty::delete_history(&self.paths.data, &id);
                Ok(Value::Null)
            }            "pty:restart" => self.pty_restart(str_arg(args, 0), &language),
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
            "transfer:cancel" => {
                let id = str_arg(args, 0);
                if self.downloads.cancel(id) || self.imports.cancel(id) { Ok(Value::Null) } else { self.uploads.cancel(id, &language) }
            }
            "transfer:retry" => {
                let id = str_arg(args, 0);
                if self.downloads.has(id) { self.download_retry(id, &language) }
                else if self.imports.project_id(id).is_some() {
                    self.validate_transfer_target(id, &language)?;
                    self.imports.retry(id, language.to_string())
                } else { self.transfer_retry(id, &language) }
            }
            "transfer:dismiss" => {
                let id = str_arg(args, 0);
                if self.downloads.dismiss(id) || self.imports.dismiss(id) { Ok(Value::Null) } else { self.uploads.dismiss(id) }
            }
            "transfer:keep-both" => {
                let id = str_arg(args, 0);
                if self.imports.project_id(id).is_some() {
                    self.validate_transfer_target(id, &language)?;
                    self.imports.keep_both(id, language.to_string())
                } else { Err(translate(&language, "上传不再询问同名处理", &[] as &[String])) }
            }
            "transfer:decide" => {
                let id = str_arg(args, 0);
                if self.imports.waiting(id) { self.imports.decide(id, str_arg(args, 1), args.get(2).and_then(|value| value.as_bool()).unwrap_or(false), &language) }
                else { Err(translate(&language, "上传不再询问同名处理", &[] as &[String])) }
            }
            "transfer:inject" => {
                let payload = args.first().cloned().unwrap_or(Value::Null);
                if !payload.is_object() { return Err(translate(&language, "传输任务不存在", &[] as &[String])); }
                (self.emit)(json!({ "channel": "transfer:update", "payload": payload }));
                Ok(Value::Null)
            }
            "file:replacement-ready" => {
                let (id, allow) = (str_arg(args, 0), args.get(1).and_then(|value| value.as_bool()).unwrap_or(false));
                if !self.imports.allow(id, allow) { self.uploads.confirm(id, allow); }
                Ok(Value::Null)
            }
            "exec:test" => self.test_exec(args.first().cloned().unwrap_or(json!({})), &language),
            "host:test" => Ok(ssh::test_connection(&self.paths.data, args.first().unwrap_or(&Value::Null), &language)),
            "app:update-state" => Ok(self.updates.lock().expect("updates").state()),
            "app:update-check" => self.update_check(),
            "app:update-download" => self.update_download(),
            "app:update-install" => Ok(json!(self.update_install())),
            "app:meta" => {
                let language = self.db.lock().expect("db")["settings"]["language"].as_str().unwrap_or("zh-CN").to_string();
                Ok(json!({ "version": env!("CARGO_PKG_VERSION"), "author": if language == "en" { "FangYang" } else { "方阳" }, "homepage": HOMEPAGE, "capture": std::env::var("AWB_CAPTURE").ok().as_deref() == Some("1"), "platform": node_platform(), "shots": std::env::var_os("AWB_SHOTS").is_some() }))
            }
            "app:homepage" => { shell::open_external(HOMEPAGE); Ok(Value::Null) }
            "app:shot" => Ok(json!(false)),
            "dialog:directory" => self.pick_directory(&language),
            "dialog:picker" => self.picker(args.first().cloned().unwrap_or(json!({})), &language),
            "menu:app" => Ok(menu::app_menu(&language)),
            "menu:project" => self.project_menu(str_arg(args, 0), &language),
            "menu:file" => Ok(menu::file_menu(&language, args.first().unwrap_or(&Value::Null))),
            "menu:preview" => Ok(menu::preview_menu(&language)),
            "menu:tree" => self.tree_template(str_arg(args, 0), str_arg(args, 1), bool_arg(args, 2).unwrap_or(false), &language),
            "menu:save" => Ok(menu::save_dialog(&language, str_arg(args, 0), args.get(1).and_then(Value::as_str).unwrap_or(""))),
            "menu:open" => Ok(menu::open_dialog(&language, str_arg(args, 0))),
            "tree:menu" => self.tree_template(str_arg(args, 0), str_arg(args, 1), bool_arg(args, 2).unwrap_or(false), &language),
            "file:menu" => Ok(menu::file_menu(&language, args.first().unwrap_or(&Value::Null))),
            // The panes are laid out by the page; the kernel only says which
            // splits a pane may still take.
            "workspace:menu" => Ok(menu::pane_menu(&language, args.first().unwrap_or(&Value::Null))),
            "tree:action" => self.tree_action(str_arg(args, 0), str_arg(args, 1), bool_arg(args, 2).unwrap_or(false), str_arg(args, 3), &language),
            // What a copy put on the clipboard, for a test to see: only a
            // clipboard kept in a file is read, never the user's own.
            "clipboard:read" => Ok(shell::read_clipboard().map(Value::String).unwrap_or(Value::Null)),
            // The executors on a machine and what resources each has there.
            "resources:targets" => resources::targets(&self.paths.data, &self.db.lock().expect("db").clone(), args.first().and_then(|value| value.as_str()).unwrap_or("local"), &language),
            // A recommended Skill repository's page, opened in the browser.
            "resources:open-recommendation" => resources::open_recommendation(str_arg(args, 0), &language).map(|_| Value::Null),
            "resources:list" => resources::list(&self.paths.data, &self.db.lock().expect("db").clone(), str_arg(args, 0), args.get(1).unwrap_or(&Value::Null), json_usize(args.get(2)), str_arg(args, 3), &language),
            "resources:toggle" => resources::toggle(&self.paths.data, &self.db.lock().expect("db").clone(), str_arg(args, 0), args.get(1).unwrap_or(&Value::Null), args.get(2).unwrap_or(&Value::Null), args.get(3).and_then(|value| value.as_bool()), &language).map(|_| Value::Null),
            "resources:detail" => resources::detail(&self.paths.data, &self.db.lock().expect("db").clone(), str_arg(args, 0), args.get(1).unwrap_or(&Value::Null), args.get(2).unwrap_or(&Value::Null), &language),
            // Opening and removing a Skill folder find it themselves, as the
            // Electron build does: the path is not handed over by the page.
            "resources:skill-open" => resources::open_skill(&self.paths.data, &self.db.lock().expect("db").clone(), args.first().unwrap_or(&Value::Null), args.get(1).unwrap_or(&Value::Null), &language),
            "resources:skill-delete" => resources::delete_skill(&self.paths.data, &self.db.lock().expect("db").clone(), args.first().unwrap_or(&Value::Null), args.get(1).unwrap_or(&Value::Null), &language),
            "resources:mcp" => resources::add_mcp(&self.resources, &self.paths.data, &self.db.lock().expect("db").clone(), str_arg(args, 0), args.get(1).unwrap_or(&Value::Null), args.get(2).and_then(|value| value.as_array()).map(|list| list.as_slice()).unwrap_or(&[]), true, &language),
            "resources:scan" => resources::scan(&self.db.lock().expect("db").clone(), str_arg(args, 0), str_arg(args, 1), args.get(2).and_then(|value| value.as_str()).unwrap_or("local"), &language),
            "resources:import-mcp" => resources::import_mcp(&self.resources, &self.paths.data, &self.db.lock().expect("db").clone(), str_arg(args, 0), args.get(1).and_then(|value| value.as_array()).map(|list| list.as_slice()).unwrap_or(&[]), args.get(2).and_then(|value| value.as_array()).map(|list| list.as_slice()).unwrap_or(&[]), args.get(3).and_then(|value| value.as_str()).unwrap_or("local"), &language),
            "resources:skills" => resources::import_skills(&self.resources, &self.paths.data, &self.db.lock().expect("db").clone(), str_arg(args, 0), args.get(1).and_then(|value| value.as_array()).map(|list| list.as_slice()).unwrap_or(&[]), args.get(2).and_then(|value| value.as_array()).map(|list| list.iter().filter_map(|item| item.as_str().map(|item| item.to_string())).collect::<Vec<_>>()).as_ref(), &language),
            "resources:pick" => Ok(menu::choose_open_path(str_arg(args, 0), &language)),
            // A folder on an SSH machine, to choose a path on it.
            "resources:browse" => resources::browse(&self.paths.data, &self.db.lock().expect("db").clone(), str_arg(args, 0), str_arg(args, 1), bool_arg(args, 2).unwrap_or(false), &language),
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

    /// Writes the database as it is at this moment. The file is written
    /// while the database is held, so that no change slips in between the
    /// two and is written over by a file that was made before it.
    fn persist(&self) -> Result<Value, String> {
        let db = self.db.lock().expect("db");
        store::save_database(&self.database_path(), &db)?;
        Ok(db.clone())
    }

    fn save_settings(&self, settings: Value) -> Result<Value, String> {
        let settings = apply_saved_settings(settings);
        let previous = self.db.lock().expect("db")["settings"].clone();
        let previous_updates = previous["autoCheckUpdates"] != false;
        self.updates.lock().expect("updates").set_enabled(settings["autoCheckUpdates"] != false);
        self.db.lock().expect("db")["settings"] = settings;
        match self.persist() {
            Ok(db) => Ok(db),
            Err(error) => {
                self.updates.lock().expect("updates").set_enabled(previous_updates);
                self.db.lock().expect("db")["settings"] = previous;
                Err(error)
            }
        }
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
            match menu::choose_save_path(language, "history", "")? {
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

    fn save_custom(&self, custom: Value, bindings: Value, language: &str) -> Result<Value, String> {
        // Each executor's own paths and session arguments are taken as the
        // settings dialog drew them, before anything of the database changes.
        let mut next = self.db.lock().expect("db").clone();
        next["custom"] = custom.clone();
        let local = templates::machine(&next, "local", false, language)?.clone();
        for executor in custom.as_array().cloned().unwrap_or_default() {
            if executor.get("resources").is_some_and(|value| !value.is_null()) {
                templates::validate_resource_paths(&executor["resources"], local["platform"] == "windows", language)?;
            }
            templates::validate_custom_session(executor.get("session"), language)?;
        }
        templates::prune(&mut next);
        for binding in bindings.as_array().cloned().unwrap_or_default() {
            let executor_id = binding["executorId"].as_str().unwrap_or("").to_string();
            if !custom.as_array().is_some_and(|list| list.iter().any(|executor| executor["id"].as_str() == Some(executor_id.as_str()))) {
                return Err(translate(language, "执行器不存在", &[] as &[String]));
            }
            templates::bind(&mut next, &binding, binding["templateId"].as_str().unwrap_or(""), language)?;
        }
        self.replace(next)
    }

    fn save_template(&self, template: Value, language: &str) -> Result<Value, String> {
        let mut next = self.db.lock().expect("db").clone();
        templates::put(&mut next, &template, language)?;
        self.replace(next)
    }

    fn bind_template(&self, scope: Value, template_id: &str, language: &str) -> Result<Value, String> {
        let mut next = self.db.lock().expect("db").clone();
        templates::bind(&mut next, &scope, template_id, language)?;
        self.replace(next)
    }

    fn delete_template(&self, id: &str, language: &str) -> Result<Value, String> {
        let mut next = self.db.lock().expect("db").clone();
        templates::delete(&mut next, id, language)?;
        self.replace(next)
    }

    /// Writes a whole database as it would be, and only then makes it the
    /// one in memory: a write that fails leaves nothing changed.
    fn replace(&self, next: Value) -> Result<Value, String> {
        store::save_database(&self.database_path(), &next)?;
        *self.db.lock().expect("db") = next.clone();
        Ok(next)
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
        // Templates of a machine that is gone go with it, and so does every
        // executor's launch on that machine.
        let mut db = self.db.lock().expect("db").clone();
        db["hosts"] = Value::Array(next);
        templates::prune(&mut db);
        let kept: Vec<String> = db["hosts"].as_array().map(|hosts| hosts.iter().filter_map(|host| host["id"].as_str().map(str::to_string)).collect()).unwrap_or_default();
        if let Some(custom) = db["custom"].as_array_mut() {
            for executor in custom {
                if let Some(over) = executor["hosts"].as_object_mut() {
                    over.retain(|id, _| kept.iter().any(|host| host == id));
                }
            }
        }
        self.replace(db)
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
        // A plain read is a refresh that was never read before.
        Ok(self.git_refresh(project_id, rel, None, language)?.unwrap_or(files::missing_file()))
    }

    /// Read a file of a project again, as the page asks when it comes back
    /// to a tab or a file is said to have changed. Asked with the stamp the
    /// file had when it was last read, `None` says it is the same file at
    /// the same moment, and nothing is sent again.
    fn git_refresh(&self, project_id: &str, rel: &str, known: Option<&str>, language: &str) -> Result<Option<Value>, String> {
        if let Some((host, path)) = self.remote_place(project_id, language)? {
            return git::read_remote_stamped(&self.paths.data, &host, &path, rel, known, language);
        }
        files::read_local_stamped(&self.local_root(project_id, language)?, rel, known, language)
    }

    fn git_write(&self, project_id: &str, rel: &str, text: &str, version: Option<&str>, language: &str) -> Result<Value, String> {
        if self.uploads.write_blocked(project_id, rel) {
            return Err(translate(language, "文件正在进行其他写入操作", &[] as &[String]));
        }
        // A local transfer replaces a file through the same guard as Electron's
        // `guardReplacement`: while it waits for the page, the file is locked.
        if self.imports.write_blocked(project_id, rel) {
            return Err(translate(language, "文件正在进行其他写入操作", &[] as &[String]));
        }
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

    /// The machine a path is checked or listed on, by its id: as the
    /// Electron build finds it, an id that is no machine's is the first
    /// machine's, which is this one. Whether the machine is connected is not
    /// asked here: a path is checked on a machine that is not connected yet,
    /// and what the machine says of it is what the page is told.
    fn path_host(&self, host_id: &str) -> Option<Value> {
        let db = self.db.lock().expect("db");
        let hosts = db["hosts"].as_array()?;
        let found = hosts.iter().find(|host| host["id"] == host_id).or_else(|| hosts.first())?;
        (found["id"] != "local").then(|| found.clone())
    }

    /// Whether a path is written from the root of a machine, as that machine
    /// spells it: a drive and a backslash on Windows, a slash elsewhere.
    fn absolute_on(value: &str, platform: &str) -> bool {
        let bytes = value.as_bytes();
        if platform == "windows" { return bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'\\' }
        bytes.first() == Some(&b'/')
    }

    fn path_check(&self, host_id: &str, input: &str, language: &str) -> Result<Value, String> {
        let Some(host) = self.path_host(host_id) else { return Ok(files::check_path(input, language)) };
        let value = input.trim();
        if value.is_empty() { return Ok(json!({ "kind": "empty" })) }
        let windows = host["platform"] == "windows";
        // Asked before anything is, as the Electron build asks: an invalid path
        // is refused without a machine being reached.
        if !Self::absolute_on(value, if windows { "windows" } else { "linux" }) || value.contains('\0') { return Ok(json!({ "kind": "invalid" })) }
        let data = &self.paths.data;
        let said = |command: String| ssh::run(data, &host, &command, None, language);
        let exists = if windows {
            said(format!("if (Test-Path -LiteralPath {} -PathType Container) {{ 'yes' }}", ssh::ps_quote(value)))
        } else {
            said(format!("if [ -d {} ]; then echo yes; fi", ssh::bash_quote(value)))
        };
        let exists = match exists {
            Ok(text) => text.trim() == "yes",
            // What the machine said of it, and not that the path is not there.
            Err(detail) => return Ok(json!({ "kind": "error", "detail": detail })),
        };
        if !exists { return Ok(json!({ "kind": "missing" })) }
        let inside = git::git_remote(data, &host, value, &["rev-parse", "--is-inside-work-tree"], language);
        if inside.as_deref().map(str::trim) != Ok("true") { return Ok(json!({ "kind": "plain" })) }
        let branch = git::git_remote(data, &host, value, &["rev-parse", "--abbrev-ref", "HEAD"], language).map(|text| text.trim().to_string()).unwrap_or_default();
        Ok(json!({ "kind": "git", "branch": branch }))
    }

    fn path_list(&self, host_id: &str, input: &str, language: &str) -> Result<Value, String> {
        if std::env::var("AWB_PATH_FIXTURE").ok().as_deref() == Some("1") {
            return fixture_directory(input);
        }
        let Some(host) = self.path_host(host_id) else { return Ok(files::list_dir(input)) };
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
        if self.closing.load(Ordering::SeqCst) {
            return Err(translate(language, "工作台正在关闭", &[] as &[String]));
        }
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
        if let Some(host) = self.optional_host(project["host"].as_str().unwrap_or("local"), language)? {
        if host["on"] == false {
            return Err(translate(language, "这台机器未连接", &[] as &[String]));
        }
        let kind = request["kind"].as_str().unwrap_or("shell");
        let shell = request["shell"].as_str().unwrap_or("bash");
        let requested = request["agentSessionId"].as_str().filter(|value| !value.is_empty());
        let session = self.resolve_legacy(id, kind, project["path"].as_str().unwrap_or(""), requested, true, language)?;
        let (command, session, shell) = self.resume_launch(id, kind, shell, session.as_deref(), host["id"].as_str().unwrap_or("local"), language)?;
        let restore = self.db.lock().expect("db")["settings"]["restore"] != false;
        let mut info = self.pty.create_remote(&self.paths.data, id, project["path"].as_str().unwrap_or(""), kind, &shell, &command, session.as_deref(), restore, &host, language, self.emit.clone())?;
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
    let (command, session, shell) = self.resume_launch(id, kind, shell, session.as_deref(), "local", language)?;
    let restore = self.db.lock().expect("db")["settings"]["restore"] != false;
    let env = self.launch_env("local", kind);
    let mut info = self.pty.create(&self.paths.data, id, Path::new(project["path"].as_str().unwrap_or("")), kind, &shell, &command, session.as_deref(), restore, language, self.emit.clone(), &env)?;
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

    /// The environment a terminal of an executor is given on a machine: the
    /// template lent to it there, else nothing beyond the shell's own.
    fn launch_env(&self, host_id: &str, kind: &str) -> Vec<(String, String)> {
        let db = self.db.lock().expect("db").clone();
        templates::executor_template(&db, host_id, kind).map(|template| template["env"].as_array().cloned().unwrap_or_default()).unwrap_or_default().iter()
            .filter_map(|row| Some((row["k"].as_str()?.to_string(), row["v"].as_str().unwrap_or("").to_string())))
            .filter(|(key, _)| !key.is_empty()).collect()
    }

    /// What a terminal of an executor runs: a built-in executor's own
    /// command, a custom one's as its machine overrides it and with the
    /// session the template lent to it there names. Says the shell too, as a
    /// machine may change it.
    fn resume_launch(&self, id: &str, kind: &str, shell: &str, requested: Option<&str>, host_id: &str, language: &str) -> Result<(String, Option<String>, String), String> {
        if kind == "shell" { return Ok((String::new(), None, shell.to_string())); }
        let db = self.db.lock().expect("db").clone();
        let Some(executor) = db["custom"].as_array().and_then(|list| list.iter().find(|item| item["id"] == kind)) else {
            let base = agent_command(kind, &db);
            let directory = self.paths.data.join("agent-sessions").join(pty::history_name(id));
            let launch = pty::resume_command(kind, &base, requested, &directory, shell);
            if launch.0.contains("--session-dir") {
                let _ = fs::create_dir_all(&directory);
            }
            return Ok((launch.0, launch.1, shell.to_string()));
        };
        let config = templates::effective_executor(executor, host_id, templates::executor_template(&db, host_id, kind));
        let effective_shell = config["shell"].as_str().filter(|value| !value.is_empty()).unwrap_or(shell).to_string();
        let quote = |text: &str| if effective_shell == "pwsh" || effective_shell == "cmd" { ssh::ps_quote(text) } else { ssh::bash_quote(text) };
        let launch = templates::custom_resume_command(&templates::command_line(&config), requested, config.get("session"), &quote, language)?;
        Ok((launch.0, launch.1, effective_shell))
    }

    fn pty_restart(&self, id: &str, language: &str) -> Result<Value, String> {
        if self.closing.load(Ordering::SeqCst) {
            return Err(translate(language, "工作台正在关闭", &[] as &[String]));
        }
        // While the terminal's process is there, what runs in it is started
        // again in the same terminal. Only a terminal whose process is gone
        // is created again, with the Agent session it resumed.
        let respawn = {
            let session = self.pty.agent_session_of(id);
            match self.pty.restart(id, &self.emit) {
                crate::pty::Restart::Retyped | crate::pty::Restart::Nothing => return Ok(Value::Null),
                crate::pty::Restart::Respawn => session,
            }
        };
        let Some((cwd, kind, shell, command, env)) = self.pty.launch_meta(id) else { return Ok(Value::Null) };
        self.pty.close(id);
        // The environment the terminal was created with is given again, as
        // the Electron build keeps it with the terminal and not with the
        // template as it reads since.
        self.pty.create(&self.paths.data, id, &cwd, &kind, &shell, &command, respawn.as_deref(), false, language, self.emit.clone(), &env).map(|_| Value::Null)
    }

/// What testing an executor comes to: the last of what its command
/// showed, the code it left with, and whether it was still running when
/// the test stopped watching it.
    pub fn test_exec(&self, request: Value, language: &str) -> Result<Value, String> {
        if self.closing.load(Ordering::SeqCst) {
            return Err(translate(language, "工作台正在关闭", &[] as &[String]));
        }
        // The command and its arguments as one line, as a terminal takes them.
        let cmd = request["cmd"].as_str().unwrap_or("");
        let args = request["args"].as_str().unwrap_or("");
        let command = [cmd, args].iter().filter(|part| !part.is_empty()).copied().collect::<Vec<_>>().join(" ");
        if command.trim().is_empty() { return Ok(json!({ "text": translate(language, "请先填写命令。", &[] as &[String]), "code": Value::Null })) }
        let host_id = request["hostId"].as_str().filter(|id| !id.is_empty()).unwrap_or("local");
        let local = host_id == "local";
        // A machine that is not configured any more, or one that is not
        // connected, cannot be tested on: said the same of both, as the
        // Electron build says it.
        let disconnected = || translate(language, "这台机器未连接", &[] as &[String]);
        let host = match self.optional_host(host_id, language) {
            Ok(host) => host,
            Err(_) => return Err(disconnected()),
        };
        if !local && host.as_ref().is_none_or(|host| host["on"] == false) { return Err(disconnected()) }
        let cwd = request["cwd"].as_str().unwrap_or("");
        let cwd = if local {
            if !cwd.is_empty() && Path::new(cwd).is_dir() { PathBuf::from(cwd) } else { std::env::current_dir().map_err(|error| error.to_string())? }
        } else {
            if cwd.is_empty() { PathBuf::from(if host.as_ref().is_some_and(|host| host["platform"] == "windows") { "C:\\" } else { "/" }) } else { PathBuf::from(cwd) }
        };
        // Bash is taken as Git Bash on Windows, as a terminal takes it; the
        // other shells are those the host offers.
        let preferred = request["shell"].as_str().unwrap_or("bash");
        let shell = if local && cfg!(windows) && preferred == "bash" { "bash" } else { shells::shell_for_host(host.as_ref().map_or(if cfg!(windows) { "windows" } else { "linux" }, |host| host["platform"].as_str().unwrap_or("linux")), preferred) };
        let id = format!("executor-test-{}", random_id());
        // The command says how it ended with a mark of its own at its end.
        // The leaving of the process is not that: on Windows the console
        // sends what the command wrote after it says the process has left,
        // and a test read at that point lost the end of the output.
        // PowerShell says a command that wrote an error succeeded, so its
        // code is taken as a terminal would show it.
        let marker = format!("\u{1b}]777;awb;{id};");
        let command = match shell {
            "pwsh" => format!("{command}; $pelloOk = $?; $pelloCode = if ($pelloOk) {{ 0 }} elseif ($global:LASTEXITCODE) {{ $global:LASTEXITCODE }} else {{ 1 }}; [Console]::Out.Write(([char]27).ToString()+'{}'+$pelloCode+([char]7))", marker[1..].replace('\'', "''")),
            "cmd" => format!("{command} & echo {id}:!ERRORLEVEL!"),
            _ => format!("{command}; printf '\\033{}%s\\007' \"$?\"", &marker[1..]),
        };
        // The environment of the template lent to the executor on that
        // machine comes in place of the one the dialog shows; otherwise the
        // dialog's own is taken.
        let rows: Vec<Value> = match request["executorId"].as_str().filter(|id| !id.is_empty()) {
            Some(executor_id) => templates::executor_template(&self.db.lock().expect("db"), host_id, executor_id).map(|template| template["env"].as_array().cloned().unwrap_or_default()).unwrap_or_else(|| request["env"].as_array().cloned().unwrap_or_default()),
            None => request["env"].as_array().cloned().unwrap_or_default(),
        };
        let env: Vec<(String, String)> = rows.iter()
            .filter_map(|item| Some((item["k"].as_str()?.to_string(), item["v"].as_str().unwrap_or("").to_string())))
            .filter(|(key, _)| !key.is_empty()).collect();
        let watched = id.clone();
        // The end of the command is found in what it wrote, as the Electron
        // build finds it: for cmd a line with the id and the code, for the
        // others the mark with the code, ended by a bell or by a backslash.
        let exit_begins = if shell == "cmd" { format!("{id}:") } else { marker.clone() };
        let collected = Arc::new(Mutex::new(String::new()));
        let sink = collected.clone();
        let exit_code = Arc::new(Mutex::new(None));
        let exit_sink = exit_code.clone();
        // The session's output is kept, its last 12 000 characters, as the
        // page is told nothing of it: it is not a terminal of the workbench.
        let emit: Emit = Arc::new(move |event: Value| {
            if event["channel"] == "pty:event" && event["payload"]["type"] == "data" && event["payload"]["id"] == watched {
                let data = event["payload"]["data"].as_str().unwrap_or("");
                if data.is_empty() { return }
                let mut kept = sink.lock().expect("test output");
                kept.push_str(data);
                // The mark is taken out of what is kept, and its code kept
                // apart, once it is whole in what there is.
                if exit_sink.lock().expect("test exit").is_none() {
                    if let Some((code, at, len)) = launch_exit(&kept, &exit_begins, shell == "cmd") {
                        *exit_sink.lock().expect("test exit") = Some(code);
                        kept.replace_range(at..at + len, "");
                    }
                }
                let over = kept.chars().count().saturating_sub(12_000);
                if over > 0 { *kept = kept.chars().skip(over).collect(); }
            }
        });
        let info = if local {
            self.pty.create(&self.paths.data, &id, &cwd, TEST_KIND, shell, &command, None, false, language, emit.clone(), &env)?
        } else {
            self.pty.create_remote(&self.paths.data, &id, &cwd.display().to_string(), TEST_KIND, shell, &command, None, false, &host.expect("a remote host"), language, emit.clone())?
        };
        let _ = info;
        let deadline = Instant::now() + TEST_WATCH;
        // Only the command's own mark, or the leaving of its process, ends
        // the test: a shell may show more prompts as it starts. The mark is
        // found in what is kept, and the console is then given its time to
        // send what it held back, as the Electron build gives it: 180 ms.
        let code = loop {
            if let Some(code) = *exit_code.lock().expect("test exit") { break code }
            match self.pty.snapshot_of(&id).and_then(|snapshot| snapshot["state"].as_str().and_then(|state| (state == "exited" || state == "failed").then(|| snapshot["exitCode"].as_i64()))) {
                Some(code) => break code,
                None => {}
            }
            if Instant::now() >= deadline { break None }
            std::thread::sleep(Duration::from_millis(40));
        };
        // What the console sends after the process has left is still the
        // command's: the session is given a moment before it is closed, so
        // that the end of the output is not lost with it.
        std::thread::sleep(TEST_SETTLE);
        let running = code.is_none();
        self.pty.close(&id);
        let text = templates::redact_output(&collected.lock().expect("test output"), &rows);
        let mut result = json!({ "text": text, "code": code });
        if running { result["running"] = json!(true); }
        Ok(result)
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
        // One live content search per project: a search asked for on a project
        // that already has one ends that one, and one asked for again under
        // the same id ends it too, so stale requests do not pile up workers.
        let stale: Vec<String> = self.content_searches.lock().expect("content").iter()
            .filter(|(key, job)| job.project_id() == project_id || key.as_str() == id)
            .map(|(key, _)| key.clone()).collect();
        for key in &stale { self.content_cancel(&key); }
        let job = if let Some((host, path)) = self.remote_place(project_id, language)? {
            let payload = json!({ "root": path, "query": str_arg(args, 2), "sensitive": sensitive, "regex": regex, "whole": whole, "ignored": ignored });
            // The script reaches the host the way a command does: encoded for
            // PowerShell, quoted for the shell. The query is in neither, as it
            // travels on the input.
            let platform = host["platform"].as_str().unwrap_or("linux");
            let words: Vec<String> = if platform == "windows" {
                vec![String::from("powershell.exe"), String::from("-NoProfile"), String::from("-Command"), search::windows_content_script().to_string()]
            } else {
                vec![String::from("bash"), String::from("-lc"), search::remote_content_shell()]
            };
            let command = ssh::remote_command(platform, &words);
            let stream = ssh::open_command_stream(&self.paths.data, &host, &command, payload.to_string().as_bytes(), language)?;
            ContentSearch::from_stream(project_id, &identity, stream, language)
        } else {
            ContentSearch::start(&root, project_id, &identity, str_arg(args, 2), sensitive, regex, whole, &ignored, language)?
        };
        self.content_stops.lock().expect("content").insert(id.to_string(), job.cancel_flag());
        self.content_searches.lock().expect("content").insert(id.to_string(), job);
        Ok(Value::Null)
    }

    fn content_cancel(&self, id: &str) {
        // The flag goes first: the batch being waited for ends as soon as it
        // is set, and only then is the lock on the searches free.
        if let Some(stop) = self.content_stops.lock().expect("content").remove(id) { stop.stop(); }
        let mut searches = self.content_searches.lock().expect("content");
        if let Some(job) = searches.get_mut(id) { job.cancel(); }
        searches.remove(id);
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
                if batch["done"] == true { searches.remove(id); self.content_stops.lock().expect("content").remove(id); }
                Ok(batch)
            }
            Err(error) => {
                searches.remove(id);
                self.content_stops.lock().expect("content").remove(id);
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

    /// The record of a machine, or none for this one. A record that is not
    /// there is said so; whether the machine is connected is not asked here,
    /// as a path may be checked on a machine that is not connected yet.
    fn optional_host(&self, host_id: &str, language: &str) -> Result<Option<Value>, String> {
        if host_id.is_empty() || host_id == "local" { return Ok(None) }
        self.db.lock().expect("db")["hosts"].as_array().and_then(|list| list.iter().find(|host| host["id"] == host_id).cloned()).map(Some)
            .ok_or_else(|| translate(language, "机器已移除", &[] as &[String]))
    }

    /// Where a project is, as the Electron build's `projectTarget` finds it:
    /// the project and the machine it is on, which is none for this one. A
    /// project that is not there, a machine whose record was removed and a
    /// machine that is not connected are three different things, said in that
    /// order, and every channel that goes to a project's machine says the same
    /// of them.
    fn project_target(&self, project_id: &str, language: &str) -> Result<(Value, Option<Value>), String> {
        let project = self.project(project_id, language)?;
        let host = self.optional_host(project["host"].as_str().unwrap_or("local"), language)?;
        if host.as_ref().is_some_and(|host| host["on"] == false) {
            return Err(translate(language, "这台机器未连接", &[] as &[String]));
        }
        Ok((project, host))
    }

    fn remote_place(&self, project_id: &str, language: &str) -> Result<Option<(Value, String)>, String> {
        let (project, host) = self.project_target(project_id, language)?;
        let path = project["path"].as_str().unwrap_or("").to_string();
        Ok(host.map(|host| (host, path)))
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
        // Electron's tree:move refuses an entry that is being replaced, lies in
        // what is being replaced, or is a folder holding it.
        if self.uploads.move_blocked(project_id, rel, directory) || self.imports.move_blocked(project_id, rel, directory) {
            return Err(translate(language, "文件正在保存或进行其他操作", &[] as &[String]));
        }
        self.with_local(project_id, language, |root| files::move_entry(root, rel, destination, directory, language).map(|path| json!(path)))
    }

    fn upload_aliases(&self, project_id: &str, host: &Value) -> Vec<Value> {
        let db = self.db.lock().expect("db");
        let hosts = db["hosts"].as_array().cloned().unwrap_or_default();
        db["projects"].as_array().cloned().unwrap_or_default().into_iter().filter_map(|project| {
            if project["id"].as_str() == Some(project_id) { return None; }
            let other = hosts.iter().find(|item| item["id"] == project["host"])?;
            let same = host["addr"] == other["addr"]
                && host["port"].as_u64().unwrap_or(22) == other["port"].as_u64().unwrap_or(22)
                && host["user"] == other["user"]
                && host["platform"] == other["platform"]
                && host["id"] != "local"
                && other["id"] != "local";
            if !same { return None; }
            Some(json!({ "id": project["id"], "path": project["path"] }))
        }).collect()
    }

    /// The other projects on this machine, which may lie on the files a
    /// local transfer replaces.
    fn local_projects(&self, project_id: &str) -> Vec<Value> {
        let db = self.db.lock().expect("db");
        db["projects"].as_array().map(|projects| projects.iter().filter(|project| {
            let host = project["host"].as_str().unwrap_or("local");
            project["id"].as_str() != Some(project_id) && (host.is_empty() || host == "local")
        }).map(|project| json!({ "id": project["id"], "path": project["path"] })).collect()).unwrap_or_default()
    }

    /// A transfer asked about again, by retry or by keeping both, must
    /// still lead to a directory of the project it was started for.
    fn validate_transfer_target(&self, id: &str, language: &str) -> Result<(), String> {
        let (project_id, root) = self.imports.context(id, language)?;
        let project = self.project(&project_id, language)?;
        if self.optional_host(project["host"].as_str().unwrap_or("local"), language)?.is_some() {
            return Err(translate(language, "项目环境已更改", &[] as &[String]));
        }
        let real = crate::real_path(project["path"].as_str().unwrap_or("")).map_err(|error| error.to_string())?;
        let relative = root.strip_prefix(&real).map_err(|_| translate(language, "目标不是目录", &[] as &[String]))?;
        if !real.join(relative).is_dir() { return Err(translate(language, "目标不是目录", &[] as &[String])); }
        Ok(())
    }

    fn transfer_drop(&self, args: &[Value], language: &str) -> Result<Value, String> {
        let project_id = str_arg(args, 0).to_string();
        let parent = str_arg(args, 1).to_string();
        let sources = args.get(2).and_then(|value| value.as_array()).map(|list| list.iter().filter_map(|item| item.as_str().map(|item| item.to_string())).collect::<Vec<_>>()).unwrap_or_default();
        let (project, host) = self.project_target(&project_id, language)?;
        let root = project["path"].as_str().unwrap_or("").to_string();
        if host.is_none() {
            let others = self.local_projects(&project_id);
            return self.imports.start(project_id, PathBuf::from(root), parent, sources, others, self.dirty.clone(), language.to_string(), self.emit.clone());
        }
        let dirty = *self.dirty.lock().expect("dirty");
        let aliases = host.as_ref().map(|item| self.upload_aliases(&project_id, item)).unwrap_or_default();
        self.uploads.start(self.paths.data.clone(), host, project_id, root, parent, sources, aliases, dirty, language.to_string(), self.emit.clone())
    }

    /// Try what failed in a download again. The project has to be on the
    /// host and at the path it was when the download began.
    fn download_retry(&self, id: &str, language: &str) -> Result<Value, String> {
        let project = self.project(&self.downloads.project_id(id), language)?;
        let host = self.optional_host(project["host"].as_str().unwrap_or("local"), language)?.ok_or_else(|| translate(language, "项目环境已更改", &[] as &[String]))?;
        let root = project["path"].as_str().unwrap_or("").to_string();
        let identity = format!("{}|{}", project["host"].as_str().unwrap_or("local"), root);
        let id = self.downloads.retry(id, host, &identity, language, self.emit.clone())?;
        Ok(json!(id))
    }

    fn transfer_retry(&self, id: &str, language: &str) -> Result<Value, String> {
        let project_id = self.uploads.project_id(id).unwrap_or_default();
        let host = if project_id.is_empty() { None } else { self.project_target(&project_id, language)?.1 };
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

    fn tree_place(&self, project_id: &str, rel: &str, language: &str) -> Result<TreePlace, String> {
        let (project, host) = self.project_target(project_id, language)?;
        let root = project["path"].as_str().unwrap_or("").to_string();
        let relative = files::clean_relative(rel, language)?;
        let remote = host.is_some();
        let platform = if remote {
            host.as_ref().map_or("linux".to_string(), |host| host["platform"].as_str().unwrap_or("linux").to_string())
        } else if cfg!(windows) {
            "win32".to_string()
        } else {
            "linux".to_string()
        };
        // A colon in a part of the path is a drive or a stream on Windows.
        if platform == "windows" && relative.split('/').any(|part| part.contains(':')) {
            return Err(translate(language, "非法文件路径", &[] as &[String]));
        }
        let relative = if relative.is_empty() { ".".to_string() } else { relative };
        if remote {
            // Joined with the other machine's own separators. `..` was
            // refused already, so the entry is inside the project.
            let separator = if platform == "windows" { '\\' } else { '/' };
            let tail = if relative == "." { String::new() } else { relative.replace('/', &separator.to_string()) };
            let full = [root.trim_end_matches(['\\', '/']).to_string(), tail].into_iter().filter(|part| !part.is_empty()).collect::<Vec<_>>().join(&separator.to_string());
            return Ok(TreePlace { local: false, root: full, relative, platform });
        }
        // As `localPath` reads it: the real path of the entry, which is
        // inside the real path of the project or not resolved at all.
        let (full, _) = files::local_existing(Path::new(&root), &relative, language)?;
        Ok(TreePlace { local: true, root: full.display().to_string(), relative, platform })
    }

    fn tree_template(&self, project_id: &str, rel: &str, directory: bool, language: &str) -> Result<Value, String> {
        let place = self.tree_place(project_id, rel, language)?;
        if place.local && files::is_directory(Path::new(&place.root)) != Some(directory) {
            return Err(translate(language, "文件类型已更改，请刷新目录", &[] as &[String]));
        }
        let editors = if directory || !place.local {
            Vec::new()
        } else {
            shell::installed_editors(Path::new(&place.root), &place.platform, &|name| std::env::var(name).ok())
                .into_iter()
                .map(|editor| (editor.id.to_string(), editor.name.to_string()))
                .collect()
        };
        Ok(menu::tree_menu(language, directory, place.local, place.relative == ".", &editors))
    }

    fn tree_action(&self, project_id: &str, rel: &str, directory: bool, action: &str, language: &str) -> Result<Value, String> {
        let before = self.project(project_id, language)?;
        let place = self.tree_place(project_id, rel, language)?;
        let full = PathBuf::from(&place.root);
        let relative = place.relative.clone();
        let local = place.local;
        // Copying a path puts it on the clipboard, and the page is told
        // nothing of it, on whichever machine the project is.
        if action == "copy-full" || action == "copy-relative" {
            shell::set_clipboard_text(if action == "copy-full" { &place.root } else { &relative });
            return Ok(Value::Null);
        }
        if !local { return Err(translate(language, "远程项目不支持本机打开", &[] as &[String])) }
        // The entry may have changed since the menu was asked for.
        if files::is_directory(&full) != Some(directory) {
            return Err(translate(language, "文件类型已更改，请刷新目录", &[] as &[String]));
        }
        let result = if !directory && action.starts_with("editor:") {
            let editor = shell::installed_editors(&full, &place.platform, &|name| std::env::var(name).ok())
                .into_iter()
                .find(|editor| format!("editor:{}", editor.id) == action)
                .ok_or_else(|| translate(language, "该编辑器不可用，请重新打开菜单", &[] as &[String]))?;
            shell::launch_editor(&editor, &full)?;
            Value::Null
        } else if action == "save-as" && !directory {
            let Some(chosen) = menu::choose_save_path(language, "save-as", &place.root)? else { return Ok(Value::Null) };
            // Asked for again after the dialog, which may have been open a long time.
            let source = self.tree_place(project_id, rel, language)?;
            if !source.local || !Path::new(&source.root).is_file() { return Err(translate(language, "源文件已更改", &[] as &[String])) }
            match shell::copy_to_new_file(Path::new(&source.root), Path::new(&chosen)).map_err(|error| error.to_string())? {
                shell::Copy::Copied => Value::Null,
                shell::Copy::Taken => return Err(translate(language, "目标已存在，请选择新的文件名", &[] as &[String])),
            }
        } else if action == "reveal" && !directory {
            shell::show_in_folder(&full);
            Value::Null
        } else if (action == "reveal" && directory) || (action == "open-default" && !directory) {
            shell::open_path(&full, language)?;
            Value::Null
        } else {
            return Err(translate(language, "不支持此操作", &[] as &[String]));
        };
        let after = self.project(project_id, language)?;
        if before != after { return Err(translate(language, "项目记录被意外修改", &[] as &[String])) }
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
        if op == "finish" {
            let generation = request["generation"].as_u64().unwrap_or(0);
            if session.generation != generation {
                return Ok(session.view());
            }
            let address = session.address.clone();
            let host_id = session.host_id.clone();
            drop(pickers);
            let listing = self.path_list(&host_id, &address, language).unwrap_or_else(|error| json!({ "path": address, "parent": Value::Null, "dirs": [], "error": error }));
            let mut pickers = self.pickers.lock().expect("picker");
            if let Some(session) = pickers.get_mut(&id) { session.apply(generation, listing); }
            return Ok(pickers.get(&id).map(|session| session.view()).unwrap_or(Value::Null));
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
            if request["stage"].as_bool().unwrap_or(false) {
                let _ = generation;
                return Ok(session.view());
            }
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
        let paths = menu::choose_open_paths(kind, language);
        if paths.is_empty() { return Ok(Value::Null) }
        let project = str_arg(args, 0);
        let parent = str_arg(args, 1);
        let sources = Value::Array(paths.into_iter().map(|path| json!(path)).collect());
        self.transfer_drop(&[json!(project), json!(parent), sources], language)
    }

    fn transfer_download(&self, args: &[Value], language: &str) -> Result<Value, String> {
        let project_id = str_arg(args, 0);
        let Some(relative) = args.get(1).and_then(Value::as_str) else { return Err(translate(language, "下载参数无效", &[] as &[String])) };
        let Some(directory) = args.get(2).map(Value::as_bool).unwrap_or(Some(false)) else { return Err(translate(language, "下载参数无效", &[] as &[String])) };
        let Some((host, root)) = self.remote_place(project_id, language)? else { return Err(translate(language, "请选择远程对象", &[] as &[String])) };
        let relative = files::clean_relative(relative, language)?;
        if relative.is_empty() { return Err(translate(language, "请选择远程对象", &[] as &[String])) }
        let identity = format!("{}|{}", self.project(project_id, language)?["host"].as_str().unwrap_or("local"), root);
        // A directory is put into a directory that is chosen; a file is
        // saved under a name, and one that is there already is replaced only
        // once the save dialog has confirmed it.
        let chosen = if directory { menu::choose_open_path("download", language) } else { menu::choose_save_path(language, "download", relative.rsplit('/').next().unwrap_or(""))?.map(|path| json!(path)).unwrap_or(Value::Null) };
        let Some(chosen) = chosen.as_str() else { return Ok(Value::Null) };
        let destination = PathBuf::from(chosen);
        if destination.as_os_str().is_empty() { return Ok(Value::Null) }
        let id = self.downloads.start(project_id, &identity, host, self.paths.data.clone(), &root, &relative, &destination, directory, language, self.emit.clone())?;
        Ok(json!(id))
    }

    fn open_html(&self, project_id: &str, relative: &str, language: &str) -> Result<Value, String> {
        let lower = relative.to_ascii_lowercase();
        if !lower.ends_with(".html") && !lower.ends_with(".htm") { return Err(translate(language, "仅支持在浏览器中预览 HTML 文件", &[] as &[String])) }
        let url = self.preview_url(&[json!(project_id), json!(relative), Value::Null], language)?;
        let href = url.as_str().unwrap_or("").to_string();
        shell::open_external(&href);
        Ok(json!(href))
    }

    fn file_link(&self, project_id: &str, source: &str, href: &str, language: &str) -> Result<Value, String> {
        if href.len() > 8192 { return Err(translate(language, "无效的链接", &[] as &[String])) }
        let trimmed = href.trim();
        if trimmed.contains("://") || trimmed.starts_with("//") {
            if !web_link(trimmed) { return Err(translate(language, "仅支持网页链接和项目内文件链接", &[] as &[String])) }
            shell::open_external(trimmed);
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

    /// The system's folder dialog, as the Electron build's `dialog` module
    /// opens it: a folder when one is chosen, and null when it is dismissed.
    ///
    /// On Linux the desktop's own programs are asked first, where they are;
    /// without one, and when a test asks for no system dialog at all, the
    /// workbench's own picker is opened in the page instead, as before.
    fn pick_directory(&self, language: &str) -> Result<Value, String> {
        if let Ok(value) = std::env::var("AWB_DIRECTORY") {
            return Ok(if value.is_empty() { Value::Null } else { json!(value) });
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = language;
            let picked = rfd::FileDialog::new().set_title("Pello").pick_folder();
            return Ok(picked.map(|path| json!(path.display().to_string())).unwrap_or(Value::Null));
        }
        #[cfg(target_os = "linux")]
        {
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

/// Where the workbench is published, as the Electron build's `APP_HOMEPAGE`
/// says of it: opened from the About page.
const HOMEPAGE: &str = "https://github.com/FangYang970206/Pello";

/// The kind of the terminal made to test an executor: not a Shell and none
/// of the Agents, known by its name wherever a terminal is told apart.
const TEST_KIND: &str = "__executor_test__";

/// How long an executor's startup is watched before the test ends with the
/// command still running: as long as the Electron build watches it.
const TEST_WATCH: Duration = Duration::from_millis(8000);
/// How long the console is given to send what it held back of a command's
/// output once its mark, or its leaving, is seen.
const TEST_SETTLE: Duration = Duration::from_millis(180);

/// The end of a launch test as the command wrote it: the code, and where the
/// mark of it is in the output, with its length. For cmd it is a line with
/// the id and the code; for the others the mark with the code, ended by a
/// bell or by a backslash. `None` when the mark is not whole there yet.
fn launch_exit(text: &str, begins: &str, line: bool) -> Option<(Option<i64>, usize, usize)> {
    let at = text.find(begins)?;
    let rest = &text[at + begins.len()..];
    let digits = rest.bytes().take_while(|byte| byte.is_ascii_digit() || *byte == b'-').count();
    if digits == 0 { return None }
    let end = if line {
        rest[digits..].find(|letter: char| letter == '\r' || letter == '\n').map(|offset| digits + offset + 1)
    } else if rest[digits..].starts_with('\u{7}') {
        Some(digits + 1)
    } else if rest[digits..].starts_with("\u{1b}\\") {
        Some(digits + 2)
    } else {
        None
    };
    Some((rest[..digits].parse().ok(), at, begins.len() + end?))
}


fn agent_command(kind: &str, db: &Value) -> String {
    const PRESETS: &[(&str, &str)] = &[("claude", "claude"), ("codex", "codex"), ("opencode", "opencode"), ("pi", "pi"), ("omp", "omp")];
    if let Some((_, cmd)) = PRESETS.iter().find(|(id, _)| *id == kind) { return (*cmd).to_string() }
    db["custom"].as_array().and_then(|list| list.iter().find(|item| item["id"] == kind)).map(|item| {
        [item["cmd"].as_str().unwrap_or(""), item["args"].as_str().unwrap_or("")].into_iter().filter(|part| !part.is_empty()).collect::<Vec<_>>().join(" ")
    }).unwrap_or_default()
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
