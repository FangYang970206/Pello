//! Main-process messages. Chinese is the source string, matching `src/shared/i18n.ts`.

const EN: &[(&str, &str)] = &[
    ("无法使用安装目录中的数据文件夹：{{0}}。请确认该目录可写。\n{{1}}", "Cannot use the data folder in the installation directory: {{0}}. Make sure it is writable.\n{{1}}"),
    ("数据目录包含链接，无法自动迁移：{{0}}", "The data folder contains a link and cannot be migrated automatically: {{0}}"),
    ("数据目录无效：{{0}}", "Invalid data folder: {{0}}"),
    ("项目不存在", "Project does not exist"),
    ("非法文件路径", "Invalid file path"),
    ("路径超出项目目录", "Path is outside the project directory"),
    ("名称无效", "Invalid name"),
    ("Windows 名称无效", "Invalid Windows name"),
    ("目标不是目录", "Target is not a directory"),
    ("不能重命名项目根目录", "Cannot rename the project root"),
    ("不能移入自身或子目录", "Cannot move an item into itself or a subdirectory"),
    ("不能删除项目根目录", "Cannot delete the project root"),
    ("不能通过符号链接删除项目文件", "Cannot delete project files through symbolic links"),
    ("文件类型已更改，请刷新目录", "File type has changed. Refresh the directory."),
    ("文件类型已更改或路径包含符号链接", "File type changed or the path contains a symbolic link"),
    ("请先读取文件再保存", "Read the file before saving"),
    ("文件超过 2 MB，无法在内置编辑器中保存", "File exceeds 2 MB and cannot be saved in the built-in editor"),
    ("文件已被其他程序修改，请重新读取后合并更改", "File was modified by another program. Reload it and merge your changes."),
    ("只能编辑 UTF-8 文本文件", "Only UTF-8 text files can be edited"),
    ("请输入有效的目录名称", "Enter a valid directory name"),
    ("请选择临时会话的绝对目录", "Choose an absolute directory for temporary sessions"),
    ("临时会话路径必须是文件夹", "Temporary session path must be a folder"),
    ("配置文件无法读取：{{0}}", "Cannot read configuration file: {{0}}"),
    ("配置文件格式无效：{{0}}", "Invalid configuration file format: {{0}}"),
    ("无法保存临时会话目录。请确认 Pello 安装目录可写：{{0}}", "Cannot save the temporary session directory. Make sure the Pello installation directory is writable: {{0}}"),
    ("临时会话 {{0}}", "Temporary session {{0}}"),
    ("请填写用户和地址", "Enter a user and address"),
    ("连接失败", "Connection failed"),
    ("密码登录的主机校验尚未在 Rust 移植中实现，未保存机器", "Password host checks are not in the Rust port yet, so the machine was not saved"),
    ("此功能尚未在 Rust 移植中实现：{{0}}", "This feature is not implemented in the Rust port yet: {{0}}"),
    ("远程项目的该操作尚未在 Rust 移植中实现", "This operation is not implemented for remote projects in the Rust port yet"),
    ("旧远程 Agent 会话缺少原生 ID，原终端历史已保留；未创建空白对话", "The previous remote Agent session has no native ID. Its terminal history was kept and a blank conversation was not created"),
    ("无法唯一定位旧 Agent 对话，原终端历史已保留；未创建空白对话", "The previous Agent conversation could not be identified uniquely. Its history was kept and a blank conversation was not created"),
    ("未检测到 {{0}}，请在设置中选择可用 Shell", "{{0}} was not found. Choose an available shell in Settings"),
    ("创建参数无效", "Invalid create arguments"),
    ("重命名参数无效", "Invalid rename arguments"),
    ("移动参数无效", "Invalid move arguments"),
    ("删除参数无效", "Invalid delete arguments"),
    ("工作台正在关闭", "The workbench is closing"),
    ("资源目录和配置文件必须使用绝对路径", "Resource directories and configuration files require absolute paths"),
    ("请选择支持的资源格式", "Choose a supported resource format"),
    ("目录不存在", "Directory does not exist"),
    ("搜索参数无效", "Invalid search parameters"),
    ("正则表达式无效", "Invalid regular expression"),
    ("正则表达式执行超时，请简化表达式", "Regular expression timed out. Simplify the expression."),
    ("搜索仍在进行中", "Search is still running"),
    ("项目环境已更改", "Project environment has changed"),
];

pub fn translate(language: &str, source: &str, values: &[impl AsRef<str>]) -> String {
    let template = if language == "en" {
        EN.iter().find(|(key, _)| *key == source).map(|(_, text)| *text).unwrap_or(source)
    } else {
        source
    };
    let mut text = template.to_string();
    for (index, value) in values.iter().enumerate() {
        text = text.replace(&format!("{{{{{index}}}}}"), value.as_ref());
    }
    text
}

pub fn language_of(db: &serde_json::Value) -> String {
    if db["settings"]["language"] == "en" { "en".into() } else { "zh-CN".into() }
}
