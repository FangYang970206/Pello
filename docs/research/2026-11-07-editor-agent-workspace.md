# 2026-11-07 编辑器、Agent 状态与工作区改进

## 实现范围

| 需求 | 当前行为 | 回归入口 |
| --- | --- | --- |
| 1 文件语法高亮 | 源码保留原有输入、撤销和保存机制，增加语法层；覆盖 JSON、YAML、XML、Java、JS/TS、Python、Go、Rust、C/C++、Shell 等语言及常见文件名。Markdown 代码块加载 CodeMirror 语言列表。 | reading-workspace、editor |
| 2 Markdown 列表 | 列表内段落移除额外 margin/padding，圆点和第一行使用相同行高。 | reading-workspace |
| 3 浅色代码首行 | CodeMirror 本体、语法色、gutter 和活动行使用共享主题变量。 | reading-workspace |
| 4 Markdown 导航 | 目录悬浮在正文左侧，显示标题层级和当前位置，支持点击跳转与折叠。窄内容区缩小目录并为正文留出空间，跳转后收起，不遮挡标题。支持中文及重复标题锚点、项目内相对文件链接和网页链接；主进程检查链接边界和协议。 | reading-workspace |
| 5 图表 | Mermaid 严格模式渲染为 SVG 图片；PlantUML 使用 plantuml.com 在线服务并注明来源。无效图表显示错误；异步结果不会覆盖后续编辑。 | reading-workspace |
| 6 Agent 定位 | 点击 Agent 展开所在项目和项目列表，仅会话显示选中底色。 | sidebar、terminal-layout |
| 7 菜单对齐 | 项目和会话的菜单沿同一侧栏边缘对齐，保留键盘关闭和焦点返回。项目菜单仅保留项目操作，支持复制路径，本机另可在资源管理器中打开；文件创建留在文件树。 | terminal-layout、reading-workspace |
| 8 终端重命名 | 支持标签双击、F2、右键及 Agents 菜单重命名，重启后保留。 | sidebar、terminal-layout |
| 9 Agent 状态 | 纯 Shell 灰色且不进入 Agents；仍打开的 Agent 显示空闲绿色或请求运行黄色。回车不再伪造运行状态，OSC 7501 优先于任务栏进度。 | program-status、terminal-layout |
| 10 临时会话 | 新建项目下方提供入口。首次根目录默认 D:\TempSessions，保存到安装目录的 pello.config.json。选定执行器后创建 UUID 子目录及限定输出范围的 AGENTS.md；CLAUDE.md 导入该文件以兼容旧版 Claude Code。取消不创建 UUID 子目录。 | terminal-layout |
| 11 分栏 | 终端右键提供四向分栏及合并，最多四个象限。合并隐藏其他终端，保留进程与终端实例；布局随会话和重启恢复。 | terminal-layout、render |
| 12 搜索结果 | 点击结果后保留查询、列表和文件树展开状态，文件在编辑区打开；每个文件保留独立标签，后续单击其他文件不覆盖，再次单击同一文件定位已有标签。草稿和撤销历史独立保留；去掉鼠标产生的紫色外框，保留键盘焦点反馈。 | reading-workspace、workspace |
| 13 侧栏拉伸 | 项目侧栏支持拖动及方向键，宽度记忆。两个面板拖动时没有紫色竖线，终端由 ResizeObserver 自适应。 | terminal-layout、render |

## 状态问题的证据与处理

修改前的复现检查同时报出列表偏移 5.25px、缺少目录、浅色活动行 gutter 仍为 rgb(44,49,58)、JSON 无高亮、搜索词被清空五项失败。

原来的终端输入路径会在收到任意回车时清除 programWaiting。原生 CLI 对 `/help` 等本地操作未必重复报告同一个 idle 状态，导致界面保持运行中。修复后，输入不修改请求状态，由原生协议或生命周期事件更新。

分栏回归还复现了设置页隐藏终端后显示空白的问题。终端数据仍在，但隐藏后的 DOM 滚动事件把视口移到了旧位置。工作区现在明确转发可见性，在布局阶段保存、恢复视口；原先跟随底部的继续跟随，主动上翻历史的位置则保留，字体和面板尺寸变化后仍可滚动。

设置关闭后，终端的可见性和异步字体刷新曾再次夺取焦点。终端焦点现由布局阶段处理，父层随后恢复触发按钮；字体加载仅重绘。review 检查等待字体和绘制完成后再核对实际焦点，分栏检查另核对首次终端输入焦点。

Pi 使用其原生 PI_PROGRAM_STATUS=1 能力；Claude 在本地启动时追加单次启动设置文件，使用随机令牌保护的 loopback HTTP hooks，保留用户配置文件。hook 请求体不记录、不保存。临时设置在退出时删除。Shell 内手动启动的已知 Agent 通过原生 app 身份识别，退出返回 Shell 后从 Agents 移除。

业界资料以原生事件为准，避免静默计时或进程存活推断请求状态。

- [Claude Code hooks](https://code.claude.com/docs/en/hooks) 提供 UserPromptSubmit、Stop、PermissionRequest 等生命周期事件。
- [Pi Program Status Protocol](https://github.com/badlogic/pi-mono/blob/main/packages/tui/src/program-status.ts) 定义 OSC 7501 的 working、idle、blocked、done、error、clear。
- [OpenCode plugins](https://opencode.ai/docs/plugins/) 提供插件和会话事件接入机制。
- [Codex OSC 7501 实现](https://github.com/openai/codex/pull/52725) 提供原生程序状态报告。
- [Claude Code 指令文件导入](https://code.claude.com/docs/en/memory#import-additional-files) 说明 CLAUDE.md 中的相对 @ 文件导入机制。
- [Typora 大纲导航](https://support.typora.io/Outline/) 使用独立目录、标题层级与当前章节提示。Pello 按用户要求将其放在正文左侧悬浮，不插入正文顶部。

## 验证记录

- 新增 reading-workspace、terminal-layout 行为检查，纳入 npm run check。
- 结构约束增加状态优先级、四象限上限、纯 Shell 排除和 UUID 目录边界，并增加反例。
- 文档检查覆盖实际语言 token、列表坐标、深浅代码 gutter、目录跳转、链接边界、实际图表图片、无效图表和源码字节未改写。
- 分栏检查覆盖四象限、四栏上限、合并、键盘输入焦点、实际可见内容、持久化、项目展开和侧栏拉伸。
- 四档 DPI（100%、125%、150%、200%）检查分栏后的图形渲染器、边线、中文、终端实例与尺寸边界。
- 深浅主题与 1024×680 / 1440×900 均生成截图，截图位于忽略的 output/playwright 目录。
- 真实 Pi 和 OpenCode 请求均观察到空闲 → 运行 → 空闲；本地 Claude 启动探针观察到空闲。
- Claude 启动链路另用受控 CLI 替身验证设置参数确实到达子进程，HTTP hooks 更新实际 UI，任务栏旧进度不会覆盖生命周期状态，退出删除临时设置文件；不调用模型。
- 后续三项调整均先复现失败，再补充实际行为检查：左侧悬浮目录的几何位置、单击多标签及切换后的草稿/撤销、本机项目菜单的真实路径复制与资源管理器调用。深浅主题与宽窄窗口分别核对目录不遮挡标题、跳转与窄窗口自动收起。

本机 PATH 中的 Codex 是桌面应用附带的 CLI，启动提示缺少完整本地 package，随后返回失败退出码；没有修改用户全局安装。其原生协议解析已覆盖数据包分片和状态回归，但本次没有完成真实 Codex 模型请求。远程 Claude 的专用 HTTP hooks 不通过本机 loopback 接入，仍依赖远程 CLI 原生 OSC 状态；本轮未进行真实远程 Agent 请求验收。

最初的系统剪贴板检查在 Windows 锁屏时失败。独立探针确认应用传入正确路径，但系统读回为空；用户解锁后，同一真实剪贴板检查及整个 workspace 入口均通过。既有检查未删除、未替换成 mock。

追加需求的 reading-workspace、workspace 及 SSH 专项通过。multi-repo、program-status、sidebar、editor、design（104 状态）、appearance、资源配置与导入、host-management、directory-browser、autosave、resource-dialog、html-preview、terminal-layout 等入口也已通过。外观测试首次在 renderer 初始化完成前读取终端检查函数；现等待实际终端内容出现后再执行原断言，后续专项通过。日志位于 `output/reading-followup-check.log`、`output/workspace-followup-check.log`、`output/ssh-followup-check.log` 与 `output/followup-tail-check.log`。

最终完整 `npm run verify` 已于 2026-11-07 从头到尾通过，退出码为 0。lint（含 54 个结构反例）、typecheck、build 和完整 check 行为链均通过，覆盖 104 个界面状态、四档 DPI、深浅主题与 1024×680 / 1440×900 窗口，以及原 13 项和追加三项的专项断言。日志位于忽略目录 `output/verify-2026-11-07-complete.log`。截图和临时测试数据未纳入源码。未提交、推送或发布。
