# 开发与验证

需要 Node.js 20.19+ 或 22.13+。Windows 安装依赖时需要 Python 3 和 Visual Studio Build Tools 2022 的 C++ 桌面开发组件。

```powershell
git clone https://github.com/FangYang970206/Pello.git
cd Pello
npm install
npm run dev
```

`npm run build` 生成 `out/`，`npm start` 运行构建结果。安装包生成流程见 [Windows 打包](Windows-Build)。

日常改动提交前运行 `npm run lint`、`npm run typecheck`，再按功能选择 `scripts/*-check.mjs` 的定向行为用例。发布前运行 `npm run verify`（lint、类型检查、构建和全量行为回归）与必要的深度验证。结构检查与实际行为检查不能互相替代。

界面检查覆盖深浅主题、1440×900 / 1024×680 窗口、键盘操作、对话框边界及文字对比度；终端检查包含四档 DPI、鼠标输入、尺寸、会话恢复与进程清理。文件、SSH、编辑器、预览及 Agent 资源有各自的行为用例。

测试截图与日志放在 `output/playwright/`，不提交。旧版文档图片放在 `assets/screenshots/`、动图放在 `assets/demos/`；当前教学动图、逐步静帧与维护说明放在 `assets/tutorials/`，Wiki 可维护源文件在 `wiki/`，使用独立示例项目拍摄，不包含用户配置。行为用例使用隔离用户数据；SSH 用例启动绑定本机回环地址的临时服务器。

开发约定见 [AGENTS.md](https://github.com/FangYang970206/Pello/blob/main/AGENTS.md)，界面约定见 [DESIGN.md](https://github.com/FangYang970206/Pello/blob/main/DESIGN.md)。

应用数据保存在仓库 `data/` 下，与安装版行为一致；测试和脚本通过 `AWB_USER_DATA` 环境变量隔离用户数据。旧版 `%APPDATA%\agent-workbench` 在首次启动时完整复制迁移到安装目录 `data`，旧目录保留。内部 `window.awb` 接口和旧配置键继续保留。

## 更新图解文档

先阅读当前实现，再用隔离项目录制。命令与动图质量检查见[文档维护说明](https://github.com/FangYang970206/Pello/blob/main/assets/tutorials/README.md)。Wiki 独立 Git 仓库与主仓库 `wiki/` 源文件保持一致，先发布资源再同步 Wiki。不要用未发布的本地图片路径。
