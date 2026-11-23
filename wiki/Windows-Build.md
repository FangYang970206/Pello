# Windows 打包

需要 Node.js 20.19+ 或 22.13+、Python 3 和 Visual Studio Build Tools 2022 的 C++ 桌面开发组件。

## 生成安装包与 ZIP

```powershell
npm install
npm run verify
npm run dist:win
```

`dist/` 中会生成以下文件，版本号取自 `package.json`。

| 文件 | 用途 |
| --- | --- |
| `Pello-<version>-win-x64-setup.exe` | Windows 安装向导，在安装目录生成 `Uninstall Pello.exe` |
| `Pello-<version>-win-x64.zip` | 解压后运行 `Pello.exe`，保留同目录资源 |
| `latest.yml` 与 `*.exe.blockmap` | 应用内更新依赖的元数据与增量下载映射，随安装包一起发布 |

命令只在本机打包，不自动上传。安装向导可选择目录，创建 Pello 快捷方式；升级和卸载保留安装目录中的 `data` 与 `pello.config.json`。ZIP 解压版可直接删除程序文件，按需保留 `data` 与 `pello.config.json`。

## 检查打包结果

```powershell
node scripts/windows-icon-check.mjs dist/win-unpacked/Pello.exe
```

再打开程序，确认终端能执行命令、切换主题后保留输出、退出时正常清理进程。开发版与安装版使用独立的 Windows 任务栏标识。

<details>
<summary>原生模块或代码签名有问题时</summary>

`npm install` 会重编 `node-pty`。失败时先检查 C++ 构建组件和 Python；打包钩子会校验 Windows x64 Node-API 二进制，不会重编未使用的可选 SSH 依赖。必要时执行 `npx electron-rebuild -f -w node-pty`。

当前默认不签名。有签名证书时，通过 `CSC_LINK` 和 `CSC_KEY_PASSWORD` 环境变量提供，再运行打包命令。证书和密码不要写入仓库。

</details>

发布前检查安装包、ZIP、源码与校验和；排除本地配置、测试数据和截图输出。GitHub Release 附件必须同时包含 `latest.yml`、安装包和 `.blockmap`，否则应用内更新无法检测或校验新版本。只有上传并核对 Release 资产后，才算发布完成。

[从源码开发](Development) · [回到指南首页](Home)
