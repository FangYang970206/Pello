//! Installation data directory. Matches `src/main/app-paths.ts` and `data-directory.ts`.
//!
//! Profile, history, cache and logs live under the install `data` directory.
//! `pello.config.json` stays at the install root unless `AWB_USER_DATA` isolates a test.

use crate::i18n::translate;
use serde_json::Value;
use std::fs;
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug)]
pub struct Paths {
    pub installation: PathBuf,
    pub data: PathBuf,
    pub legacy: PathBuf,
    pub config_file: PathBuf,
}

impl Paths {
    /// `installation` is the directory that contains `pello.config.json` in a packaged or dev layout.
    pub fn resolve(installation: &Path) -> Self {
        if let Some(isolated) = std::env::var_os("AWB_USER_DATA") {
            let data = PathBuf::from(isolated);
            return Self {
                installation: installation.to_path_buf(),
                data: data.clone(),
                legacy: data.clone(),
                config_file: data.join("pello.config.json"),
            };
        }
        let data = installation.join("data");
        Self {
            installation: installation.to_path_buf(),
            data,
            legacy: legacy_app_data(),
            config_file: installation.join("pello.config.json"),
        }
    }

    pub fn prepare(&self) -> Result<(), String> {
        let language = peek_language(self);
        match prepare_data_directory(&self.data, &self.legacy, &language) {
            Ok(()) => {
                for folder in ["tmp", "logs", "crashes"] {
                    fs::create_dir_all(self.data.join(folder)).map_err(|error| data_error(&language, self, &error.to_string()))?;
                }
                Ok(())
            }
            Err(error) => Err(data_error(&language, self, &error)),
        }
    }
}

fn data_error(language: &str, paths: &Paths, detail: &str) -> String {
    translate(
        language,
        "无法使用安装目录中的数据文件夹：{{0}}。请确认该目录可写。\n{{1}}",
        &[paths.data.display().to_string(), detail.to_string()],
    )
}

fn peek_language(paths: &Paths) -> String {
    for file in [paths.data.join("workbench.json"), paths.legacy.join("workbench.json")] {
        let Ok(text) = fs::read_to_string(file) else { continue };
        let Ok(value) = serde_json::from_str::<Value>(&text) else { continue };
        if value["settings"]["language"] == "en" {
            return "en".into();
        }
    }
    "zh-CN".into()
}

pub fn legacy_app_data() -> PathBuf {
    #[cfg(windows)]
    {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            return PathBuf::from(appdata).join("agent-workbench");
        }
    }
    if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
        if !xdg.is_empty() {
            return PathBuf::from(xdg).join("agent-workbench");
        }
    }
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."));
    home.join(".config").join("agent-workbench")
}

/// Publish one complete copy. Never merge over an existing installation profile.
pub fn prepare_data_directory(directory: &Path, legacy: &Path, language: &str) -> Result<(), String> {
    if !directory.exists() {
        if let Some(parent) = directory.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let staged = directory.with_file_name(format!(
            "{}.migration-{}",
            directory.file_name().and_then(|name| name.to_str()).unwrap_or("data"),
            crate::random_id()
        ));
        let copy_result = (|| -> Result<(), String> {
            if legacy.exists() {
                copy_tree(legacy, &staged, language)?;
            } else {
                fs::create_dir(&staged).map_err(|error| error.to_string())?;
            }
            fs::rename(&staged, directory).map_err(|error| error.to_string())?;
            Ok(())
        })();
        if staged.exists() {
            let _ = fs::remove_dir_all(&staged);
        }
        copy_result?;
    }
    let meta = fs::symlink_metadata(directory).map_err(|error| error.to_string())?;
    if meta.file_type().is_symlink() || !directory.is_dir() {
        return Err(translate(language, "数据目录无效：{{0}}", &[directory.display().to_string()]));
    }
    let probe = directory.join(format!(".write-{}", crate::random_id()));
    fs::OpenOptions::new().write(true).create_new(true).open(&probe).map_err(|error| error.to_string())?;
    fs::remove_file(&probe).map_err(|error| error.to_string())?;
    Ok(())
}

fn copy_tree(source: &Path, destination: &Path, language: &str) -> Result<(), String> {
    let meta = fs::symlink_metadata(source).map_err(|error| error.to_string())?;
    if meta.file_type().is_symlink() {
        return Err(translate(language, "数据目录包含链接，无法自动迁移：{{0}}", &[source.display().to_string()]));
    }
    if meta.is_dir() {
        fs::create_dir_all(destination).map_err(|error| error.to_string())?;
        for entry in fs::read_dir(source).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with("Singleton") || name == "DevToolsActivePort" {
                continue;
            }
            copy_tree(&entry.path(), &destination.join(entry.file_name()), language)?;
        }
        return Ok(());
    }
    if meta.is_file() {
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        fs::copy(source, destination).map_err(|error| error.to_string())?;
        return Ok(());
    }
    Err(io::Error::new(ErrorKind::Other, "unsupported file type").to_string())
}
