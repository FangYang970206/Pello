# 文件管理实现与验收进度

此清单记录当前工作区的实际实现与验证范围，不能作为 F01–F18 全部交付的声明。

## 2026-11-06 上传目标修正（以此要求为准）

- 远程上传遇到同名文件自动覆盖；同名文件夹整体替换，旧目录中未出现在来源中的内容也会移除，不再采用同名选择菜单或目录合并。
- 保留未保存草稿确认，目录覆盖覆盖到已打开的所有后代文件及同一物理目录的其他项目记录。取消草稿确认时保留旧对象；传输取消或失败时不提前清空旧目录。
- 上传先进入隔离临时对象，完成后复核目标版本再发布。Linux 使用同一父目录描述符下的原子交换；Windows 使用同目录备份、重命名与失败回滚。发布后的旧备份清理失败显示其保留位置。
- 增加整批上传进度、当前文件进度、百分比和字节量；预检与发布阶段保留明确状态，暂停传输时也刷新最后一批进度。
- 已增加 `scripts/upload-replace-check.mjs` 实际 SSH 行为检查，并更新原有 SSH 用例中被此目标替代的同名交互断言。新任务会自动定位到当前进度，保留历史记录，并验证进度条位于可见区域。
- 本次修正验证完成：`npm run verify` 实际退出码 **0**（含 40 个结构反例、16 组主题／窗口／DPI 检查及原有全部行为门禁）；`npm run check:files:ssh-auth`、`npm run check:files:ssh-linux` 实际退出码均为 **0**。
- 已验证 Windows／Linux 的文件与整目录替换、旧目录独有内容移除、空目录与二进制、类型冲突、版本竞争保护、来源保留、取消与临时清理、整目录失败重试、别名项目草稿和撤销历史，以及清理旧备份失败时的保留位置提示。密钥和 Agent 认证均验证了真实签名、文件及整目录覆盖；变化的主机指纹继续拒绝。
- 本轮日志位于 `output/playwright/upload-auto-verify.log`、`upload-auto-auth.log`、`upload-auto-linux.log`；进度截图位于 `output/playwright/upload-replace/`，16 组布局截图位于 `output/playwright/file-dialogs/*-upload-progress.png`。这些证据不提交。

## 2026-11-06 用户增补要求

- 文件侧栏移除项目根路径行和“忽略的目录”区域，只保留搜索框及文件树；根目录操作通过文件树空白处右键或键盘菜单进入，忽略规则移到设置。
- 增加默认 Shell 检测与选择。用户已确认范围是工作台内部的 PowerShell、CMD、Git Bash 等 Shell，不需要独立 Windows Terminal 窗口入口。
- Windows Bash 必须检测真实可用的 Bash 程序并能实际启动，不能把 WSL 的旧 bash.exe 启动器当成 Git Bash；修改默认值不得重建已存在终端。
- 补充实际 Windows Bash 启动、路径与中文空格、提示标记、默认值保存／恢复，以及原有文件管理完整回归。

### 增补要求的实现与证据

- 已移除文件侧栏的根路径行与忽略规则区域，顶部仅保留搜索输入框；根目录菜单仍能通过文件树空白处右键、Shift+F10 或菜单键进入。忽略规则位于“设置 → 通用 → 文件搜索设置”，按项目保存。
- 已接通主进程 Shell 检测 API、默认值设置和新建终端选项。本机检测 PowerShell、CMD、Git Bash／Bash，支持 PATH、自定义 Git 安装位置及 Windows Git 注册表路径；排除旧 System32 Bash 的 WSL 启动器。SSH 的 Shell 选项仍以远端能力为准。
- 本机 Bash 使用检测到的实际程序与工作台 rc 文件启动，保留用户 `.bashrc`，处理 Windows 路径及 Git 命令目录。检测失败可重试，已保存但暂不可用的默认值会明确提示，不会静默改写；默认值修改不重建现有终端。
- `npm run check:shells` 验证实际 Git Bash 启动、用户 rc、中文空格路径、文件引用、Shell 提示就绪、默认值持久化与重启恢复、检测失败重试和默认程序缺失；已纳入完整 `npm run verify`。
- `file-dialog-check.mjs` 同步覆盖搜索规则设置和 Shell 选项，检查深浅主题、两档窗口、四档 DPI 的布局及键盘返回。截图位于 `output/playwright/file-dialogs/` 与 `output/playwright/local-shells/`，不提交。
- 完整回归发现间歇性的 Windows 原生 PTY 退出异常；缩小后的回归证明此前应用退出早于 PTY 的退出回调。现已等待回调并顺序关闭 Windows 终端，退出期间拒绝新建、重启及执行器试运行，避免启动清理清单以外的进程。`terminal-shutdown-check.mjs` 同时核对实际退出码、回调完成顺序、关闭期间的新建拒绝与测试 Agent 子孙进程身份；已加入完整门禁。20 个混合 Shell 加 Agent 进程树的压力退出已连续两轮通过。

### 本轮完整验证结果（2026-11-06）

- `npm run verify` 实际退出码 **0**，包含 lint、39 个结构反例、类型检查、构建与全部行为检查。验证期间未修改实现和测试脚本。
- 新增 Shell 行为、文件侧栏搜索与状态恢复、16 组主题／窗口／DPI 检查、关闭期间拒绝新建及混合 Shell 清理均通过；原有 SSH、草稿、资源管理、自动保存和 HTML 连续 20 次源码／预览切换通过。
- 完整日志保存在 `output/playwright/adjusted-goal-verify.log`，截图及日志不提交。
- 此结果完成了用户本轮新增的两项功能；不代表下方列出的 F01–F18 剩余验收已完成。

## 已实现并有行为回归覆盖

| 范围 | 当前实现与证据 |
| --- | --- |
| F01–F02 | 独立文件树选择；目录选择、展开与收起分离；右键选中实际对象；单击预览、双击固定；不重建终端。`workspace-check.mjs` |
| F03–F04 | 主进程逐层递归搜索、分批读取、取消旧请求、跨项目隔离；搜索、选择、展开和滚动按项目保留；可调整并持久化忽略目录规则。`workspace-check.mjs` |
| F05–F06 | 主进程复制完整／项目相对路径；本机文件定位、目录打开；拒绝越界。`workspace-check.mjs` |
| F07 本机 | 默认应用及检测到的 VS Code、Cursor、Windsurf、Sublime Text、Notepad++；按文本文件类型提供编辑器；执行前重新检测；独立程序参数不经过命令字符串拼接。`external-editors-check.mjs`、`workspace-check.mjs` |
| F08 传输实现 | preload 使用 `webUtils.getPathForFile`；本机复制、远程上传；保留来源和目录层级；目录行／文件行／空白处目标规则与高亮。目标交互用合成拖拽覆盖，传输用真实文件验证。 |
| F10 | 流式二进制传输、逐项结果、取消、失败项重试；本机临时文件清理；退出时取消任务并等待清理。`transfer-check.mjs`、SSH 行为用例 |
| F11 非冲突路径 | 大于文本接口限制的二进制下载／另存为；远程目录包含空目录和隐藏目录；下载重试只处理失败项；项目配置变化或本机目录被链接替换时拒绝重试。SSH、workspace 用例 |
| F12–F13 | 排他新建；即时名称／同名提示；右键和 F2 重命名、Enter／Esc、Windows 大小写改名；项目根保护。workspace、Linux、Windows SSH 用例 |
| F14 非冲突路径 | 当前项目选择目标目录；拒绝自身／后代及现有目标；标签、目录缓存和草稿跟随路径。workspace、Linux、Windows SSH 用例 |
| F15 | 本机回收站调用；远程永久删除两次确认；未保存草稿提示；根目录／越界／链接保护。workspace、SSH 用例；本机回收站回归使用可控替身，验证确认与恢复文件。 |
| F16 交互 | 目标终端选择、路径预览、显式确认；默认最近选中的终端；仅发送路径，不发送回车；Shell 转义。`workspace-check.mjs` |
| F17–F18 已实现部分 | 重命名／移动保留草稿与撤销历史、迁移路径及自动保存；删除后不由旧计时器重建；刷新受影响目录与 Git；保留展开状态、终端实例。`workspace-check.mjs` |

## 新增验证入口

- `npm run verify`：包含原有全部检查，以及 `check:files` 的本机传输、打开方式和文件弹窗检查。
- `npm run check:files:ssh-linux`：需要 Windows Ubuntu WSL；验证 Linux 原子移动和真实 SSH 文件传输、取消、断线、重试、边界保护。
- `npm run check:files:ssh-auth`：需要 Git for Windows 的 OpenSSH；隔离 HOME、密钥、known_hosts 和临时 Agent，验证密钥／Agent 的新建、改名、移动、删除与大文件双向传输，并拒绝变化的主机指纹。密钥测试停用 Agent，Agent 测试移走私钥，防止两种路径相互代替。
- 文件弹窗覆盖深浅主题、1024×680／1440×900、100%／125%／150%／200% 实际 DPI，共 16 组；每组检查新建、移动与引用的居中、长路径、主题文字、焦点约束和 Esc 返回。
- 截图位置：`output/playwright/file-dialogs/`，不提交。

### v0.1.4 发布补充验证（2026-11-06）

- 修正 HTML 测试交互时序后，重新执行完整 `npm run verify`，实际退出码 **0**；最终日志位于 `output/playwright/release-v0.1.4-verify-final.log`。第二轮门禁运行期间未修改实现和测试脚本。
- `npm run check:files:ssh-linux` 与 `npm run check:files:ssh-auth` 实际退出码均为 **0**；覆盖 Linux 原子改名、真实 SSH 二进制传输和断线重试，以及隔离的 OpenSSH 密钥／Agent 认证与主机指纹变化拒绝。
- HTML 回归发现 iframe DOM 就绪早于 Chromium 鼠标命中区域更新，立即右键可能误触外层文档菜单。用例增加双帧绘制等待，保留原生右键、最新草稿内容及原文件未写入断言；修正后连续 6 轮通过，每轮切换 20 次，并验证同内容覆盖更新预览 URL。
- 补充日志位于 `output/playwright/release-v0.1.4-ssh-linux.log`、`release-v0.1.4-ssh-auth.log` 与 `release-v0.1.4-html-regression.log`，不提交。

### v0.1.5 发布补充验证（2026-11-06）

- 版本更新为 `0.1.5` 后重新执行完整 `npm run verify`，实际退出码 **0**；日志位于 `output/playwright/release-v0.1.5-verify.log`。
- `npm run dist:win` 实际退出码 **0**，生成 Windows x64 安装包与便携 ZIP。安装包产品／文件版本均为 `0.1.5`；便携 ZIP 中的程序、ASAR 及 3 个 x64 原生模块与已测试的打包目录逐项校验一致。
- 直接启动打包后的程序，验证版本与打包模式、PowerShell 输入输出、Git Bash、会话实际内容恢复与切换、原生 Agent 状态、主题持久化、中文文件新建／改名／移动、本机二进制传输及退出后的子孙进程清理；实际退出码 **0**。
- 同一打包程序通过 Windows／Linux SSH 自动文件覆盖、整目录替换、取消清理、版本竞争与重试、链接和边界拒绝、备份清理失败提示、别名项目草稿与撤销历史、可见的上传进度检查。真实 OpenSSH 密钥及 Agent 认证均通过，变化的主机指纹继续拒绝；Windows Shell 的任务栏图标、分组和重启目标检查通过。上述脚本实际退出码均为 **0**。
- 打包验证日志位于 `output/playwright/release-v0.1.5-packaged.log`，截图位于 `output/playwright/release-v0.1.5-smoke.png` 及 `output/playwright/upload-replace/`，不提交。此版本发布不代表下列剩余范围已全部完成。

## 尚待完成或验收

1. **F09 其他入口冲突处理**：远程上传改按本页最新目标自动覆盖文件、整体替换目录；原上传的同名选择、合并及批次选项不再作为验收要求。本机导入保留既有批量跳过、保留两者、显式目录合并、普通文件覆盖和草稿保护。远程下载、另存为及移动尚未共用完整冲突流程。
2. **F17 覆盖草稿联动**：本机导入已接入草稿确认、取消保留、前后端写入锁、自动保存暂停、成功后读取新版本并保留撤销历史；HTML 内容相同时也更新预览 URL。远程上传覆盖已接入同等保护；下载、另存为和移动等其他覆盖入口仍需接入。
3. **F16 执行器适配**：原生 Agent 当前采用完整路径，仍需核对并适配各执行器的文件引用格式。
4. **F08 原生验收未能执行**：Windows 资源管理器真实跨窗口拖入，覆盖多文件、目录、中文、空格、二进制、大文件；合成 DataTransfer 不能代替此项。
5. **补充异常验收**：Windows SSH 上传连接中断后的远端临时文件清理、真实系统回收站恢复，以及下载／另存为／移动的冲突与覆盖草稿联动。文件夹上传取消后的旧内容保留与临时目录清理已通过实际 Windows／Linux SSH 回归。

上述未完成项清零并通过对应验证后，才能将整个目标标记完成。
