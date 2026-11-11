# Git 并排编辑与原生会话恢复

## 实现范围

- 并排视图采用 CodeMirror MergeView。双侧编辑实时更新差异，横纵滚动双向联动，不等宽面板共享水平滚动范围。中间双箭头仅还原对应块，支持鼠标与键盘操作；分隔线可拖动或用左右键调整。
- 左侧编辑比较基准，不改写 Git 提交；右侧共用文件草稿、撤销、IME 暂停、自动保存和原子保存。保存冲突保留草稿；删除文件可按块还原，重建时拒绝覆盖并发创建的目标。
- 启动恢复全部项目、会话分组、终端及活动项。Claude / Codex / OpenCode 绑定原生 ID，Pi / Oh My Pi 使用终端独立原生存储；Codex 先通过 app-server 分配并持久化 thread，再由独立 CLI 按 ID 打开，不发送模型请求。
- 本机旧记录没有 ID 时按目录和独有消息匹配原生记录，不按时间猜测。Pi / Oh My Pi 保留原文件，将匹配记录复制到独立目录。无匹配或歧义时保留历史并报错，不创建空白对话。
- 终端输出由主进程持续保存为 ANSI 记录，可通过终端右键导出。屏幕快照取消 512 KB / 100 个文件的淘汰限制；回放保留当前画面、光标和输入模式，退出等待 xterm 写入队列及快照落盘。

## 回归入口

| 用例 | 交互与边界 |
| --- | --- |
| `diff-editor-check.mjs` | 双侧编辑、撤销重做跨视图保留、双轴联动、不等宽滚动、鼠标/键盘调整、分块还原保留其他块、保存冲突、删除文件重建与并发创建保护、深浅主题和两种窗口尺寸 |
| `agent-resume-check.mjs` | 五种原生恢复参数、独立目录、旧消息唯一匹配与歧义拒绝、OpenCode 导出解析、超过 512 KB 的完整 UTF-8 历史、105 个终端保留、清屏不删除输出记录、显式删除 |
| `session-restore-check.mjs` | 两个会话分组各两个终端、隐藏终端自动恢复实际内容、离线远程失败保留、完整记录导出及原有侧栏交互 |
| `codex-native-session-check.mjs` | 真实 Codex CLI 配合本机 Responses 夹具生成两段对话，连续启动后核对用户消息、回复和准确 ID；模拟旧记录缺 ID、空 thread 恢复，并继续输入验证回放后 TUI 可交互 |
| `pi-native-session-check.mjs` | 真实 Pi 的两段旧原生对话，缺 ID 时自动迁移，连续启动核对实际可视消息；原始原生文件保持不变 |

直接受影响的既有回归还包括 `editor-check.mjs`、`autosave-check.mjs`、`program-status-check.mjs`、`terminal-shutdown-check.mjs`、`remote-terminal-check.mjs`。日常静态验证执行 `npm run lint` 和 `npm run typecheck`，Electron 行为验证前执行构建，不使用全量 check 代替定向选择。

原生深度测试入口为 `npm run check:sessions:deep`，要求本机安装 Codex 和 Pi。测试使用隔离配置、合成消息和本地 Responses 服务，不使用真实模型账户。

## 实际限制

- 原生记录已删除，或旧历史无法唯一定位原生记录时，无法重建已丢失的模型上下文；保留工作台已有历史和错误。
- 旧远程 Agent 记录若没有原生 ID，保留历史并提示错误。具有 ID 或终端独立存储标识的记录走自动恢复。真实 SSH Agent 原生续接尚未实机验证，已有 SSH 输出、启动与尺寸回归单独验证。
- 自定义执行器的上下文续接由其命令及原生能力决定；工作台仍保存完整终端输出和可视历史。
- 旧版已经截断、且原生记录也不存在的内容无法凭空找回。新记录不再按旧大小或数量阈值淘汰。

实现参考与参数核对来自 [CodeMirror MergeView](https://codemirror.net/docs/ref/#merge.MergeView)、[Codex app-server](https://learn.chatgpt.com/docs/app-server) 及本机 CLI 帮助和 Pi 原生 SessionManager；实际行为以以上可运行用例为准。

## 验证结果（2026-11-12）

`npm run lint`（含 76 项反例）、`npm run typecheck`、`npm run build` 均通过。表中五个新增或扩展用例及列出的直接受影响既有回归均已通过；Codex、Pi 使用真实 CLI 与隔离数据验证。最后修正不等宽分栏在字体及虚拟行宽更新后的横向范围，以及编辑器快捷键优先级后，重新通过静态检查、构建与两次完整差异编辑回归。深浅主题、1024×680 / 1440×900 截图已查看，截图和临时数据未纳入改动。
