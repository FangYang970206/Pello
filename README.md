# Agent Workbench

在本机运行的桌面工作台。每个项目绑定一台机器（本机或 SSH 远程主机）和一个目录，中间的标签是真实终端，用来启动 code agent CLI。没有账号，没有后端，没有云服务。

界面按 Agent Workbench v4 设计稿实现。颜色、间距、字号和圆角来自设计令牌，深色 / 浅色主题可以在设置里切换。

## Windows 上安装

需要：

- Node.js 20 或 22
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
- 运行中、空闲、已退出、失败和退出码来自 shell 进程本身（提示符钩子和子进程），不解析 agent 的输出。
- 终端标签用圆点显示状态：黄色表示任务运行中，绿色表示命令已结束且终端可以继续输入，灰色表示尚未运行 Agent 或终端已退出。新建终端的加号紧跟标签，快捷键可在「设置 → 快捷键」查看。
- 关闭终端会结束对应会话和整棵进程树，退出应用时也会等待进程清理完成。运行中的终端是否需要关闭确认，由「结束进程前确认」设置控制。
- 右栏「变更」调用本机或 `ssh` 上的 `git`。丢弃已跟踪文件用 `git restore`；未跟踪文件 `git restore` 删不掉，这时用 `git clean -f`。
- 远程主机走系统自带的 `ssh` 客户端。应用自己不发起其它网络请求。插件开关只保存在本地。

在 Linux 或 macOS 上开发时，本机 shell 会退回 bash，Windows 的 PowerShell / CMD 启动代码仍然保留。

## 核对界面

设计稿截图是 1440×900。在带显示器的环境里可以用下面的方式把同样尺寸的界面截下来（应用会自己走一遍主要流程并退出）：

```bash
AWB_CAPTURE=1 AWB_SHOTS=./shots AWB_USER_DATA=/tmp/awb-userdata npm start
```

先执行 `npm run build`，再用 `npm run check` 运行 Electron 回归检查，覆盖标签布局、状态颜色、深浅主题、弹窗焦点、会话恢复，以及关闭标签和退出应用后的进程树清理。截图写入 `output/playwright/`。

窗口最小宽度是 1024。
