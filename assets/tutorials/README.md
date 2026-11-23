# Pello 功能教学素材

这套素材用于主仓库 README 与 GitHub Wiki。18 类功能各有独立 GIF，画面来自当前 Pello 的实际界面；镜头移动、步骤字幕与进度线在录制后添加，没有重绘应用界面。

动图宽 1120px，先显示操作位置，再平滑聚焦到关键区域，每步停留约 3 秒。点击 README / Wiki 中的动图可打开原尺寸。需要暂停、放大或逐步阅读时，使用 [静帧版](STEPS.md)，点击每张原始 1440×900 截图查看细节。

## 重新录制

在 Windows 上安装项目依赖及 Python Pillow；编码使用系统的 Microsoft YaHei 字体。工具不会安装到用户的 Agent 目录，不发起付费模型请求。

```powershell
npm run build
node scripts/documentation/capture.mjs
node scripts/documentation/capture.mjs --extras
node scripts/documentation/capture.mjs --polish
python scripts/documentation/encode.py
node scripts/documentation-check.mjs
```

基础录制创建独立 `AWB_USER_DATA` 与 `AWB_RESOURCE_HOME`；补充录制从真实 GitHub 仓库扫描并安装一个 Skill 到隔离目录，生成两页示例 PDF，并启动只绑定 `127.0.0.1` 的临时 SSH 服务。SSH 通过真实认证与 PowerShell 查询目录，结束时清理连接及子进程，不访问生产机器。

`manifest.json` 保存步骤文案、原始截图与聚焦位置。截图或步骤增删后，同步更新 `STEPS.md` 和对应 Wiki 页面。每次检查 `output/playwright/documentation/*-review.png` 的实际画面，并完整播放有变化的 GIF；此目录的质量检查截图不提交。

## 演示范围

- MCP 是隔离示例配置，不启动服务器，也不声称完成认证。
- Skill 发现演示真实扫描 `mattpocock/skills` 并安装所选资源，仓库内容与数量随上游改变。
- SSH 动图演示连接后的目录选择流程；上传、网络中断等场景以文字说明与相关回归为准。
- 更新动图来自开发版，明确显示开发模式不检查更新。下载、安装与自动重启不是这段动画的验证范围。
- 自定义执行器演示配置入口，Agent CLI 需用户自行安装与认证。
- 所有动图是教学资料，不代替完整的功能与性能回归报告。

## 同步 Wiki

`wiki/` 是 Wiki 页面的可维护源文件。先发布主仓库图片与动图，再将 `wiki/*.md` 同步到 `Pello.wiki.git` 的默认分支。保留历史页面和旧页面地址，旧入口改为当前功能索引，避免已有链接失效。

介绍结构参考 [WindTerm 功能目录](https://github.com/kingToolbox/WindTerm#features)与[独立操作教程](https://kingtoolbox.github.io/2020/01/22/new-session/)。Pello 的文案与素材独立制作。
