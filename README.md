<p><img src="assets/icon.png" width="96" height="96" alt="Agent Workbench 图标"></p>

# Agent Workbench

在本机运行的桌面工作台。每个项目绑定一台机器（本机或 SSH 远程主机）和一个目录，中间的标签是真实终端，用来启动 code agent CLI。没有账号，没有后端，没有云服务。

界面按 Agent Workbench v4 设计稿实现。颜色、间距、字号和圆角来自设计令牌，深色 / 浅色主题可以在设置里切换。

## Windows 上安装

需要：

- Node.js 20.19+ 或 22.13+
- 终端进程依赖 `node-pty`。安装时会按当前 Electron 版本编译原生模块，需要：
  - [Visual Studio Build Tools 2022](https://visualstudio.microsoft.com/visual-cpp-build-tools/)，勾选「使用 C++ 的桌面开发」
  - Python 3（`node-gyp` 会用到）

```powershell
npm install
npm run dev
```

`npm install` 结束时会执行 `electron-rebuild`，把 `node-pty` 编到 Electron 上。如果这一步失败，先确认上面的 C++ 构建工具和 Python 已装好，再重新执行 `npm install`。

生产构建（不打包、不签名）：

```powershell
npm run build
npm start
```

`npm start` 运行 `out/` 里的构建结果。打出 NSIS 安装包见 [BUILD-WINDOWS.md](BUILD-WINDOWS.md)。

## 数据放在哪里

项目、主机、自定义执行器和设置写在 Electron `userData` 目录的 `workbench.json`：

- Windows：`%APPDATA%\agent-workbench\workbench.json`
- 同目录下的 `shell/` 是启动 PowerShell / bash 时用的初始化脚本

没有数据库。

## 终端和 Git

- Windows 上，新建终端可选 PowerShell（优先 `pwsh.exe`，否则 `powershell.exe`）或 CMD。远程终端通过 SSH 使用目标机器的默认 Shell：Windows 为 PowerShell，Linux / macOS 为 bash 或 zsh。本应用在 Linux 上启动 bash。
- 内置 Agent 为 Claude Code、OpenCode、Codex CLI 和 Pi，也可以添加自定义执行器。
- 运行中、空闲、已退出、失败和退出码来自 shell 进程本身（提示符钩子和子进程），不解析 agent 的输出。
- 终端标签用圆点显示状态：黄色表示任务运行中，绿色表示命令已结束且终端可以继续输入，灰色表示尚未运行 Agent 或终端已退出。新建终端的加号紧跟标签，快捷键可在「设置 → 快捷键」查看。
- 关闭终端会结束对应会话和整棵进程树，退出应用时也会等待进程清理完成。运行中的终端是否需要关闭确认，由「结束进程前确认」设置控制。
- 终端在切换文件页或项目时保持原实例，保留全屏 TUI、滚动位置与鼠标模式。普通与二进制鼠标事件都转发给终端程序，尺寸按内容区域计算，避免底部状态栏被截断。
- 文件树按展开的目录逐层读取，不限制目录深度；拖动文件面板左边缘可以调整宽度。文件模式点击文件会打开编辑器，变更模式仍打开差异视图。
- Markdown 默认使用所见即所得编辑器，支持标题、列表、表格、代码块、公式和图片，可切换源码编辑；打开文件不会自动改写原文，文档属性单独保留。其他 UTF-8 文本支持行号和 Tab 缩进。
- 停止输入 2 分钟后按文件自动保存，成功时提示 2 秒；也可通过右键菜单保存或按 `Ctrl+S`。`Ctrl+Z` 撤销，`Ctrl+Shift+Z` 或 `Ctrl+Y` 重做；保存、切换标签和编辑模式后仍保留历史。中文组合输入期间暂停自动保存。右键菜单支持源码 / 渲染模式、剪贴板、格式、段落、表格和重新读取等操作，文档区不显示操作栏。
- 保存保留原有 BOM 和换行格式，并检查磁盘版本。发生冲突时保留草稿并暂停自动保存，避免覆盖外部修改；关闭未保存文件可保存或放弃。超过 2 MB、二进制和非 UTF-8 文件保持只读。远程文件使用相同编辑流程。
- HTML 默认在应用内隔离预览，右键可切换源码。预览通过受限本机回环服务加载相对 CSS、JS 和图片，草稿预览不隐式保存；文档脚本无法访问工作台 API 或顶层页面。远程项目资源通过现有 SSH 认证读取。
- 右栏「变更」调用本机或 `ssh` 上的 `git`。丢弃已跟踪文件用 `git restore`；未跟踪文件 `git restore` 删不掉，这时用 `git clean -f`。
- 远程机器支持 SSH 密钥、SSH Agent 和用户密码认证。密钥模式使用系统 `ssh`；密码模式通过 SSH 协议连接，连接测试、终端、目录、文件和 Git 操作共用认证配置。密码使用系统加密能力单独保存在 `credentials.json`，不写入普通配置；系统加密不可用时仅在本次应用运行期间保留。首次成功认证的主机指纹保存在 `ssh-host-keys.json`，密钥改变时拒绝连接。
- 新建 SSH 机器必须通过连接验证后才能保存。连接失败保留输入并提示错误；在项目弹窗或远程机器设置中可编辑、移除已有机器，移除前需要确认。
- 终端使用 WebGL 渲染线条和块字符，行高为 1，中文回退到微软雅黑或 Noto Sans Mono CJK；显卡不支持 WebGL 时使用 DOM 渲染。

## MCP 与 Skill

设置中的 MCP 和 Skill 为同级入口，按 Claude Code、Codex CLI、OpenCode、Pi 和自定义执行器分别展示，可搜索并按每页 12 项浏览。本版本管理本机用户配置与 Skill 兼容目录。列表仅显示名称，右侧通过眼睛查看详情、通过开关启停；新增在独立模态窗口中填写，并可勾选多个分发目标。

| Agent | MCP 配置 | Skill 分发目录 |
| --- | --- | --- |
| Claude Code | `~/.claude.json` 的 `mcpServers` | `~/.claude/skills` |
| Codex CLI | `~/.codex/config.toml` 的 `mcp_servers` | `~/.agents/skills` |
| OpenCode | `~/.config/opencode/opencode.json` / `.jsonc` 的 `mcp` | `~/.config/opencode/skills` |
| Pi | `~/.pi/agent/mcp.json` 的 `mcpServers` | `~/.pi/agent/skills` |

添加 MCP 时填写名称和单个服务器 JSON 对象，再勾选目标 Agent。例如 stdio 使用 `{"command":"node","args":["C:/tools/server.mjs"],"env":{}}`，HTTP 使用 `{"url":"https://example.com/mcp","headers":{}}`。工作台转换各 Agent 的格式，保留其他配置和注释，写入前备份到 `.awb-backup`；同名服务器不覆盖。配置添加不会自动执行服务器，连接授权和 OAuth 由对应 Agent 完成。添加后重新加载 Agent 或启动新会话。

Skill 可从文件夹或 ZIP 导入，也可打包多个 Skill。每个 Skill 目录须包含带 `name`、`description` 的 `SKILL.md`；附属文件一并分发，同名目录不覆盖。支持按需勾选 Agent，分别显示成功或失败；共享目录（如 `.agents/skills`）中的资源可能被多个 Agent 自动发现。导入限制为 32 MB、10000 个文件，拒绝路径穿越和文件夹内的符号链接，不执行导入脚本。

自定义执行器在「高级属性」中设置 Skill 目录、MCP 配置文件及格式、Skill 管理方式和可选配置文件，之后可参与相同的分发流程。兼容原有资源路径映射。原有演示插件已移除。

开关修改实际发现配置并保留原文件。Codex、OpenCode、Pi 使用其原生 enabled、技能覆盖、权限或排除配置；Claude Code 的个人 MCP 开关将条目暂存于原配置的 `awbDisabledMcp` 区域，启用时恢复到 `mcpServers`，遇到同名新配置不覆盖。Claude Skill 使用 `skillOverrides`。自定义执行器可选择相应 Skill 适配方式；通用文件开关在独立 Skill 目录中可逆地切换 `SKILL.md` / `SKILL.md.awb-disabled`，不会执行或删除 Skill 内容。已有会话可能需重新加载配置。

「外观」支持 Cascadia Mono、随包分发的 JetBrains Mono、Consolas 等终端字体，以及 10–24px 终端和源码字号；界面字体及 12–16px 字号独立设置。切换字体后保留终端实例，等待字体加载再计算尺寸。

格式依据 [Claude Code MCP](https://code.claude.com/docs/en/mcp)、[Codex MCP](https://developers.openai.com/codex/mcp)、[OpenCode MCP](https://opencode.ai/docs/mcp-servers/)、[Pi MCP](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md) 及各 Agent 的 Skill 文档。

在 Linux 或 macOS 上开发时，本机 shell 会退回 bash，Windows 的 PowerShell / CMD 启动代码仍然保留。

## 核对界面

设计稿截图是 1440×900。在带显示器的环境里可以用下面的方式把同样尺寸的界面截下来（应用会自己走一遍主要流程并退出）：

```bash
AWB_CAPTURE=1 AWB_SHOTS=./shots AWB_USER_DATA=/tmp/awb-userdata npm start
```

开发约定见 [AGENTS.md](AGENTS.md)。`npm run lint` 包含 ESLint、24 条项目约束及对应反例检查。提交前运行 `npm run verify`，依次完成 lint、类型检查、构建和 Electron 行为回归。

界面约定见 [DESIGN.md](DESIGN.md)。`scripts/design-check.mjs` 覆盖深浅主题、1440×900 / 1024×680 两档窗口的 84 个界面状态，检查菜单边界、对话框布局、文字色对比度及键盘项目切换。菜单支持方向键、Home / End 与 Esc，截图位于 `output/playwright/design-after/`。

行为回归覆盖标签布局、状态颜色、深浅主题、弹窗焦点、会话恢复、进程树清理、密码认证、SSH 机器管理、远程保存、鼠标事件、终端尺寸、深层目录、面板拖宽、Markdown 所见即所得、自动保存与撤销、编辑冲突、内嵌 HTML 隔离预览、MCP / Skill 原生格式与界面分发，以及 100% / 125% / 150% / 200% 缩放下的边线像素连续性。精确自动保存时序使用浏览器虚拟时钟验证。SSH 检查启动绑定本机回环地址的临时测试服务器。截图写入 `output/playwright/`。

窗口最小宽度是 1024。
