<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/pello-logo-dark.svg">
    <img src="assets/pello-logo.svg" width="230" alt="Pello">
  </picture>
</h1>

**简体中文** · [English](README.en.md)

**在同一个工作区，运行 Agent、编辑文件、审阅变更。**

Pello 是一款面向本机与 SSH 环境的编码 Agent 桌面工作台。它以 **项目 → 会话 → 多终端与多标签** 组织工作，让你在同一处并行处理任务、运行多个 Agent、检查代码改动。

[下载 Windows x64](https://github.com/FangYang970206/Pello/releases/latest) · [图解使用指南](https://github.com/FangYang970206/Pello/wiki/Home) · [更新记录](CHANGELOG.md) · [反馈问题](https://github.com/FangYang970206/Pello/issues)

![Pello 工作区中的终端与源代码分栏](assets/tutorials/11-split-3.jpg)

```text
项目（本机目录或 SSH 目录，可置顶）
└── 会话（按任务组织，可重命名，支持历史恢复与原生对话续接）
    ├── 终端（多个 Agent 或纯 Shell）
    ├── 文件标签（源码、Markdown、HTML、PDF 与图片）
    └── 变更标签（统一与并排 Git Diff）
```

## 核心特点

- **按任务切换工作现场**。每个会话可同时打开多个终端和文件标签，切换时保留各自的终端与草稿。一次性任务可以建立有独立目录的本机或 SSH 临时会话。
- **多 Agent 共存与对话续接**。支持 Claude Code、Codex、OpenCode、Pi、Oh My Pi、自定义 CLI 和纯 Shell。使用目标机器上已配置的 CLI 和认证，重启后可恢复终端历史、续接受支持的 Agent 原生对话。
- **排查日志与审阅代码**。搜索终端输出，用六种颜色标记关键文本。Git Diff 支持子仓库、统一与并排视图，并排模式支持双侧编辑、滚动联动和按块还原。可在标签页编辑源码，查看 HTML 草稿、PDF 与图片。Markdown 支持目录、图表和缩放。
- **管理 MCP 与 Skill**。按机器和 Agent 查看原生资源配置，支持查看详情、启停和多目标分发。在系统浏览器打开推荐 Skill 仓库，将下载的目录或 ZIP 导入目标 Agent。
- **在本机和 SSH 项目中工作**。连接远程终端、浏览目录、编辑文件并上传或下载。界面提供六套主题、中英双语、独立字号设置及应用内更新。

## 开始使用

1. 下载 Windows x64 安装包或 ZIP，安装或解压后启动 Pello。
2. 点击侧栏「项目」旁的加号，选择本机或 SSH 项目目录。
3. 点击项目行旁的加号，选择已安装并完成认证的 Agent CLI，或选择「仅 Shell」启动第一个会话。

功能动图与操作步骤见 [Pello Wiki](https://github.com/FangYang970206/Pello/wiki/Home)。
