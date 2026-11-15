//! Locate an old local Agent conversation from the project directory and a
//! message that appears only in that terminal's history. Recency is not used.

use crate::i18n::translate;
use crate::pty::history_name;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

pub fn locate(kind: &str, cwd: &str, history: &str, data: &Path, terminal_id: &str, language: &str) -> Result<Option<String>, String> {
    let candidates = conversations(kind, cwd)?;
    let Some(matched) = match_conversation(history, &candidates) else { return Ok(None) };
    if kind == "pi" || kind == "omp" {
        if matched.file.as_os_str().is_empty() || !matched.file.is_file() {
            return Err(translate(language, "无法唯一定位旧 Agent 对话，原终端历史已保留；未创建空白对话", &[] as &[String]));
        }
        let directory = data.join("agent-sessions").join(history_name(terminal_id));
        fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
        let destination = directory.join(matched.file.file_name().unwrap_or_default());
        if !destination.exists() {
            fs::copy(&matched.file, &destination).map_err(|error| error.to_string())?;
        }
        if !matched.file.is_file() {
            return Err(translate(language, "无法唯一定位旧 Agent 对话，原终端历史已保留；未创建空白对话", &[] as &[String]));
        }
        return Ok(Some("pello:directory".into()));
    }
    if matched.id.is_empty() { return Ok(None) }
    Ok(Some(matched.id))
}

struct Conversation { id: String, file: PathBuf, messages: Vec<String> }

fn match_conversation(history: &str, candidates: &[Conversation]) -> Option<Conversation> {
    let visible = normalize(history);
    let normalized: Vec<(usize, Vec<String>)> = candidates.iter().enumerate().map(|(index, candidate)| (index, candidate.messages.iter().map(|message| normalize(message)).collect())).collect();
    let mut hits = Vec::new();
    for (index, messages) in &normalized {
        let mut unique = false;
        for value in messages {
            if value.len() < 8 { continue }
            let size = 32.min(value.len());
            for start in [0, value.len().saturating_sub(size) / 2, value.len() - size] {
                let snippet = &value[start..start + size];
                if !visible.contains(snippet) { continue }
                let shared = normalized.iter().any(|(other, other_messages)| other != index && other_messages.iter().any(|message| message.contains(snippet)));
                if !shared { unique = true; break }
            }
            if unique { break }
        }
        if unique { hits.push(*index); }
    }
    let mut ids = hits.iter().map(|index| candidates[*index].id.as_str()).collect::<Vec<_>>();
    ids.sort();
    ids.dedup();
    if ids.len() == 1 { candidates.get(hits[0]).map(|item| Conversation { id: item.id.clone(), file: item.file.clone(), messages: Vec::new() }) } else { None }
}

fn normalize(text: &str) -> String { text.chars().filter(|char| !char.is_whitespace()).collect() }

fn conversations(kind: &str, cwd: &str) -> Result<Vec<Conversation>, String> {
    let home = std::env::var_os("AWB_RESOURCE_HOME").map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("."));
    let root = match kind {
        "claude" => std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from).unwrap_or_else(|| home.join(".claude")).join("projects"),
        "codex" => std::env::var_os("CODEX_HOME").map(PathBuf::from).unwrap_or_else(|| home.join(".codex")).join("sessions"),
        "pi" => std::env::var_os("PI_CODING_AGENT_SESSION_DIR").map(PathBuf::from).unwrap_or_else(|| {
            std::env::var_os("PI_CODING_AGENT_DIR").map(PathBuf::from).unwrap_or_else(|| home.join(".pi").join("agent")).join("sessions")
        }),
        "omp" => std::env::var_os("PI_CODING_AGENT_DIR").map(PathBuf::from).unwrap_or_else(|| home.join(".omp").join("agent")).join("sessions"),
        _ => return Ok(Vec::new()),
    };
    let mut files = Vec::new();
    collect_jsonl(&root, &mut files)?;
    let mut results = Vec::new();
    for file in files {
        let text = fs::read_to_string(&file).unwrap_or_default();
        let mut id = String::new();
        let mut belongs = false;
        let mut messages = Vec::new();
        let mut sidechain = false;
        for line in text.lines() {
            let Ok(row) = serde_json::from_str::<Value>(line) else { continue };
            if row["isSidechain"] == true || (row["type"] == "session_meta" && row["payload"]["source"].is_object()) { sidechain = true; break }
            let directory = row["cwd"].as_str().or_else(|| row["payload"]["cwd"].as_str());
            if let Some(directory) = directory {
                if !same_path(directory, cwd) { belongs = false; break }
                belongs = true;
                if id.is_empty() {
                    id = row["sessionId"].as_str().or_else(|| row["payload"]["session_id"].as_str()).or_else(|| row["payload"]["id"].as_str())
                        .or_else(|| if row["type"] == "session" { row["id"].as_str() } else { None })
                        .map(|value| value.to_string())
                        .unwrap_or_else(|| file.file_stem().and_then(|name| name.to_str()).unwrap_or("").to_string());
                }
            }
            if !belongs { continue }
            let message = if row.get("message").is_some() { &row["message"] } else { &row["payload"] };
            let role = message["role"].as_str().unwrap_or("");
            if role == "user" || role == "assistant" {
                let text = message_text(&message["content"]);
                if !text.is_empty() { messages.push(text); }
            }
            let event = row["payload"]["type"].as_str().unwrap_or("");
            if row["type"] == "event_msg" && (event == "user_message" || event == "agent_message") {
                if let Some(text) = row["payload"]["message"].as_str() { if !text.is_empty() { messages.push(text.to_string()); } }
            }
        }
        if !sidechain && belongs && !id.is_empty() && !messages.is_empty() {
            results.push(Conversation { id, file, messages });
        }
    }
    Ok(results)
}

fn message_text(value: &Value) -> String {
    if let Some(text) = value.as_str() { return text.to_string() }
    value.as_array().map(|blocks| blocks.iter().filter_map(|block| block["text"].as_str()).collect::<Vec<_>>().join("\n")).unwrap_or_default()
}

fn same_path(left: &str, right: &str) -> bool {
    let left = Path::new(left);
    let right = Path::new(right);
    let left = fs::canonicalize(left).unwrap_or_else(|_| left.to_path_buf());
    let right = fs::canonicalize(right).unwrap_or_else(|_| right.to_path_buf());
    left == right
}

fn collect_jsonl(directory: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let kind = entry.file_type().map_err(|error| error.to_string())?;
        if kind.is_dir() { collect_jsonl(&path, files)?; }
        else if kind.is_file() && path.extension().and_then(|ext| ext.to_str()) == Some("jsonl") { files.push(path); }
    }
    Ok(())
}
