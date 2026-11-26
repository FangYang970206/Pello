//! Native menu templates. Labels come from the shared catalog.

use crate::i18n::translate;
use serde_json::{json, Value};
use std::fs;

pub fn app_menu(language: &str) -> Value {
    json!([
        { "id": "file", "label": translate(language, "文件", &[] as &[String]), "items": [
            { "id": "settings", "label": translate(language, "设置", &[] as &[String]) },
            { "id": "quit", "label": translate(language, "退出", &[] as &[String]) }
        ]},
        { "id": "edit", "label": translate(language, "编辑", &[] as &[String]), "items": [
            { "id": "undo", "label": translate(language, "撤销", &[] as &[String]) },
            { "id": "redo", "label": translate(language, "重做", &[] as &[String]) },
            { "id": "copy", "label": translate(language, "复制", &[] as &[String]), "edit": "copy" },
            { "id": "paste", "label": translate(language, "粘贴", &[] as &[String]), "edit": "paste" }
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

/// The splits a pane may still take, as the Electron build's `layoutMenuItems`
/// lists them: left and right when the pane spans both columns, up and down
/// when it spans both rows, then merging when it is one of several.
fn layout_menu_items(language: &str, options: &Value) -> Vec<Value> {
    let mut items = Vec::new();
    for (id, label, flag) in [
        ("split-left", "向左分栏", "horizontal"),
        ("split-right", "向右分栏", "horizontal"),
        ("split-up", "向上分栏", "vertical"),
        ("split-down", "向下分栏", "vertical"),
    ] {
        items.push(json!({ "id": id, "label": translate(language, label, &[] as &[String]), "enabled": options[flag].as_bool().unwrap_or(false) }));
    }
    items.push(json!({ "type": "separator" }));
    items.push(json!({ "id": "merge", "label": translate(language, "撤销分栏（合并）", &[] as &[String]), "enabled": options["merge"].as_bool().unwrap_or(false) }));
    items
}

/// A pane's menu: what a terminal offers by its own, then the splits. A
/// document's pane leaves the terminal's part out.
pub fn pane_menu(language: &str, options: &Value) -> Value {
    let mut items = Vec::new();
    if options["terminal"].as_bool().unwrap_or(false) {
        if options["reconnect"].as_bool().unwrap_or(false) {
            items.push(json!({ "id": "reconnect", "label": translate(language, "重新连接会话", &[] as &[String]), "enabled": true }));
            items.push(json!({ "type": "separator" }));
        }
        items.push(json!({ "id": "rename", "label": translate(language, "重命名终端", &[] as &[String]), "enabled": true }));
        items.push(json!({ "id": "export-history", "label": translate(language, "导出完整终端记录", &[] as &[String]), "enabled": true }));
        items.push(json!({ "type": "separator" }));
    }
    items.extend(layout_menu_items(language, options));
    Value::Array(items)
}

/// The menu of an entry of the file tree, item for item as the Electron
/// build builds it. `editors` are the editors installed for the file, in the
/// order they are offered under "open with"; the default application comes
/// before them. A submenu holds its items under `items`.
pub fn tree_menu(language: &str, directory: bool, local: bool, root: bool, editors: &[(String, String)]) -> Value {
    let said = |text: &str| translate(language, text, &[] as &[String]);
    let item = |id: &str, label: &str| json!({ "id": id, "label": said(label) });
    let separator = || json!({ "type": "separator" });
    let mut items = Vec::new();
    if directory {
        items.push(item("create-file", "新建文件"));
        items.push(item("create-directory", "新建文件夹"));
        items.push(item("import-files", if local { "导入文件…" } else { "上传文件…" }));
        items.push(item("import-directory", if local { "导入文件夹…" } else { "上传文件夹…" }));
        items.push(separator());
    } else {
        items.push(item("open", "打开"));
        items.push(item("reload", "刷新文件"));
        items.push(item("reference", "引用到当前终端"));
        items.push(separator());
    }
    if !root {
        items.push(item("rename", "重命名"));
        items.push(item("move", "移动到…"));
        items.push(item("trash", "删除"));
    }
    items.push(json!({ "id": "copy-path", "label": said("复制路径"), "items": [item("copy-full", "复制完整路径"), item("copy-relative", "复制项目相对路径")] }));
    if local {
        items.push(item("reveal", if directory { "在资源管理器中打开" } else { "在资源管理器中显示" }));
        if !directory {
            let mut open_with = vec![item("open-default", "默认应用")];
            open_with.extend(editors.iter().map(|(id, name)| item(&format!("editor:{id}"), name)));
            items.push(json!({ "id": "open-with", "label": said("打开方式"), "items": open_with }));
            items.push(item("save-as", "另存为…"));
        }
    } else if !root {
        items.push(item("download", "下载…"));
    }
    Value::Array(items)
}

/// A document's menu, item for item as the Electron build builds it. The
/// editing roles act on the focused control themselves, so the page is left
/// to carry them out; a submenu holds its items under `items`.
pub fn file_menu(language: &str, options: &Value) -> Value {
    let said = |text: &str| translate(language, text, &[] as &[String]);
    let editable = options["editable"].as_bool().unwrap_or(false);
    let enabled = |id: &str, label: &str, on: bool| json!({ "id": id, "label": said(label), "enabled": on });
    // What the Electron build's roles are: the shell carries them out on the
    // focused control, and the page never hears of them.
    let role = |id: &str, label: &str, on: bool| json!({ "id": id, "label": said(label), "enabled": on, "edit": id });
    let mut template = vec![
        enabled("mode", if options["visual"].as_bool().unwrap_or(false) { "源码模式" } else { "渲染模式" }, true),
        json!({ "type": "separator" }),
        enabled("undo", "撤销", options["undo"].as_bool().unwrap_or(false)),
        enabled("redo", "重做", options["redo"].as_bool().unwrap_or(false)),
        json!({ "type": "separator" }),
        role("cut", "剪切", editable),
        role("copy", "复制", true),
        role("paste", "粘贴", editable),
        role("pasteAndMatchStyle", "粘贴为纯文本", editable),
        role("selectAll", "全选", true),
    ];
    if options["markdown"].as_bool().unwrap_or(false) && options["visual"].as_bool().unwrap_or(false) && editable {
        template.push(json!({ "type": "separator" }));
        template.push(json!({ "id": "format", "label": said("格式"), "items": [
            enabled("bold", "加粗", true), enabled("italic", "斜体", true), enabled("code", "行内代码", true)
        ] }));
        template.push(json!({ "id": "paragraph", "label": said("段落"), "items": [
            enabled("heading", "一级标题", true), enabled("quote", "引用", true), enabled("bullet", "无序列表", true), enabled("ordered", "有序列表", true), enabled("codeblock", "代码块", true), enabled("table", "插入表格", true)
        ] }));
    }
    template.push(json!({ "type": "separator" }));
    template.push(enabled("save", "保存", editable));
    template.push(enabled("reload", "重新读取", true));
    template.push(enabled("panel", "切换文件面板", true));
    if options["layout"].is_object() {
        template.push(json!({ "type": "separator" }));
        template.extend(layout_menu_items(language, &options["layout"]));
    }
    Value::Array(template)
}

/// The menu of an HTML preview, as the Electron build pops it on the preview:
/// back to the source, the file read again, then copying and selecting the
/// preview's own text, which the shell carries out in the frame that has the
/// keyboard, the preview's after a right click on it.
pub fn preview_menu(language: &str) -> Value {
    let said = |text: &str| translate(language, text, &[] as &[String]);
    let role = |id: &str, label: &str| json!({ "id": id, "label": said(label), "edit": id });
    Value::Array(vec![
        json!({ "id": "source", "label": said("源码模式") }),
        json!({ "id": "reload", "label": said("刷新文件") }),
        json!({ "type": "separator" }),
        role("copy", "复制"),
        role("selectAll", "全选"),
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
/// empty value cancels. `AWB_SAVE_LOG` receives what was asked for, and
/// `AWB_SAVE_WHILE` names a program that runs while the dialog is open, given
/// the name the file is offered under, as a test changes something that the
/// caller must read again afterwards.
pub fn choose_save_path(language: &str, kind: &str, name: &str) -> Result<Option<String>, String> {
    let spec = save_dialog(language, kind, name);
    if let Ok(log) = std::env::var("AWB_SAVE_LOG") {
        let _ = fs::write(log, spec.to_string());
    }
    if let Ok(path) = std::env::var("AWB_SAVE_PATH") {
        if let Ok(program) = std::env::var("AWB_SAVE_WHILE") {
            let _ = std::process::Command::new(program).arg(spec["defaultPath"].as_str().unwrap_or("")).status();
        }
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
