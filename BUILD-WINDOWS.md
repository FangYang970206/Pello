# 在 Windows 上打出安装包与免安装包

只涉及打包。应用本身怎么跑，见 [README.md](README.md)。

## 前提

- Node.js 22（Node.js 20 也可以）。本仓库在 Node.js 22 下开发。
- [Visual Studio 2022 Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)，工作负载选「使用 C++ 的桌面开发」（MSVC、Windows 10/11 SDK）。`node-pty` 要按本仓库的 Electron 33 重新编译，没有这套工具编不过。
- Python 3。`node-gyp` 和 `@electron/rebuild` 会调用它。

不需要 Wine。Wine 只在 Linux 或 macOS 上调用 NSIS 时才用得到。

## 命令

在仓库根目录：

```powershell
npm install
npm run dist:win
```

`npm install` 结束时，已有的 `postinstall` 会执行 `electron-rebuild`，把 `node-pty` 编到当前 Electron 上。

`npm run dist:win`（`scripts/dist-win.mjs`）接着做两件事：

1. `electron-vite build`，产出 `out/`。
2. `electron-builder --win --x64 --publish never -c.npmRebuild=false`，打出 x64 NSIS 安装包和免安装 ZIP。打包钩子校验 `node-pty` 的 Windows x64 Node-API 二进制；已有有效编译产物时使用该产物，否则使用依赖自带的预编译模块。此步骤不重编译未打入应用的可选 SSH 原生依赖。配置在 `electron-builder.yml`，版本号取自 `package.json` 的 `version`。

产物在 `dist/`，版本号随 `package.json` 变化：

- `Agent-Workbench-0.1.3-win-x64-setup.exe`：安装向导。
- `Agent-Workbench-0.1.3-win-x64.zip`：解压后运行 `agent-workbench.exe`，须保留同目录的资源文件。

使用发布的二进制无需安装 Node.js、Python 或 C++ 构建工具。Agent CLI、Git 和 SSH 等外部工具按需自行安装。

只想单独重编原生模块、先不打包时：

```powershell
npx electron-rebuild -f -w node-pty
```

## 安装包行为

- 向导式安装（`oneClick: false`），可以选择安装目录。
- 创建桌面快捷方式和开始菜单快捷方式，名称是 Agent Workbench。可执行文件名是 `agent-workbench.exe`。
- 卸载会删掉程序文件、快捷方式和卸载登记。`deleteAppDataOnUninstall` 为 `false`，默认保留 `%APPDATA%\agent-workbench`（`workbench.json` 和 `shell/`）。

## 图标

应用采用用户提供的图标。`assets/icon.ico` 包含 16–256px 七档尺寸，用于 Windows 程序、窗口和安装 / 卸载向导；`assets/icon.png` 用于 README 与其他平台窗口；标题栏使用适合小尺寸的 `assets/icon-small.svg`。打包时只复制运行所需的 ICO 和 PNG，不包含原始附件、设计预览或未使用的图标尺寸。

任务栏分组图标通过窗口的 Windows Shell 属性显式指定，独立于标题栏图标和 EXE 内嵌图标。安装版使用 `com.agentworkbench.app`，开发启动使用 `com.agentworkbench.app.dev`，避免开发版 `electron.exe` 与旧安装快捷方式混为一组。重新启动命令同时保存正确的程序和开发项目路径。

`node scripts/windows-icon-check.mjs` 读取实际窗口的 Shell 属性，校验应用标识、任务栏图标和重新启动目标。传入打包后的 EXE 路径可检查发布包。

## 代码签名

当前不签名。要签名时只通过环境变量提供证书，不要把证书或密码提交进仓库：

```powershell
$env:CSC_LINK = "C:\certs\agent-workbench.pfx"
$env:CSC_KEY_PASSWORD = "<证书密码>"
npm run dist:win
```

`CSC_LINK` 可以是 `.pfx` / `.p12` 的路径、`https://` 地址，或证书的 base64。`electron-builder.yml` 里对应的 `certificateFile` / `certificatePassword` 保持注释：环境变量为空时取消注释会让打包失败。`electron-builder` 在这两个变量都存在时会自动读取它们。

## 不会上传

`electron-builder.yml` 里 `publish: null`，命令行还有 `--publish never`。没有自动更新地址，构建结果不会传到任何服务器。

## 发布归档

提交或发布前运行 `npm run verify`，通过后执行 `npm run dist:win`。Release 上传上述 EXE、ZIP、源码 ZIP 和 `SHA256SUMS.txt`；不要上传 `win-unpacked/`、构建调试文件、截图或本地配置。

源码包从发布标签生成，例如：

```powershell
git archive --format=zip --prefix=agent-workbench-0.1.3/ --output=dist/Agent-Workbench-0.1.3-source.zip v0.1.3
```

`.gitattributes` 的 `export-ignore` 排除 `design/` 设计图、截图输出、缓存、依赖和构建产物；GitHub 自动生成的源码归档也使用此规则。源码包保留 `src/`、运行所需字体、锁文件、构建配置、检查脚本和开发文档，支持安装依赖、构建及完整验证。

## node-pty

`node-pty` 的加载顺序是 `build/Release`，然后才是 `prebuilds/win32-x64`。安装包保留通过 Windows x64 Node-API 校验的模块，打包本身不强制重新编译。

`node-pty@1.1.0` 的 npm 包里带有 `prebuilds/win32-x64`（`conpty.node`、`pty.node`、`conpty_console_list.node`，以及旁边的 `conpty.dll`、`OpenConsole.exe`、`winpty.dll`、`winpty-agent.exe`）。这些 `.node` 是 Node-API 模块。在编不出 MSVC 产物的机器上，打包前的钩子 `scripts/ensure-win32-node-pty.cjs` 会把非 win32 的 `build/` 和 `@electron/rebuild` 顺手复制到 `bin/` 的产物挪走，改用这份预编译包，并检查每个要加载的 `.node` 都是 win32-x64 的 Node-API 二进制。检查失败则直接中止，不会打出一个终端模块打不开的安装包。`node-pty` 不读取 `bin/`，那个目录不会打进安装包。

`.node`、`.dll`、`.exe` 通过 `asarUnpack` 放在 `app.asar.unpacked` 里，否则运行时无法 `dlopen` 或拉起 ConPTY / winpty 辅助程序。
