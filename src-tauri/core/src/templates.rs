//! Executor templates, as the Electron build keeps them: resource paths,
//! environment and session arguments that belong to a machine and are lent
//! to an executor on it by a binding.
use crate::i18n::translate;
use serde_json::{json, Value};

/// The executors the workbench knows without being told, with the names the
/// settings show for them.
pub const PRESETS: &[(&str, &str)] = &[
    ("claude", "Claude Code"),
    ("codex", "Codex CLI"),
    ("opencode", "OpenCode"),
    ("pi", "Pi"),
    ("omp", "Oh My Pi"),
];

fn t(language: &str, text: &str) -> String { translate(language, text, &[] as &[String]) }

fn text<'a>(value: &'a Value, key: &str) -> &'a str { value.get(key).and_then(|item| item.as_str()).unwrap_or("") }

fn list(db: &Value, key: &str) -> Vec<Value> { db[key].as_array().cloned().unwrap_or_default() }

/// A machine of the database, or why there is none such to act on.
pub fn machine<'a>(db: &'a Value, id: &str, require_connection: bool, language: &str) -> Result<&'a Value, String> {
    let host = db["hosts"].as_array().and_then(|hosts| hosts.iter().find(|item| text(item, "id") == id)).ok_or_else(|| t(language, "机器不存在"))?;
    if require_connection && host["on"] == false { return Err(t(language, "这台机器未连接")); }
    Ok(host)
}

fn has_control(input: &str) -> bool { input.chars().any(|char| (char as u32) < 32) }

/// An absolute path of the machine it is for, spelled as that machine
/// normalizes it, or a refusal.
pub fn resource_path(input: &str, windows: bool, language: &str) -> Result<String, String> {
    let drive = { let bytes = input.as_bytes(); bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && (bytes[2] == b'\\' || bytes[2] == b'/') };
    let lead = input.starts_with("\\\\") || input.starts_with("//");
    let rest = input.trim_start_matches(['\\', '/']);
    let first_share = rest.split(['\\', '/']).next().unwrap_or("");
    let share = rest.split_once(['\\', '/']).map(|(_, after)| after.split(['\\', '/']).next().unwrap_or("")).unwrap_or("");
    let unc = lead && !first_share.is_empty() && !first_share.starts_with(['?', '.']) && !share.is_empty();
    let absolute = if windows { drive || unc } else { input.starts_with('/') };
    let after_drive = input.split_once(':').map(|(_, tail)| tail).unwrap_or(input);
    let forbidden = windows && after_drive.contains(['<', '>', '"', '|', '?', '*']);
    if has_control(input) || !absolute || forbidden { return Err(t(language, "资源目录和配置文件必须使用绝对路径")); }
    Ok(normalize(input, windows))
}

/// `path.win32.normalize` and `path.posix.normalize` as far as a path that
/// passed `resource_path` reaches: separators are the machine's own, `.` is
/// dropped and `..` climbs, and a path that ended in a separator still does.
fn normalize(input: &str, windows: bool) -> String {
    let is_sep: fn(char) -> bool = if windows { |char| char == '/' || char == '\\' } else { |char| char == '/' };
    let (prefix, rest) = if windows {
        if input.as_bytes().get(1) == Some(&b':') { (input[..2].to_string(), &input[2..]) } else { ("\\\\".to_string(), &input[2..]) }
    } else { (String::new(), input) };
    let absolute = rest.starts_with(is_sep);
    // A path that ended in a separator, or in a `..` that climbed to the
    // root or the share, still ends in one.
    let trailing = rest.ends_with(is_sep) || rest.rsplit(is_sep).next() == Some("..");
    let mut parts: Vec<&str> = Vec::new();
    for part in rest.split(is_sep) {
        match part {
            "" | "." => {}
            // A `..` that would climb above the root or a share is dropped,
            // as `normalize` drops it.
            ".." => { if parts.len() > if windows && prefix == "\\\\" { 2 } else { 0 } { parts.pop(); } }
            _ => parts.push(part),
        }
    }
    let separator = if windows { '\\' } else { '/' };
    let mut out = prefix;
    if absolute { out.push(separator); }
    out.push_str(&parts.join(&separator.to_string()));
    if trailing { out.push(separator); }
    out
}

/// The resource paths of a template as they are kept, or why they are not
/// ones the workbench takes.
pub fn validate_resource_paths(target: &Value, windows: bool, language: &str) -> Result<Value, String> {
    let format = text(target, "format");
    let adapter = match target.get("skillAdapter") {
        None | Some(Value::Null) => "portable",
        Some(value) => value.as_str().unwrap_or(""),
    };
    if !["standard", "codex", "opencode"].contains(&format) || !["portable", "claude", "codex", "opencode", "pi", "omp"].contains(&adapter) {
        return Err(t(language, "请选择支持的资源格式"));
    }
    let normalize = |key: &str| -> Result<String, String> {
        let input = text(target, key);
        if input.is_empty() { Ok(String::new()) } else { resource_path(input, windows, language) }
    };
    let config = normalize("skillConfigPath")?;
    let mut out = json!({ "mcpPath": normalize("mcpPath")?, "skillPath": normalize("skillPath")?, "format": format, "skillAdapter": adapter });
    if !config.is_empty() { out["skillConfigPath"] = json!(config); }
    Ok(out)
}

/// Environment of a template as it is kept: only what a process can be given.
pub fn validate_template_env(env: &Value, language: &str) -> Result<Value, String> {
    let Some(rows) = env.as_array() else { return Err(t(language, "请输入有效的环境变量名称和值")) };
    let name_ok = |key: &str| {
        let mut chars = key.chars();
        chars.next().is_some_and(|first| first == '_' || first.is_ascii_alphabetic()) && chars.all(|char| char == '_' || char.is_ascii_alphanumeric())
    };
    let mut kept = Vec::new();
    for row in rows {
        let (Some(key), Some(value), Some(secret)) = (row.get("k").and_then(|item| item.as_str()), row.get("v").and_then(|item| item.as_str()), row.get("secret").and_then(|item| item.as_bool())) else {
            return Err(t(language, "请输入有效的环境变量名称和值"));
        };
        if !name_ok(key) || value.contains(['\0', '\r', '\n']) { return Err(t(language, "请输入有效的环境变量名称和值")); }
        kept.push(json!({ "k": key, "v": value, "secret": secret }));
    }
    Ok(Value::Array(kept))
}

/// Whether a built-in executor reads a template's paths as its own.
pub fn template_compatible(template: &Value, executor_id: &str) -> bool {
    let (format, adapter) = (text(template, "format"), text(template, "skillAdapter"));
    match executor_id {
        "codex" => format == "codex" && adapter == "codex",
        "opencode" => format == "opencode" && adapter == "opencode",
        "claude" | "pi" | "omp" => format == "standard" && adapter == executor_id,
        _ => true,
    }
}

fn executor_exists(db: &Value, id: &str) -> bool {
    PRESETS.iter().any(|(preset, _)| *preset == id) || list(db, "custom").iter().any(|item| text(item, "id") == id)
}

fn check_compatibility(template: &Value, executor_id: &str, language: &str) -> Result<(), String> {
    if template_compatible(template, executor_id) { return Ok(()); }
    let name = PRESETS.iter().find(|(preset, _)| *preset == executor_id).map(|(_, name)| *name).unwrap_or(executor_id);
    Err(translate(language, "模板与 {{0}} 的原生格式不兼容，请先更换绑定", &[name]))
}

/// A custom executor's new and resume arguments must each name the session.
pub fn validate_custom_session(config: Option<&Value>, language: &str) -> Result<(), String> {
    let Some(config) = config.filter(|value| !value.is_null()) else { return Ok(()) };
    for key in ["startArgs", "resumeArgs"] {
        let taken = config.get(key).and_then(|item| item.as_str()).is_some_and(|value| value.contains("{sessionId}") && !value.contains(['\r', '\n']));
        if !taken { return Err(t(language, "新建和恢复参数都必须包含 {sessionId}")); }
    }
    Ok(())
}

/// The template lent to an executor on a machine, if one is.
pub fn executor_template<'a>(db: &'a Value, host_id: &str, executor_id: &str) -> Option<&'a Value> {
    let binding = db["templateBindings"].as_array()?.iter().find(|entry| text(entry, "hostId") == host_id && text(entry, "executorId") == executor_id)?;
    db["templates"].as_array()?.iter().find(|template| text(template, "id") == text(binding, "templateId") && text(template, "hostId") == host_id)
}

/// An executor as it launches on a machine: its own fields as that machine
/// overrides them, and the environment and session of the template lent to
/// it there.
pub fn effective_executor(executor: &Value, host_id: &str, template: Option<&Value>) -> Value {
    let mut out = executor.clone();
    if let Some(over) = executor["hosts"][host_id].as_object() { for (key, value) in over { out[key] = value.clone(); } }
    if let Some(template) = template {
        out["env"] = template["env"].clone();
        match template.get("session") {
            Some(session) => out["session"] = session.clone(),
            None => { if let Some(object) = out.as_object_mut() { object.remove("session"); } }
        }
    }
    out
}

/// Puts a template as it was drawn, keeping the id it had, and refuses one
/// that does not belong to its machine, repeats a name on it, or no longer
/// fits the executors bound to it.
pub fn put(db: &mut Value, input: &Value, language: &str) -> Result<Value, String> {
    let host = machine(db, text(input, "hostId"), false, language)?.clone();
    let name = input.get("name").and_then(|item| item.as_str()).map(str::trim).unwrap_or("").to_string();
    if name.is_empty() || name.chars().count() > 80 || has_control(&name) { return Err(t(language, "请输入 1 到 80 字符的模板名称")); }
    let asked = text(input, "id");
    let templates = list(db, "templates");
    let at = (!asked.is_empty()).then(|| templates.iter().position(|entry| text(entry, "id") == asked)).flatten();
    if !asked.is_empty() && at.is_none() { return Err(t(language, "模板不存在")); }
    if at.is_some_and(|at| text(&templates[at], "hostId") != text(&host, "id")) { return Err(t(language, "模板必须属于所选机器")); }
    if templates.iter().any(|entry| text(entry, "id") != asked && text(entry, "hostId") == text(&host, "id") && text(entry, "name") == name) {
        return Err(t(language, "这台机器已有同名模板"));
    }
    let resources = validate_resource_paths(input, text(&host, "platform") == "windows", language)?;
    if let Some(at) = at {
        let id = text(&templates[at], "id");
        for binding in list(db, "templateBindings") {
            if text(&binding, "templateId") == id { check_compatibility(&resources, text(&binding, "executorId"), language)?; }
        }
    }
    validate_custom_session(input.get("session"), language)?;
    let mut template = resources;
    template["id"] = json!(at.map(|at| text(&templates[at], "id").to_string()).unwrap_or_else(crate::random_id));
    template["hostId"] = json!(text(&host, "id"));
    template["name"] = json!(name);
    template["env"] = validate_template_env(input.get("env").unwrap_or(&Value::Null), language)?;
    match input.get("session").filter(|value| !value.is_null()) {
        Some(session) => template["session"] = json!({ "startArgs": text(session, "startArgs"), "resumeArgs": text(session, "resumeArgs") }),
        None => {}
    }
    if !db["templates"].is_array() { db["templates"] = json!([]); }
    let list = db["templates"].as_array_mut().expect("templates");
    match at { Some(at) => list[at] = template.clone(), None => list.push(template.clone()) }
    Ok(template)
}

/// Lends a template to an executor on a machine, or takes the loan back
/// when `template_id` is empty: never across machines, never to a built-in
/// executor whose native format it does not speak.
pub fn bind(db: &mut Value, scope: &Value, template_id: &str, language: &str) -> Result<(), String> {
    let (host_id, executor_id) = (text(scope, "hostId"), text(scope, "executorId"));
    machine(db, host_id, false, language)?;
    if !executor_exists(db, executor_id) { return Err(t(language, "执行器不存在")); }
    if !template_id.is_empty() {
        let template = list(db, "templates").into_iter().find(|entry| text(entry, "id") == template_id).ok_or_else(|| t(language, "模板必须属于所选机器"))?;
        if text(&template, "hostId") != host_id { return Err(t(language, "模板必须属于所选机器")); }
        check_compatibility(&template, executor_id, language)?;
    }
    let kept: Vec<Value> = list(db, "templateBindings").into_iter().filter(|entry| text(entry, "hostId") != host_id || text(entry, "executorId") != executor_id).collect();
    db["templateBindings"] = Value::Array(kept);
    if !template_id.is_empty() {
        db["templateBindings"].as_array_mut().expect("bindings").push(json!({ "hostId": host_id, "executorId": executor_id, "templateId": template_id }));
    }
    Ok(())
}

/// Forgets a template and every binding that lent it.
pub fn delete(db: &mut Value, id: &str, language: &str) -> Result<(), String> {
    if !list(db, "templates").iter().any(|entry| text(entry, "id") == id) { return Err(t(language, "模板不存在")); }
    db["templates"] = Value::Array(list(db, "templates").into_iter().filter(|entry| text(entry, "id") != id).collect());
    db["templateBindings"] = Value::Array(list(db, "templateBindings").into_iter().filter(|entry| text(entry, "templateId") != id).collect());
    Ok(())
}

/// Forgets templates of machines that are gone and bindings to executors or
/// templates that are gone or no longer fit.
pub fn prune(db: &mut Value) {
    let hosts = list(db, "hosts");
    let templates: Vec<Value> = list(db, "templates").into_iter().filter(|entry| hosts.iter().any(|host| text(host, "id") == text(entry, "hostId"))).collect();
    let fits = |binding: &Value| {
        executor_exists(db, text(binding, "executorId")) && templates.iter().any(|template| text(template, "id") == text(binding, "templateId") && text(template, "hostId") == text(binding, "hostId") && template_compatible(template, text(binding, "executorId")))
    };
    let bindings: Vec<Value> = list(db, "templateBindings").into_iter().filter(|binding| fits(binding)).collect();
    db["templates"] = Value::Array(templates);
    db["templateBindings"] = Value::Array(bindings);
}

/// Once an executor's own paths became templates: each custom executor that
/// has some and is lent none yet is lent one, and the old field is dropped.
pub fn migrate(db: &mut Value, old_targets: &Value, language: &str) {
    if !db["templates"].is_array() { db["templates"] = json!([]); }
    if !db["templateBindings"].is_array() { db["templateBindings"] = json!([]); }
    let ids: Vec<String> = list(db, "custom").iter().map(|item| text(item, "id").to_string()).collect();
    for id in ids {
        // The executor is read whole, then the database is changed, so that
        // nothing is borrowed across a change.
        let Some(executor) = list(db, "custom").into_iter().find(|item| text(item, "id") == id) else { continue };
        if executor_template(db, "local", &id).is_some() { continue; }
        let mut old = json!({ "mcpPath": "", "skillPath": "", "format": "standard" });
        if let Some(saved) = old_targets.get(&id).and_then(|value| value.as_object()) { for (key, value) in saved { old[key] = value.clone(); } }
        if let Some(own) = executor.get("resources").and_then(|value| value.as_object()) { for (key, value) in own { old[key] = value.clone(); } }
        if text(&old, "mcpPath").is_empty() && text(&old, "skillPath").is_empty() && text(&old, "skillConfigPath").is_empty() { continue; }
        let Ok(windows) = machine(db, "local", false, language).map(|host| text(host, "platform") == "windows") else { continue };
        let Ok(resources) = validate_resource_paths(&old, windows, language) else { continue };
        let mut template = resources;
        let template_id = crate::random_id();
        template["id"] = json!(template_id);
        template["hostId"] = json!("local");
        template["name"] = json!(text(&executor, "name"));
        template["env"] = Value::Array(list(&executor, "env").iter().map(|entry| json!({ "k": text(entry, "k"), "v": text(entry, "v"), "secret": entry["secret"] == true })).collect());
        match executor.get("session").filter(|value| !value.is_null()) {
            Some(session) => template["session"] = session.clone(),
            None => {}
        }
        db["templates"].as_array_mut().expect("templates").push(template);
        let _ = bind(db, &json!({ "hostId": "local", "executorId": id }), &template_id, "zh-CN");
        let Some(executor) = db["custom"].as_array_mut().and_then(|items| items.iter_mut().find(|item| text(item, "id") == id)) else { continue };
        if let Some(object) = executor.as_object_mut() { object.remove("resources"); }
    }
}

/// Takes the templates and bindings of a database as it was read, keeping
/// what is whole, and — once, for a database written before there were
/// templates — turns each custom executor's own paths into a template.
/// Says whether the database is to be written back.
pub fn adopt(db: &mut Value, raw: Option<&Value>, old_targets: &Value, language: &str) -> bool {
    let whole = |item: &Value| item.get("id").is_some_and(|value| value.is_string()) && item.get("name").is_some_and(|value| value.is_string()) && item["env"].is_array();
    let templates = raw.and_then(|raw| raw.get("templates")).filter(|value| value.is_array()).map(|value| value.as_array().expect("array").iter().filter(|item| whole(item)).cloned().collect::<Vec<_>>()).unwrap_or_default();
    let bindings = raw.and_then(|raw| raw.get("templateBindings")).filter(|value| value.is_array()).map(|value| value.as_array().expect("array").iter().filter(|item| item.get("executorId").is_some_and(|value| value.is_string())).cloned().collect::<Vec<_>>()).unwrap_or_default();
    let first_time = raw.and_then(|raw| raw.get("templates")).is_none_or(|value| !value.is_array());
    db["templates"] = Value::Array(templates);
    db["templateBindings"] = Value::Array(bindings);
    if !first_time { return false; }
    migrate(db, old_targets, language);
    true
}

/// What testing an executor shows: every value it was told to keep secret
/// is dots, the longest first, so that one secret inside another is gone
/// whole.
pub fn redact_output(text: &str, env: &[Value]) -> String {
    let mut secrets: Vec<&str> = env.iter().filter(|row| row["secret"] == true).filter_map(|row| row["v"].as_str()).filter(|value| !value.is_empty()).collect();
    secrets.sort_by_key(|value| std::cmp::Reverse(value.chars().count()));
    secrets.dedup();
    let mut out = text.to_string();
    for secret in secrets { out = out.replace(secret, "••••"); }
    out
}

/// A command and its arguments as one line, as a terminal takes them.
pub fn command_line(executor: &Value) -> String {
    [text(executor, "cmd"), text(executor, "args")].iter().filter(|part| !part.is_empty()).copied().collect::<Vec<_>>().join(" ")
}

/// A custom executor's launch with its session argument filled in: the
/// resume arguments when a session is named, else the ones that start a
/// conversation.
pub fn custom_resume_command(command: &str, session: Option<&str>, config: Option<&Value>, quote: &dyn Fn(&str) -> String, language: &str) -> Result<(String, Option<String>), String> {
    let Some(config) = config.filter(|value| !value.is_null()) else { return Ok((command.to_string(), session.map(str::to_string))); };
    validate_custom_session(Some(config), language)?;
    let id = session.and_then(|value| valid_agent_session(value)).unwrap_or_else(crate::random_id);
    let template = if session.is_some() { text(config, "resumeArgs") } else { text(config, "startArgs") };
    Ok((format!("{command} {}", template.replace("{sessionId}", &quote(&id))), Some(id)))
}

fn valid_agent_session(value: &str) -> Option<String> {
    ((1..=512).contains(&value.len()) && value.chars().all(|char| char.is_ascii_alphanumeric() || ":./@+-_".contains(char))).then(|| value.to_string())
}

/// Tokenize only simple launch commands. Pipelines, substitutions and
/// wrappers are not identities.
pub fn launch_tokens(command: &str) -> Option<Vec<String>> {
    if command.contains(['\r', '\n', ';', '|', '`', '<', '>']) || command.contains("&&") { return None; }
    let chars: Vec<char> = command.trim().trim_start_matches("& ").chars().collect();
    let mut tokens = Vec::new();
    let mut at = 0;
    while at < chars.len() {
        while at < chars.len() && chars[at].is_whitespace() { at += 1; }
        if at >= chars.len() { break }
        let mut token = String::new();
        match chars[at] {
            '"' => {
                at += 1;
                while at < chars.len() && chars[at] != '"' { token.push(chars[at]); at += 1; }
                if at >= chars.len() { return None; }
                at += 1;
            }
            '\'' => {
                at += 1;
                loop {
                    if at >= chars.len() { return None; }
                    if chars[at] == '\'' {
                        if chars.get(at + 1) == Some(&'\'') { token.push('\''); at += 2; continue }
                        at += 1;
                        break;
                    }
                    token.push(chars[at]);
                    at += 1;
                }
            }
            _ => {
                while at < chars.len() && !chars[at].is_whitespace() && chars[at] != '"' && chars[at] != '\'' { token.push(chars[at]); at += 1; }
            }
        }
        tokens.push(token);
    }
    Some(tokens)
}

/// The custom executor whose configured command is the one that was typed
/// into a terminal, if exactly one says so.
pub fn submitted_custom_agent(command: &str, custom: &[Value], host_id: &str) -> Option<Value> {
    let submitted = launch_tokens(command)?;
    if submitted.is_empty() { return None; }
    let matches: Vec<&Value> = custom.iter().filter(|item| {
        let config = effective_executor(item, host_id, None);
        let expected = launch_tokens(&[text(&config, "cmd"), text(&config, "args")].iter().filter(|part| !part.is_empty()).copied().collect::<Vec<_>>().join(" "));
        expected.is_some_and(|expected| !expected.is_empty() && expected.iter().zip(&submitted).all(|(want, got)| want == got))
    }).collect();
    // Identical configured commands cannot establish which conversation owns the process.
    (matches.len() == 1).then(|| matches[0].clone())
}

/// Whether what was typed is exactly an executor's configured launch.
pub fn is_configured_launch(command: &str, executor: &Value, host_id: &str) -> bool {
    let config = effective_executor(executor, host_id, None);
    let expected = launch_tokens(&[text(&config, "cmd"), text(&config, "args")].iter().filter(|part| !part.is_empty()).copied().collect::<Vec<_>>().join(" "));
    let actual = launch_tokens(command);
    match (expected, actual) {
        (Some(expected), Some(actual)) => expected.len() == actual.len() && expected.iter().zip(&actual).all(|(want, got)| want == got),
        _ => false,
    }
}
