# Agent Workbench 六项升级验收

日期：2026-11-04。实现基于当前工作区，保留之前的任务栏、SSH、资源兼容性和目录浏览修复。原始模型日志、测试配置、下载和截图均未加入发布文件。

## 完成内容

| 目标 | 结果 | 使用入口 |
| --- | --- | --- |
| oh-my-pi | Windows 与 Ubuntu WSL 原生安装 18.16.0；加入内置执行器，支持原生 MCP 与 Skill 开关 | 设置 → 执行器 → Oh My Pi；新建终端选择 Oh My Pi |
| 多仓库变更 | 非 Git 父目录自动发现子仓库，按仓库路径/分支分组，筛选及重新扫描；diff 和撤销定位所属仓库 | 将父目录作为工作台项目打开 → 变更 |
| Skill 批量导入 | 文件夹和 ZIP 递归发现全部 SKILL.md；预览、搜索、选择及多 Agent 分发 | 设置 → Skill → 添加 Skill |
| MCP 文件导入 | 自动提取常见配置文件，预览条目、保留停用状态并分发；凭据不进入预览 | 设置 → MCP → 添加 MCP → 从配置文件导入 |
| 外观 | 六套主题、三种工作布局、左右文件面板、两档密度；增加随包字体 | 设置 → 外观 |
| 侧栏会话 | 按项目展示终端；项目与终端重命名、删除，真实状态标记，重启后恢复名称 | 项目/终端菜单；F2、Enter、Esc |

## oh-my-pi 平台实测

采用 [官方安装器](https://github.com/can1357/oh-my-pi#install) 的固定版本二进制安装与 SHA-256 校验流程。Windows 安装位置为 `%LOCALAPPDATA%/omp/omp.exe`，Linux 为 `/home/fy/.local/bin/omp`，配置分别使用各自的 `.omp/agent`。

| 实测项 | Windows | Ubuntu WSL（原生 Linux 二进制） |
| --- | --- | --- |
| CLI 版本 | 18.16.0 | 18.16.0 |
| 自定义 gateway 模型发现 | 通过 | 通过 |
| 工作台交互终端 | 正常进入会话并连接 MCP | 正常进入会话并连接 MCP |
| 加载 Vercel React Skill | 实际 read 调用及 async-parallel 规则 | 同左 |
| 官方 Filesystem MCP | 实际 read_text_file 调用并返回唯一标记 | 同左 |
| Bash 工具读取测试文件 | 返回独立标记 | 返回独立标记 |
| Skill 开关 | 原生 RPC 命令发现随禁用/恢复改变 | 同左 |
| 模型调用退出码 | 0 | 0 |

OMP 使用原生 `write` 工具向 `xd://mcp__awb_filesystem_read_text_file` 虚拟协议提交 JSON 参数，最终调用 MCP 的只读工具。已核对工具开始、结束事件及返回标记，不把它误判成普通磁盘写入。[官方 MCP 调度说明](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/prompts/system/mcp-xdev-guidance.md)。

Windows 官方安装器在这台机器上选中了 WSL 的 bash.exe。为保证 Windows 文件与 Bash 行为一致，已在 OMP 原生配置中选择实际安装的 Git Bash。完成模型、资源配置后，通过公开的 `startup.setupWizard: false` 关闭重复的初次引导；没有伪造引导完成版本。工作台也能识别官方安装目录，并为新建终端补齐 PATH，避免已运行应用继承旧 PATH。

测试只访问合成文件及安装的 Skill，未打印或提交认证值。Linux 的验证环境为 Ubuntu WSL，不将它扩大为所有发行版的保证。

## 多仓库设计与边界

参考 [VS Code 多根工作区](https://code.visualstudio.com/docs/editing/workspaces/multi-root-workspaces) 的仓库归属和路径区分：展示仓库路径、分支、变更数量，同名文件不会混用 diff。工作台项目自身是仓库时保留单仓库体验；非 Git 父目录则显示子仓库分组。

发现过程异步执行，不设静默目录深度/仓库数量截断。默认跳过依赖、构建、缓存和符号链接目录，避免扫描大型生成目录或越出工作区；界面提供说明和重新扫描。发现结果缓存 30 秒，Git 状态并发最多 4 个，同一项目的重叠轮询合并。部分仓库不可读时显示错误而继续展示其他仓库。

补充修复了项目位于仓库子目录时带出目录外变更的问题。Git 状态和统计使用 NUL 分隔，Windows Git 输出固定 UTF-8；中文、空格等文件名保持原样。Git worktree 的 `.git` 文件也能识别。撤销仍需明确确认，定位到原仓库；移除工作台项目不会删除磁盘目录。

## 资源导入与原生适配

Skill 会继续搜索已找到 Skill 目录的子目录，不再在第一个 SKILL.md 停止。保留 scripts、references 等支持文件，检查 YAML 元数据、路径穿越、符号链接、重复名称及包大小；现有上限为 32 MB、10000 个文件。目标同名资源不覆盖。

MCP 支持 JSON、JSONC、TOML、YAML，提取 `mcpServers`、`mcp_servers`、`mcp.servers`、`servers`、`context_servers` 以及项目作用域内的服务器。自动转换 OpenCode 命令数组、环境变量及 Codex HTTP headers 等常见字段。源配置已停用时不会在导入过程中先启用。

未知或需专门适配的高级字段会显示“需要手动适配”，对应条目不可勾选；不会悄悄丢掉认证或传输设置。仍保留手动配置入口。主进程读取原配置和认证，renderer 预览只得到名称、来源和状态，写入前备份，结果按 Agent/资源显示。

Oh My Pi 使用原生 `.omp/agent/mcp.json` 和 `config.yml` 中的 `disabledExtensions: [skill:<name>]`。修改 YAML 保留其他字段与注释；受全局筛选或源 Skill 停用限制的条目不会被开关伪装成启用。[OMP Skill 文档](https://github.com/can1357/oh-my-pi/blob/main/docs/skills.md)、[OMP MCP 文档](https://github.com/can1357/oh-my-pi/blob/main/docs/mcp-config.md)。

## 主题、布局、字体与侧栏

参考 [OpenCode 主题](https://opencode.ai/v2/docs/themes) 和 [OMP 语义主题](https://github.com/can1357/oh-my-pi/blob/main/docs/theme.md)，扩展现有设计而不改变应用品牌。提供深色、浅色、Nord、Dracula、Catppuccin Mocha、Solarized Light；共享语义色同时用于工作台与终端 ANSI 色板。Code Agent 自己输出的真彩色主题由其原生设置控制。

默认工作布局为终端专注，文件/变更面板按需展开；另提供均衡、跨仓库审阅，文件/变更面板可放左右两侧，并支持舒适/紧凑密度。左右面板的拖拽和键盘调整方向一致。切换字体、主题和布局均保留真实 xterm 实例、内容、输入模式与会话。

随包增加 Fira Code、IBM Plex Mono，与既有 JetBrains Mono 和中文回退共同使用；字体 OFL 文本已纳入发行配置。三套随包等宽字体均通过 100%、125%、150%、200% DPI 的连续边线和加号位置检查。

侧栏按项目展示终端，使用文字和颜色表达未启动、运行中、已完成，以及失败退出码。F2 进入内联重命名，Enter 保存，Esc 取消。菜单使用原生顶层弹出层，支持键盘并避免被滚动容器裁切。删除运行终端仍等待进程树结束，取消不会结束会话；项目移除仅删除工作台记录。

## 验证入口与证据

最终 `npm run verify` 退出码 0；33 条静态反例和全部行为检查通过，捕获 104 个原有界面状态。新增六主题、批量导入、侧栏、重启与进程树回归通过，随包字体另有 12 组 DPI 检查。

- `npm run verify` 保留并执行原有 lint、typecheck、build、check，新增行为入口纳入门禁。
- `scripts/multi-repo-check.mjs`：非 Git 父目录、深层与同名文件、中文/空格、worktree、目录范围、diff/撤销和重新扫描。
- `scripts/resource-import-check.mjs`、`scripts/resource-import-ui-check.mjs`：递归导入、格式识别、预览脱敏、多目标、冲突、源停用与无效条目。
- `scripts/sidebar-check.mjs`：四种状态、跨项目选择、重命名、实际重启、取消删除及子/孙进程清理。
- `scripts/appearance-check.mjs`：六主题正文与辅助文字 4.5:1、两档窗口、字体、布局、密度及实例保留。
- `node scripts/render-check.mjs 'Fira Code' 'IBM Plex Mono' 'JetBrains Mono'`：12 组字体/DPI 实测。
- `.cache/goal-upgrade/omp-model-results.json`、`omp-toggle-results.json`：两端真实调用与原生发现证据。
- `.cache/goal-upgrade/omp-win-tui.png`、`omp-linux-tui.png`、`appearance/`、`resource-imports/`：交互截图。
- `.cache/goal-upgrade/verify-final.log`、`font-dpi.log`：完整门禁和字体像素日志。

未自动创建新的 GitHub Release；本报告对应当前工作区实现与本机安装。
