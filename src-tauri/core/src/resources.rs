//! Native MCP and Skill configuration. Reads and edits each agent's own files.
//! Imported Skill packages are copied only; nothing in them is executed.

use crate::i18n::translate;
use crate::random_id;
use serde_json::{json, Map, Value};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

const MAX_CONFIG: u64 = 32 * 1024 * 1024;
const MAX_SKILL_BYTES: u64 = 32 * 1024 * 1024;
const MAX_SKILL_FILES: usize = 10_000;

pub struct Resources {
    busy: AtomicBool,
    scope: Mutex<Option<Vec<Target>>>,
}

impl Resources {
    pub fn new() -> Self { Self { busy: AtomicBool::new(false), scope: Mutex::new(None) } }
}

/// Limit the next resource operations to the targets the caller already resolved.
/// An empty list restores the saved builtin and custom agents.
pub fn set_scope(resources: &Resources, value: &Value) {
    let scope = value.as_array().map(|list| list.iter().filter_map(target_from_json).collect::<Vec<_>>()).filter(|list| !list.is_empty());
    *resources.scope.lock().expect("scope") = scope;
}

fn target_from_json(value: &Value) -> Option<Target> {
    let id = value.get("id").and_then(|item| item.as_str()).unwrap_or("");
    if id.is_empty() { return None; }
    Some(Target {
        id: id.to_string(),
        name: value.get("name").and_then(|item| item.as_str()).unwrap_or(id).to_string(),
        mcp_path: value.get("mcpPath").and_then(|item| item.as_str()).unwrap_or("").to_string(),
        skill_path: value.get("skillPath").and_then(|item| item.as_str()).unwrap_or("").to_string(),
        skill_config_path: value.get("skillConfigPath").and_then(|item| item.as_str()).unwrap_or("").to_string(),
        format: value.get("format").and_then(|item| item.as_str()).unwrap_or("standard").to_string(),
        skill_adapter: value.get("skillAdapter").and_then(|item| item.as_str()).unwrap_or("portable").to_string(),
    })
}

fn current_targets(resources: &Resources, data: &Path, custom: &Value) -> Vec<Target> {
    if let Some(scope) = resources.scope.lock().expect("scope").clone() { return scope; }
    owned_targets(data, custom)
}

#[derive(Clone)]
struct Target {
    id: String,
    name: String,
    mcp_path: String,
    skill_path: String,
    skill_config_path: String,
    format: String,
    skill_adapter: String,
}

fn t(language: &str, text: &str) -> String { translate(language, text, &[] as &[String]) }

/// Whether a value is what JavaScript calls an object: not null and not an array.
fn is_record(value: &Value) -> bool { value.as_object().is_some() }

/// Whether a value is what JavaScript calls truthy, for the few fields the
/// Electron build tests that way: a set string is true unless it is empty,
/// and an array or an object is true however empty.
fn is_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|number| number != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// What JavaScript's `String(value)` makes of a value: an array is its items
/// joined by commas, an object is `[object Object]`, null is `null`.
fn string_of(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => js_number(number),
        Value::String(text) => text.clone(),
        Value::Array(items) => items.iter().map(string_of).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

/// A number as JavaScript writes it. Only the whole of it matters here: a
/// number never equals one of the words a type is compared with.
fn js_number(number: &serde_json::Number) -> String {
    match number.as_f64() {
        Some(value) if value == value.trunc() && value.abs() < 1e21 => format!("{}", value as i64),
        Some(value) => format!("{}", value),
        None => number.to_string(),
    }
}

/// Whether a character is one JavaScript's `String.prototype.trim` takes
/// off. Its set is not Rust's: the byte order mark is in it and the next
/// line character is not.
fn is_js_whitespace(character: char) -> bool {
    matches!(character, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

/// A string without the characters at its ends that JavaScript's `trim`
/// takes off.
fn js_trim(text: &str) -> &str { text.trim_matches(is_js_whitespace) }

fn home_dir() -> PathBuf {
    std::env::var_os("AWB_RESOURCE_HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into())))
}

pub fn targets(data: &Path, custom: &Value) -> Vec<Value> {
    let home = home_dir();
    let join = |parts: &[&str]| {
        let mut path = home.clone();
        for part in parts { path.push(part); }
        path
    };
    let config = if std::env::var_os("AWB_RESOURCE_HOME").is_some() { join(&[".config"]) } else { std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).unwrap_or_else(|| join(&[".config"])) };
    let claude = if std::env::var_os("AWB_RESOURCE_HOME").is_some() { join(&[".claude"]) } else { std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from).unwrap_or_else(|| join(&[".claude"])) };
    let codex = if std::env::var_os("AWB_RESOURCE_HOME").is_some() { join(&[".codex"]) } else { std::env::var_os("CODEX_HOME").map(PathBuf::from).unwrap_or_else(|| join(&[".codex"])) };
    let pi = if std::env::var_os("AWB_RESOURCE_HOME").is_some() { join(&[".pi", "agent"]) } else { std::env::var_os("PI_CODING_AGENT_DIR").map(PathBuf::from).unwrap_or_else(|| join(&[".pi", "agent"])) };
    let opencode_dir = config.join("opencode");
    let opencode_file = if opencode_dir.join("opencode.jsonc").is_file() { "opencode.jsonc" } else { "opencode.json" };
    let mut builtin = vec![
        Target { id: "claude".into(), name: "Claude Code".into(), mcp_path: join(&[".claude.json"]).display().to_string(), skill_path: claude.join("skills").display().to_string(), skill_config_path: String::new(), format: "standard".into(), skill_adapter: "claude".into() },
        Target { id: "codex".into(), name: "Codex CLI".into(), mcp_path: codex.join("config.toml").display().to_string(), skill_path: join(&[".agents", "skills"]).display().to_string(), skill_config_path: String::new(), format: "codex".into(), skill_adapter: "codex".into() },
        Target { id: "opencode".into(), name: "OpenCode".into(), mcp_path: opencode_dir.join(opencode_file).display().to_string(), skill_path: opencode_dir.join("skills").display().to_string(), skill_config_path: String::new(), format: "opencode".into(), skill_adapter: "opencode".into() },
        Target { id: "pi".into(), name: "Pi".into(), mcp_path: pi.join("mcp.json").display().to_string(), skill_path: pi.join("skills").display().to_string(), skill_config_path: String::new(), format: "standard".into(), skill_adapter: "pi".into() },
        Target { id: "omp".into(), name: "Oh My Pi".into(), mcp_path: join(&[".omp", "agent", "mcp.json"]).display().to_string(), skill_path: join(&[".omp", "agent", "skills"]).display().to_string(), skill_config_path: join(&[".omp", "agent", "config.yml"]).display().to_string(), format: "standard".into(), skill_adapter: "omp".into() },
    ];
    let saved = read_text(&data.join("resource-targets.json"), "zh-CN").ok().and_then(|text| parse_json_text(&text, "zh-CN").ok()).unwrap_or_else(|| json!({}));
    if let Some(list) = custom.as_array() {
        for item in list {
            let id = item["id"].as_str().unwrap_or("").to_string();
            if id.is_empty() { continue; }
            let mut target = Target { id: id.clone(), name: item["name"].as_str().unwrap_or(&id).to_string(), mcp_path: String::new(), skill_path: String::new(), skill_config_path: String::new(), format: "standard".into(), skill_adapter: item["resources"]["skillAdapter"].as_str().unwrap_or("portable").to_string() };
            if let Some(stored) = saved.get(&id) { apply_saved(&mut target, stored); }
            if item.get("resources").is_some() { apply_saved(&mut target, &item["resources"]); }
            builtin.push(target);
        }
    }
    builtin.into_iter().map(target_json).collect()
}

pub fn save_target(data: &Path, custom: &Value, value: &Value, language: &str) -> Result<(), String> {
    let id = value["id"].as_str().unwrap_or("");
    let known = custom.as_array().map(|list| list.iter().any(|item| item["id"].as_str() == Some(id))).unwrap_or(false);
    if id.is_empty() || !known { return Err(t(language, "仅自定义 Agent 可设置资源路径")) }
    let format = value["format"].as_str().unwrap_or("standard");
    if !matches!(format, "standard" | "codex" | "opencode") { return Err(t(language, "不支持的配置格式")) }
    for key in ["mcpPath", "skillPath", "skillConfigPath"] {
        if let Some(path) = value.get(key).and_then(|item| item.as_str()) {
            if !path.is_empty() && !Path::new(path).is_absolute() { return Err(t(language, "请选择绝对路径")) }
        }
    }
    let file = data.join("resource-targets.json");
    let mut saved = read_text(&file, language).ok().and_then(|text| parse_json_text(&text, language).ok()).unwrap_or_else(|| json!({}));
    let entry = saved.as_object_mut().ok_or_else(|| t(language, "不支持的配置格式"))?.entry(id).or_insert_with(|| json!({}));
    if let Some(path) = value.get("mcpPath").and_then(|item| item.as_str()) { entry["mcpPath"] = json!(path); }
    if let Some(path) = value.get("skillPath").and_then(|item| item.as_str()) { entry["skillPath"] = json!(path); }
    if let Some(path) = value.get("skillConfigPath").and_then(|item| item.as_str()) { entry["skillConfigPath"] = json!(path); }
    entry["format"] = json!(format);
    fs::write(file, saved.to_string()).map_err(|error| error.to_string())
}

fn apply_saved(target: &mut Target, value: &Value) {
    if let Some(path) = value.get("mcpPath").and_then(|item| item.as_str()) { target.mcp_path = path.to_string(); }
    if let Some(path) = value.get("skillPath").and_then(|item| item.as_str()) { target.skill_path = path.to_string(); }
    if let Some(path) = value.get("skillConfigPath").and_then(|item| item.as_str()) { target.skill_config_path = path.to_string(); }
    if let Some(format) = value.get("format").and_then(|item| item.as_str()) { target.format = format.to_string(); }
    if let Some(adapter) = value.get("skillAdapter").and_then(|item| item.as_str()) { target.skill_adapter = adapter.to_string(); }
}

fn target_json(target: Target) -> Value {
    json!({ "id": target.id, "name": target.name, "mcpPath": target.mcp_path, "skillPath": target.skill_path, "skillConfigPath": target.skill_config_path, "format": target.format, "skillAdapter": target.skill_adapter })
}

fn owned_targets(data: &Path, custom: &Value) -> Vec<Target> {
    targets(data, custom).into_iter().map(|value| Target {
        id: value["id"].as_str().unwrap_or("").to_string(),
        name: value["name"].as_str().unwrap_or("").to_string(),
        mcp_path: value["mcpPath"].as_str().unwrap_or("").to_string(),
        skill_path: value["skillPath"].as_str().unwrap_or("").to_string(),
        skill_config_path: value["skillConfigPath"].as_str().unwrap_or("").to_string(),
        format: value["format"].as_str().unwrap_or("standard").to_string(),
        skill_adapter: value["skillAdapter"].as_str().unwrap_or("portable").to_string(),
    }).collect()
}

fn find_target<'a>(targets: &'a [Target], agent: &str, language: &str) -> Result<&'a Target, String> {
    targets.iter().find(|item| item.id == agent).ok_or_else(|| t(language, "Agent 不存在"))
}

pub fn list(resources: &Resources, data: &Path, custom: &Value, kind: &str, agent: &str, page: usize, query: &str, language: &str) -> Result<Value, String> {
    let targets = current_targets(resources, data, custom);
    let target = find_target(&targets, agent, language)?;
    let mut items = Vec::new();
    let mut errors = Vec::new();
    if kind == "mcp" {
        if !target.mcp_path.is_empty() {
            match mcp_items(target, language) {
                Ok(found) => items = found,
                Err(error) => errors.push(format!("{}: {error}", target.mcp_path)),
            }
        }
    } else if kind == "skills" {
        let mut seen = Vec::new();
        for folder in skill_roots(target) {
            scan_skills(&folder, target, &mut seen, &mut items, &mut errors, language)?;
        }
    }
    let query = query.to_lowercase();
    items.retain(|item| format!("{} {}", item["name"].as_str().unwrap_or(""), item["description"].as_str().unwrap_or("")).to_lowercase().contains(&query));
    items.sort_by(|a, b| a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or("")));
    let total = items.len();
    let pages = if total == 0 { 1 } else { total.div_ceil(12) };
    let current = page.max(1).min(pages);
    let start = (current - 1) * 12;
    let slice = items.into_iter().skip(start).take(12).collect::<Vec<_>>();
    Ok(json!({ "items": slice, "total": total, "page": current, "pages": pages, "errors": errors }))
}

fn mcp_items(target: &Target, language: &str) -> Result<Vec<Value>, String> {
    let text = read_text(Path::new(&target.mcp_path), language)?;
    let config = parse_config(target, &text, language)?;
    let (_active_key, map, v2) = mcp_root(target, &config, language)?;
    let mut items = Vec::new();
    for (name, value) in map {
        // Every entry is asked to be an object, as the Electron build asks;
        // one that is not fails the whole list.
        object_or(value, language)?;
        items.push(mcp_item(name, value, &target.mcp_path, v2, language));
    }
    // Servers parked as disabled are listed too, unless the active list
    // has one of the same name.
    if let Some(parked) = config.get("awbDisabledMcp").filter(|value| is_truthy(value)) {
        for (name, value) in object_or(parked, language)? {
            if map.contains_key(name) { continue; }
            object_or(value, language)?;
            let has_url = value.get("url").is_some_and(is_truthy);
            items.push(json!({ "name": name, "description": mcp_description(value, language), "path": target.mcp_path, "transport": if has_url { "http" } else { "stdio" }, "enabled": false }));
        }
    }
    Ok(items)
}

/// A value as an object, or the Electron build's own refusal of it.
fn object_or<'a>(value: &'a Value, language: &str) -> Result<&'a Map<String, Value>, String> {
    match value {
        Value::Object(map) => Ok(map),
        _ => Err(t(language, "配置必须是对象")),
    }
}

/// An agent's configuration as the Electron build's `parseConfig` reads it:
/// Codex's in TOML, the others in JSON with comments and trailing commas.
fn parse_config(target: &Target, text: &str, language: &str) -> Result<Value, String> {
    if target.format == "codex" { read_toml_config(text) } else { parse_json_text(text, language) }
}

/// A TOML document as the JSON the rest of the kernel works with, read
/// whole by the format's own parser. A date or a time is a string, as it is
/// to the Electron build, and the order of the keys is the document's own.
fn read_toml_config(text: &str) -> Result<Value, String> {
    // A file the parser cannot read fails with the parser's own message, as
    // the Electron build's does; it is not translated.
    let parsed: toml::Value = toml::from_str(text.trim_start_matches('\u{feff}')).map_err(|error| error.to_string())?;
    Ok(toml_to_json(parsed))
}

/// One server as the list shows it.
fn mcp_item(name: &str, value: &Value, path: &str, v2: bool, language: &str) -> Value {
    let has_url = value.get("url").is_some_and(is_truthy);
    let transport = if has_url { value.get("type").filter(|item| is_truthy(item)).map(string_of).unwrap_or_else(|| "http".to_string()) } else { "stdio".to_string() };
    let enabled = if v2 { value.get("disabled") != Some(&json!(true)) } else { value.get("enabled") != Some(&json!(false)) };
    json!({ "name": name, "description": mcp_description(value, language), "path": path, "transport": transport, "enabled": enabled })
}

/// What the list says of a server: where it is reached, read by the URL
/// standard's parser and shown as its scheme, host and path; or the program
/// it runs. A URL the parser cannot read is said so, in words.
fn mcp_description(value: &Value, language: &str) -> String {
    if let Some(url) = value.get("url").and_then(|item| item.as_str()) {
        return match ada_url::Url::parse(url, None) {
            // As the Electron build writes it: the protocol with its colon,
            // the host with its port, and the path, `/` when the URL has none.
            Ok(parsed) => format!("{}//{}{}", parsed.protocol(), parsed.host(), parsed.pathname()),
            Err(_) => t(language, "无效 URL"),
        };
    }
    // `String(command[0] || '')`: the first item as JavaScript writes it, or
    // nothing when there is none or it is false.
    match value.get("command") {
        Some(Value::Array(list)) => list.first().filter(|item| is_truthy(item)).map(string_of).unwrap_or_default(),
        Some(Value::String(text)) => text.clone(),
        _ => String::new(),
    }
}

/// Where the MCP servers of a configuration are, as the Electron build's
/// `mcpRoot` finds them: the keys that lead to them, the servers themselves,
/// and whether an OpenCode configuration is of its second release. Each
/// value along the way, and the last one above all, is asked to be an object
/// after a value JavaScript calls false has stood for an empty one.
fn mcp_root<'a>(target: &Target, config: &'a Value, language: &str) -> Result<(Vec<&'a str>, &'a Map<String, Value>, bool), String> {
    let v2 = target.format == "opencode" && opencode_v2(config);
    let keys: Vec<&'a str> = if target.format == "codex" { vec!["mcp_servers"] } else if target.format == "opencode" { if v2 { vec!["mcp", "servers"] } else { vec!["mcp"] } } else { vec!["mcpServers"] };
    static NONE: Value = Value::Null;
    static EMPTY: std::sync::OnceLock<Map<String, Value>> = std::sync::OnceLock::new();
    // `object(value || {})`: a value JavaScript calls false is an empty
    // object before it is asked to be one.
    fn asked<'a>(value: &'a Value, language: &str) -> Result<&'a Map<String, Value>, String> {
        if is_truthy(value) { object_or(value, language) } else { Ok(EMPTY.get_or_init(Map::new)) }
    }
    let mut value: &Value = config;
    for key in &keys {
        value = asked(value, language)?.get(*key).unwrap_or(&NONE);
    }
    let servers = asked(value, language)?;
    Ok((keys, servers, v2))
}

fn opencode_v2(config: &Value) -> bool {
    // The second release of the OpenCode configuration is told by a value
    // that is true to JavaScript, whatever its kind, in one of these fields.
    let servers = config.get("mcp").and_then(|value| value.get("servers"));
    config.get("permissions").is_some_and(|value| value.is_array())
        || config.get("providers").is_some_and(is_truthy)
        || config.get("skills").is_some_and(|value| value.is_array())
        || servers.is_some_and(|value| value.is_object() && value.get("type").is_none() && value.get("command").is_none() && value.get("url").is_none())
}

fn skill_roots(target: &Target) -> Vec<PathBuf> {
    let home = home_dir();
    let mut roots = Vec::new();
    if !target.skill_path.is_empty() { roots.push(PathBuf::from(&target.skill_path)); }
    if matches!(target.id.as_str(), "codex" | "opencode" | "pi") { roots.push(home.join(".agents").join("skills")); }
    if target.id == "codex" {
        if let Some(parent) = Path::new(&target.mcp_path).parent() { roots.push(parent.join("skills")); }
    }
    if target.id == "opencode" { roots.push(home.join(".claude").join("skills")); }
    let mut unique = Vec::new();
    for root in roots {
        if !unique.iter().any(|item: &PathBuf| item == &root) { unique.push(root); }
    }
    unique
}

fn scan_skills(folder: &Path, target: &Target, seen: &mut Vec<PathBuf>, items: &mut Vec<Value>, errors: &mut Vec<String>, language: &str) -> Result<(), String> {
    let real = match crate::real_path(folder) {
        Ok(path) => path,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => { errors.push(format!("{}: {error}", folder.display())); return Ok(()); }
    };
    if seen.iter().any(|item| item == &real) { return Ok(()); }
    seen.push(real);
    let file = folder.join("SKILL.md");
    let disabled = PathBuf::from(format!("{}.awb-disabled", file.display()));
    let source = if file.is_file() { file.clone() } else if disabled.is_file() { disabled } else { PathBuf::new() };
    if source.as_os_str().is_empty() {
        let entries = match fs::read_dir(folder) {
            Ok(entries) => entries,
            Err(error) => { errors.push(format!("{}: {error}", folder.display())); return Ok(()); }
        };
        for entry in entries.flatten() {
            let kind = entry.file_type();
            if kind.as_ref().is_ok_and(|kind| kind.is_dir() || kind.is_symlink()) { scan_skills(&entry.path(), target, seen, items, errors, language)?; }
        }
        return Ok(());
    }
    match skill_info(&source, language) {
        Ok(info) => {
            let enabled = skill_enabled(target, &file, &info.name, language)?;
            items.push(json!({ "name": info.name, "description": info.description, "path": file.display().to_string(), "enabled": enabled }));
        }
        Err(error) => errors.push(format!("{}: {error}", folder.display())),
    }
    Ok(())
}

struct SkillInfo { name: String, description: String }

fn skill_info(file: &Path, language: &str) -> Result<SkillInfo, String> {
    let text = read_text(file, language)?.trim_start_matches('\u{feff}').to_string();
    let rest = text.strip_prefix("---\r\n").or_else(|| text.strip_prefix("---\n")).ok_or_else(|| t(language, "SKILL.md 缺少 YAML 文档属性"))?;
    let end = rest.find("\r\n---").or_else(|| rest.find("\n---")).ok_or_else(|| t(language, "SKILL.md 缺少 YAML 文档属性"))?;
    let front = &rest[..end];
    let mut name = String::new();
    let mut description = String::new();
    for line in front.lines() {
        let Some((key, value)) = line.split_once(':') else { continue };
        let value = value.trim().trim_matches('"').trim().to_string();
        match key.trim() {
            "name" => name = value,
            "description" => description = value,
            _ => {}
        }
    }
    if !skill_name_ok(&name) { return Err(t(language, "Skill 名称须为小写字母、数字和单连字符，最多 64 字符")); }
    let description = description.trim().to_string();
    if description.is_empty() || description.chars().count() > 1024 { return Err(t(language, "Skill 需要 1 到 1024 字符的 description")); }
    Ok(SkillInfo { name, description })
}

fn skill_name_ok(name: &str) -> bool {
    let bytes = name.as_bytes();
    if bytes.is_empty() || bytes.len() > 64 || bytes[0] == b'-' || bytes[bytes.len() - 1] == b'-' { return false; }
    let mut hyphen = false;
    for byte in bytes {
        if *byte == b'-' {
            if hyphen { return false; }
            hyphen = true;
        } else if byte.is_ascii_lowercase() || byte.is_ascii_digit() {
            hyphen = false;
        } else { return false; }
    }
    true
}

fn skill_enabled(target: &Target, file: &Path, name: &str, language: &str) -> Result<bool, String> {
    let disabled = PathBuf::from(format!("{}.awb-disabled", file.display()));
    if disabled.is_file() && !file.is_file() { return Ok(false); }
    if target.skill_adapter.is_empty() || target.skill_adapter == "portable" { return Ok(true); }
    let settings = settings_file(target);
    if settings.as_os_str().is_empty() { return Ok(true); }
    let raw = read_text(&settings, language)?;
    match target.skill_adapter.as_str() {
        "codex" => {
            let entries = toml_skill_entries(&raw);
            Ok(entries.into_iter().rev().find(|item| item.0 == file.display().to_string() || item.1.as_deref() == Some(name)).map(|item| item.2).unwrap_or(true))
        }
        "claude" => {
            let config = parse_json_text(&raw, language)?;
            Ok(config.get("skillOverrides").and_then(|value| value.get(name)).and_then(|value| value.as_str()) != Some("off"))
        }
        "opencode" => opencode_skill_enabled(&raw, name, language),
        "pi" => {
            let config = parse_json_text(&raw, language)?;
            let mark = format!("-{}", file.display());
            Ok(!config.get("skills").and_then(|value| value.as_array()).is_some_and(|items| items.iter().any(|item| item.as_str() == Some(mark.as_str()))))
        }
        "omp" => omp_skill_enabled(&raw, file, name, language),
        _ => Ok(true),
    }
}

fn settings_file(target: &Target) -> PathBuf {
    if !target.skill_config_path.is_empty() { return PathBuf::from(&target.skill_config_path); }
    if target.skill_adapter == "codex" || target.skill_adapter == "opencode" { return PathBuf::from(&target.mcp_path); }
    if target.skill_adapter == "omp" {
        if target.skill_path.is_empty() { return PathBuf::new(); }
        return Path::new(&target.skill_path).parent().unwrap_or(Path::new("")).join("config.yml");
    }
    if !target.skill_path.is_empty() { return Path::new(&target.skill_path).parent().unwrap_or(Path::new("")).join("settings.json"); }
    PathBuf::new()
}

fn toml_skill_entries(text: &str) -> Vec<(String, Option<String>, bool)> {
    let mut entries = Vec::new();
    let mut path = String::new();
    let mut name = None;
    let mut enabled = true;
    let mut open = false;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("[[skills.config]]") { if open { entries.push((path.clone(), name.clone(), enabled)); } open = true; path.clear(); name = None; enabled = true; continue; }
        if !open || trimmed.starts_with('#') { continue; }
        if let Some((key, value)) = trimmed.split_once('=') {
            match key.trim() {
                "path" => path = unquote(value.trim()),
                "name" => name = Some(unquote(value.trim())),
                "enabled" => enabled = value.trim() != "false",
                _ => {}
            }
        }
    }
    if open { entries.push((path, name, enabled)); }
    entries
}

fn toggle_codex_skill(settings: &Path, skill_path: &str, enabled: bool, language: &str) -> Result<(), String> {
    let before = read_text(settings, language)?;
    let entries = toml_skill_entries(&before);
    let index = entries.iter().enumerate().rev().find(|(_, (path, _, _))| path == skill_path).map(|(index, _)| index);
    let next = if let Some(index) = index {
        set_toml_skill_enabled(&before, index, enabled).map_err(|_| t(language, "MCP 配置已改变"))?
    } else {
        let mut next = before.clone();
        if !next.is_empty() && !next.ends_with('\n') { next.push('\n'); }
        if !next.is_empty() { next.push('\n'); }
        next.push_str("[[skills.config]]\n");
        next.push_str(&format!("path = \"{}\"\n", escape_toml(skill_path)));
        next.push_str(&format!("enabled = {enabled}\n"));
        next
    };
    atomic_text(settings, &before, &next, language)
}

fn set_toml_skill_enabled(text: &str, index: usize, enabled: bool) -> Result<String, ()> {
    let mut lines: Vec<String> = text.lines().map(|line| line.to_string()).collect();
    let headers: Vec<usize> = lines.iter().enumerate().filter(|(_, line)| line.trim().starts_with("[[skills.config]]")).map(|(index, _)| index).collect();
    let start = *headers.get(index).ok_or(())?;
    let mut end = headers.get(index + 1).copied().unwrap_or(lines.len());
    if let Some(offset) = lines[start + 1..end].iter().position(|line| {
        let trimmed = line.trim();
        trimmed.starts_with('[') && !trimmed.starts_with("[[skills.config]]")
    }) {
        end = start + 1 + offset;
    }
    let value = if enabled { "true" } else { "false" };
    if let Some(offset) = lines[start..end].iter().position(|line| line.trim().starts_with("enabled")) {
        let absolute = start + offset;
        let indent: String = lines[absolute].chars().take_while(|char| char.is_whitespace()).collect();
        lines[absolute] = format!("{indent}enabled = {value}");
    } else {
        lines.insert(end, format!("enabled = {value}"));
    }
    let mut next = lines.join("\n");
    if text.ends_with('\n') || text.is_empty() { next.push('\n'); }
    Ok(next)
}

fn escape_toml(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn toggle_opencode_skill(settings: &Path, name: &str, enabled: bool, language: &str) -> Result<(), String> {
    let before = read_text(settings, language)?;
    let source = if before.trim().is_empty() { "{\n}\n".to_string() } else { before.clone() };
    let config = parse_json_text(&source, language)?;
    let effect = if enabled { "allow" } else { "deny" };
    let next = if opencode_v2(&config) {
        if config.get("permissions").is_some_and(|value| !value.is_array()) {
            return Err(t(language, "OpenCode V2 permissions 必须是数组"));
        }
        patch_permission_rule(&source, name, effect).map_err(|_| t(language, "JSON 配置存在语法错误，请修复后重试"))?
    } else {
        let skill = config.get("permission").and_then(|value| value.get("skill"));
        if let Some(policy) = skill.and_then(|value| value.as_str()) {
            let raw = serde_json::to_string(&json!({ "*": policy, name: effect })).map_err(|_| t(language, "JSON 配置存在语法错误，请修复后重试"))?;
            upsert_json(&source, &["permission", "skill"], &raw).map_err(|_| t(language, "JSON 配置存在语法错误，请修复后重试"))?
        } else {
            upsert_json(&source, &["permission", "skill", name], &format!("\"{effect}\"")).map_err(|_| t(language, "JSON 配置存在语法错误，请修复后重试"))?
        }
    };
    parse_json_text(&next, language)?;
    atomic_text(settings, &before, &next, language)
}

fn patch_permission_rule(text: &str, name: &str, effect: &str) -> Result<String, ()> {
    let open = root_object(text)?;
    let fields = object_fields(text, open)?;
    let field = fields.iter().rev().find(|field| field.key == "permissions").ok_or(())?;
    let array_at = skip_ws(text.as_bytes(), field.value_at);
    if text.as_bytes().get(array_at) != Some(&b'[') { return Err(()); }
    let elements = array_elements(text, array_at)?;
    if let Some(&(start, end)) = elements.last() {
        let parsed: Value = serde_json::from_str(&strip_jsonc(&text[start..end])).unwrap_or(Value::Null);
        let matches = parsed.get("action").and_then(|value| value.as_str()) == Some("skill")
            && parsed.get("resource").and_then(|value| value.as_str()) == Some(name);
        if matches {
            let inner = text[start..end].find('{').ok_or(())?;
            let rules = object_fields(text, start + inner)?;
            let effect_field = rules.iter().find(|item| item.key == "effect").ok_or(())?;
            let raw = serde_json::to_string(effect).map_err(|_| ())?;
            return Ok(format!("{}{raw}{}", &text[..effect_field.value_at], &text[effect_field.value_end..]));
        }
    }
    let close = skip_value(text, array_at)? - 1;
    let trailing = elements.last().is_some_and(|&(_, end)| text[end..close].contains(','));
    let comma = if elements.is_empty() || trailing { "" } else { "," };
    let raw = format!("{{\"action\":\"skill\",\"resource\":{},\"effect\":{}}}", serde_json::to_string(name).map_err(|_| ())?, serde_json::to_string(effect).map_err(|_| ())?);
    Ok(format!("{}{comma}{raw}{}", &text[..close], &text[close..]))
}

fn array_elements(text: &str, open: usize) -> Result<Vec<(usize, usize)>, ()> {
    let bytes = text.as_bytes();
    if bytes.get(open) != Some(&b'[') { return Err(()); }
    let mut index = open + 1;
    let mut items = Vec::new();
    loop {
        index = skip_ws(bytes, index);
        if bytes.get(index) == Some(&b']') { return Ok(items); }
        let start = index;
        let end = skip_value(text, start)?;
        items.push((start, end));
        index = skip_ws(bytes, end);
        if bytes.get(index) == Some(&b',') { index += 1; continue; }
        if bytes.get(index) == Some(&b']') { return Ok(items); }
        return Err(());
    }
}

fn toggle_pi_skill(settings: &Path, skill_path: &str, enabled: bool, language: &str) -> Result<(), String> {
    let before = read_text(settings, language)?;
    let source = if before.trim().is_empty() { "{\n}\n".to_string() } else { before.clone() };
    let config = parse_json_text(&source, language)?;
    let mark = format!("-{skill_path}");
    let mut entries = config.get("skills").and_then(|value| value.as_array()).map(|items| items.iter().filter_map(|item| item.as_str().map(|item| item.to_string())).collect()).unwrap_or_else(Vec::new);
    entries.retain(|entry| entry != &mark);
    if !enabled { entries.push(mark); }
    let raw = serde_json::to_string(&entries).map_err(|_| t(language, "JSON 配置存在语法错误，请修复后重试"))?;
    let next = upsert_json(&source, &["skills"], &raw).map_err(|_| t(language, "JSON 配置存在语法错误，请修复后重试"))?;
    parse_json_text(&next, language)?;
    atomic_text(settings, &before, &next, language)
}

fn toggle_omp_skill(settings: &Path, file: &Path, name: &str, enabled: bool, language: &str) -> Result<(), String> {
    let before = read_text(settings, language)?;
    let document = parse_yaml(&before).map_err(|_| t(language, "Oh My Pi YAML 配置存在语法错误"))?;
    if enabled && omp_blocked(&document, file, name, language)? {
        return Err(t(language, "此 Skill 受 Oh My Pi 全局筛选或 SKILL.md 停用限制，请先修改对应设置"));
    }
    let mut entries = yaml_list(&document, &["disabledExtensions"]);
    let mark = format!("skill:{name}");
    entries.retain(|entry| entry != &mark);
    if !enabled { entries.push(mark); }
    let next = set_yaml_root_list(&before, "disabledExtensions", &entries);
    atomic_text(settings, &before, &next, language)
}

fn opencode_skill_enabled(raw: &str, name: &str, language: &str) -> Result<bool, String> {
    let config = parse_json_text(raw, language)?;
    let permission = config.get("permission").and_then(|value| value.get("skill"));
    let mut enabled = if let Some(policy) = permission.and_then(|value| value.as_str()) { policy != "deny" } else { true };
    if let Some(rules) = permission.filter(|value| value.is_object()) {
        for (pattern, policy) in rules.as_object().cloned().unwrap_or_default() {
            if wildcard_matches(&pattern, name) { enabled = policy.as_str() != Some("deny"); }
        }
    }
    if config.get("permissions").is_some_and(|value| !value.is_array()) {
        return Err(t(language, "OpenCode V2 permissions 必须是数组"));
    }
    if let Some(rules) = config.get("permissions").and_then(|value| value.as_array()) {
        for rule in rules {
            let action = rule.get("action").and_then(|value| value.as_str()).unwrap_or("");
            let resource = rule.get("resource").and_then(|value| value.as_str()).unwrap_or("");
            if wildcard_matches(action, "skill") && wildcard_matches(resource, name) {
                enabled = rule.get("effect").and_then(|value| value.as_str()) != Some("deny");
            }
        }
    }
    Ok(enabled)
}

fn omp_skill_enabled(raw: &str, file: &Path, name: &str, language: &str) -> Result<bool, String> {
    let document = parse_yaml(raw).map_err(|_| t(language, "Oh My Pi YAML 配置存在语法错误"))?;
    Ok(!omp_blocked(&document, file, name, language)? && !yaml_list(&document, &["disabledExtensions"]).iter().any(|entry| entry == &format!("skill:{name}")))
}

fn omp_blocked(document: &Yaml, file: &Path, name: &str, language: &str) -> Result<bool, String> {
    let include = yaml_list(document, &["skills", "includeSkills"]);
    let ignored = yaml_list(document, &["skills", "ignoredSkills"]).iter().any(|pattern| wildcard_matches(pattern, name));
    let included = include.is_empty() || include.iter().any(|pattern| wildcard_matches(pattern, name));
    Ok(!front_enabled(file, language)? || yaml_false(document, &["skills", "enabled"]) || ignored || !included)
}

fn front_enabled(file: &Path, language: &str) -> Result<bool, String> {
    let text = read_text(file, language)?.trim_start_matches('\u{feff}').to_string();
    let Some(rest) = text.strip_prefix("---\n").or_else(|| text.strip_prefix("---\r\n")) else { return Ok(true); };
    let end = rest.find("\n---").unwrap_or(rest.len());
    for line in rest[..end].lines() {
        let Some((key, value)) = line.split_once(':') else { continue };
        if key.trim() != "enabled" { continue; }
        let value = value.trim();
        if (value.starts_with('"') && value.ends_with('"')) || (value.starts_with('\'') && value.ends_with('\'')) { return Ok(true); }
        return Ok(!matches!(value, "false" | "no" | "off" | "False" | "No" | "Off"));
    }
    Ok(true)
}

fn wildcard_matches(pattern: &str, value: &str) -> bool {
    fn eat(pattern: &[u8], value: &[u8]) -> bool {
        let mut pattern_index = 0;
        let mut value_index = 0;
        let mut star = None;
        let mut mark = 0;
        while value_index < value.len() {
            if pattern_index < pattern.len() && (pattern[pattern_index] == b'?' || pattern[pattern_index] == value[value_index]) {
                pattern_index += 1;
                value_index += 1;
            } else if pattern_index < pattern.len() && pattern[pattern_index] == b'*' {
                star = Some(pattern_index);
                pattern_index += 1;
                mark = value_index;
            } else if let Some(star_at) = star {
                pattern_index = star_at + 1;
                mark += 1;
                value_index = mark;
            } else {
                return false;
            }
        }
        while pattern_index < pattern.len() && pattern[pattern_index] == b'*' { pattern_index += 1; }
        pattern_index == pattern.len()
    }
    eat(pattern.as_bytes(), value.as_bytes())
}

#[derive(Clone)]
enum Yaml { Map(Vec<(String, Yaml)>), Seq(Vec<Yaml>), Str(String), Null }

fn parse_yaml(text: &str) -> Result<Yaml, ()> {
    let lines: Vec<(usize, String)> = text.lines().filter_map(|line| {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') { return None; }
        if line.starts_with('\t') { return None; }
        let indent = line.chars().take_while(|char| *char == ' ').count();
        Some((indent, trimmed.to_string()))
    }).collect();
    if lines.is_empty() { return Ok(Yaml::Map(Vec::new())); }
    let (value, next) = parse_yaml_block(&lines, 0, 0)?;
    if next != lines.len() { return Err(()) }
    Ok(value)
}

fn parse_yaml_block(lines: &[(usize, String)], mut index: usize, indent: usize) -> Result<(Yaml, usize), ()> {
    if index >= lines.len() || lines[index].0 < indent { return Ok((Yaml::Null, index)); }
    if lines[index].1.starts_with("- ") || lines[index].1 == "-" {
        let mut items = Vec::new();
        while index < lines.len() && lines[index].0 == indent && (lines[index].1.starts_with("- ") || lines[index].1 == "-") {
            let rest = lines[index].1.trim_start_matches("- ").trim();
            if rest.is_empty() {
                let (child, next) = parse_yaml_block(lines, index + 1, indent + 2)?;
                items.push(child);
                index = next;
            } else {
                items.push(Yaml::Str(unyaml(rest)));
                index += 1;
            }
        }
        return Ok((Yaml::Seq(items), index));
    }
    let mut map = Vec::new();
    while index < lines.len() && lines[index].0 == indent && !lines[index].1.starts_with('-') {
        let Some((key, value)) = lines[index].1.split_once(':') else { return Err(()) };
        let key = key.trim().to_string();
        let value = value.trim();
        if value.is_empty() {
            let (child, next) = parse_yaml_block(lines, index + 1, indent + 2)?;
            map.push((key, child));
            index = next;
        } else {
            map.push((key, Yaml::Str(unyaml(value))));
            index += 1;
        }
    }
    Ok((Yaml::Map(map), index))
}

fn unyaml(value: &str) -> String {
    let value = value.trim();
    if value.len() >= 2 {
        let bytes = value.as_bytes();
        if (bytes[0] == b'"' && bytes[bytes.len() - 1] == b'"') || (bytes[0] == b'\'' && bytes[bytes.len() - 1] == b'\'') {
            return value[1..value.len() - 1].replace("\\\"", "\"").replace("\\\\", "\\");
        }
    }
    value.to_string()
}

fn yaml_at<'a>(node: &'a Yaml, path: &[&str]) -> Option<&'a Yaml> {
    let mut current = node;
    for key in path {
        match current {
            Yaml::Map(entries) => current = entries.iter().rev().find(|(name, _)| name == key).map(|(_, value)| value)?,
            _ => return None,
        }
    }
    Some(current)
}

fn yaml_list(node: &Yaml, path: &[&str]) -> Vec<String> {
    match yaml_at(node, path) {
        Some(Yaml::Seq(items)) => items.iter().filter_map(|item| match item { Yaml::Str(value) => Some(value.clone()), _ => None }).collect(),
        Some(Yaml::Str(value)) if value == "[]" || value.is_empty() => Vec::new(),
        _ => Vec::new(),
    }
}

fn yaml_false(node: &Yaml, path: &[&str]) -> bool {
    matches!(yaml_at(node, path), Some(Yaml::Str(value)) if matches!(value.as_str(), "false" | "no" | "off" | "False" | "No" | "Off"))
}

fn set_yaml_root_list(text: &str, key: &str, values: &[String]) -> String {
    let mut lines: Vec<String> = text.split('\n').map(|line| line.to_string()).collect();
    if lines.last().is_some_and(|line| line.is_empty()) { lines.pop(); }
    let mut rendered = vec![format!("{key}:")];
    for value in values {
        rendered.push(format!("  - \"{}\"", value.replace('\\', "\\\\").replace('"', "\\\"")));
    }
    let header = lines.iter().position(|line| !line.starts_with(' ') && !line.starts_with('\t') && line.trim().starts_with(&format!("{key}:")));
    if let Some(start) = header {
        let mut end = start + 1;
        while end < lines.len() {
            let line = &lines[end];
            if line.trim().is_empty() || line.starts_with(' ') || line.starts_with('\t') { end += 1; } else { break; }
        }
        let mut next = lines[..start].to_vec();
        next.extend(rendered);
        next.extend_from_slice(&lines[end..]);
        lines = next;
    } else {
        if lines.last().is_some_and(|line| !line.is_empty()) { lines.push(String::new()); }
        lines.extend(rendered);
    }
    let mut next = lines.join("\n");
    if !next.ends_with('\n') { next.push('\n'); }
    next
}

pub fn toggle(resources: &Resources, data: &Path, custom: &Value, kind: &str, agent: &str, item: &Value, enabled: Option<bool>, language: &str) -> Result<(), String> {
    let enabled = enabled.ok_or_else(|| t(language, "无效的开关状态"))?;
    let targets = current_targets(resources, data, custom);
    let target = find_target(&targets, agent, language)?.clone();
    let found = listed(resources, data, custom, kind, agent, item, language)?;
    if kind == "mcp" {
        toggle_mcp(&target, &found, enabled, language)
    } else {
        toggle_skill(&target, &found, enabled, language)
    }
}

fn listed(resources: &Resources, data: &Path, custom: &Value, kind: &str, agent: &str, item: &Value, language: &str) -> Result<Value, String> {
    let page = list(resources, data, custom, kind, agent, 1, "", language)?;
    let name = item["name"].as_str().unwrap_or("");
    let path = item["path"].as_str().unwrap_or("");
    let mut all = page["items"].as_array().cloned().unwrap_or_default();
    if page["pages"].as_u64().unwrap_or(1) > 1 {
        for index in 2..=page["pages"].as_u64().unwrap_or(1) {
            let next = list(resources, data, custom, kind, agent, index as usize, "", language)?;
            all.extend(next["items"].as_array().cloned().unwrap_or_default());
        }
    }
    all.into_iter().find(|entry| entry["name"] == name && entry["path"] == path).ok_or_else(|| t(language, "资源已改变或不属于当前 Agent，请刷新后重试"))
}

fn toggle_mcp(target: &Target, item: &Value, enabled: bool, language: &str) -> Result<(), String> {
    let path = Path::new(&target.mcp_path);
    let before = read_text(path, language)?;
    let name = item["name"].as_str().unwrap_or("");
    if target.format == "codex" {
        let next = set_toml_enabled(&before, name, enabled).map_err(|_| t(language, "MCP 配置已改变"))?;
        return atomic_text(path, &before, &next, language);
    }
    let parks = target.id == "claude" || (target.format == "standard" && target.id != "pi" && target.id != "omp");
    if parks {
        let config = parse_json_text(&before, language)?;
        let active = config.get("mcpServers").cloned().unwrap_or_else(|| json!({}));
        let parked = config.get("awbDisabledMcp").cloned().unwrap_or_else(|| json!({}));
        if enabled && active.get(name).is_some() { return Err(t(language, "已有同名 MCP，未覆盖当前配置")); }
        if !enabled && parked.get(name).is_some() { return Err(t(language, "已有同名停用配置，未覆盖原配置")); }
        let source = if enabled { "awbDisabledMcp" } else { "mcpServers" };
        let dest = if enabled { "mcpServers" } else { "awbDisabledMcp" };
        if config.get(source).and_then(|value| value.get(name)).is_none() { return Err(t(language, "MCP 配置已改变")); }
        let moved = move_json_key(&before, &[source, name], &[dest, name]).map_err(|_| t(language, "JSON 配置存在语法错误，请修复后重试"))?;
        parse_json_text(&moved, language)?;
        if moved.contains("\"enabled\"") && !before.contains("\"enabled\"") { return Err(t(language, "MCP 配置已改变")); }
        return atomic_text(path, &before, &moved, language);
    }
    let config = parse_json_text(&before, language)?;
    let (keys, _, v2) = mcp_root(target, &config, language)?;
    let mut path_keys = keys;
    path_keys.push(name);
    path_keys.push(if v2 { "disabled" } else { "enabled" });
    let raw = if v2 { if enabled { "false" } else { "true" } } else if enabled { "true" } else { "false" };
    let next = upsert_json(&before, &path_keys, raw).map_err(|_| t(language, "JSON 配置存在语法错误，请修复后重试"))?;
    parse_json_text(&next, language)?;
    atomic_text(path, &before, &next, language)
}

fn toggle_skill(target: &Target, item: &Value, enabled: bool, language: &str) -> Result<(), String> {
    let file = PathBuf::from(item["path"].as_str().unwrap_or(""));
    let name = item["name"].as_str().unwrap_or("");
    let settings = settings_file(target);
    if !target.skill_adapter.is_empty() && target.skill_adapter != "portable" && settings.as_os_str().is_empty() {
        return Err(t(language, "请先在执行器高级属性中设置 Skill 配置文件或 MCP 配置文件"));
    }
    match target.skill_adapter.as_str() {
        "claude" => {
            let before = read_text(&settings, language)?;
            let source = if before.trim().is_empty() { "{\n}\n".to_string() } else { before.clone() };
            let next = upsert_json(&source, &["skillOverrides", name], if enabled { "\"on\"" } else { "\"off\"" }).map_err(|_| t(language, "JSON 配置存在语法错误，请修复后重试"))?;
            parse_json_text(&next, language)?;
            atomic_text(&settings, &before, &next, language)?;
            return Ok(());
        }
        "codex" => return toggle_codex_skill(&settings, &file.display().to_string(), enabled, language),
        "opencode" => return toggle_opencode_skill(&settings, name, enabled, language),
        "pi" => return toggle_pi_skill(&settings, &file.display().to_string(), enabled, language),
        "omp" => return toggle_omp_skill(&settings, &file, name, enabled, language),
        _ => {}
    }
    let source = if enabled { PathBuf::from(format!("{}.awb-disabled", file.display())) } else { file.clone() };
    let dest = if enabled { file.clone() } else { PathBuf::from(format!("{}.awb-disabled", file.display())) };
    let meta = fs::symlink_metadata(&source).map_err(|_| t(language, "MCP 配置已改变"))?;
    if meta.file_type().is_symlink() { return Err(t(language, "不能切换指向其他目录的 Skill 链接")); }
    let root = crate::real_path(Path::new(&target.skill_path)).map_err(|error| error.to_string())?;
    let real = crate::real_path(&source).map_err(|error| error.to_string())?;
    if !real.starts_with(&root) { return Err(t(language, "不能切换指向其他目录的 Skill 链接")); }
    if dest.exists() { return Err(t(language, "目标文件已存在，未覆盖")); }
    fs::rename(&source, &dest).map_err(|error| error.to_string())
}

pub fn detail(resources: &Resources, data: &Path, custom: &Value, kind: &str, agent: &str, item: &Value, language: &str) -> Result<Value, String> {
    let targets = current_targets(resources, data, custom);
    let target = find_target(&targets, agent, language)?.clone();
    let found = listed(resources, data, custom, kind, agent, item, language)?;
    if kind == "skills" {
        let path = PathBuf::from(found["path"].as_str().unwrap_or(""));
        let disabled = PathBuf::from(format!("{}.awb-disabled", path.display()));
        let source = if path.is_file() { path } else { disabled };
        let mut detail = found;
        detail["content"] = json!(read_text(&source, language)?);
        return Ok(detail);
    }
    let text = read_text(Path::new(&target.mcp_path), language)?;
    let config = if target.format == "codex" { read_toml_config(&text)? } else { parse_json_text(&text, language)? };
    // `servers[item.name] || object(config.awbDisabledMcp || {})[item.name]`:
    // the active entry when it is true to JavaScript, else the parked one;
    // what is found is asked to be an object, as the Electron build asks.
    let (_, servers, _) = mcp_root(&target, &config, language)?;
    let name = found["name"].as_str().unwrap_or("");
    let value = match servers.get(name).filter(|item| is_truthy(item)) {
        Some(value) => value.clone(),
        None => {
            let parked = config.get("awbDisabledMcp").filter(|item| is_truthy(item)).cloned().unwrap_or_else(|| json!({}));
            object_or(&parked, language)?.get(name).cloned().unwrap_or(Value::Null)
        }
    };
    let clean = redact(&value, language)?;
    let mut detail = found;
    detail["content"] = json!(serde_json::to_string_pretty(&clean).unwrap_or_else(|_| "{}".into()));
    detail["notice"] = json!(t(language, "环境变量、请求头和认证信息已隐藏。"));
    Ok(detail)
}

/// A server's configuration with what must not be shown taken out: the
/// entries of its environment and headers, any field whose name says it is
/// a credential, the account, query and fragment of its URL, and the
/// arguments around a credential. Each step is the Electron build's, and
/// fails as its does when a value is not of the kind it asks for.
fn redact(value: &Value, language: &str) -> Result<Value, String> {
    let mut clean = value.clone();
    let object = object_or_mut(&mut clean, language)?;
    for field in ["env", "environment", "headers", "http_headers"] {
        if let Some(entries) = object.get_mut(field).filter(|item| is_truthy(item)) {
            let map = object_or_mut(entries, language)?;
            for (_key, entry) in map.iter_mut() { *entry = json!("********"); }
        }
    }
    let keys = object.keys().filter(|key| regex_credential(key)).cloned().collect::<Vec<_>>();
    for key in keys { object.insert(key, json!("********")); }
    if let Some(url) = object.get("url").filter(|item| item.is_string()).map(|item| item.as_str().expect("checked to be a string").to_string()) {
        // Read by the standard's parser, as the Electron build reads it; a
        // URL it cannot read fails the whole detail there, and does here.
        let mut parsed = ada_url::Url::parse(&url, None).map_err(|_| "Invalid URL".to_string())?;
        let _ = parsed.set_username(Some(""));
        let _ = parsed.set_password(Some(""));
        parsed.set_search(None);
        parsed.set_hash(None);
        object.insert("url".into(), json!(parsed.href()));
    }
    for field in ["args", "command"] {
        if let Some(list) = object.get_mut(field).and_then(|item| item.as_array_mut()) {
            let mut secret = false;
            for arg in list.iter_mut() {
                let text = string_of(arg);
                let hide = secret || regex_secret(&text);
                secret = regex_secret(&text);
                if hide { *arg = json!("********"); }
            }
        }
    }
    Ok(clean)
}

/// A value as an object to change, or the Electron build's own refusal of it.
fn object_or_mut<'a>(value: &'a mut Value, language: &str) -> Result<&'a mut Map<String, Value>, String> {
    match value {
        Value::Object(map) => Ok(map),
        _ => Err(t(language, "配置必须是对象")),
    }
}

/// Whether a field's name says it is a credential, as the Electron build's
/// `/token|password|secret/i` asks.
fn regex_credential(field: &str) -> bool {
    let lower = field.to_lowercase();
    lower.contains("token") || lower.contains("password") || lower.contains("secret")
}

fn regex_secret(text: &str) -> bool {
    let lower = text.to_lowercase();
    lower.contains("token") || lower.contains("password") || lower.contains("secret") || lower.contains("api-key") || lower.contains("api_key")
}

pub fn skill_directory(resources: &Resources, data: &Path, custom: &Value, agent: &str, item: &Value, removing: bool, language: &str) -> Result<PathBuf, String> {
    let targets = current_targets(resources, data, custom);
    let target = find_target(&targets, agent, language)?.clone();
    let found = listed(resources, data, custom, "skills", agent, item, language)?;
    let folder = Path::new(found["path"].as_str().unwrap_or("")).parent().ok_or_else(|| t(language, "Skill 路径不属于当前 Agent"))?.to_path_buf();
    let roots = skill_roots(&target);
    let inside = roots.iter().any(|root| folder.starts_with(root));
    if !inside { return Err(t(language, "Skill 路径不属于当前 Agent")); }
    if !removing { return Ok(folder); }
    let real = crate::real_path(&folder).map_err(|error| error.to_string())?;
    let mut contained = false;
    for root in roots.iter().filter(|root| root.exists()) {
        let root_real = crate::real_path(root).map_err(|error| error.to_string())?;
        if real == root_real { return Err(t(language, "不能删除整个 Skill 发现目录")); }
        if let Ok(relative) = real.strip_prefix(&root_real) {
            if !relative.as_os_str().is_empty() { contained = true; }
        }
    }
    if !contained { return Err(t(language, "Skill 目录超出 Agent 资源范围，不能执行此操作")); }
    for root in &roots {
        if !root.exists() { continue; }
        let mut current = folder.clone();
        while current.starts_with(root) && current != *root {
            if fs::symlink_metadata(&current).map(|meta| meta.file_type().is_symlink()).unwrap_or(false) {
                return Err(t(language, "不能删除通过符号链接发现的 Skill，请在资源管理器中管理该链接"));
            }
            if !current.pop() { break; }
        }
    }
    Ok(folder)
}

pub fn open_skill(resources: &Resources, data: &Path, custom: &Value, agent: &str, item: &Value, language: &str) -> Result<Value, String> {
    let folder = skill_directory(resources, data, custom, agent, item, false, language)?;
    let real = crate::real_path(&folder).unwrap_or(folder);
    // `AWB_OPEN_SKILL=0` is a test that has no desktop to open a folder on.
    if std::env::var("AWB_OPEN_SKILL").ok().as_deref() != Some("0") {
        crate::shell::open_path(&real, language)?;
    }
    Ok(json!(real.display().to_string()))
}

pub fn delete_skill(resources: &Resources, data: &Path, custom: &Value, agent: &str, item: &Value, language: &str) -> Result<Value, String> {
    let folder = skill_directory(resources, data, custom, agent, item, true, language)?;
    trash_path(&folder, language)?;
    Ok(Value::Null)
}

fn trash_path(path: &Path, language: &str) -> Result<(), String> {
    let unmovable = || t(language, "无法移入回收站");
    if let Ok(program) = std::env::var("AWB_TRASH_BIN") {
        let mut mover = std::process::Command::new(program);
        mover.arg(path);
        let output = crate::sys::hidden(&mut mover).output().map_err(|error| error.to_string())?;
        if output.status.success() { return Ok(()) }
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if !stderr.is_empty() { stderr } else { stdout };
        return Err(if detail.is_empty() { unmovable() } else { detail });
    }
    crate::sys::trash(path).map_err(|_| unmovable())
}

pub fn add_mcp(resources: &Resources, data: &Path, custom: &Value, name: &str, config: &Value, agents: &[Value], enabled: bool, language: &str) -> Result<Value, String> {
    if !mcp_name_ok(name) { return Err(t(language, "MCP 名称只能包含字母、数字、下划线、连字符，最多 64 字符")); }
    validate_mcp_config(config, language)?;
    distribute(resources, data, custom, agents, language, &mut |target| write_mcp(target, name, config, enabled, language))
}

fn mcp_name_ok(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty() && bytes.len() <= 64 && bytes.iter().all(|byte| byte.is_ascii_alphanumeric() || *byte == b'_' || *byte == b'-')
}

/// A server's configuration as the add form gives it, checked in the order
/// the Electron build checks it, so that the first fault found is the same.
fn validate_mcp_config(config: &Value, language: &str) -> Result<(), String> {
    let object = object_or(config, language)?;
    // A server is remote when its URL is a string, be that string empty.
    let remote = object.get("url").is_some_and(|value| value.is_string());
    if remote {
        // The URL is read by the standard's own parser, as the Electron
        // build reads it. One it cannot read fails with its message, which
        // is not translated there and is not here.
        let text = object.get("url").and_then(|value| value.as_str()).expect("checked to be a string");
        let parsed = ada_url::Url::parse(text, None).map_err(|_| "Invalid URL".to_string())?;
        if !matches!(parsed.protocol(), "http:" | "https:") || !parsed.username().is_empty() || !parsed.password().is_empty() { return Err(t(language, "请使用不含账号密码的 HTTP / HTTPS URL")); }
        if object.get("command").is_some() || object.get("type").is_some_and(|value| is_truthy(value) && value.as_str() != Some("http")) { return Err(t(language, "HTTP MCP 请仅配置 url，type 使用 http")); }
        if object.get("args").is_some() || object.get("env").is_some() { return Err(t(language, "HTTP MCP 使用 headers；args、env 仅用于 stdio")); }
    } else {
        match object.get("command").and_then(|value| value.as_str()) {
            Some(value) if !js_trim(value).is_empty() && !value.contains('\0') => {}
            _ => return Err(t(language, "stdio MCP 需要 command")),
        }
    }
    if !remote && (object.get("headers").is_some() || object.get("type").is_some_and(|value| is_truthy(value) && value.as_str() != Some("stdio"))) {
        return Err(t(language, "stdio MCP 使用 command、args、env；不支持 headers 或其他 type"));
    }
    if let Some(args) = object.get("args") {
        if !args.as_array().is_some_and(|list| list.iter().all(|item| item.is_string())) { return Err(t(language, "args 必须是字符串数组")); }
    }
    for key in ["env", "headers"] {
        if let Some(map) = object.get(key) {
            // A value that is not an object is refused as the Electron
            // build refuses it before it looks at the entries.
            let map = object_or(map, language)?;
            if map.values().any(|value| !value.is_string()) { return Err(translate(language, "{{0}} 必须是字符串键值对象", &[key.to_string()])); }
        }
    }
    let allowed = ["type", "command", "args", "env", "url", "headers"];
    if object.keys().any(|key| !allowed.contains(&key.as_str())) { return Err(t(language, "支持的字段为 type、command、args、env、url、headers")); }
    Ok(())
}

fn write_mcp(target: &Target, name: &str, config: &Value, enabled: bool, language: &str) -> Result<(), String> {
    if target.mcp_path.is_empty() { return Err(t(language, "请先设置这个 Agent 的 MCP 配置路径")); }
    let path = Path::new(&target.mcp_path);
    let before = read_text(path, language)?;
    if target.format == "codex" {
        if toml_servers(&before, language)?.iter().any(|(existing, _)| existing == name) { return Err(t(language, "已存在同名 MCP，保留原配置")); }
        let next = format!("{before}{}", toml_table(name, config, enabled));
        return atomic_text(path, &before, &next, language);
    }
    let parsed = parse_json_text(&before, language)?;
    let (keys, servers, v2) = mcp_root(target, &parsed, language)?;
    let parked = !enabled && target.format == "standard" && target.id != "pi" && target.id != "omp";
    if servers.get(name).is_some() || parsed.get("awbDisabledMcp").and_then(|value| value.get(name)).is_some() { return Err(t(language, "已存在同名 MCP，保留原配置")); }
    let value = mcp_value(target, config, enabled, v2, parked);
    let source = if before.trim().is_empty() { "{\n}\n".to_string() } else { before.clone() };
    let mut json_keys: Vec<&str> = if parked { vec!["awbDisabledMcp"] } else { keys };
    json_keys.push(name);
    let raw = serde_json::to_string(&value).map_err(|error| error.to_string())?;
    let next = upsert_json(&source, &json_keys, &raw).map_err(|_| t(language, "JSON 配置存在语法错误，请修复后重试"))?;
    parse_json_text(&next, language)?;
    atomic_text(path, &before, &next, language)
}

fn mcp_value(target: &Target, config: &Value, enabled: bool, v2: bool, parked: bool) -> Value {
    let remote = config.get("url").and_then(|value| value.as_str());
    let mut value = Map::new();
    if target.format == "opencode" {
        if let Some(url) = remote {
            value.insert("type".into(), json!("remote"));
            value.insert("url".into(), json!(url));
            if let Some(headers) = config.get("headers") { value.insert("headers".into(), headers.clone()); }
        } else {
            let mut command = vec![json!(config["command"].as_str().unwrap_or(""))];
            if let Some(args) = config.get("args").and_then(|value| value.as_array()) { command.extend(args.iter().cloned()); }
            value.insert("type".into(), json!("local"));
            value.insert("command".into(), Value::Array(command));
            if let Some(env) = config.get("env") { value.insert("environment".into(), env.clone()); }
        }
        value.insert(if v2 { "disabled" } else { "enabled" }.into(), json!(if v2 { !enabled } else { enabled }));
    } else if let Some(url) = remote {
        value.insert("type".into(), json!("http"));
        value.insert("url".into(), json!(url));
        if let Some(headers) = config.get("headers") { value.insert("headers".into(), headers.clone()); }
        if !enabled && !parked { value.insert("enabled".into(), json!(false)); }
    } else {
        value.insert("command".into(), config.get("command").cloned().unwrap_or(json!("")));
        value.insert("args".into(), config.get("args").cloned().unwrap_or_else(|| json!([])));
        if let Some(env) = config.get("env") { value.insert("env".into(), env.clone()); }
        if !enabled && !parked { value.insert("enabled".into(), json!(false)); }
    }
    Value::Object(value)
}

fn toml_table(name: &str, config: &Value, enabled: bool) -> String {
    let mut lines = format!("\n[mcp_servers.{name}]\n");
    if let Some(url) = config.get("url").and_then(|value| value.as_str()) {
        lines.push_str(&format!("url = {}\n", toml_string(url)));
        if let Some(headers) = config.get("headers") { lines.push_str(&format!("http_headers = {}\n", headers)); }
    } else {
        lines.push_str(&format!("command = {}\n", toml_string(config["command"].as_str().unwrap_or(""))));
        lines.push_str(&format!("args = {}\n", serde_json::to_string(config.get("args").unwrap_or(&json!([]))).unwrap_or_else(|_| "[]".into())));
        if let Some(env) = config.get("env") { lines.push_str(&format!("env = {}\n", inline_toml(env))); }
    }
    if !enabled { lines.push_str("enabled = false\n"); }
    lines
}

fn toml_string(value: &str) -> String { format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\"")) }

fn inline_toml(value: &Value) -> String {
    let Some(map) = value.as_object() else { return "{}".into() };
    let body = map.iter().map(|(key, item)| format!("{key} = {}", toml_string(item.as_str().unwrap_or("")))).collect::<Vec<_>>().join(", ");
    format!("{{ {body} }}")
}

/// The MCP servers of a TOML configuration, as `mcpRoot` finds them.
fn toml_servers(text: &str, language: &str) -> Result<Vec<(String, Value)>, String> {
    let config = read_toml_config(text)?;
    let target = Target { id: String::new(), name: String::new(), mcp_path: String::new(), skill_path: String::new(), skill_config_path: String::new(), format: "codex".to_string(), skill_adapter: String::new() };
    let (_, servers, _) = mcp_root(&target, &config, language)?;
    Ok(servers.iter().map(|(name, value)| (name.clone(), value.clone())).collect())
}

/// A TOML document as the JSON the rest of the kernel works with. A date or
/// a time is a string, as it is to the Electron build, and the order of the
/// keys is the document's own.
fn toml_to_json(value: toml::Value) -> Value {
    match value {
        toml::Value::String(text) => Value::String(text),
        toml::Value::Integer(number) => json!(number),
        toml::Value::Float(number) if number.is_finite() => json!(number),
        toml::Value::Float(_) => Value::Null,
        toml::Value::Boolean(flag) => json!(flag),
        toml::Value::Datetime(moment) => Value::String(moment.to_string()),
        toml::Value::Array(items) => Value::Array(items.into_iter().map(toml_to_json).collect()),
        toml::Value::Table(table) => Value::Object(table.into_iter().map(|(key, item)| (key, toml_to_json(item))).collect()),
    }
}





/// The value of a TOML basic string, with the two escapes `escape_toml` writes
/// restored. A Windows path holds backslashes, so a value read back has to
/// unescape them to equal the path it was written from.
fn unquote(value: &str) -> String {
    let inner = value.trim().trim_matches('"');
    let mut text = String::with_capacity(inner.len());
    let mut chars = inner.chars();
    while let Some(char) = chars.next() {
        if char == '\\' {
            match chars.next() {
                Some('\\') => text.push('\\'),
                Some('"') => text.push('"'),
                // Anything else is kept as written: it is not one of ours.
                Some(next) => {
                    text.push('\\');
                    text.push(next);
                }
                None => text.push('\\'),
            }
        } else {
            text.push(char);
        }
    }
    text
}

fn set_toml_enabled(text: &str, name: &str, enabled: bool) -> Result<String, ()> {
    let header = format!("[mcp_servers.{name}]");
    let quoted = format!("[mcp_servers.\"{name}\"]");
    let mut lines = text.lines().map(|line| line.to_string()).collect::<Vec<_>>();
    let Some(start) = lines.iter().position(|line| { let trimmed = line.trim(); trimmed == header || trimmed == quoted }) else {
        return set_inline_toml_enabled(text, name, enabled);
    };
    let end = lines.iter().enumerate().skip(start + 1).find(|(_, line)| line.trim().starts_with('[')).map(|(index, _)| index).unwrap_or(lines.len());
    let replacement = format!("enabled = {}", if enabled { "true" } else { "false" });
    if let Some(index) = lines.iter().enumerate().skip(start + 1).take(end - start - 1).find(|(_, line)| line.trim().starts_with("enabled")).map(|(index, _)| index) {
        lines[index] = replacement;
    } else {
        lines.insert(start + 1, replacement);
    }
    Ok(lines.join("\n") + if text.ends_with('\n') { "\n" } else { "" })
}


fn matching_brace(text: &str, open: usize) -> Option<usize> {
    let bytes = text.as_bytes();
    let mut depth = 0;
    let mut index = open;
    let mut quoted = false;
    while index < bytes.len() {
        let byte = bytes[index];
        if quoted {
            if byte == b'\\' { index += 2; continue; }
            if byte == b'"' { quoted = false; }
            index += 1;
            continue;
        }
        match byte {
            b'"' => quoted = true,
            b'{' => depth += 1,
            b'}' => { depth -= 1; if depth == 0 { return Some(index); } }
            _ => {}
        }
        index += 1;
    }
    None
}





fn set_inline_toml_enabled(text: &str, name: &str, enabled: bool) -> Result<String, ()> {
    let mut index = 0;
    while index < text.len() {
        let Some(found) = text[index..].find("mcp_servers") else { break };
        let start = index + found;
        let after = start + "mcp_servers".len();
        if !text[after..].trim_start().starts_with('=') { index = after; continue; }
        let Some(eq) = text[after..].find('=') else { break };
        let Some(open_rel) = text[after + eq..].find('{') else { break };
        let open = after + eq + open_rel;
        let Some(close) = matching_brace(text, open) else { break };
        let body = &text[open + 1..close];
        if let Some((inner_start, inner_end)) = inline_server_span(body, name) {
            let start = open + 1 + inner_start;
            let end = open + 1 + inner_end;
            let replaced = replace_enabled_token(&text[start..end], enabled)?;
            return Ok(format!("{}{replaced}{}", &text[..start], &text[end..]));
        }
        index = close + 1;
    }
    Err(())
}

fn inline_server_span(body: &str, name: &str) -> Option<(usize, usize)> {
    let bytes = body.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        while index < bytes.len() && (bytes[index].is_ascii_whitespace() || bytes[index] == b',') { index += 1; }
        if index >= bytes.len() { return None; }
        let (key, next) = if bytes[index] == b'"' {
            let end = body[index + 1..].find('"')? + index + 1;
            (body[index + 1..end].to_string(), end + 1)
        } else {
            let start = index;
            while index < bytes.len() && bytes[index] != b'=' && !bytes[index].is_ascii_whitespace() { index += 1; }
            (body[start..index].to_string(), index)
        };
        let eq = body[next..].find('=')? + next;
        let value_from = eq + 1;
        let rel = body[value_from..].find(|char: char| !char.is_whitespace())?;
        let value_at = value_from + rel;
        if bytes.get(value_at) != Some(&b'{') { return None; }
        let close = matching_brace(body, value_at)?;
        if key == name { return Some((value_at + 1, close)); }
        index = close + 1;
    }
    None
}

fn replace_enabled_token(inner: &str, enabled: bool) -> Result<String, ()> {
    let value = if enabled { "true" } else { "false" };
    let bytes = inner.as_bytes();
    let mut index = 0;
    while let Some(found) = inner[index..].find("enabled") {
        let at = index + found;
        let after = at + "enabled".len();
        let before_ok = at == 0 || !bytes[at - 1].is_ascii_alphanumeric();
        if before_ok && inner[after..].trim_start().starts_with('=') {
            let eq = inner[after..].find('=').ok_or(())? + after;
            let mut value_at = eq + 1;
            while value_at < bytes.len() && bytes[value_at].is_ascii_whitespace() { value_at += 1; }
            let word = if inner[value_at..].starts_with("true") { 4 } else if inner[value_at..].starts_with("false") { 5 } else { return Err(()) };
            return Ok(format!("{}{value}{}", &inner[..value_at], &inner[value_at + word..]));
        }
        index = after;
    }
    Err(())
}

fn distribute(resources: &Resources, data: &Path, custom: &Value, agents: &[Value], language: &str, run: &mut dyn FnMut(&Target) -> Result<(), String>) -> Result<Value, String> {
    if resources.busy.swap(true, Ordering::SeqCst) { return Err(t(language, "正在分发资源，请稍候")); }
    let result = (|| {
        if agents.is_empty() { return Err(t(language, "请选择至少一个 Code Agent")); }
        let targets = current_targets(resources, data, custom);
        let mut seen = Vec::new();
        let mut results = Vec::new();
        for agent in agents {
            let id = agent.as_str().unwrap_or("").to_string();
            if seen.contains(&id) { continue; }
            seen.push(id.clone());
            match find_target(&targets, &id, language) {
                Ok(target) => match run(target) {
                    Ok(()) => results.push(json!({ "agent": id, "ok": true })),
                    Err(error) => results.push(json!({ "agent": id, "ok": false, "error": error })),
                },
                Err(error) => results.push(json!({ "agent": id, "ok": false, "error": error })),
            }
        }
        Ok(Value::Array(results))
    })();
    resources.busy.store(false, Ordering::SeqCst);
    result
}

pub fn scan(data: &Path, custom: &Value, kind: &str, source: &str, language: &str) -> Result<Value, String> {
    if kind == "skills" {
        let _ = (data, custom);
        let (staging, skills) = stage_skills(Path::new(source), language)?;
        let listed = skills.iter().map(|skill| json!({ "id": skill.name, "name": skill.name, "description": skill.description, "path": skill.relative })).collect::<Vec<_>>();
        let _ = remove_tree(&staging);
        return Ok(Value::Array(listed));
    }
    let entries = read_mcp_import(Path::new(source), language)?;
    // A server that can be imported has no error said of it at all, as in
    // the Electron build's scan; the configuration itself is not returned.
    Ok(Value::Array(entries.into_iter().map(|entry| {
        let mut shown = json!({ "id": entry.id, "name": entry.name, "path": entry.path, "enabled": entry.enabled });
        if let Some(error) = entry.error { shown["error"] = json!(error); }
        shown
    }).collect()))
}

struct ImportEntry { id: String, name: String, path: String, config: Option<Value>, enabled: bool, error: Option<String> }

pub fn import_mcp(resources: &Resources, data: &Path, custom: &Value, source: &str, agents: &[Value], ids: &[Value], language: &str) -> Result<Value, String> {
    let entries = read_mcp_import(Path::new(source), language)?;
    if ids.is_empty() || ids.iter().any(|id| !entries.iter().any(|entry| entry.id == id.as_str().unwrap_or(""))) { return Err(t(language, "请选择扫描结果中的 MCP")); }
    let mut results = Vec::new();
    for entry in entries.into_iter().filter(|entry| ids.iter().any(|id| id.as_str() == Some(entry.id.as_str()))) {
        if entry.config.is_none() || entry.error.is_some() {
            for agent in agents {
                results.push(json!({ "agent": agent.as_str().unwrap_or(""), "name": entry.name, "id": entry.id, "ok": false, "error": entry.error.clone().unwrap_or_else(|| t(language, "无效配置")) }));
            }
            continue;
        }
        let added = add_mcp(resources, data, custom, &entry.name, entry.config.as_ref().unwrap(), agents, entry.enabled, language)?;
        if let Some(list) = added.as_array() {
            for item in list { let mut item = item.clone(); item["name"] = json!(entry.name); item["id"] = json!(entry.id); results.push(item); }
        }
    }
    Ok(Value::Array(results))
}

/// The servers of a configuration file, found as the Electron build's
/// `readMcpImport` finds them, with what each one would be refused for. The
/// file's own content is not returned with them, only its shape.
fn read_mcp_import(source: &Path, language: &str) -> Result<Vec<ImportEntry>, String> {
    let syntax = || t(language, "配置语法有误，请检查 JSON、JSONC、TOML 或 YAML 格式");
    // The limit here is in round millions of bytes, as the Electron build's
    // own reading of an import file has it; the other files it reads are
    // limited to 32 MiB.
    if !source.is_absolute() { return Err(t(language, "请选择 32 MB 以内的 MCP 配置文件")); }
    let meta = fs::metadata(source).map_err(|error| error.to_string())?;
    if meta.len() > 32_000_000 { return Err(t(language, "请选择 32 MB 以内的 MCP 配置文件")); }
    let text = read_text(source, language)?;
    // The format is chosen by the file's name, without regard to case.
    let lower = source.file_name().and_then(|item| item.to_str()).unwrap_or("").to_lowercase();
    let config: Value = if lower.ends_with(".toml") {
        toml::from_str::<toml::Value>(text.trim_start_matches('\u{feff}')).map(toml_to_json).map_err(|_| syntax())?
    } else if lower.ends_with(".yaml") || lower.ends_with(".yml") {
        yaml_document(&text).map_err(|_| syntax())?
    } else {
        let source = text.trim_start_matches('\u{feff}').trim();
        // Comments and trailing commas are allowed, as jsonc-parser allows them.
        jsonc_value(if source.is_empty() { "{}" } else { source }).map_err(|_| syntax())?
    };
    if !config.is_object() { return Err(t(language, "MCP 配置的根节点必须是对象")); }
    let mut entries = Vec::new();
    walk_mcp(&config, "$", 0, language, &mut entries)?;
    if entries.is_empty() {
        let object = config.as_object().expect("the root was checked to be an object");
        // A file that is one server on its own takes its name from what it
        // says, or from the file's name with what a name cannot hold replaced.
        if object.contains_key("command") || object.contains_key("url") {
            let name = object.get("name").filter(|value| value.is_string()).map(|value| value.as_str().unwrap_or("").to_string()).unwrap_or_else(|| {
                let base = source.file_stem().and_then(|item| item.to_str()).unwrap_or("").to_string();
                let cleaned: String = base.chars().map(|character| if character.is_ascii_alphanumeric() || character == '_' || character == '-' { character } else { '-' }).take(64).collect();
                if cleaned.is_empty() { "imported-mcp".to_string() } else { cleaned }
            });
            add_import_entry(&name, &config, "$", language, &mut entries);
        } else if !object.is_empty() && object.values().all(|item| item.as_object().is_some_and(|map| map.contains_key("command") || map.contains_key("url"))) {
            collect_mcp(&config, "$", language, &mut entries)?;
        }
    }
    if entries.is_empty() { return Err(t(language, "未发现 MCP 服务器。支持 mcpServers、mcp_servers、mcp.servers、servers 和 context_servers")); }
    Ok(entries)
}

/// A JSON or JSONC document, with comments and trailing commas allowed.
fn jsonc_value(text: &str) -> Result<Value, ()> {
    let stripped = strip_jsonc(text);
    serde_json::from_str::<Value>(&stripped).map_err(|_| ())
}

/// A YAML document as the JSON the rest of the kernel works with. A document
/// that says nothing is null, as it is to the Electron build's package, so
/// that the caller refuses it as a root that is not an object.
fn yaml_document(text: &str) -> Result<Value, ()> {
    let parsed: serde_yaml::Value = serde_yaml::from_str(text.trim_start_matches('\u{feff}')).map_err(|_| ())?;
    Ok(yaml_value_to_json(parsed))
}

fn yaml_value_to_json(node: serde_yaml::Value) -> Value {
    match node {
        serde_yaml::Value::Null => Value::Null,
        serde_yaml::Value::Bool(flag) => json!(flag),
        serde_yaml::Value::Number(number) => json!(number),
        serde_yaml::Value::String(text) => Value::String(text),
        serde_yaml::Value::Sequence(items) => Value::Array(items.into_iter().map(yaml_value_to_json).collect()),
        serde_yaml::Value::Mapping(map) => Value::Object(map.into_iter().map(|(key, value)| (yaml_key(key), yaml_value_to_json(value))).collect()),
        other => json!(other.as_str().unwrap_or("")),
    }
}

/// A mapping's key as text. A key that is not a string is written as the
/// YAML package writes it to a JavaScript object's key.
fn yaml_key(key: serde_yaml::Value) -> String {
    match key {
        serde_yaml::Value::String(text) => text,
        serde_yaml::Value::Bool(flag) => flag.to_string(),
        serde_yaml::Value::Number(number) => number.to_string(),
        serde_yaml::Value::Null => "null".to_string(),
        _ => String::new(),
    }
}

/// The collections of servers in a configuration, at any depth up to 64.
fn walk_mcp(node: &Value, location: &str, depth: usize, language: &str, entries: &mut Vec<ImportEntry>) -> Result<(), String> {
    if depth > 64 { return Err(t(language, "配置嵌套超过 64 层，请选择更小的配置文件")); }
    let Some(object) = node.as_object() else { return Ok(()) };
    for (key, child) in object {
        let current = format!("{location}.{key}");
        if matches!(key.as_str(), "mcpServers" | "mcp_servers" | "context_servers") {
            collect_mcp(child, &current, language, entries)?;
        } else if key == "mcp" && child.is_object() {
            let servers = child.get("servers").filter(|value| value.is_object()).unwrap_or(child);
            collect_mcp(servers, &current, language, entries)?;
        } else if key == "servers" && location == "$" {
            collect_mcp(child, &current, language, entries)?;
        } else if child.is_object() {
            walk_mcp(child, &current, depth + 1, language, entries)?;
        }
    }
    Ok(())
}

/// The servers named by a collection, each checked on its own.
fn collect_mcp(map: &Value, location: &str, language: &str, entries: &mut Vec<ImportEntry>) -> Result<(), String> {
    let Some(object) = map.as_object() else { return Err(translate(language, "{{0}} 必须是服务器对象集合", &[location.to_string()])) };
    for (name, value) in object { add_import_entry(name, value, location, language, entries); }
    Ok(())
}

fn add_import_entry(name: &str, value: &Value, location: &str, language: &str, entries: &mut Vec<ImportEntry>) {
    // A server that is not an object is enabled by default; its reason is
    // said by the check below.
    let enabled = match value.as_object() {
        Some(object) => object.get("enabled") != Some(&json!(false)) && object.get("disabled") != Some(&json!(true)),
        None => true,
    };
    let mut entry = ImportEntry { id: format!("{location}:{name}"), name: name.to_string(), path: location.to_string(), config: None, enabled, error: None };
    if !mcp_name_ok(name) {
        entry.error = Some(t(language, "MCP 名称只能包含字母、数字、下划线和连字符，最多 64 字符"));
    } else {
        match normalize_import(value, language) {
            Ok(config) => entry.config = Some(config),
            Err(error) => entry.error = Some(error),
        }
    }
    entries.push(entry);
}

fn string_map(value: &Value) -> bool { value.as_object().is_some_and(|map| map.values().all(|item| item.is_string())) }

/// A server's configuration in the form the agents take, or the one reason
/// it cannot be used, checked in the order the Electron build checks it.
/// A field that is absent is `undefined` there; null is a value that is set.
fn normalize_import(value: &Value, language: &str) -> Result<Value, String> {
    let object = value.as_object().ok_or_else(|| t(language, "服务器配置必须是对象"))?;
    // The field's value, when the file sets it; null counts as set.
    let set = |key: &str| object.get(key);
    if set("args").is_some_and(|item| !item.is_array()) { return Err(t(language, "args 必须是字符串数组")); }
    for key in ["enabled", "disabled"] {
        if set(key).is_some_and(|item| !item.is_boolean()) { return Err(translate(language, "{{0}} 必须是布尔值", &[key.to_string()])); }
    }
    let supported = ["name", "description", "type", "command", "args", "env", "environment", "url", "headers", "http_headers", "enabled", "disabled"];
    let extra = object.keys().filter(|key| !supported.contains(&key.as_str())).cloned().collect::<Vec<_>>();
    if !extra.is_empty() { return Err(translate(language, "包含需要手动适配的字段：{{0}}", &[extra.join("、")])); }
    if let Some(url) = set("url") {
        // A URL that is not a string is refused in so many words. A string
        // the URL parser cannot read throws its own error there, which is
        // shown as it is, not translated.
        if !url.is_string() { return Err(t(language, "HTTP MCP 需要有效的 http/https URL")); }
        let parsed = match ada_url::Url::parse(url.as_str().expect("checked to be a string"), None) {
            Ok(parsed) => parsed,
            // The message of Node's `new URL` for a URL it cannot read.
            Err(_) => return Err("Invalid URL".to_string()),
        };
        if !matches!(parsed.protocol(), "http:" | "https:") { return Err(t(language, "HTTP MCP 需要有效的 http/https URL")); }
        if set("type").is_some_and(is_truthy) && !["http", "remote", "streamable-http"].contains(&string_of(set("type").unwrap()).as_str()) { return Err(t(language, "暂不支持此远程传输类型")); }
        // The first of the two that is not null or absent; the second may
        // itself be null, which is a value that does not pass the check.
        let headers = match set("headers") {
            Some(first) if !first.is_null() => Some(first),
            _ => set("http_headers"),
        };
        if headers.is_some_and(|headers| !is_record(headers) || !string_map(headers)) { return Err(t(language, "headers 必须是字符串键值对象")); }
        let mut config = serde_json::Map::new();
        config.insert("url".into(), url.clone());
        if let Some(headers) = headers.filter(|value| is_truthy(value)) { config.insert("headers".into(), headers.clone()); }
        return Ok(Value::Object(config));
    }
    if set("type").is_some_and(is_truthy) && !["stdio", "local"].contains(&string_of(set("type").unwrap()).as_str()) { return Err(t(language, "暂不支持此传输类型")); }
    if set("headers").is_some() || set("http_headers").is_some() { return Err(t(language, "stdio MCP 不支持 HTTP headers，请确认源配置")); }
    // A command may be given as an object: the program, its arguments and
    // its environment in one place.
    let command_value = set("command").unwrap_or(&Value::Null);
    let command_object = if is_record(command_value) { command_value.as_object().expect("checked to be an object") } else { object };
    let command = if is_record(command_value) {
        command_object.get("path").unwrap_or(&Value::Null)
    } else if let Some(list) = command_value.as_array() {
        list.first().unwrap_or(&Value::Null)
    } else {
        command_value
    };
    let args = match command_value.as_array() {
        Some(list) => {
            let mut args: Vec<Value> = list.iter().skip(1).cloned().collect();
            if let Some(extra) = set("args").and_then(|value| value.as_array()) { args.extend(extra.iter().cloned()); }
            Value::Array(args)
        }
        None => command_object.get("args").filter(|value| is_truthy(value)).cloned().unwrap_or_else(|| Value::Array(Vec::new())),
    };
    // The first of the two that is not null or absent, as above.
    let env = match command_object.get("env") {
        Some(first) if !first.is_null() => Some(first),
        _ => set("environment"),
    };
    if !command.is_string() || command.as_str().is_some_and(|text| js_trim(text).is_empty() || text.contains('\0')) { return Err(t(language, "stdio MCP 缺少有效 command")); }
    if !args.as_array().is_some_and(|list| list.iter().all(|item| item.is_string())) { return Err(t(language, "args 必须是字符串数组")); }
    if env.is_some_and(|env| !is_record(env) || !string_map(env)) { return Err(t(language, "env 必须是字符串键值对象")); }
    let mut config = serde_json::Map::new();
    config.insert("command".into(), command.clone());
    config.insert("args".into(), args);
    if let Some(env) = env.filter(|value| is_truthy(value)) { config.insert("env".into(), env.clone()); }
    Ok(Value::Object(config))
}

struct StagedSkill { folder: PathBuf, name: String, description: String, relative: String }

pub fn import_skills(resources: &Resources, data: &Path, custom: &Value, source: &str, agents: &[Value], names: Option<&Vec<String>>, language: &str) -> Result<Value, String> {
    let (staging, discovered) = stage_skills(Path::new(source), language)?;
    let outcome = (|| {
        let skills = if let Some(names) = names {
            if names.is_empty() || names.iter().any(|name| !discovered.iter().any(|skill| &skill.name == name)) { return Err(t(language, "请选择扫描结果中的 Skill")); }
            discovered.iter().filter(|skill| names.iter().any(|name| name == &skill.name)).cloned().collect::<Vec<_>>()
        } else { discovered.clone() };
        if skills.is_empty() { return Err(t(language, "请选择扫描结果中的 Skill")); }
        let results = distribute(resources, data, custom, agents, language, &mut |target| install_skills(target, &skills, language))?;
        if skills.len() == 1 { return Ok(results); }
        let mut expanded = Vec::new();
        if let Some(list) = results.as_array() {
            for result in list {
                for skill in &skills {
                    let mut item = result.clone();
                    item["name"] = json!(skill.name);
                    expanded.push(item);
                }
            }
        }
        Ok(Value::Array(expanded))
    })();
    let _ = remove_tree(&staging);
    outcome
}

impl Clone for StagedSkill {
    fn clone(&self) -> Self { Self { folder: self.folder.clone(), name: self.name.clone(), description: self.description.clone(), relative: self.relative.clone() } }
}

fn install_skills(target: &Target, skills: &[StagedSkill], language: &str) -> Result<(), String> {
    if target.skill_path.is_empty() { return Err(t(language, "请先设置这个 Agent 的 Skill 目录")); }
    let root = PathBuf::from(&target.skill_path);
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let root = crate::real_path(&root).map_err(|error| error.to_string())?;
    for skill in skills {
        if root.join(&skill.name).exists() { return Err(translate(language, "已存在 {{0}}，保留原文件", &[skill.name.clone()])); }
    }
    let mut prepared = Vec::new();
    let mut installed = Vec::new();
    let result = (|| {
        for skill in skills {
            let temp = root.join(format!(".awb-{}", random_id()));
            let dest = root.join(&skill.name);
            copy_skill_tree(&skill.folder, &temp, language)?;
            prepared.push((temp, dest));
        }
        for (temp, dest) in &prepared {
            if dest.exists() { return Err(t(language, "目标目录已变化，请刷新后重试")); }
            fs::rename(temp, dest).map_err(|error| error.to_string())?;
            installed.push(dest.clone());
        }
        Ok(())
    })();
    if result.is_err() {
        for dest in &installed { let _ = remove_inside(&root, dest); }
    }
    for (temp, _) in &prepared { let _ = remove_inside(&root, temp); }
    result
}

fn stage_skills(source: &Path, language: &str) -> Result<(PathBuf, Vec<StagedSkill>), String> {
    if !source.is_absolute() { return Err(t(language, "请选择 Skill 文件夹或 ZIP 压缩包")); }
    let meta = fs::symlink_metadata(source).map_err(|error| error.to_string())?;
    if meta.file_type().is_symlink() { return Err(t(language, "导入文件夹包含符号链接，请选择真实目录")); }
    let staging = std::env::temp_dir().join(format!("awb-skills-{}", random_id()));
    fs::create_dir_all(&staging).map_err(|error| error.to_string())?;
    let staged = (|| {
        if meta.is_dir() {
            copy_import_dir(source, &staging, &staging, language)?;
        } else {
            if !source.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("zip")) || meta.len() > MAX_SKILL_BYTES { return Err(t(language, "请选择 32 MB 以内的 ZIP 文件")); }
            extract_zip(source, &staging, language)?;
        }
        let mut skills = Vec::new();
        discover_skills(&staging, &staging, &mut skills, language)?;
        if skills.is_empty() { return Err(t(language, "未找到包含有效 SKILL.md 的目录")); }
        let mut names = Vec::new();
        for skill in &skills {
            if names.contains(&skill.name) { return Err(t(language, "导入包包含同名 Skill")); }
            names.push(skill.name.clone());
        }
        Ok(skills)
    })();
    match staged {
        Ok(skills) => Ok((staging, skills)),
        Err(error) => { let _ = remove_tree(&staging); Err(error) }
    }
}

fn discover_skills(folder: &Path, staging: &Path, skills: &mut Vec<StagedSkill>, language: &str) -> Result<(), String> {
    let file = folder.join("SKILL.md");
    if file.is_file() {
        let info = skill_info(&file, language)?;
        let relative = folder.strip_prefix(staging).unwrap_or(Path::new(".")).display().to_string();
        skills.push(StagedSkill { folder: folder.to_path_buf(), name: info.name, description: info.description, relative: if relative.is_empty() { ".".into() } else { relative } });
    }
    for entry in fs::read_dir(folder).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        if entry.file_type().map_err(|error| error.to_string())?.is_dir() { discover_skills(&entry.path(), staging, skills, language)?; }
    }
    Ok(())
}

fn copy_import_dir(source: &Path, dest_root: &Path, staging: &Path, language: &str) -> Result<(), String> {
    let mut budget = (0usize, 0u64);
    copy_checked(source, dest_root, staging, &mut budget, language)
}

fn copy_checked(source: &Path, dest: &Path, staging: &Path, budget: &mut (usize, u64), language: &str) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|error| error.to_string())?;
    for entry in fs::read_dir(source).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let kind = fs::symlink_metadata(entry.path()).map_err(|error| error.to_string())?;
        if kind.file_type().is_symlink() { return Err(t(language, "导入文件夹包含符号链接，请先移除链接")); }
        let target = dest.join(entry.file_name());
        if !target.starts_with(staging) { return Err(t(language, "导入包包含不安全路径")); }
        if kind.is_dir() { copy_checked(&entry.path(), &target, staging, budget, language)?; }
        else if kind.is_file() {
            if kind.len() > MAX_SKILL_BYTES.saturating_sub(budget.1) { return Err(t(language, "Skill 包超过 32 MB")); }
            budget.0 += 1;
            budget.1 += kind.len();
            if budget.0 > MAX_SKILL_FILES || budget.1 > MAX_SKILL_BYTES { return Err(t(language, "Skill 包超过 10000 个文件或 32 MB")); }
            fs::copy(entry.path(), &target).map_err(|error| error.to_string())?;
        } else { return Err(t(language, "Skill 包包含不支持的文件类型")); }
    }
    Ok(())
}

fn copy_skill_tree(source: &Path, dest: &Path, language: &str) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|error| error.to_string())?;
    for entry in fs::read_dir(source).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let kind = entry.file_type().map_err(|error| error.to_string())?;
        if kind.is_symlink() { return Err(t(language, "导入文件夹包含符号链接，请先移除链接")); }
        let target = dest.join(entry.file_name());
        if kind.is_dir() { copy_skill_tree(&entry.path(), &target, language)?; }
        else if kind.is_file() {
            let mut input = File::open(entry.path()).map_err(|error| error.to_string())?;
            let mut output = crate::sys::create_shared_file(&target).map_err(|error| error.to_string())?;
            std::io::copy(&mut input, &mut output).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn extract_zip(source: &Path, staging: &Path, language: &str) -> Result<(), String> {
    let bytes = fs::read(source).map_err(|error| error.to_string())?;
    let declared = zip_declarations(&bytes).map_err(|_| t(language, "请选择 32 MB 以内的 ZIP 文件"))?;
    let mut total = 0u64;
    if declared.len() > MAX_SKILL_FILES { return Err(t(language, "ZIP 解压后超过 10000 个文件或 32 MB")); }
    for (name, size) in &declared {
        safe_relative(name, language)?;
        total = total.saturating_add(*size);
        if total > MAX_SKILL_BYTES { return Err(t(language, "ZIP 解压后超过 10000 个文件或 32 MB")); }
    }
    let file = File::open(source).map_err(|error| error.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|_| t(language, "请选择 32 MB 以内的 ZIP 文件"))?;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|error| error.to_string())?;
        if entry.is_dir() { continue; }
        let name = entry.name().to_string();
        let relative = safe_relative(&name, language)?;
        let dest = staging.join(&relative);
        if !dest.starts_with(staging) { return Err(t(language, "导入包包含不安全路径")); }
        if let Some(parent) = dest.parent() { fs::create_dir_all(parent).map_err(|error| error.to_string())?; }
        let mut output = crate::sys::create_shared_file(&dest).map_err(|error| error.to_string())?;
        let mut limited = entry.by_ref().take(MAX_SKILL_BYTES + 1);
        let copied = std::io::copy(&mut limited, &mut output).map_err(|error| error.to_string())?;
        if copied > MAX_SKILL_BYTES { return Err(t(language, "ZIP 解压后超过 10000 个文件或 32 MB")); }
    }
    Ok(())
}

fn zip_declarations(bytes: &[u8]) -> Result<Vec<(String, u64)>, ()> {
    if bytes.len() < 22 { return Err(()); }
    let mut eocd = None;
    let start = bytes.len().saturating_sub(22 + 65_535);
    for index in (start..=bytes.len() - 22).rev() {
        if bytes[index..index + 4] == [0x50, 0x4b, 0x05, 0x06] { eocd = Some(index); break; }
    }
    let eocd = eocd.ok_or(())?;
    let count = u16::from_le_bytes([bytes[eocd + 10], bytes[eocd + 11]]) as usize;
    let offset = u32::from_le_bytes([bytes[eocd + 16], bytes[eocd + 17], bytes[eocd + 18], bytes[eocd + 19]]) as usize;
    let mut cursor = offset;
    let mut entries = Vec::new();
    for _ in 0..count {
        if cursor + 46 > bytes.len() || bytes[cursor..cursor + 4] != [0x50, 0x4b, 0x01, 0x02] { return Err(()); }
        let compressed = u32::from_le_bytes(bytes[cursor + 20..cursor + 24].try_into().unwrap()) as u64;
        let size = u32::from_le_bytes(bytes[cursor + 24..cursor + 28].try_into().unwrap()) as u64;
        let name_len = u16::from_le_bytes([bytes[cursor + 28], bytes[cursor + 29]]) as usize;
        let extra_len = u16::from_le_bytes([bytes[cursor + 30], bytes[cursor + 31]]) as usize;
        let comment_len = u16::from_le_bytes([bytes[cursor + 32], bytes[cursor + 33]]) as usize;
        let name_at = cursor + 46;
        if name_at + name_len > bytes.len() { return Err(()); }
        let name = String::from_utf8_lossy(&bytes[name_at..name_at + name_len]).into_owned();
        if !name.ends_with('/') { entries.push((name, size.max(compressed))); }
        cursor = name_at + name_len + extra_len + comment_len;
    }
    Ok(entries)
}

fn safe_relative(value: &str, language: &str) -> Result<String, String> {
    let normalized = value.replace('\\', "/");
    let trimmed = normalized.trim_end_matches('/');
    if trimmed.is_empty() || trimmed.starts_with('/') || (trimmed.len() >= 2 && trimmed.as_bytes()[1] == b':' && trimmed.as_bytes()[0].is_ascii_alphabetic()) || trimmed.contains('\0') {
        return Err(t(language, "导入包包含不安全路径"));
    }
    for part in trimmed.split('/') {
        if part.is_empty() { continue; }
        let reserved = part.split('.').next().unwrap_or(part).to_ascii_lowercase();
        let windows = matches!(reserved.as_str(), "con" | "prn" | "aux" | "nul" | "com1" | "com2" | "com3" | "com4" | "com5" | "com6" | "com7" | "com8" | "com9" | "lpt1" | "lpt2" | "lpt3" | "lpt4" | "lpt5" | "lpt6" | "lpt7" | "lpt8" | "lpt9");
        if part == ".." || part.contains(':') || part.ends_with('.') || part.ends_with(' ') || windows { return Err(t(language, "导入包包含不安全路径")); }
    }
    Ok(trimmed.to_string())
}

fn remove_inside(root: &Path, target: &Path) -> Result<(), String> {
    if !target.exists() { return Ok(()); }
    let root = crate::real_path(root).map_err(|error| error.to_string())?;
    let absolute = crate::real_path(target).unwrap_or_else(|_| target.to_path_buf());
    let relative = absolute.strip_prefix(&root).map_err(|_| "临时清理路径超出预期目录".to_string())?;
    if relative.as_os_str().is_empty() { return Err("临时清理路径超出预期目录".into()); }
    if absolute.is_dir() { fs::remove_dir_all(&absolute) } else { fs::remove_file(&absolute) }.map_err(|error| error.to_string())
}

fn remove_tree(path: &Path) -> Result<(), String> {
    if path.exists() { fs::remove_dir_all(path).map_err(|error| error.to_string())? }
    Ok(())
}

fn read_text(path: &Path, language: &str) -> Result<String, String> {
    // The file's size is taken through a link, as the Electron build takes
    // it: a configuration that is a link to another file is read like any
    // other; only writing through one is refused.
    match fs::metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(error.to_string()),
        Ok(meta) if meta.len() > MAX_CONFIG => Err(t(language, "配置文件超过 32 MB")),
        Ok(_) => fs::read_to_string(path).map_err(|error| error.to_string()),
    }
}

fn atomic_text(path: &Path, before: &str, next: &str, language: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() { fs::create_dir_all(parent).map_err(|error| error.to_string())?; }
    if fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink()) { return Err(t(language, "配置是符号链接，请选择真实配置文件")); }
    let temp = path.with_file_name(format!("{}.{}.tmp", path.file_name().and_then(|item| item.to_str()).unwrap_or(""), random_id()));
    // Whatever happens, the temporary file does not stay behind.
    let outcome = (|| {
        {
            let mut file = OpenOptions::new().write(true).create_new(true).open(&temp).map_err(|error| error.to_string())?;
            crate::sys::restrict_to_owner(&file);
            file.write_all(next.as_bytes()).map_err(|error| error.to_string())?;
        }
        let current = read_text(path, language)?;
        if current != before { return Err(t(language, "配置已被其他程序修改，请刷新后重试")); }
        if path.exists() {
            fs::copy(path, PathBuf::from(format!("{}.awb-backup", path.display()))).map_err(|error| error.to_string())?;
        }
        fs::rename(&temp, path).map_err(|error| error.to_string())
    })();
    if temp.exists() { let _ = fs::remove_file(&temp); }
    outcome
}

fn parse_json_text(text: &str, language: &str) -> Result<Value, String> {
    let source = text.trim_start_matches('\u{feff}').trim();
    if source.is_empty() { return Ok(json!({})); }
    let stripped = strip_jsonc(source);
    match serde_json::from_str::<Value>(&stripped) {
        Ok(value) if value.is_object() => Ok(value),
        Ok(_) => Err(t(language, "配置必须是对象")),
        Err(_) => Err(t(language, "JSON 配置存在语法错误，请修复后重试")),
    }
}

fn strip_jsonc(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'"' {
            if let Ok((_, end)) = parse_string(text, index) { out.extend_from_slice(&bytes[index..end]); index = end; continue; }
        }
        if bytes[index] == b'/' && bytes.get(index + 1) == Some(&b'/') {
            index += 2;
            while index < bytes.len() && bytes[index] != b'\n' { index += 1; }
            out.push(b' ');
            continue;
        }
        if bytes[index] == b'/' && bytes.get(index + 1) == Some(&b'*') {
            index += 2;
            while index + 1 < bytes.len() && !(bytes[index] == b'*' && bytes[index + 1] == b'/') { index += 1; }
            if index + 1 < bytes.len() { index += 2; }
            out.push(b' ');
            continue;
        }
        out.push(bytes[index]);
        index += 1;
    }
    strip_trailing_commas(&String::from_utf8_lossy(&out))
}

fn strip_trailing_commas(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'"' {
            if let Ok((_, end)) = parse_string(text, index) { out.extend_from_slice(&bytes[index..end]); index = end; continue; }
        }
        if bytes[index] == b',' {
            let next = skip_ws(bytes, index + 1);
            if bytes.get(next) == Some(&b'}') || bytes.get(next) == Some(&b']') { index += 1; continue; }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8(out).unwrap_or_default()
}

#[derive(Clone)]
struct Field { key: String, key_at: usize, value_at: usize, value_end: usize }

fn skip_ws(bytes: &[u8], mut index: usize) -> usize {
    while index < bytes.len() {
        if bytes[index].is_ascii_whitespace() { index += 1; continue; }
        if bytes[index] == b'/' && bytes.get(index + 1) == Some(&b'/') {
            index += 2;
            while index < bytes.len() && bytes[index] != b'\n' { index += 1; }
            continue;
        }
        if bytes[index] == b'/' && bytes.get(index + 1) == Some(&b'*') {
            index += 2;
            while index + 1 < bytes.len() && !(bytes[index] == b'*' && bytes[index + 1] == b'/') { index += 1; }
            if index + 1 < bytes.len() { index += 2; } else { index = bytes.len(); }
            continue;
        }
        break;
    }
    index
}

fn parse_string(text: &str, start: usize) -> Result<(String, usize), ()> {
    let bytes = text.as_bytes();
    if bytes.get(start) != Some(&b'"') { return Err(()); }
    let mut index = start + 1;
    let mut raw = Vec::new();
    while index < bytes.len() {
        match bytes[index] {
            b'\\' => {
                let next = *bytes.get(index + 1).ok_or(())?;
                raw.push(match next { b'n' => b'\n', b't' => b'\t', b'r' => b'\r', other => other });
                index += 2;
            }
            b'"' => return Ok((String::from_utf8(raw).map_err(|_| ())?, index + 1)),
            byte => { raw.push(byte); index += 1; }
        }
    }
    Err(())
}

fn skip_value(text: &str, start: usize) -> Result<usize, ()> {
    let bytes = text.as_bytes();
    let index = skip_ws(bytes, start);
    match bytes.get(index).copied().ok_or(())? {
        b'{' => skip_container(text, index, b'{', b'}'),
        b'[' => skip_container(text, index, b'[', b']'),
        b'"' => Ok(parse_string(text, index)?.1),
        _ => {
            let mut end = index;
            while end < bytes.len() && !matches!(bytes[end], b',' | b'}' | b']' | b'/') && !bytes[end].is_ascii_whitespace() { end += 1; }
            if end == index { Err(()) } else { Ok(end) }
        }
    }
}

fn skip_container(text: &str, start: usize, open: u8, close: u8) -> Result<usize, ()> {
    let bytes = text.as_bytes();
    let mut index = start + 1;
    let mut depth = 1;
    while index < bytes.len() {
        index = skip_ws(bytes, index);
        if index >= bytes.len() { break; }
        if bytes[index] == b'"' { index = parse_string(text, index)?.1; continue; }
        if bytes[index] == open { depth += 1; index += 1; continue; }
        if bytes[index] == close {
            depth -= 1;
            index += 1;
            if depth == 0 { return Ok(index); }
            continue;
        }
        index += 1;
    }
    Err(())
}

fn object_fields(text: &str, open: usize) -> Result<Vec<Field>, ()> {
    let bytes = text.as_bytes();
    if bytes.get(open) != Some(&b'{') { return Err(()); }
    let mut index = open + 1;
    let mut fields = Vec::new();
    loop {
        index = skip_ws(bytes, index);
        if bytes.get(index) == Some(&b'}') { return Ok(fields); }
        let key_at = index;
        let (key, mut next) = parse_string(text, index)?;
        next = skip_ws(bytes, next);
        if bytes.get(next) != Some(&b':') { return Err(()); }
        let value_at = skip_ws(bytes, next + 1);
        let value_end = skip_value(text, value_at)?;
        fields.push(Field { key, key_at, value_at, value_end });
        index = skip_ws(bytes, value_end);
        if bytes.get(index) == Some(&b',') { index += 1; continue; }
        if bytes.get(index) == Some(&b'}') { return Ok(fields); }
        return Err(());
    }
}

fn root_object(text: &str) -> Result<usize, ()> {
    let index = skip_ws(text.as_bytes(), 0);
    if text.as_bytes().get(index) == Some(&b'{') { Ok(index) } else { Err(()) }
}

fn upsert_json(text: &str, keys: &[&str], raw: &str) -> Result<String, ()> {
    if keys.is_empty() { return Err(()); }
    let open = root_object(text)?;
    upsert_in(text, open, keys, raw)
}

fn upsert_in(text: &str, open: usize, keys: &[&str], raw: &str) -> Result<String, ()> {
    let fields = object_fields(text, open)?;
    let key = keys[0];
    if keys.len() == 1 {
        if let Some(field) = fields.iter().rev().find(|field| field.key == key) {
            return Ok(format!("{}{raw}{}", &text[..field.value_at], &text[field.value_end..]));
        }
        return insert_field(text, open, key, raw);
    }
    if let Some(field) = fields.iter().rev().find(|field| field.key == key) {
        let value_at = skip_ws(text.as_bytes(), field.value_at);
        if text.as_bytes().get(value_at) != Some(&b'{') { return Err(()); }
        return upsert_in(text, value_at, &keys[1..], raw);
    }
    let mut built = raw.to_string();
    for key in keys[1..].iter().rev() { built = format!("{{\"{key}\": {built}}}"); }
    insert_field(text, open, key, &built)
}

fn insert_field(text: &str, open: usize, key: &str, raw: &str) -> Result<String, ()> {
    let end = skip_value(text, open)?;
    let close = end - 1;
    let fields = object_fields(text, open)?;
    let trailing = fields.last().is_some_and(|field| text[field.value_end..close].contains(','));
    let comma = if fields.is_empty() || trailing { "" } else { "," };
    let piece = format!("{comma}\n  \"{key}\": {raw}");
    Ok(format!("{}{}{}", &text[..close], piece, &text[close..]))
}

fn move_json_key(text: &str, from: &[&str], to: &[&str]) -> Result<String, ()> {
    let open = root_object(text)?;
    let field = find_field(text, open, from)?.ok_or(())?;
    let raw = text[field.value_at..field.value_end].to_string();
    let removed = remove_field(text, &field)?;
    upsert_json(&removed, to, &raw)
}

fn find_field(text: &str, mut open: usize, keys: &[&str]) -> Result<Option<Field>, ()> {
    for (index, key) in keys.iter().enumerate() {
        let fields = object_fields(text, open)?;
        let Some(field) = fields.iter().rev().find(|field| &field.key == key).cloned() else { return Ok(None) };
        if index + 1 == keys.len() { return Ok(Some(field)); }
        open = skip_ws(text.as_bytes(), field.value_at);
        if text.as_bytes().get(open) != Some(&b'{') { return Err(()); }
    }
    Ok(None)
}

fn remove_field(text: &str, field: &Field) -> Result<String, ()> {
    let bytes = text.as_bytes();
    let mut start = field.key_at;
    let mut end = field.value_end;
    let after = skip_ws(bytes, end);
    if bytes.get(after) == Some(&b',') {
        end = after + 1;
    } else {
        let mut before = start;
        while before > 0 && bytes[before - 1].is_ascii_whitespace() { before -= 1; }
        if before > 0 && bytes[before - 1] == b',' { start = before - 1; }
    }
    Ok(format!("{}{}", &text[..start], &text[end..]))
}
