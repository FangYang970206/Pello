//! Update checks stay manual for download and install.
//! Turning automatic checks off clears every later scheduled check.

use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha512};
use std::fs;
use std::path::{Path, PathBuf};

const STARTUP_MS: u64 = 15_000;
const INTERVAL_MS: u64 = 6 * 60 * 60 * 1000;

pub struct Service {
    state: Value,
    enabled: bool,
    now: u64,
    next_check: Option<u64>,
    automatic_checks: u64,
    downloaded: Option<PathBuf>,
}

impl Service {
    pub fn new(enabled: bool) -> Self {
        let supported = feed_file().is_file();
        Self {
            state: json!({ "phase": if supported { "idle" } else { "unsupported" } }),
            enabled,
            now: 0,
            next_check: if enabled && supported { Some(STARTUP_MS) } else { None },
            automatic_checks: 0,
            downloaded: None,
        }
    }

    pub fn state(&self) -> Value { self.state.clone() }
    pub fn automatic_checks(&self) -> u64 { self.automatic_checks }
    pub fn installs_on_quit(&self) -> bool { false }

    pub fn set_enabled(&mut self, enabled: bool) {
        if self.enabled == enabled { return; }
        self.enabled = enabled;
        self.next_check = if enabled && feed_file().is_file() { Some(self.now.saturating_add(STARTUP_MS)) } else { None };
    }

    /// Returns whether an automatic check ran. A disabled switch never runs one.
    pub fn poll(&mut self, now: u64) -> bool {
        self.now = now;
        let Some(due) = self.next_check else { return false };
        if !self.enabled || now < due { return false; }
        self.automatic_checks += 1;
        self.next_check = Some(now.saturating_add(INTERVAL_MS));
        let _ = self.check();
        true
    }

    pub fn check(&mut self) -> Value {
        if !feed_file().is_file() {
            self.state = json!({ "phase": "unsupported" });
            return self.state();
        }
        let phase = self.state["phase"].as_str().unwrap_or("");
        if matches!(phase, "downloaded" | "downloading" | "installing") { return self.state(); }
        self.state = json!({ "phase": "checking" });
        match read_feed() {
            Ok(Feed::Available { version }) => self.state = json!({ "phase": "available", "version": version }),
            Ok(Feed::Current) => self.state = json!({ "phase": "current" }),
            Err(_) => self.state = json!({ "phase": "error", "failed": "check" }),
        }
        self.state()
    }

    pub fn begin_download(&mut self) -> Value {
        let phase = self.state["phase"].as_str().unwrap_or("");
        let retry = phase == "error" && self.state["failed"] == "download";
        if phase != "available" && !retry { return self.state(); }
        let version = self.state["version"].as_str().unwrap_or("").to_string();
        self.state = json!({ "phase": "downloading", "version": version, "percent": 0 });
        self.state()
    }

    pub fn finish_download(&mut self, data: &Path) -> Value {
        if self.state["phase"] != "downloading" { return self.state(); }
        let version = self.state["version"].as_str().unwrap_or("").to_string();
        match copy_release(data) {
            Ok(path) => {
                self.downloaded = Some(path);
                self.state = json!({ "phase": "downloaded", "version": version });
            }
            Err(message) => self.state = json!({ "phase": "error", "failed": "download", "version": version, "error": message }),
        }
        self.state()
    }

    pub fn install(&mut self, data: &Path, dirty: bool) -> bool {
        let phase = self.state["phase"].as_str().unwrap_or("");
        let retry = phase == "error" && self.state["failed"] == "install";
        if phase != "downloaded" && !retry { return false; }
        if dirty {
            let version = self.state["version"].clone();
            self.state = json!({ "phase": "downloaded", "version": version });
            return false;
        }
        let version = self.state["version"].as_str().unwrap_or("").to_string();
        self.state = json!({ "phase": "installing", "version": version });
        if let Some(path) = &self.downloaded {
            let _ = fs::create_dir_all(data.join("updates"));
            let _ = fs::write(data.join("updates").join("install-requested"), path.display().to_string());
        }
        true
    }
}

enum Feed { Available { version: String }, Current }

fn feed_dir() -> PathBuf {
    std::env::var("AWB_UPDATE_FEED").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("missing-update-feed"))
}

fn feed_file() -> PathBuf { feed_dir().join("latest.yml") }

fn current_version() -> String {
    std::env::var("AWB_APP_VERSION").unwrap_or_else(|_| "0.0.0".into())
}

fn read_feed() -> Result<Feed, ()> {
    let text = fs::read_to_string(feed_file()).map_err(|_| ())?;
    let version = text.lines().find_map(|line| line.trim().strip_prefix("version:")).map(|value| value.trim().to_string()).ok_or(())?;
    if newer(&version, &current_version()) { Ok(Feed::Available { version }) } else { Ok(Feed::Current) }
}

fn release_name() -> Result<String, ()> {
    let text = fs::read_to_string(feed_file()).map_err(|_| ())?;
    let name = text.lines().find_map(|line| line.trim().strip_prefix("path:")).map(|value| value.trim().to_string()).ok_or(())?;
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") { return Err(()); }
    Ok(name)
}

fn copy_release(data: &Path) -> Result<PathBuf, String> {
    let name = release_name().map_err(|_| "size mismatch".to_string())?;
    let source = feed_dir().join(&name);
    let bytes = fs::read(&source).map_err(|_| "size mismatch".to_string())?;
    if let Some(size) = feed_value("size").and_then(|value| value.parse::<u64>().ok()) {
        if bytes.len() as u64 != size { return Err("size mismatch".into()); }
    }
    if let Some(expected) = feed_value("sha512") {
        let digest = base64::engine::general_purpose::STANDARD.encode(Sha512::digest(&bytes));
        if digest != expected { return Err("sha512 checksum mismatch".into()); }
    }
    let destination_dir = data.join("updates");
    fs::create_dir_all(&destination_dir).map_err(|_| "size mismatch".to_string())?;
    let destination = destination_dir.join(&name);
    fs::write(&destination, &bytes).map_err(|_| "size mismatch".to_string())?;
    let blockmap = feed_dir().join(format!("{name}.blockmap"));
    if blockmap.is_file() {
        fs::copy(&blockmap, destination_dir.join(format!("{name}.blockmap"))).map_err(|_| "size mismatch".to_string())?;
    }
    Ok(destination)
}

fn feed_value(key: &str) -> Option<String> {
    let text = fs::read_to_string(feed_file()).ok()?;
    let prefix = format!("{key}:");
    text.lines().rev().find_map(|line| line.trim().strip_prefix(&prefix).map(|value| value.trim().trim_matches('"').to_string())).filter(|value| !value.is_empty())
}

fn newer(found: &str, current: &str) -> bool {
    let parse = |text: &str| {
        let mut parts = text.split('.').map(|part| part.parse::<u64>().unwrap_or(0)).collect::<Vec<_>>();
        parts.resize(3, 0);
        parts
    };
    parse(found) > parse(current)
}
