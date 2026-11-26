//! Native menu templates. Labels come from the shared catalog.
//! Project actions copy or reveal the real path and do not rewrite the project record.

use crate::i18n::translate;
use serde_json::{json, Value};
use std::fs;
use std::path::Path;
use std::process::Command;

pub fn app_menu(language: &str) -> Value {
    json!([
        { "id": "file", "label": translate(language, "文件", &[] as &[String]), "items": [
            { "id": "settings", "label": translate(language, "设置", &[] as &[String]) },
            { "id": "quit", "label": translate(language, "退出", &[] as &[String]) }
        ]},
        { "id": "edit", "label": translate(language, "编辑", &[] as &[String]), "items": [
            { "id": "undo", "label": translate(language, "撤销", &[] as &[String]) },
            { "id": "redo", "label": translate(language, "重做", &[] as &[String]) },
            { "id": "copy", "label": translate(language, "复制", &[] as &[String]) },
            { "id": "paste", "label": translate(language, "粘贴", &[] as &[String]) }
        ]},
        { "id": "view", "label": translate(language, "视图", &[] as &[String]), "items": [
            { "id": "toggle-panel", "label": translate(language, "切换文件面板", &[] as &[String]) }
        ]}
    ])
}

pub fn project_menu(language: &str, local: bool) -> Value {
    let mut items = vec![
        json!({ "id": "copy-full", "label": translate(language, "复制路径", &[] as &[String]) }),
        json!({ "id": "pin", "label": translate(language, "置顶项目", &[] as &[String]) }),
        json!({ "id": "rename", "label": translate(language, "重命名项目", &[] as &[String]) }),
        json!({ "id": "remove", "label": translate(language, "移除项目", &[] as &[String]) }),
    ];
    if local {
        items.insert(1, json!({ "id": "reveal", "label": translate(language, "在资源管理器中打开", &[] as &[String]) }));
    }
    Value::Array(items)
}

pub fn terminal_menu(language: &str, options: &Value) -> Value {
    let mut items = Vec::new();
    if options["reconnect"].as_bool().unwrap_or(false) {
        items.push(json!({ "id": "reconnect", "label": translate(language, "重新连接会话", &[] as &[String]), "enabled": true }));
    }
    items.push(json!({ "id": "rename", "label": translate(language, "重命名终端", &[] as &[String]), "enabled": true }));
    items.push(json!({ "id": "export-history", "label": translate(language, "导出完整终端记录", &[] as &[String]), "enabled": true }));
    for (id, label, flag) in [
        ("split-left", "向左分栏", "horizontal"),
        ("split-right", "向右分栏", "horizontal"),
        ("split-up", "向上分栏", "vertical"),
        ("split-down", "向下分栏", "vertical"),
    ] {
        items.push(json!({ "id": id, "label": translate(language, label, &[] as &[String]), "enabled": options[flag].as_bool().unwrap_or(false) }));
    }
    items.push(json!({ "id": "merge", "label": translate(language, "撤销分栏（合并）", &[] as &[String]), "enabled": options["merge"].as_bool().unwrap_or(false) }));
    Value::Array(items)
}

pub fn tree_menu(language: &str, directory: bool, local: bool, root: bool) -> Value {
    let mut items = Vec::new();
    if directory {
        items.push(json!({ "id": "create-file", "label": translate(language, "新建文件", &[] as &[String]) }));
        items.push(json!({ "id": "create-directory", "label": translate(language, "新建文件夹", &[] as &[String]) }));
        items.push(json!({ "id": if local { "import-files" } else { "import-files" }, "label": translate(language, if local { "导入文件…" } else { "上传文件…" }, &[] as &[String]) }));
        items.push(json!({ "id": "import-directory", "label": translate(language, if local { "导入文件夹…" } else { "上传文件夹…" }, &[] as &[String]) }));
    } else {
        items.push(json!({ "id": "open", "label": translate(language, "打开", &[] as &[String]) }));
        items.push(json!({ "id": "reference", "label": translate(language, "引用到当前终端", &[] as &[String]) }));
    }
    if !root {
        items.push(json!({ "id": "rename", "label": translate(language, "重命名", &[] as &[String]) }));
        items.push(json!({ "id": "move", "label": translate(language, "移动到…", &[] as &[String]) }));
        items.push(json!({ "id": "trash", "label": translate(language, "删除", &[] as &[String]) }));
    }
    items.push(json!({ "id": "copy-full", "label": translate(language, "复制完整路径", &[] as &[String]) }));
    items.push(json!({ "id": "copy-relative", "label": translate(language, "复制项目相对路径", &[] as &[String]) }));
    if local {
        items.push(json!({ "id": "reveal", "label": translate(language, if directory { "在资源管理器中打开" } else { "在资源管理器中显示" }, &[] as &[String]) }));
    } else if !root {
        items.push(json!({ "id": "download", "label": translate(language, "下载…", &[] as &[String]) }));
    }
    Value::Array(items)
}

pub fn file_menu(language: &str, options: &Value) -> Value {
    json!([
        { "id": "mode", "label": translate(language, if options["visual"].as_bool().unwrap_or(false) { "源码模式" } else { "渲染模式" }, &[] as &[String]) },
        { "id": "undo", "label": translate(language, "撤销", &[] as &[String]), "enabled": options["undo"].as_bool().unwrap_or(false) },
        { "id": "redo", "label": translate(language, "重做", &[] as &[String]), "enabled": options["redo"].as_bool().unwrap_or(false) },
        { "id": "cut", "label": translate(language, "剪切", &[] as &[String]) },
        { "id": "copy", "label": translate(language, "复制", &[] as &[String]) },
        { "id": "paste", "label": translate(language, "粘贴", &[] as &[String]) },
        { "id": "save", "label": translate(language, "保存", &[] as &[String]), "enabled": options["editable"].as_bool().unwrap_or(false) },
        { "id": "reload", "label": translate(language, "重新加载", &[] as &[String]) }
    ])
}

/// What a save dialog asks for, as the Electron build's `showSaveDialog` was
/// called: a title, the name the file is offered under, its filter, and
/// whether the dialog confirms before replacing a file that is there already.
/// A download does: that confirmation is what lets it replace the file.
///
/// The system's own save dialog always asks before replacing, so the answer
/// is the same for the kinds that do not ask; the copy that refuses a name
/// that is taken still refuses it after the dialog.
pub fn save_dialog(language: &str, kind: &str, name: &str) -> Value {
    let (title, default_path, filter, extensions, replace) = match kind {
        "download" => (translate(language, "下载文件", &[] as &[String]), name.to_string(), translate(language, "所有文件", &[] as &[String]), vec!["*"], true),
        "save-as" => (translate(language, "另存为（请选择新文件名）", &[] as &[String]), name.to_string(), translate(language, "所有文件", &[] as &[String]), vec!["*"], false),
        _ => (String::new(), if name.is_empty() { "terminal-history.ansi".to_string() } else { name.to_string() }, translate(language, "ANSI 终端记录", &[] as &[String]), vec!["ansi"], false),
    };
    json!({ "title": title, "defaultPath": default_path, "filters": [{ "name": filter, "extensions": extensions }], "showOverwriteConfirmation": replace, "createDirectory": kind != "history" })
}

/// What an open dialog asks for, by what is chosen: resource kinds `folder`,
/// `zip` and `config`, the import sources `files` and `directory`, and the
/// `download` place, which alone offers to create the directory. Files are
/// chosen one at a time unless said otherwise.
pub fn open_dialog(language: &str, kind: &str) -> Value {
    let (select, filters, title) = match kind {
        "folder" => ("directory", Vec::new(), String::new()),
        "zip" => ("file", vec![json!({ "name": translate(language, "ZIP 压缩包", &[] as &[String]), "extensions": ["zip"] })], String::new()),
        "files" => ("many", Vec::new(), translate(language, "选择导入来源", &[] as &[String])),
        "directory" => ("directory", Vec::new(), translate(language, "选择导入来源", &[] as &[String])),
        "download" => ("directory", Vec::new(), translate(language, "选择下载位置", &[] as &[String])),
        _ => ("file", vec![json!({ "name": translate(language, "Agent 配置", &[] as &[String]), "extensions": ["json", "jsonc", "toml", "yaml", "yml"] })], String::new()),
    };
    json!({ "title": title, "select": select, "filters": filters, "createDirectory": kind == "download" })
}

fn filter_list(spec: &Value) -> Vec<(String, Vec<String>)> {
    spec["filters"].as_array().map(|filters| filters.iter().map(|filter| (filter["name"].as_str().unwrap_or("").to_string(), filter["extensions"].as_array().map(|extensions| extensions.iter().filter_map(|extension| extension.as_str().map(str::to_string)).collect()).unwrap_or_default())).collect()).unwrap_or_default()
}

fn rfd_dialog(spec: &Value) -> rfd::FileDialog {
    let mut dialog = rfd::FileDialog::new().set_title(spec["title"].as_str().unwrap_or("")).set_can_create_directories(spec["createDirectory"].as_bool().unwrap_or(false));
    for (name, extensions) in filter_list(spec) {
        if extensions != ["*"] { dialog = dialog.add_filter(name, &extensions); }
    }
    dialog
}

/// Ask for a save path. `AWB_SAVE_PATH` supplies the choice in tests; an
/// empty value cancels. `AWB_SAVE_LOG` receives what was asked for.
pub fn choose_save_path(language: &str, kind: &str, name: &str) -> Result<Option<String>, String> {
    let spec = save_dialog(language, kind, name);
    if let Ok(log) = std::env::var("AWB_SAVE_LOG") {
        let _ = fs::write(log, spec.to_string());
    }
    if let Ok(path) = std::env::var("AWB_SAVE_PATH") {
        if path.is_empty() { return Ok(None); }
        return Ok(Some(path));
    }
    // The system's save dialog asks itself before replacing a file.
    Ok(rfd_dialog(&spec).set_file_name(spec["defaultPath"].as_str().unwrap_or("")).save_file().map(|path| path.display().to_string()))
}

/// Ask for what to open: files, many files or a directory. `AWB_PICK_PATHS`
/// supplies the choice in tests, one path a line.
pub fn choose_open_paths(kind: &str, language: &str) -> Vec<String> {
    let spec = open_dialog(language, kind);
    if let Ok(raw) = std::env::var("AWB_PICK_PATHS") {
        return raw.lines().map(str::trim).filter(|line| !line.is_empty()).map(str::to_string).collect();
    }
    if let Ok(file) = std::env::var("AWB_PICK_FILE") {
        let raw = fs::read_to_string(file).unwrap_or_default();
        return raw.lines().map(str::trim).filter(|line| !line.is_empty()).map(str::to_string).collect();
    }
    let dialog = rfd_dialog(&spec);
    let picked = match spec["select"].as_str().unwrap_or("file") {
        "directory" => dialog.pick_folder().into_iter().collect(),
        "many" => dialog.pick_files().unwrap_or_default(),
        _ => dialog.pick_file().into_iter().collect(),
    };
    picked.into_iter().map(|path| path.display().to_string()).collect()
}

pub fn choose_open_path(kind: &str, language: &str) -> Value {
    choose_open_paths(kind, language).into_iter().next().map(|path| json!(path)).unwrap_or(Value::Null)
}

pub fn open_external(target: &str) {
    if let Ok(log) = std::env::var("AWB_OPEN_LOG") {
        if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(log) {
            use std::io::Write;
            let _ = writeln!(file, "{target}");
        }
    }
    let program = std::env::var("AWB_OPEN_BIN").unwrap_or_else(|_| "xdg-open".into());
    if program == "true" || Path::new(&program).file_name().and_then(|name| name.to_str()) == Some("true") { return }
    let _ = Command::new(program).arg(target).status();
}

pub fn reveal_path(path: &Path, language: &str) -> Result<(), String> {
    if !path.exists() { return Err(translate(language, "目录不存在", &[] as &[String])); }
    let program = std::env::var("AWB_OPEN_BIN").unwrap_or_else(|_| "xdg-open".into());
    if let Ok(log) = std::env::var("AWB_OPEN_LOG") {
        let _ = fs::write(log, path.display().to_string());
        if program == "true" || Path::new(&program).file_name().and_then(|name| name.to_str()) == Some("true") {
            return Ok(());
        }
    }
    let output = Command::new(&program).arg(path).output().map_err(|error| error.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if !stderr.is_empty() { stderr } else { stdout };
        Err(if detail.is_empty() { translate(language, "无法在资源管理器中打开", &[] as &[String]) } else { detail })
    }
}
