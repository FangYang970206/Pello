//! Temporary session root in `pello.config.json`, then a UUID directory with AGENTS.md.

use crate::i18n::translate;
use crate::random_id;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

pub fn read_directory(config: &Path) -> Option<PathBuf> {
    let text = fs::read_to_string(config).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    let path = value["temporarySessionsDirectory"].as_str()?;
    Path::new(path).is_absolute().then(|| PathBuf::from(path))
}

pub fn resolve_directory(configured: Option<&Path>, language: &str) -> Result<PathBuf, String> {
    let Some(configured) = configured else {
        return Err(translate(language, "请选择临时会话的绝对目录", &[] as &[String]));
    };
    let text = configured.to_string_lossy();
    if !configured.is_absolute() || text.contains('\0') {
        return Err(translate(language, "请选择临时会话的绝对目录", &[] as &[String]));
    }
    fs::create_dir_all(configured).map_err(|error| error.to_string())?;
    let base = crate::real_path(configured).map_err(|error| error.to_string())?;
    if !base.is_dir() {
        return Err(translate(language, "临时会话路径必须是文件夹", &[] as &[String]));
    }
    Ok(base)
}

pub fn write_directory(config: &Path, root: &Path, language: &str) -> Result<PathBuf, String> {
    let base = resolve_directory(Some(root), language)?;
    let mut current = json!({});
    if config.exists() {
        let text = fs::read_to_string(config).map_err(|_| translate(language, "配置文件无法读取：{{0}}", &[config.display().to_string()]))?;
        current = serde_json::from_str(&text).map_err(|_| translate(language, "配置文件无法读取：{{0}}", &[config.display().to_string()]))?;
        if !current.is_object() {
            return Err(translate(language, "配置文件格式无效：{{0}}", &[config.display().to_string()]));
        }
    }
    current["temporarySessionsDirectory"] = json!(base.display().to_string());
    if let Some(parent) = config.parent() {
        fs::create_dir_all(parent).map_err(|_| save_error(language, config))?;
    }
    let staged = config.with_extension(format!("{}.tmp", random_id()));
    let write = (|| -> Result<(), String> {
        fs::OpenOptions::new().write(true).create_new(true).open(&staged).map_err(|error| error.to_string())?;
        fs::write(&staged, serde_json::to_string_pretty(&current).map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;
        fs::rename(&staged, config).map_err(|error| error.to_string())?;
        Ok(())
    })();
    if staged.exists() { let _ = fs::remove_file(&staged); }
    write.map_err(|_| save_error(language, config))?;
    Ok(base)
}

fn save_error(language: &str, config: &Path) -> String {
    let directory = config.parent().unwrap_or(config).display().to_string();
    translate(language, "无法保存临时会话目录。请确认 Pello 安装目录可写：{{0}}", &[directory])
}

pub fn agents_markdown(directory: &Path) -> String {
    format!("# 临时会话工作范围\n\n本次临时会话的工作目录为\n\n`{}`\n\n所有临时文件、下载内容、中间产物、脚本、日志和生成的输出必须保存在此 UUID 目录内部，按用途分门别类存放，例如 tmp/、scripts/、logs/、outputs/。不得将文件或输出写到此目录之外，也不得使用其他项目或系统临时目录存放本会话产物。引用外部资料时保持只读；需要修改时先复制到此目录。清理操作也仅限本目录内部。\n", directory.display())
}
