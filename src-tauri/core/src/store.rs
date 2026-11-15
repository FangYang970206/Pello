//! `workbench.json` load and save. Field rules follow `src/main/store.ts`.

use crate::{i18n::language_of, uid};
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

const CODE_FONTS: &[&str] = &["Cascadia Mono", "JetBrains Mono", "Fira Code", "IBM Plex Mono", "Consolas", "Cascadia Code", "monospace"];
const UI_FONTS: &[&str] = &["Geist", "Segoe UI", "Microsoft YaHei UI", "IBM Plex Mono", "JetBrains Mono", "system-ui"];
const THEMES: &[&str] = &["dark", "light", "nord", "dracula", "catppuccin", "solarized-light"];
const PRESETS: &[&str] = &["claude", "codex", "opencode", "pi", "omp"];
const HOST_COLORS: &[&str] = &["blue", "teal", "purple", "orange", "rose", "olive", "sky", "mauve"];

#[derive(Clone, Copy, Debug)]
pub struct PlatformInfo {
    pub os: &'static str,
    pub label: &'static str,
    pub shell: &'static str,
}

impl PlatformInfo {
    pub fn current() -> Self {
        if cfg!(windows) {
            Self { os: "windows", label: "Windows", shell: "pwsh" }
        } else {
            Self { os: "linux", label: "Linux", shell: "bash" }
        }
    }
}

pub fn os_label() -> String {
    if cfg!(windows) {
        return "Windows".into();
    }
    if let Ok(text) = fs::read_to_string("/etc/os-release") {
        let name = capture(&text, "NAME");
        let version = capture(&text, "VERSION_ID");
        if let (Some(name), Some(version)) = (name.as_deref(), version.as_deref()) {
            return format!("{name} {version}");
        }
        if let Some(name) = name {
            return name;
        }
    }
    "Linux".into()
}

fn capture(text: &str, key: &str) -> Option<String> {
    for line in text.lines() {
        let rest = line.strip_prefix(key)?;
        let rest = rest.strip_prefix('=')?;
        let value = rest.trim().trim_matches('"');
        if !value.is_empty() {
            return Some(value.to_string());
        }
    }
    None
}

pub fn default_database(info: PlatformInfo) -> Value {
    json!({
        "settings": {
            "language": "zh-CN",
            "theme": "light",
            "layout": "focus",
            "fontSize": 13,
            "fontFamily": "Cascadia Mono",
            "uiFontFamily": "Geist",
            "uiFontSize": 13,
            "editorFontSize": 14,
            "defShell": info.shell,
            "defAgent": "claude",
            "restore": true,
            "confirmKill": true,
            "autoCheckUpdates": true
        },
        "custom": [],
        "hosts": [{
            "id": "local",
            "name": "本机",
            "addr": "",
            "user": "",
            "os": os_label(),
            "on": true,
            "port": 22,
            "platform": info.os,
            "auth": "key",
            "color": "blue"
        }],
        "projects": [],
        "sessions": {},
        "activeTab": {},
        "workSessions": {},
        "activeSession": {}
    })
}

pub fn valid_tree_ignores(rules: &Value) -> bool {
    let Some(list) = rules.as_array() else { return false };
    list.len() <= 100 && list.iter().all(|item| {
        let Some(text) = item.as_str() else { return false };
        !text.is_empty() && text.len() <= 255 && !text.chars().any(|char| char == '\\' || char == '/' || char == '\0') && text != "." && text != ".."
    })
}

pub fn host_color(value: &Value) -> &'static str {
    match value.as_str() {
        Some("blue") => "blue",
        Some("teal") => "teal",
        Some("purple") => "purple",
        Some("orange") => "orange",
        Some("rose") => "rose",
        Some("olive") => "olive",
        Some("sky") => "sky",
        Some("mauve") => "mauve",
        _ => "blue",
    }
}

fn next_host_color(hosts: &[Value]) -> &'static str {
    HOST_COLORS.iter().copied().find(|color| !hosts.iter().any(|host| host_color(&host["color"]) == *color)).unwrap_or("blue")
}

pub fn load_database(file: &Path, info: PlatformInfo) -> (Value, bool) {
    let Ok(text) = fs::read_to_string(file) else { return (default_database(info), false) };
    let Ok(raw) = serde_json::from_str::<Value>(&text) else { return (default_database(info), false) };
    let next = sanitize(&raw, info);
    let rewrite = sessions_need_save(&raw, &next) || raw.get("plugins").is_some();
    (next, rewrite)
}

pub fn save_database(file: &Path, db: &Value) -> Result<(), String> {
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let temporary = PathBuf::from(format!("{}.tmp", file.display()));
    fs::write(&temporary, serde_json::to_string_pretty(db).map_err(|error| error.to_string())?).map_err(|error| format!("{}: {error}", temporary.display()))?;
    fs::rename(&temporary, file).map_err(|error| format!("{}: {error}", temporary.display()))?;
    Ok(())
}

pub fn sanitize(raw: &Value, info: PlatformInfo) -> Value {
    let mut base = default_database(info);
    let Some(raw_obj) = raw.as_object() else { return base };
    let settings = raw_obj.get("settings").cloned().unwrap_or(json!({}));
    let settings = settings.as_object();
    let font_size = int_in(settings, "fontSize", 10, 24).unwrap_or(13);
    let editor_font = int_in(settings, "editorFontSize", 10, 24).unwrap_or(14);
    let ui_font_size = settings.and_then(|map| map.get("uiFontSize")).and_then(|value| value.as_i64()).filter(|size| [12, 13, 14, 15, 16].contains(size)).unwrap_or(13);
    let theme = settings.and_then(|map| map.get("theme")).and_then(|value| value.as_str()).filter(|theme| THEMES.contains(theme)).unwrap_or("light");
    let layout = settings.and_then(|map| map.get("layout")).and_then(|value| value.as_str()).filter(|layout| ["balanced", "focus", "review"].contains(layout)).unwrap_or("focus");
    let panel_side = if settings.and_then(|map| map.get("panelSide")).and_then(|value| value.as_str()) == Some("left") { "left" } else { "right" };
    let density = if settings.and_then(|map| map.get("density")).and_then(|value| value.as_str()) == Some("compact") { "compact" } else { "comfortable" };
    let font_family = settings.and_then(|map| map.get("fontFamily")).and_then(|value| value.as_str()).filter(|font| CODE_FONTS.contains(font)).unwrap_or("Cascadia Mono");
    let ui_font = settings.and_then(|map| map.get("uiFontFamily")).and_then(|value| value.as_str()).filter(|font| UI_FONTS.contains(font)).unwrap_or("Geist");
    let language = if settings.and_then(|map| map.get("language")).and_then(|value| value.as_str()) == Some("en") { "en" } else { "zh-CN" };
    let def_shell = as_shell(settings.and_then(|map| map.get("defShell")), info);
    let def_agent = settings.and_then(|map| map.get("defAgent")).and_then(|value| value.as_str()).filter(|value| !value.is_empty()).unwrap_or("claude").to_string();
    base["settings"] = json!({
        "language": language,
        "theme": theme,
        "layout": layout,
        "panelSide": panel_side,
        "density": density,
        "fontSize": font_size,
        "fontFamily": font_family,
        "uiFontFamily": ui_font,
        "uiFontSize": ui_font_size,
        "editorFontSize": editor_font,
        "defShell": def_shell,
        "defAgent": def_agent,
        "restore": as_bool(settings.and_then(|map| map.get("restore")), true),
        "confirmKill": as_bool(settings.and_then(|map| map.get("confirmKill")), true),
        "autoCheckUpdates": as_bool(settings.and_then(|map| map.get("autoCheckUpdates")), true)
    });
    if let Some(custom) = raw_obj.get("custom").and_then(|value| value.as_array()) {
        base["custom"] = Value::Array(custom.iter().filter(|item| is_executor(item)).cloned().collect());
    }
    if let Some(hosts) = raw_obj.get("hosts").and_then(|value| value.as_array()).filter(|hosts| !hosts.is_empty()) {
        let mut hosts: Vec<Value> = hosts.iter().filter(|item| is_host(item)).cloned().collect();
        if !hosts.iter().any(|host| host["id"] == "local") {
            hosts.insert(0, base["hosts"][0].clone());
        } else if let Some(local) = hosts.iter_mut().find(|host| host["id"] == "local") {
            if local["name"].as_str().unwrap_or("").is_empty() {
                local["name"] = json!("本机");
            }
            local["on"] = json!(true);
            local["platform"] = json!(info.os);
            if local["os"].as_str().unwrap_or("").is_empty() {
                local["os"] = json!(os_label());
            }
        }
        base["hosts"] = Value::Array(hosts);
    }
    if let Some(projects) = raw_obj.get("projects").and_then(|value| value.as_array()) {
        base["projects"] = Value::Array(projects.iter().filter(|item| is_project(item)).map(|project| {
            let mut project = project.clone();
            if project["pinned"] == true {
                project["pinned"] = json!(true);
            } else if let Some(object) = project.as_object_mut() {
                object.remove("pinned");
            }
            project
        }).collect());
    }
    if let Some(ignores) = raw_obj.get("treeIgnores").and_then(|value| value.as_object()) {
        let mut kept = Map::new();
        for project in base["projects"].as_array().cloned().unwrap_or_default() {
            let Some(id) = project["id"].as_str() else { continue };
            if let Some(rules) = ignores.get(id) {
                if valid_tree_ignores(rules) {
                    let mut unique = Vec::new();
                    for rule in rules.as_array().cloned().unwrap_or_default() {
                        if !unique.contains(&rule) {
                            unique.push(rule);
                        }
                    }
                    kept.insert(id.to_string(), Value::Array(unique));
                }
            }
        }
        if !kept.is_empty() {
            base["treeIgnores"] = Value::Object(kept);
        }
    }
    let mut supported = vec!["shell".to_string()];
    supported.extend(PRESETS.iter().map(|id| (*id).to_string()));
    if let Some(custom) = base["custom"].as_array() {
        for executor in custom {
            if let Some(id) = executor["id"].as_str() {
                supported.push(id.to_string());
            }
        }
    }
    if !supported.iter().any(|id| id == &def_agent) {
        base["settings"]["defAgent"] = json!("claude");
    }
    if let Some(projects) = base["projects"].as_array_mut() {
        for project in projects {
            let agent = project["agent"].as_str().unwrap_or("");
            if !supported.iter().any(|id| id == agent) {
                project["agent"] = json!("shell");
            }
        }
    }
    let hosts = base["hosts"].as_array().cloned().unwrap_or_default();
    let mut colored = Vec::new();
    for host in hosts {
        let color = if host.get("color").and_then(|value| value.as_str()).is_some_and(|color| !color.is_empty()) { host_color(&host["color"]) } else { next_host_color(&colored) };
        let mut host = host;
        host["color"] = json!(color);
        colored.push(public_host(host));
    }
    base["hosts"] = Value::Array(colored);
    let mut sessions = Map::new();
    let mut active_tab = Map::new();
    if let Some(raw_sessions) = raw_obj.get("sessions").and_then(|value| value.as_object()) {
        for (id, list) in raw_sessions {
            let Some(list) = list.as_array() else { continue };
            let terms: Vec<Value> = normalize_terms(list).into_iter().map(|mut term| {
                let kind = term["kind"].as_str().unwrap_or("");
                if !supported.iter().any(|id| id == kind) {
                    term["kind"] = json!("shell");
                }
                term
            }).collect();
            if !terms.is_empty() {
                sessions.insert(id.clone(), Value::Array(terms));
            }
        }
    }
    for (id, terms) in &sessions {
        let wanted = wanted_active(raw_obj.get("activeTab"), id);
        let terms = terms.as_array().cloned().unwrap_or_default();
        let active = if terms.iter().any(|term| term["id"].as_str() == Some(wanted.as_str())) { wanted } else { terms[0]["id"].as_str().unwrap_or("").to_string() };
        active_tab.insert(id.clone(), json!(active));
    }
    base["sessions"] = Value::Object(sessions.clone());
    base["activeTab"] = Value::Object(active_tab.clone());
    let projects = base["projects"].as_array().cloned().unwrap_or_default();
    for project in projects {
        let Some(id) = project["id"].as_str() else { continue };
        let terms = sessions.get(id).cloned().unwrap_or(json!([]));
        let active = active_tab.get(id).and_then(|value| value.as_str()).map(|value| value.to_string());
        let groups = raw_obj.get("workSessions").and_then(|value| value.get(id));
        let selected = raw_obj.get("activeSession").and_then(|value| value.get(id)).and_then(|value| value.as_str());
        write_sessions(base.as_object_mut().expect("database object"), id, &terms, active.as_deref(), groups, selected);
    }
    let _ = language_of(&base);
    base
}

pub fn write_sessions(draft: &mut Map<String, Value>, project_id: &str, terms: &Value, active_id: Option<&str>, groups: Option<&Value>, selected: Option<&str>) {
    let mut clean = if terms.is_array() { normalize_terms(terms.as_array().unwrap()) } else { Vec::new() };
    let mut sessions = clean_sessions(groups);
    if !clean.is_empty() && sessions.is_empty() {
        sessions.push(json!({ "id": format!("session:{project_id}"), "name": "会话一" }));
    }
    for term in &mut clean {
        let sid = term["sessionId"].as_str().unwrap_or("");
        if !sessions.iter().any(|session| session["id"].as_str() == Some(sid)) {
            if let Some(first) = sessions.first() {
                term["sessionId"] = first["id"].clone();
            }
        }
    }
    let active_term_session = active_id.and_then(|id| clean.iter().find(|term| term["id"].as_str() == Some(id))).and_then(|term| term["sessionId"].as_str().map(|value| value.to_string()));
    for session in &mut sessions {
        let session_id = session["id"].as_str().unwrap_or("").to_string();
        let mine: Vec<&Value> = clean.iter().filter(|term| term["sessionId"].as_str() == Some(session_id.as_str())).collect();
        let wanted = if active_term_session.as_deref() == Some(session_id.as_str()) { active_id.map(|value| value.to_string()) } else { session["activeTab"].as_str().map(|value| value.to_string()) };
        let next = wanted.as_deref().filter(|id| mine.iter().any(|term| term["id"].as_str() == Some(*id))).map(|id| id.to_string())
            .or_else(|| mine.first().and_then(|term| term["id"].as_str().map(|value| value.to_string())));
        if let Some(next) = next { session["activeTab"] = json!(next); }
        else if let Some(object) = session.as_object_mut() { object.remove("activeTab"); }
    }
    let mut active_sessions = object_map(draft, "activeSession");
    let wanted_session = selected.map(|value| value.to_string()).or_else(|| active_sessions.get(project_id).and_then(|value| value.as_str()).map(|value| value.to_string()));
    let selected_id = wanted_session.as_deref().filter(|id| sessions.iter().any(|session| session["id"].as_str() == Some(*id))).map(|id| id.to_string())
        .or_else(|| active_term_session.clone())
        .or_else(|| sessions.first().and_then(|session| session["id"].as_str().map(|value| value.to_string())));
    if let Some(selected_id) = selected_id { active_sessions.insert(project_id.to_string(), json!(selected_id)); }
    else { active_sessions.remove(project_id); }
    let mut work = object_map(draft, "workSessions");
    work.insert(project_id.to_string(), Value::Array(sessions));
    draft.insert("workSessions".into(), Value::Object(work));
    draft.insert("activeSession".into(), Value::Object(active_sessions));
    let mut stored_sessions = object_map(draft, "sessions");
    let mut active_tabs = object_map(draft, "activeTab");
    if clean.is_empty() {
        stored_sessions.remove(project_id);
        active_tabs.remove(project_id);
    } else {
        let wanted = match active_id {
            None => active_tabs.get(project_id).and_then(|value| value.as_str()).unwrap_or("").to_string(),
            Some(id) => id.to_string(),
        };
        let next_active = if clean.iter().any(|term| term["id"].as_str() == Some(wanted.as_str())) { wanted } else { clean[0]["id"].as_str().unwrap_or("").to_string() };
        stored_sessions.insert(project_id.to_string(), Value::Array(clean));
        active_tabs.insert(project_id.to_string(), json!(next_active));
    }
    draft.insert("sessions".into(), Value::Object(stored_sessions));
    draft.insert("activeTab".into(), Value::Object(active_tabs));
}

fn object_map(draft: &Map<String, Value>, key: &str) -> Map<String, Value> {
    draft.get(key).and_then(|value| value.as_object()).cloned().unwrap_or_default()
}

fn clean_sessions(value: Option<&Value>) -> Vec<Value> {
    let Some(list) = value.and_then(|value| value.as_array()) else { return Vec::new() };
    let mut seen = Vec::new();
    let mut sessions = Vec::new();
    for item in list {
        let Some(id) = item["id"].as_str().filter(|id| !id.is_empty()) else { continue };
        let Some(name) = item["name"].as_str() else { continue };
        let id = chars_limit(id, 160);
        let name = clean_name(name, 80);
        if name.is_empty() || seen.iter().any(|existing: &String| existing == &id) { continue }
        seen.push(id.clone());
        let mut session = json!({ "id": id, "name": name });
        if let Some(tab) = item["activeTab"].as_str() {
            session["activeTab"] = json!(tab);
        }
        sessions.push(session);
    }
    sessions
}

fn normalize_terms(list: &[Value]) -> Vec<Value> {
    let mut seen = Vec::new();
    let mut terms = Vec::new();
    for item in list {
        if !is_saved(item) { continue }
        let mut id = item["id"].as_str().unwrap_or("").to_string();
        if id.is_empty() || seen.iter().any(|existing: &String| existing == &id) {
            id = uid("t");
        }
        seen.push(id.clone());
        let mut term = json!({ "id": id, "kind": item["kind"].as_str().unwrap_or("shell"), "shell": item["shell"].as_str().unwrap_or("bash") });
        if let Some(session) = item["sessionId"].as_str().filter(|value| !value.is_empty()) {
            term["sessionId"] = json!(chars_limit(session, 160));
        }
        if let Some(agent) = item["agentSessionId"].as_str().filter(|value| !value.is_empty()) {
            term["agentSessionId"] = json!(chars_limit(agent, 512));
        }
        if let Some(name) = item["name"].as_str() {
            let name = clean_name(name.trim(), 80);
            if !name.is_empty() { term["name"] = json!(name); }
        }
        terms.push(term);
    }
    terms
}

fn chars_limit(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

fn clean_name(value: &str, max: usize) -> String {
    value.trim().chars().filter(|char| *char as u32 >= 32).take(max).collect()
}

fn object_field(value: &Value, key: &str) -> Value {
    let field = &value[key];
    if field.is_object() { field.clone() } else { json!({}) }
}

fn sessions_need_save(raw: &Value, next: &Value) -> bool {
    if object_field(raw, "workSessions") != object_field(next, "workSessions") || object_field(raw, "activeSession") != object_field(next, "activeSession") { return true }
    if raw["activeTab"].is_string() { return true }
    let raw_sessions = raw["sessions"].as_object();
    let next_sessions = next["sessions"].as_object();
    let mut keys = Vec::new();
    if let Some(map) = raw_sessions { keys.extend(map.keys().cloned()); }
    if let Some(map) = next_sessions { for key in map.keys() { if !keys.contains(key) { keys.push(key.clone()); } } }
    for id in keys {
        let before = raw_sessions.and_then(|map| map.get(&id)).and_then(|value| value.as_array()).cloned().unwrap_or_default();
        let after = next_sessions.and_then(|map| map.get(&id)).and_then(|value| value.as_array()).cloned().unwrap_or_default();
        if before.len() != after.len() { return true }
        for (index, term) in after.iter().enumerate() {
            let item = &before[index];
            if item["id"] != term["id"] || item["kind"] != term["kind"] || item["shell"] != term["shell"] { return true }
        }
        if wanted_active(raw.get("activeTab"), &id) != next["activeTab"][&id].as_str().unwrap_or("") { return true }
    }
    false
}

fn wanted_active(raw: Option<&Value>, project_id: &str) -> String {
    let Some(raw) = raw else { return String::new() };
    if let Some(value) = raw.as_str() { return value.to_string() }
    raw.get(project_id).and_then(|value| value.as_str()).unwrap_or("").to_string()
}

fn as_bool(value: Option<&Value>, fallback: bool) -> bool {
    value.and_then(|value| value.as_bool()).unwrap_or(fallback)
}

fn int_in(settings: Option<&Map<String, Value>>, key: &str, min: i64, max: i64) -> Option<i64> {
    let value = settings?.get(key)?;
    if let Some(number) = value.as_i64() {
        if number >= min && number <= max { return Some(number) }
    }
    None
}

fn as_shell(value: Option<&Value>, info: PlatformInfo) -> &'static str {
    match value.and_then(|value| value.as_str()) {
        Some("cmd") => "cmd",
        Some("pwsh") => "pwsh",
        Some("bash") => "bash",
        Some("zsh") => "zsh",
        _ => info.shell,
    }
}

fn is_executor(value: &Value) -> bool {
    value["id"].is_string() && value["name"].is_string() && value["cmd"].is_string()
}

fn is_host(value: &Value) -> bool {
    value["id"].is_string() && value["name"].is_string()
}

fn is_project(value: &Value) -> bool {
    value["id"].is_string() && value["name"].is_string() && value["path"].is_string()
}

fn is_saved(value: &Value) -> bool {
    value["kind"].is_string() && matches!(value["shell"].as_str(), Some("pwsh" | "cmd" | "bash" | "zsh"))
}

pub fn public_host(host: Value) -> Value {
    let mut host = host;
    if let Some(object) = host.as_object_mut() {
        object.remove("password");
        object.remove("hasPassword");
    }
    host["hasPassword"] = json!(false);
    host
}

pub fn apply_saved_settings(settings: Value) -> Value {
    let mut settings = settings;
    let language = if settings["language"] == "en" { "en" } else { "zh-CN" };
    let updates = settings["autoCheckUpdates"].as_bool().unwrap_or(true);
    settings["language"] = json!(language);
    settings["autoCheckUpdates"] = json!(updates);
    settings
}
