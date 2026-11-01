# 在 Windows 上打出 NSIS 安装包

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

`npm run dist:win`（`scripts/dist-win.mjs`）接着做三件事：

1. `electron-vite build`，产出 `out/`。
2. 在 Windows 上执行 `electron-builder install-app-deps`。这一步就是 `@electron/rebuild`，按 `node_modules/electron` 里的 Electron 33 重新编译 `node-pty`。
3. `electron-builder --win --x64 --publish never`，打出 x64 NSIS 安装包。配置在 `electron-builder.yml`，版本号取自 `package.json` 的 `version`，不会在配置里再写一份。

安装包在 `dist/`。默认文件名是 `Agent Workbench Setup 0.1.0.exe`（版本号随 `package.json` 变）。

只想单独重编原生模块、先不打包时：

```powershell
npx electron-builder install-app-deps
```

## 安装包行为

- 向导式安装（`oneClick: false`），可以选择安装目录。
- 创建桌面快捷方式和开始菜单快捷方式，名称是 Agent Workbench。可执行文件名是 `agent-workbench.exe`。
- 卸载会删掉程序文件、快捷方式和卸载登记。`deleteAppDataOnUninstall` 为 `false`，默认保留 `%APPDATA%\agent-workbench`（`workbench.json` 和 `shell/`）。

## 图标

仓库里没有 `.ico` 或 `.png` 应用图标，安装包使用 Electron 默认图标。不要为了打包临时画一张。以后若要换成自己的图标，把 `build/icon.ico` 放进仓库再执行 `npm run dist:win`。

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

## node-pty

Windows 上真正打进安装包的是 `electron-builder install-app-deps` 编出来的 `node_modules/node-pty/build/Release/*.node`（Electron 33 的 ABI）。`node-pty` 的加载顺序是 `build/Release`，然后才是 `prebuilds/win32-x64`。

`node-pty@1.1.0` 的 npm 包里带有 `prebuilds/win32-x64`（`conpty.node`、`pty.node`、`conpty_console_list.node`，以及旁边的 `conpty.dll`、`OpenConsole.exe`、`winpty.dll`、`winpty-agent.exe`）。这些 `.node` 是 Node-API 模块。在编不出 MSVC 产物的机器上，打包前的钩子 `scripts/ensure-win32-node-pty.cjs` 会把非 win32 的 `build/` 和 `@electron/rebuild` 顺手复制到 `bin/` 的产物挪走，改用这份预编译包，并检查每个要加载的 `.node` 都是 win32-x64 的 Node-API 二进制。检查失败则直接中止，不会打出一个终端模块打不开的安装包。`node-pty` 不读取 `bin/`，那个目录不会打进安装包。

`.node`、`.dll`、`.exe` 通过 `asarUnpack` 放在 `app.asar.unpacked` 里，否则运行时无法 `dlopen` 或拉起 ConPTY / winpty 辅助程序。
