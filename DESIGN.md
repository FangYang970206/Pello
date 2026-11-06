---
name: Pello
description: 本地 Code Agent 桌面工作台的界面约定
typography:
  compact:
    fontSize: "11px"
  help:
    fontSize: "12px"
  body:
    fontFamily: "Geist, Segoe UI Variable, Segoe UI, Microsoft YaHei UI, system-ui, sans-serif"
    fontSize: "13px"
    lineHeight: 1.5
  label:
    fontSize: "14px"
  reading:
    fontSize: "15px"
  compact-heading:
    fontSize: "16px"
  dialog-heading:
    fontSize: "18px"
  empty-heading:
    fontSize: "20px"
  page-heading:
    fontSize: "24px"
rounded:
  inline-code: "2px"
  compact: "4px"
  mark: "5px"
  control: "6px"
  project-mark: "7px"
  small-panel: "8px"
  panel: "10px"
  dialog: "12px"
  circle: "50%"
  scrollbar: "99px"
spacing:
  unit: "4px"
  related: "8px"
  field: "16px"
  section: "32px"
---

## Overview

面向长期使用终端和项目文件的开发者。界面保持克制，任务内容优先；桌面操作采用熟悉的标签、侧栏、表单和对话框。Markdown 阅读区强调内容层级。保留既有紫色主操作色与深浅主题，不引入装饰性卡片、插画或动画。项目侧栏采用紧凑单行，左侧环境配色文件夹、名称、菜单与加号，隐藏环境副标题。项目下展示会话，双击项目名称收起或展开，键盘左右键提供等效操作；会话内保留多终端标签。会话与终端名称及分组重启后保留。Agents 默认折叠，展开平铺终端，支持状态多选筛选与跨项目定位。

## Colors

以 `src/shared/themes.ts` 的主题色板和共享语义变量为准，`workbench.css` 保留深浅基础样式。提供深色、浅色、Nord、Dracula、Catppuccin Mocha、Solarized Light；工作台和终端 ANSI 色板同步，Code Agent 自身的真彩色主题仍由其原生设置控制。`--text` 为正文，`--muted` / `--faint` 为辅助信息，不能以降低透明度代替文字颜色。正文、帮助和占位文本对主要表面保持至少 4.5:1。危险实心按钮用 `--danger-fill`，错误文字用 `--red`。

`--accent` 仅用于主要动作、选择与焦点。会话行不显示状态。终端执行时显示黄色旋转点，等待指令时静止；错误保留红点与退出码，无障碍名称补足含义。状态接入 Shell 提示和 Agent OSC 7501 / OSC 9;4 原生信号。环境采用低饱和度蓝、青、紫、橙、玫红、橄榄绿、天蓝、藕紫，深浅主题分别配色；项目左侧文件夹使用环境颜色，颜色选择提供名称、选中标记与重复使用提示。

## Typography

界面保留应用随包分发的 Geist 与中文回退，此选择不因“常见字体”检测建议而替换；等宽字体仅用于终端、代码、路径和快捷键。设置页标题 24px，分组标题 13px，对话框标题 18px，表单标签 13px，帮助文字 12px。11px 仅保留在紧凑快捷键、状态数据等位置。设置页按 h1 → h2 排列。Markdown 使用自身的正文与标题层级，源码编辑与终端字体分别控制。

## Layout

间距采用 4px 基准。侧栏宽 240px，窗口不超过 1180px 时为 216px；主内容保留 `minmax(0,1fr)`。设置内容最大宽 760px，窄窗口减少留白。支持的最小窗口为 1024×680，不添加移动端导航。默认使用终端专注，收起文件/变更面板，可随时展开；布局另提供均衡和跨仓库审阅，文件/变更面板可放左侧或右侧；紧凑密度仅缩减控件间距，不改变终端行高。

表单控件高 36px，小按钮 30px，标签与加号同为 32px 并底部对齐。文件工具栏按可用宽度换行，不遮挡编辑区。对话框距窗口至少 24px，正文独立滚动，标题和操作区始终可见。深层文件树可横向滚动；不能以截断目录或文件来维持布局。

## Elevation & Depth

面板采用细边框；对话框、菜单和提示采用柔和阴影，不叠加装饰性外发光。普通页面保持静态，交互反馈使用 160ms 过渡；尊重减少动态效果设置。

## Shapes

控件圆角 6px，设置分组 10px，对话框 12px；胶囊只用于短状态或开关。操作图标统一使用 `icons.tsx` 的描边 SVG；应用品牌使用用户提供的橙色机器人图标，标题栏采用 `assets/icon-small.svg`，保留 18px 尺寸与既有对齐。

## Components

- 按钮、输入框、选择器、分段选项共用样式，具有悬停、焦点、选中、禁用和加载状态。焦点不可仅靠颜色微变表达。
- 自定义 Agent 菜单使用原生 Popover 顶层，按可用空间向上或向下展开；方向键移动，Home / End 定位，Esc 先关闭菜单并返回触发按钮。
- 项目选择用原生按钮，项目菜单为兄弟按钮，避免嵌套交互元素；键盘与鼠标均可操作。截断名称提供完整名称或路径提示。
- 状态、空内容和失败信息保留明确文字；长路径、命令和错误可换行或滚动，不能把关键操作挤出窗口。
- MCP / Skill 采用紧凑名称列表，右侧统一放详情图标与状态开关，Skill 行末增加三个点菜单，提供打开目录和删除；删除需确认后移入系统回收站，失败保留弹窗与错误。技术路径和完整配置收进只读详情。新增和多目标分发在模态窗口完成，相对当前设置内容列居中；Skill 详情高度上限为可见内容区的 60%，点击遮罩、Esc 或关闭按钮均可返回列表并恢复焦点。正文滚动，操作区固定可见；不在列表前放重复提示段落。
- 自定义执行器的资源路径和适配格式集中在高级属性。终端字体与字号、界面字体与字号、源码字号独立设置；默认保留 Geist 与现有等宽字体体系，JetBrains Mono 随应用分发。
- Markdown、源码、差异和终端共用外层导航，内容区域分别保留适合任务的排版。终端 fit、PTY 与输入协议约束见 AGENTS.md。

## Do's and Don'ts

变更共享控件时检查所有使用界面。执行 `npm run verify`：其中 `scripts/design-check.mjs` 检查深浅主题、宽窄窗口、文字色对比度、键盘项目切换、界面溢出并生成截图。截图与临时项目仅保存在忽略目录；不提交用户数据。

工作台随包提供 JetBrains Mono、Fira Code、IBM Plex Mono 与 Geist；系统字体继续使用中文回退。新增字体的 OFL 文本随发行包保留。非 Git 工作目录中的仓库按路径、分支和变更数量分组，支持筛选与重新扫描；保持文件名与完整相对路径可辨识。
