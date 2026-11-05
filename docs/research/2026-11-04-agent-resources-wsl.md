# OpenCode、Pi 资源实测与 WSL 目录浏览调研

测试日期：2026-11-04。Windows 本机为 OpenCode 2.2.3、Pi 1.4.0；Ubuntu WSL 为 OpenCode 2.2.5。测试使用现有模型配置，只向模型提供合成示例和测试文件。

## 添加的公开资源

- Skill：Vercel 官方仓库的 `vercel-react-best-practices`，来源固定到 `vercel-labs/agent-skills@1a2c79d`。保留 SKILL.md、规则和支持文件，不执行仓库脚本。[源仓库](https://github.com/vercel-labs/agent-skills)、[Skills 目录](https://skills.sh/vercel-labs/agent-skills/vercel-react-best-practices)。
- MCP：Model Context Protocol 官方 `@modelcontextprotocol/server-filesystem@2.1.0`，名称 `awb-filesystem`。其可访问范围只包含本次测试沙箱，实际调用只读工具。服务器本身也提供写入工具，不能将其称作只读服务器。[官方说明](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem)。

两项资源均通过工作台的 ResourceManager 分发到 OpenCode 和 Pi 的 Windows 用户配置，未覆盖同名资源；原配置已备份。测试后保持启用。

| Agent | MCP 配置 | Skill 目录 |
| --- | --- | --- |
| OpenCode | `%USERPROFILE%/.config/opencode/opencode.jsonc` | `%USERPROFILE%/.config/opencode/skills/vercel-react-best-practices` |
| Pi | `%USERPROFILE%/.pi/agent/mcp.json` | `%USERPROFILE%/.pi/agent/skills/vercel-react-best-practices` |

MCP 运行依赖与合成数据位于仓库忽略目录 `.cache/agent-resource-audit`，属于本次测试夹具；删除此目录前应先移除 `awb-filesystem` 配置。它们不进入源码归档或应用发行包。

## 实际结果

| 检查 | OpenCode / Windows | Pi / Windows |
| --- | --- | --- |
| 工作台分发 MCP 和 Skill | 通过 | 通过 |
| Agent 原生发现 Skill | 通过 | 通过 |
| MCP 禁用、重新启用 | 原生 `disabled` 状态随开关改变 | 禁用后 disabled，恢复后 connected，发现 14 个工具 |
| Skill 禁用、重新启用 | 原生 skill 权限 deny / allow | 禁用后不再发现 Skill 命令，恢复后再次发现 |
| 真实模型加载 Skill | 通过，调用 skill 工具 | 通过，调用 `/skill:vercel-react-best-practices` |
| 真实 MCP 读取 | 通过，`awb-filesystem.read_text_file` | 通过，`mcp__awb_filesystem__read_text_file` |
| 返回测试文件标记 | `AWB_MCP_PROOF_20261104` | `AWB_MCP_PROOF_20261104` |
| 应用 Skill 规则 | 正确指出独立 fetch 使用 `async-parallel` / `Promise.all` | 同左 |

除独立 CLI 调用，还在工作台 PowerShell PTY 中执行了真实 Agent 调用，检查输出、命令结束后可继续输入及切换设置时终端实例保留。也启动了工作台内置的 Pi / OpenCode 交互式终端：两者正常进入输入界面，Pi 的启动清单包含新 Skill，OpenCode 显示已加载 MCP。尚未穷尽交互式 TUI 的所有快捷键。

### 已修复：OpenCode v2 原生配置兼容

由已安装的 OpenCode CLI 自己生成项目 MCP 配置后，旧工作台将 `mcp.servers` 容器显示为名叫 `servers` 的服务器，而非实际 MCP。这会同时影响新增、详情和开关。

现在同时兼容旧版 `mcp.<name>.enabled` 和 v2 的 `mcp.servers.<name>.disabled`；Skill 使用 v2 有序 `permissions` 数组。保留 JSONC 注释、其他权限和认证字段，详情继续脱敏。同名冲突仍拒绝覆盖。

回归用例先在旧实现复现失败，再验证列表、添加、禁用/恢复、Skill 权限、注释和脱敏。另用修复后的 ResourceManager 对原生 CLI 生成的项目配置实测，能列出真实服务器，禁用并恢复 `awb-native-control`。依据：[OpenCode MCP](https://opencode.ai/v2/docs/mcp-servers)、[权限](https://opencode.ai/v2/docs/permissions)、[Skills](https://opencode.ai/v2/docs/skills)。Pi 1.4.0 已内置 MCP，此次不安装额外代理扩展。[Pi 对应版本文档](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/mcp.md)。

### 已提供兼容修复：OpenCode 冷启动 MCP 状态查询

OpenCode 2.2.3（Windows）和 2.2.5（WSL）在新私有服务上直接执行 `mcp list --standalone` 会返回空列表。进一步实测同一服务的 API，得到下面的确定性顺序：

1. `GET /api/mcp` 返回空数组。
2. `GET /api/config`、`GET /api/plugin` 之后仍为空。
3. `GET /api/agent` 后，再查 `/api/mcp` 即出现真实服务器，随后连接完成。

根因位于上游的初始化依赖：MCP 配置由 Agent/config 插件应用，列表处理器直接读取 MCP 状态，没有先激活这条配置链。对应的上游实现可见 [CLI 列表处理器](https://github.com/anomalyco/opencode/blob/dev/packages/cli/src/commands/handlers/mcp/list.ts) 和 [MCP 配置插件](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/config/plugin/mcp.ts)。`dev` 分支会变动，上述 API 行为已在本机安装版本上单独复现。

本仓库增加 `npm run mcp:opencode` 兼容入口：启动本机回环地址上的临时私有服务，先初始化 Agent 配置，再等待 MCP 状态。传递实际项目目录；认证仅在进程内使用，输出只包含服务器名称和状态，结束后关闭测试服务。不创建模型会话，不伪造连接成功。

```powershell
npm run mcp:opencode -- --name awb-filesystem --json
```

支持 `--directory`、`--executable`、`--name`、`--timeout`；指定服务器不存在、初始化失败、认证失败、连接失败或超时未连接时返回非零退出码。Windows 2.2.3 和 WSL 2.2.5 的真实服务均已通过检查，测试 Filesystem MCP 返回 `connected`。未替换官方二进制，所以官方原始 `mcp list --standalone` 的上游缺陷仍可能复现；修复的是本仓库提供的检查路径。

### 已修复：WSL Pi 安装、运行时和资源验证

最初 Ubuntu 的 `pi` 命中 `/mnt/c/Users/Lenovo/AppData/Roaming/npm/pi`。本轮复查时系统已有 Hermes 提供的 Node 22，但仍依赖 Windows npm 安装；直接 `wsl --exec` 又不会加载交互式 Bash 的 PATH。

现在已安装 Linux 原生 `@earendil-works/pi-coding-agent@1.4.0`，与 Windows 测试版本一致。官方 Filesystem MCP 2.1.0 的 engines 要求 Node >=24，因此额外安装独立 Linux Node **24.22.2**，下载自 Node.js 官方发行目录并通过官方 SHA256 校验。Pi 启动器和 MCP 都明确使用该运行时，不再依赖 Windows shim 或 Bash PATH。

- Pi 启动器：`/home/fy/.local/bin/pi`。
- npm 安装：`/home/fy/.local/lib/node_modules/@earendil-works/pi-coding-agent`。
- Node：`/home/fy/.local/share/agent-workbench/runtime/node-v24.22.2-linux-x64/bin/node`。
- npm 原始 Pi 链接备份：`/home/fy/.local/bin/pi.awb-npm-link`。后续 npm 全局更新可能重建该链接，需要再次检查直接 `wsl --exec` 的启动行为。
- Linux MCP 配置：`/home/fy/.pi/agent/mcp.json`。
- Skill：`/home/fy/.pi/agent/skills/vercel-react-best-practices`。
- MCP 依赖与测试沙箱：`/home/fy/.local/share/agent-workbench/qa/`，独立于仓库 `.cache`。

复用现有 gateway 模型配置进行真实测试，Linux 配置权限设为 0600，修改前备份，不在日志或报告中输出认证值。依据：[Pi 1.4.0 安装包定义](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/package.json)、[Node.js 官方发行](https://nodejs.org/dist/v24.22.2/)。

| WSL / Ubuntu 检查 | 结果 |
| --- | --- |
| 原生安装和版本 | Pi 1.4.0；Linux Node 24.22.2 |
| 无交互式 PATH 的直接启动 | `wsl.exe -d Ubuntu --exec /home/fy/.local/bin/pi --version` 成功 |
| 模型认证 | `ready`，使用既有 gateway |
| MCP 原生列表 | `awb-filesystem` connected，14 个工具 |
| MCP 禁用 / 恢复 | disabled → connected |
| Skill 禁用 / 恢复 | RPC 不再发现命令 → 再次发现 `skill:vercel-react-best-practices` |
| 真实模型调用 | 加载 Skill，通过 MCP 读出 `AWB_WSL_PI_PROOF_20261104`，指出 `async-parallel` |
| 工作台终端 | Linux Pi TUI 正常；`/mcp` 显示连接；真实调用退出码 0；切换设置保留终端 |
| 测试关闭清理 | 测试沙箱中未遗留 Pi 进程 |

WSL OpenCode 也已添加 Linux 原生 Filesystem MCP 和同一 Skill；新的冷启动检查入口验证连接成功。Windows 与 WSL 使用各自的原生配置路径。

## WSL 目录浏览：业界做法与本次改进

[VS Code WSL](https://code.visualstudio.com/docs/remote/wsl) 采用先连接发行版、再在该 Linux 环境选择文件夹的流程，终端和工具也运行在该环境。这个环境归属比单纯弹出 Windows 目录选择框更重要。

[Microsoft 文件系统指南](https://learn.microsoft.com/en-us/windows/wsl/filesystems) 建议使用 Linux 工具的项目放在 Linux 文件系统；Windows 工具则适合 Windows 文件系统。Windows 资源管理器可通过 `\\wsl$` / `\\wsl.localhost` 浏览 Linux 文件；路径转换应使用 `wslpath`，不应手写盘符替换。[互操作说明](https://learn.microsoft.com/en-us/windows/dev-environment/wsl-interop)。

当前工作台只有本机和 SSH 主机。通过 SSH 接入 WSL 时，原目录浏览只能逐级点击；地址无法直接跳转，也没有加载和错误反馈。本次保留现有连接方式，改进远程目录选择器：

- 输入 Linux 绝对路径后按 Enter 或“前往”。留空打开远端主目录。
- “主目录”“上一级”，以及当前层子目录名称筛选，支持中文。
- 独立呈现加载、没有子目录、没有筛选结果、权限和连接错误；失败可重试，失败目录不可选择。
- 显示待选路径，明确“使用此目录”；切换机器关闭旧环境浏览，过期请求不会覆盖新导航。
- 深浅主题、1024×680 / 1440×900 布局检查；正文滚动，主对话框操作区保持可见。

该改进适用于现有 SSH Linux/WSL 浏览，不包含“发行版直连”。后续建议新增原生 WSL 主机类型，列出发行版并显式选择，使用 `wsl.exe -d <发行版> --cd <Linux 路径>` 执行 Linux 工具。文件读写、Git、终端和资源管理必须共用发行版上下文；仅给本机选择器增加 UNC 路径不能保证工具运行环境正确。

## 复核与证据

当前工作区完整 `npm run verify`（lint → typecheck → build → check）退出码 0，包含原有远程终端检查；界面回归捕获 104 个状态，新增目录选择器另有四种主题/尺寸截图。首次在隔离工作树运行时，终端缩放用例曾出现一次缓冲区标记计数断言失败；单独复测及最终全套重跑均通过，未确认首次失败原因。

- `scripts/opencode-mcp-check.mjs`：冷启动配置初始化、连接等待、目录上下文和错误返回。
- `.cache/wsl-pi-fix/`：本轮 WSL 工作台终端截图和验证日志；Linux 详细调用与开关证据在 `/home/fy/.local/share/agent-workbench/qa/`。
- `scripts/resources-check.mjs`：原生配置、开关、注释、冲突、详情脱敏及 OpenCode v2 回归。
- `scripts/directory-browser-check.mjs`：真实 Electron 界面与可控 IPC 目录夹具，覆盖路径跳转、中文筛选、加载、错误、空目录、旧请求、选中回填及切换机器。
- `.cache/agent-resource-audit/manifest.json`、`toggle-evidence.json`：分发和开关结果。
- `.cache/agent-resource-audit/*-real-call*.jsonl`：真实 Agent 工具调用记录；不提交原始模型会话。
- `.cache/agent-resource-audit/*-workbench-terminal.png`：终端执行截图；`pi-tui.png`、`oc-tui.png` 为内置 Agent TUI 启动截图。
- `.cache/directory-browser-shots/`：四种目录浏览布局截图。

截图、下载的资源、第三方依赖、用户配置和认证数据不提交。
