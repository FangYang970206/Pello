import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import postcss from 'postcss'

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export function projectFiles() {
  const files = new Map()
  const read = (dir) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`
      if (entry.isDirectory()) read(rel)
      else if (/\.(tsx?|css)$/.test(entry.name)) files.set(rel, fs.readFileSync(path.join(root, rel), 'utf8'))
    }
  }
  read('src')
  for (const rel of ['package.json', 'AGENTS.md', 'electron-builder.yml', 'electron.vite.config.ts', 'assets/installer.nsh', 'src/renderer/index.html', 'src-tauri/core/src/menu.rs', 'src-tauri/core/src/workbench.rs', 'src-tauri/core/src/pty.rs', 'src-tauri/core/src/i18n.rs', 'src-tauri/core/src/shell.rs', 'src-tauri/core/src/files.rs', 'src-tauri/core/src/git.rs', 'src-tauri/core/src/preview.rs', 'src-tauri/core/src/resources.rs', 'src-tauri/core/src/remote_resources.rs', 'src-tauri/core/src/templates.rs', 'src-tauri/core/src/shells.rs', 'src-tauri/src/lib.rs', 'src-tauri/src/edit.rs', 'src-tauri/core/tests/behavior.rs']) files.set(rel, fs.readFileSync(path.join(root, rel), 'utf8'))
  return files
}

function nodes(node, predicate) {
  const found = []
  if (!node) return found
  const visit = (child) => { if (predicate(child)) found.push(child); ts.forEachChild(child, visit) }
  visit(node)
  return found
}
const called = (node, method) => nodes(node, (item) => ts.isCallExpression(item) &&
  (ts.isPropertyAccessExpression(item.expression) ? item.expression.name.text : item.expression.getText()) === method)
const named = (node, name) => nodes(node, (item) => (ts.isFunctionDeclaration(item) || ts.isMethodDeclaration(item)) && item.name?.getText() === name)[0]
const hasString = (node, value) => nodes(node, (item) => ts.isStringLiteralLike(item) && item.text === value).length > 0
const attr = (node, name) => node.attributes.properties.find((property) => ts.isJsxAttribute(property) && property.name.getText() === name)
const attrText = (node, name) => attr(node, name)?.initializer?.text

export function checkInvariants(files) {
  const errors = []
  const source = (file) => ts.createSourceFile(file, files.get(file) || '', ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const require = (condition, id, file, message) => { if (!condition) errors.push({ id, file, message }) }
  const terminalFile = 'src/renderer/TerminalPane.tsx', terminal = source(terminalFile)
  require(['onData', 'onBinary', 'onResize'].every((name) => called(terminal, name).length), 'AWB001', terminalFile, '终端必须转发普通、二进制输入和尺寸事件')
  const termOptions = nodes(terminal, (node) => ts.isNewExpression(node) && node.expression.getText() === 'Terminal')[0]?.arguments?.[0]
  const property = (name) => termOptions && ts.isObjectLiteralExpression(termOptions) ? termOptions.properties.find((node) => node.name?.getText() === name)?.initializer : null
  require(property('lineHeight')?.getText() === '1' && property('customGlyphs')?.kind === ts.SyntaxKind.TrueKeyword &&
    nodes(terminal, (node) => ts.isNewExpression(node) && node.expression.getText() === 'WebglAddon').length,
  'AWB002', terminalFile, '保留行高 1、自绘线条和图形渲染器')

  const workspaceFile = 'src/renderer/Workspace.tsx', workspace = source(workspaceFile)
  const terms = nodes(workspace, (node) => ts.isVariableDeclaration(node) && node.name.getText() === 'terms')[0]
  const panes = nodes(workspace, (node) => ts.isJsxOpeningElement(node) && attrText(node, 'className') === 'panes')[0]
  let stable = !!panes && !!attr(panes, 'hidden')
  for (let parent = panes?.parent; parent; parent = parent.parent) if (ts.isConditionalExpression(parent) || ts.isBinaryExpression(parent)) stable = false
  require(terms?.initializer?.expression?.expression?.getText() === 'tabs' && stable, 'AWB003', workspaceFile, '全部终端常驻，只按可见性隐藏，不能放进文件/项目条件分支')

  for (const [file, text] of files) {
    if (!file.startsWith('src/renderer/') || !file.endsWith('.tsx')) continue
    const ast = source(file)
    const tags = nodes(ast, (node) => ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))
    require(!tags.some((node) => ['send', 'kill', 'restart', 'split', 'ctrlc'].includes(attrText(node, 'data-a'))), 'AWB004', file, '不恢复终端进程工具栏')
    if (!/SettingsView|Dialogs/.test(file)) require(!tags.some((node) => node.tagName.getText() === 'kbd'), 'AWB004', file, '工作区不显示快捷键徽标')
    require(!nodes(ast, (node) => ts.isImportDeclaration(node) && /^(node:)?(fs|child_process)$|^electron$/.test(node.moduleSpecifier.text)).length,
      'AWB005', file, 'renderer 只能通过受限 preload API 访问文件和系统')
    require(!text.includes('dangerouslySetInnerHTML'), 'AWB005', file, '文档 HTML 不得在 renderer 执行')
  }

  const ptyFile = 'src/main/pty.ts', pty = source(ptyFile), dispose = named(pty, 'dispose'), finishDispose = named(pty, 'finishDispose'), stopTree = named(pty, 'stopProcessTree'), close = named(pty, 'closeSession')
  const awaited = close && nodes(close, (node) => ts.isAwaitExpression(node) && called(node, 'dispose').length)[0]
  require(dispose && stopTree && hasString(stopTree, 'taskkill') && hasString(stopTree, '/T') && hasString(stopTree, '/F') && awaited &&
    called(close, 'delete').some((call) => call.pos > awaited.end), 'AWB006', ptyFile, '关闭必须等待进程树清理完成后再删除会话')
  require(finishDispose && called(finishDispose, 'then').some((call) => call.expression.getText() === 'this.processExit!.then'),
    'AWB006', ptyFile, 'Windows 关闭必须等待原生 PTY 退出回调，不能只等待 taskkill')
  require(hasString(named(pty, 'write'), 'latin1'), 'AWB007', ptyFile, '二进制鼠标输入必须保留字节，不转换为 UTF-8 文本')
  const mainFile = 'src/main/index.ts', main = source(mainFile)
  const windowClose = called(main, 'on').find((call) => call.arguments[0]?.text === 'close' && called(call, 'closeAllSessions').length)
  require(windowClose && called(windowClose, 'finally').some((call) => called(call, 'destroy').length) &&
    called(windowClose, 'destroy').every((call) => call.pos > called(windowClose, 'closeAllSessions')[0].pos), 'AWB008', mainFile, '窗口销毁前完成会话清理；取消退出不清理进程')
  const hostsWrite = nodes(main, (node) => ts.isBinaryExpression(node) && node.left.getText() === 'draft.hosts')[0]
  require(hostsWrite && called(hostsWrite, 'rememberPassword').length && called(hostsWrite, 'publicHost').length, 'AWB009', mainFile, '密码加密保存，普通配置与 IPC 数据使用脱敏 Host')

  const typesFile = 'src/shared/types.ts', types = source(typesFile)
  const presets = nodes(types, (node) => ts.isVariableDeclaration(node) && node.name.getText() === 'PRESETS')[0]
  const ids = presets ? nodes(presets, (node) => ts.isPropertyAssignment(node) && node.name.getText() === 'id').map((node) => node.initializer.text).sort() : []
  require(JSON.stringify(ids) === JSON.stringify(['claude', 'codex', 'omp', 'opencode', 'pi']), 'AWB010', typesFile, '内置预设仅 claude/codex/opencode/pi/omp')
  const gitFile = 'src/main/git.ts', git = source(gitFile), tree = named(git, 'fileTree'), write = named(git, 'writeFile')
  require(tree && !called(tree, 'fileTree').length && !/(-Recurse|-maxdepth|MAX_TREE|depth\s*>)/.test(tree.getText()), 'AWB011', gitFile, '文件树必须逐层加载，不能以深度或全局数量静默截断')
  const versionChecks = write ? nodes(write, (node) => ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken && node.right.getText() === 'version' && called(node.left, 'versionOf').length) : []
  require(write && called(write, 'cleanRelative').length && called(write, 'localPath').length && versionChecks.length >= 2 && called(write, 'renameSync').length &&
    called(write, 'run').some((call) => call.arguments.length === 3), 'AWB012', gitFile, '保存须真实路径校验、版本检查、原子替换；远程载荷走 stdin')
  const rightFile = 'src/renderer/RightPanel.tsx', right = source(rightFile)
  const separator = nodes(right, (node) => ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)).find((node) => attrText(node, 'role') === 'separator')
  require(separator && ['onPointerDown', 'onPointerMove', 'onKeyDown'].every((name) => attr(separator, name)), 'AWB013', rightFile, '保留文件侧栏的鼠标与键盘调宽')
  const documentFile = 'src/renderer/documents.ts', documents = source(documentFile)
  const app = source('src/renderer/App.tsx'), save = named(app, 'saveFile')
  const preservesHistory = save && called(save, 'putDocument').some((call) => {
    const value = call.arguments[1]
    return value && ts.isObjectLiteralExpression(value) && value.properties.some((prop) => ts.isSpreadAssignment(prop) && prop.expression.getText() === 'latest') &&
      value.properties.some((prop) => ts.isSpreadAssignment(prop) && prop.expression.getText() === 'saved')
  })
  require(named(documents, 'recordChange') && named(documents, 'undoDocument') && named(documents, 'fileText')?.getText().includes('\\ufeff') && preservesHistory,
    'AWB014', documentFile, '草稿层保留撤销重做历史、BOM 和换行；保存合并历史，不能重建草稿')
  const ssh = source('src/main/ssh.ts'), connect = named(ssh, 'connectPasswordHost')
  require(connect && nodes(connect, (node) => ts.isPropertyAssignment(node) && node.name.getText() === 'hostVerifier').length && hasString(connect, 'sha256'),
    'AWB020', 'src/main/ssh.ts', '密码认证必须校验并固定主机指纹')
  const preview = source('src/main/preview.ts')
  require(called(preview, 'listen').some((call) => call.arguments[1]?.text === '127.0.0.1') && called(preview, 'readAsset').length &&
    called(preview, 'openExternal').every((call) => call.arguments[0]?.getText() === 'url'), 'AWB021', 'src/main/preview.ts', '浏览器预览限本机、项目资源与受控 URL')
  require(save && called(save, 'has').some((call) => call.expression.getText() === 'savingDocuments.current.has' && call.arguments[0]?.getText() === 'key') &&
    called(save, 'add').length && called(save, 'delete').length, 'AWB022', 'src/renderer/App.tsx', '按文件串行保存，写入期间的新草稿与保存失败状态必须保留')
  const markdown = source('src/renderer/MarkdownEditor.tsx')
  require(nodes(markdown, (node) => ts.isNewExpression(node) && node.expression.getText() === 'Plugin').length &&
    nodes(markdown, (node) => ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken && node.operand.getText() === 'interacted.current').length,
    'AWB023', 'src/renderer/MarkdownEditor.tsx', '同步捕获富文本变更；打开文档不能触发重写')
  const openHtml = named(preview, 'openHtmlPreview')
  require(openHtml && nodes(openHtml, (node) => ts.isRegularExpressionLiteral(node) && node.text.includes('html?')).length && called(openHtml, 'previewUrl').length,
    'AWB024', 'src/main/preview.ts', '浏览器入口必须验证 HTML 扩展名并使用受控预览 URL')
  const delay = nodes(documents, (node) => ts.isVariableDeclaration(node) && node.name.getText() === 'AUTO_SAVE_DELAY')[0]
  require(delay?.initializer && Number(delay.initializer.getText().replaceAll('_', '')) === 120000,
    'AWB025', documentFile, '自动保存按文件防抖 2 分钟')
  const filePane = source('src/renderer/FilePane.tsx')
  const iframe = nodes(filePane, (node) => ts.isJsxSelfClosingElement(node) && node.tagName.getText() === 'iframe')[0]
  require(iframe && attrText(iframe, 'sandbox') === 'allow-scripts' && called(filePane, 'documentMenu').length,
    'AWB026', 'src/renderer/FilePane.tsx', '内嵌 HTML 保留 sandbox 隔离与右键源码入口')
  const resourcesFile = 'src/renderer/ResourceSettings.tsx', resources = source(resourcesFile)
  const resourceRow = nodes(resources, (node) => ts.isJsxOpeningElement(node) && attrText(node, 'className') === 'srow resource-item')[0]?.parent
  require(resourceRow && ts.isJsxElement(resourceRow) && !resourceRow.children.some((child) => /item\.(path|description|transport)/.test(child.getText())) && called(resources, 'resourceToggle').length,
    'AWB027', resourcesFile, '资源列表保持名称、详情与真实配置开关，路径和说明放入详情')
  const resourceDialogFile = 'src/renderer/ResourceDialog.tsx', resourceDialog = source(resourceDialogFile)
  require(called(resourceDialog, 'showModal').length && nodes(resourceDialog, (node) => ts.isJsxOpeningElement(node) && node.tagName.getText() === 'dialog' && attr(node, 'onCancel') && attr(node, 'onPointerUp')).length,
    'AWB028', resourceDialogFile, '资源配置弹窗必须约束焦点、处理 Esc 与详情遮罩关闭')
  const resourceMain = source('src/main/resources.ts')
  require(called(named(resourceMain, 'skillDirectory'), 'listed').length && called(main, 'trashItem').some((call) => called(call, 'skillDirectory').some((check) => check.arguments.at(-1)?.kind === ts.SyntaxKind.TrueKeyword)),
    'AWB033', 'src/main/index.ts', 'Skill 删除必须在主进程校验实际发现目录并移入系统回收站')
  require(called(terminal, 'load').some((call) => call.expression.getText() === 'document.fonts.load') && nodes(terminal, (node) => ts.isBinaryExpression(node) && node.left.getText() === 'term.options.fontFamily').length,
    'AWB029', terminalFile, '字体加载后更新现有终端字体，不能重建会话')
  require(iframe && attr(iframe, 'key')?.initializer?.getText() === '{preview.url}' && files.get('src/renderer/FilePane.tsx')?.includes('preview.content === document.draft'),
    'AWB030', 'src/renderer/FilePane.tsx', 'HTML 框架必须匹配当前草稿，并按预览 URL 更新')
  const platform = source('src/main/platform.ts')
  require(named(platform, 'bashRc')?.getText().includes('. "$HOME/.bashrc"') && called(named(platform, 'remoteBootstrap'), 'bashRc').length,
    'AWB031', 'src/main/platform.ts', '本地和远程托管 Bash 必须先加载用户环境，再安装工作台提示标记')
  require(['runPasswordCommand', 'passwordTerminal'].every((name) => {
    const decoders = called(named(ssh, name), 'setEncoding').filter((call) => call.arguments[0]?.text === 'utf8')
    return ['stream.setEncoding', 'stream.stderr.setEncoding'].every((method) => decoders.some((call) => call.expression.getText() === method))
  }), 'AWB032', 'src/main/ssh.ts', 'SSH 命令及终端的 stdout/stderr 必须分别连续解码 UTF-8')

  const cssFiles = ['src/renderer/styles/workbench.css', 'src/renderer/styles/extra.css']
  require(files.get(workspaceFile)?.includes('sessionOf(tab) === sessionId'), 'AWB034', workspaceFile, '标签按当前会话过滤，终端实例仍须全部常驻')
  require(files.get('src/renderer/styles/extra.css')?.includes('animation:terminal-spin .85s linear infinite') && files.get('src/renderer/terminal-state.ts')?.includes("tab.state === 'running' && !tab.inputReady"), 'AWB035', 'src/renderer/styles/extra.css', '只有执行中的终端旋转，等待输入时停止')
  require(files.get(ptyFile)?.includes('this.programStatus.push(chunk)') && files.get(ptyFile)?.includes("this.phase === 'prompt' || this.programWaiting"), 'AWB036', ptyFile, 'Agent 状态接入原生协议，不能只根据 CLI 进程存在或输出静默推断运行')
  require(!named(pty, 'write')?.getText().includes('this.programWaiting = false') && files.get(ptyFile)?.includes("report.protocol === 'progress' && this.nativeStatus") && files.get(ptyFile)?.includes("PI_PROGRAM_STATUS: '1'"), 'AWB039', ptyFile, '回车不能伪造请求状态，原生程序状态优先于任务栏进度，Pi 显式开启原生报告')
  require(files.get('src/renderer/terminal-layout.ts')?.includes('tiles.length >= 4') && files.get('src/renderer/terminal-layout.ts')?.includes('tile.x + tile.width > 2') && files.get('src/renderer/ProjectSidebar.tsx')?.includes("term.state === 'running'") && files.get('src/renderer/ProjectSidebar.tsx')?.includes('activeAgentKind(term)'), 'AWB040', workspaceFile, '终端最多显示四个象限，Agents 排除纯 Shell 和已退出进程')
  require(files.get('src/main/temporary-sessions.ts')?.includes('path.isAbsolute(configured)') && files.get('src/main/temporary-sessions.ts')?.includes('const id = randomUUID()') && files.get('src/main/temporary-sessions.ts')?.includes("path.join(directory, 'AGENTS.md')") && files.get('src/main/temporary-sessions.ts')?.includes("flag: 'wx'"), 'AWB041', 'src/main/temporary-sessions.ts', '临时目录必须绝对化，在随机 UUID 目录独占创建 AGENTS.md')
  require(files.get(workspaceFile)?.includes('visible={workspaceVisible && visible}') && files.get('src/renderer/App.tsx')?.includes("workspaceVisible={route === 'work'}") && files.get(terminalFile)?.includes('scrollToLine(saved.viewport)') && called(source(terminalFile), 'useLayoutEffect').length, 'AWB042', terminalFile, '设置/文件隐藏终端前保存视口，恢复时区分底部跟随和用户历史滚动，不重建实例')
  const openFile = named(app, 'openFile')
  require(openFile && called(openFile, 'uid').length && !called(openFile, 'setDocuments').length && !openFile.getText().includes('pinned') && !files.get(workspaceFile)?.includes('tab.preview'), 'AWB043', 'src/renderer/App.tsx', '单击文件创建或定位独立标签，不能复用预览标签或删除其他文件的草稿')
  require(files.get('src/renderer/styles/markdown.css')?.includes('.markdown-outline{position:absolute;') && files.get('src/renderer/MarkdownEditor.tsx')?.includes('data-compact={compact}') && !files.get('src/renderer/ProjectSidebar.tsx')?.includes('onCreateEntry') && files.get('src/renderer/ProjectSidebar.tsx')?.includes("onProjectAction(project.id, 'reveal')"), 'AWB044', 'src/renderer/MarkdownEditor.tsx', '目录悬浮正文左侧且适配窄内容区；项目菜单仅提供项目操作，文件创建留在文件树')
  require(markdown.getText().includes('view.nodeDOM(position)') && !/\bnode\.id\s*=/.test(markdown.getText()) && files.get('src/renderer/markdown-code-layout.ts')?.includes("'--pello-code-height'") && files.get('src/renderer/styles/markdown.css')?.includes('height:var(--pello-code-height,auto)') && files.get('src/renderer/styles/markdown.css')?.includes('.cm-activeLine{background:transparent}'), 'AWB045', 'src/renderer/MarkdownEditor.tsx', '目录从编辑器模型定位，不能改写 DOM ID；代码虚拟化保留高度，代码行底色一致')
  require(files.get('src/renderer/App.tsx')?.includes('prependTermHistory(id, entry.text)') && files.get('src/renderer/App.tsx')?.includes('if (existingId)') && files.get('src/renderer/App.tsx')?.includes('无法恢复会话') && files.get('src/renderer/App.tsx')?.includes('window.awb.terminalHistory(id)'),
    'AWB050', 'src/renderer/App.tsx', '启动恢复须回放终端历史；本机或远程恢复失败保留会话、提示错误并提供重新连接')
  require(files.get('src/main/terminal-history.ts')?.includes('export function saveTerminalHistory') && files.get('src/renderer/terms.ts')?.includes('window.awb.saveTerminalHistory(id, text)') && files.get('src/main/index.ts')?.includes('pruneTerminalHistory(Object.values(db().sessions)') && files.get('src/main/index.ts')?.includes('deleteTerminalHistory(id)'),
    'AWB051', 'src/main/terminal-history.ts', '终端输出按会话持久化，启动清理失效记录，显式关闭标签时删除对应历史')
  require(files.get('src/main/index.ts')?.includes("if (!node.name.startsWith('.')) search.pending.push(node.path)") && files.get('src/renderer/FileSearchSettings.tsx')?.includes('以 . 开头的文件夹始终跳过'),
    'AWB052', 'src/main/index.ts', '文件搜索始终跳过以点开头的目录，并在设置中说明')
  require(files.get('src/renderer/RightPanel.tsx')?.includes('seg plain-seg') && files.get('src/renderer/RightPanel.tsx')?.includes('mode-cluster') && files.get('src/renderer/RightPanel.tsx')?.includes('data-a="file-search"') && files.get('src/renderer/RightPanel.tsx')?.includes('<Icon name="search"') && !/>\s*文件\s*<\/button>/.test(files.get('src/renderer/RightPanel.tsx') || '') && !files.get('src/renderer/RightPanel.tsx')?.includes("{mode === 'files' ? <button") && !files.get('src/renderer/RightPanel.tsx')?.includes('files.length ? <span className="c">') && files.get('src/renderer/icons.tsx')?.includes('changes: \'M15 18a3 3 0 1 0 6 0'),
    'AWB053', 'src/renderer/RightPanel.tsx', '文件、变更和内容搜索使用无边框图标入口且搜索紧邻变更；变更为 Git 变更图标且不显示数量')
  require(files.get('src/renderer/ProjectSidebar.tsx')?.includes('Number(!!b.project.pinned) - Number(!!a.project.pinned)') && hasString(source('src/renderer/ProjectSidebar.tsx'), '取消置顶') && hasString(source('src/renderer/ProjectSidebar.tsx'), '置顶项目') && files.get('src/main/store.ts')?.includes('project.pinned === true'),
    'AWB054', 'src/renderer/ProjectSidebar.tsx', '置顶项目排在最前、可从项目菜单切换并在重启后保留')
  require(files.get('src/main/pty.ts')?.includes('windowsDescendants(roots)') && files.get('src/main/pty.ts')?.includes('session.disposeRoot()') && files.get('src/main/pty.ts')?.includes('proc.kill()'),
    'AWB055', 'src/main/pty.ts', '退出时先按进程快照叶子优先结束子孙，再串行结束根进程并等待原生退出，避免 taskkill 与 ConPTY 并发析构')
  const diagramRenderer = files.get('src/main/diagram-renderer.ts') || ''
  const sidebarText = files.get('src/renderer/ProjectSidebar.tsx') || ''
  require(!sidebarText.includes('<Icon name="more"') && sidebarText.includes("contextMenu('agents-filter')") && sidebarText.includes("event.key === 'ContextMenu'") && sidebarText.includes("event.shiftKey && event.key === 'F10'") && !sidebarText.includes('<Icon name="folder" className="s" />') && files.get('src/shared/locales/en.ts')?.includes('"临时会话": "TempSessions"'),
    'AWB064', 'src/renderer/ProjectSidebar.tsx', '侧栏无三个点，项目、会话及 Agents 菜单保留右键和键盘入口；临时分组无文件夹图标且英文为 TempSessions')
  require(diagramRenderer.includes('show: false') && diagramRenderer.includes('sandbox: true') && diagramRenderer.includes('nodeIntegration: false') && diagramRenderer.includes('source.length > 100_000') && diagramRenderer.includes('cancelDiagramRenderer') && files.get('src/renderer/diagram-renderer.ts')?.includes("securityLevel: 'strict'") && !files.get('src/renderer/diagram-preview.ts')?.includes("import('mermaid')") && files.get('src/main/index.ts')?.includes('disposeDiagramRenderer()'), 'AWB046', 'src/main/diagram-renderer.ts', 'Mermaid 在独立隐藏沙箱渲染，限制输入与缓存，关闭时清理；不得阻塞工作台渲染线程')
  const declarations = (selector) => {
    const values = new Map()
    for (const file of cssFiles) postcss.parse(files.get(file) || '').walkRules((rule) => {
      if (rule.selector === selector) rule.walkDecls((decl) => values.set(decl.prop, decl.value))
    })
    return values
  }
  const host = declarations('.termhost'), frame = declarations('.termframe')
  require(host.get('overflow') === 'clip', 'AWB047', cssFiles[1], '终端外框禁止程序滚动，防止中文输入法显示光标时横移裁掉内容')
  require(files.get(ptyFile)?.includes("PI_HARDWARE_CURSOR: '1'"), 'AWB048', ptyFile, 'Windows 使用 Pi 原生硬件光标定位输入法，不能让拼音固定在最右侧')
  require(called(main, 'windowsTaskbarIcon').length && files.get('src/main/app-icon.ts')?.includes("createHash('sha256')"), 'AWB049', mainFile, 'Windows 原生窗口与任务栏使用内容寻址的图标路径，避免旧路径缓存')
  require(![...host].some(([key, value]) => key.startsWith('padding') && !/^0(?:px)?$/.test(value)) && frame.get('position') === 'absolute' && !frame.has('padding'),
    'AWB015', cssFiles[1], 'fit 父节点无 padding，终端边距由外框 inset 提供')
  require(declarations('.tabs').get('flex')?.startsWith('0 ') && declarations('.tabtools').get('align-self') === 'flex-end' && declarations('.tabtools').get('margin-bottom') === '0',
    'AWB016', cssFiles[0], '加号紧贴标签并底部对齐')
  require(declarations('.dot.terminal-status.busy').get('background') === 'var(--amber)' && declarations('.dot.terminal-status.ready').get('background') === 'var(--green)',
    'AWB017', cssFiles[0], '运行黄点、可输入绿点，不与连接状态混用')
  const scripts = JSON.parse(files.get('package.json') || '{}').scripts || {}
  require(nodes(named(main, 'startRemoteUpload'), (node) => ts.isPropertyAssignment(node) && node.name.getText() === 'automatic' && node.initializer.getText() === '!keepBoth').length && called(source('src/main/remote-file.ts'), 'publishRemoteStage').length,
    'AWB037', mainFile, '远程上传默认自动覆盖，同名目录经临时上传完成后整体替换')
  const uploadFile = 'src/renderer/UploadStatus.tsx', upload = source(uploadFile)
  const uploadTags = nodes(upload, (node) => ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))
  require(!nodes(upload, (node) => ts.isPropertyAccessExpression(node) && ['task.current', 'task.destination', 'task.overallBytes', 'task.overallTotal'].includes(node.getText())).length && !uploadTags.some((node) => node.tagName.getText() === 'progress') && hasString(upload, '上传中') && hasString(upload, '上传成功') && called(upload, 'transferCancel').length &&
    nodes(upload, (node) => ts.isVariableDeclaration(node) && node.name.getText() === 'TRANSFER_SUCCESS_DURATION' && node.initializer?.getText() === '2000').length &&
    called(app, 'setTimeout').some((call) => call.arguments[1]?.getText() === 'TRANSFER_SUCCESS_DURATION') && named(upload, 'transferSucceeded')?.getText().includes('!task.warnings?.length') && called(named(upload, 'transferSucceeded'), 'every').length,
  'AWB038', uploadFile, '上传只显示状态与取消，全部成功且无警告才在 2 秒后移除，不能恢复路径或进度明细')
  require(uploadTags.some((node) => node.tagName.getText() === 'FileOperationDialog') && hasString(upload, '传输详情') && hasString(upload, 'transfer-error-details') && !hasString(upload, 'transfer-details') && hasString(upload, 'dialog'),
    'AWB104', uploadFile, '传输错误详情使用居中模态弹窗与关闭、焦点恢复，不在右下角提示内展开')
  require(['review', 'windows-icon', 'shell-profile', 'terminal', 'terminal-shutdown', 'session-restore', 'ssh-password', 'remote-terminal', 'render', 'workspace', 'multi-repo', 'program-status', 'sidebar', 'editor', 'design', 'appearance', 'resources', 'resource-import', 'resource-import-ui', 'opencode-mcp', 'host-management', 'directory-browser', 'autosave', 'resources-ui', 'resource-dialog', 'html-preview'].every((name) => scripts.check?.includes(`scripts/${name}-check.mjs`)) && scripts.check?.includes('npm run check:shells') && scripts['check:shells']?.includes('scripts/local-shells-check.mjs'),
    'AWB018', 'package.json', '保留已有行为回归入口，不能删检查来绕过失败')
  require(files.get('AGENTS.md')?.includes('npm run lint') && files.get('AGENTS.md')?.includes('npm run check'), 'AWB019', 'AGENTS.md', '项目规则必须注明静态与行为验证入口')
  require(scripts['check:files']?.includes('scripts/upload-replace-check.mjs') && scripts['check:files']?.includes('scripts/upload-status-check.mjs'), 'AWB018', 'package.json', '保留上传整体替换、草稿和简洁状态的实际行为回归')
  require(scripts.check?.includes('scripts/reading-workspace-check.mjs') && scripts.check?.includes('scripts/terminal-layout-check.mjs'), 'AWB018', 'package.json', '保留文档高亮、导航、图表与临时会话、分栏、状态和侧栏行为回归')
  require(scripts.check?.includes('scripts/document-performance-check.mjs'), 'AWB018', 'package.json', '保留大文档编辑、目录跳转、代码虚拟化高度和图表进程隔离回归')
  require(scripts.check?.includes('scripts/terminal-input-check.mjs'), 'AWB018', 'package.json', '保留输入法组合、确认、取消和终端几何稳定性回归')
  require(files.get('src/renderer/SplitDiffEditor.tsx')?.includes("revertControls: 'a-to-b'") && files.get('src/renderer/SplitDiffEditor.tsx')?.includes('target.scrollDOM.scrollTop = source.scrollDOM.scrollTop') && files.get('src/renderer/SplitDiffEditor.tsx')?.includes('target.scrollDOM.scrollLeft = source.scrollDOM.scrollLeft') && files.get('src/renderer/SplitDiffEditor.tsx')?.includes('setPointerCapture(event.pointerId)') && scripts.check?.includes('scripts/diff-editor-check.mjs'),
    'AWB056', 'src/renderer/SplitDiffEditor.tsx', '并排差异支持双侧编辑、双轴滚动联动、分块还原和可拖动分隔线，保留行为用例')
  require(files.get('src/main/agent-resume.ts')?.includes('--session-dir ${directory} --continue') && files.get('src/main/pty.ts')?.includes('createCodexThread(this.cwd') && files.get('src/main/terminal-history.ts')?.includes('fs.appendFileSync') && !files.get('src/main/terminal-history.ts')?.includes('MAX_BYTES') && scripts.check?.includes('scripts/agent-resume-check.mjs'),
    'AWB057', 'src/main/agent-resume.ts', 'Agent 恢复绑定终端原生会话，不回退到项目最近会话；终端记录不静默截断')
  require(files.get('src/renderer/terms.ts')?.includes('serializer.serialize({ scrollback: 0 })') && files.get('src/main/index.ts')?.includes('flushRendererHistory(closing).then('),
    'AWB058', 'src/renderer/terms.ts', '历史回放保留当前终端画面和光标；退出等待渲染队列快照落盘')
  require(files.get('src/main/legacy-agent-session.ts')?.includes('other.candidate.id !== candidate.id') && files.get('src/main/legacy-agent-session.ts')?.includes('size === 1') && files.get('src/main/pty.ts')?.includes('if (!match) throw new Error'),
    'AWB059', 'src/main/legacy-agent-session.ts', '旧记录只能按独有消息绑定原生对话，不猜测最近会话或静默创建空白对话')
  const sidebar = files.get('src/renderer/ProjectSidebar.tsx') || ''
  require(sidebar.includes('projects.filter((project) => !project.temporary)') && sidebar.includes('className="temporary-group"') && sidebar.includes('data-a="temporary-toggle"') && sidebar.includes('props.onNewTemporary()') && files.get('src/main/temporary-sessions.ts')?.includes('path.join(base, id)'),
    'AWB060', 'src/renderer/ProjectSidebar.tsx', '临时会话独立归组并保留各自工作目录；新增终端沿用会话目录')
  require(files.get('src/main/store.ts')?.includes("language: settings.language === 'en' ? 'en' : 'zh-CN'") && called(main, 'saveSettings').length && files.get('src/renderer/App.tsx')?.includes('useSyncExternalStore(subscribeLanguage, getLanguage)') && !files.get('src/renderer/App.tsx')?.includes('key={language}') && files.get('src/shared/i18n.ts')?.includes('String(values[Number(index)])') && !called(named(source('src/shared/i18n.ts'), 't'), 't').length && scripts.check?.includes('scripts/i18n-check.mjs'),
    'AWB061', 'src/shared/i18n.ts', '中英文配置持久化，共享翻译保留插值，切换不重建工作区并保留行为回归')
  require(files.get('src/main/index.ts')?.startsWith("import './app-paths'") && files.get('src/main/app-paths.ts')?.includes("path.join(installationDirectory, 'data')") && files.get('src/main/app-paths.ts')?.includes("app.setPath('sessionData', dataDirectory)") && files.get('src/main/data-directory.ts')?.includes('fs.renameSync(staged, directory)') && files.get('assets/installer.nsh')?.includes('${AndIf} $R1 != "data"') && files.get('assets/installer.nsh')?.includes('${AndIf} $R1 != "pello.config.json"'),
    'AWB062', 'src/main/app-paths.ts', '启动前配置安装目录数据及缓存，完整迁移并在升级和卸载时保留')
  require(files.get('src/main/app-updates.ts')?.includes('driver.autoDownload = false') && files.get('src/main/app-updates.ts')?.includes('driver.autoInstallOnAppQuit = false') && files.get('src/main/app-updates.ts')?.includes('driver.installDirectory = installationDirectory') && files.get('src/main/index.ts')?.includes("'app:update-install': () => appUpdates.install(async () =>") && files.get('electron-builder.yml')?.includes('provider: github') && scripts.check?.includes('scripts/app-update-check.mjs'),
    'AWB063', 'src/main/app-updates.ts', '更新必须显式下载与安装，安装前复用关闭流程，保留更新行为回归')
  require(files.get('src/main/store.ts')?.includes('autoCheckUpdates: asBool(settings.autoCheckUpdates, true)') && files.get('src/main/index.ts')?.includes('automaticUpdates.setEnabled(next.settings.autoCheckUpdates)') && files.get('src/main/index.ts')?.includes('automaticUpdates.setEnabled(db().settings.autoCheckUpdates)') && files.get('src/main/update-scheduler.ts')?.includes('this.timers.clearTimeout(this.startup)') && files.get('src/main/update-scheduler.ts')?.includes('this.timers.clearInterval(this.interval)') && !files.get('src/renderer/App.tsx')?.includes('<AppUpdate') && files.get('src/renderer/SettingsView.tsx')?.includes('<AppUpdate settings={settings} onSettings={onSettings} />'),
    'AWB064', 'src/renderer/AppUpdate.tsx', '更新只在通用栏目操作，自动检测默认开启、保存后调整定时器并支持关闭')
  const controlsCss = files.get('src/renderer/styles/workbench.css') || ''
  require(!files.get('src/renderer/App.tsx')?.includes('className="newp"') && !files.get('src/renderer/Workspace.tsx')?.includes('data-a="newproj"') && sidebar.includes('data-a="newproj"') && sidebar.includes('props.onNewProject()') && controlsCss.includes('.proj:has(:focus-visible) .project-add') && controlsCss.includes('.sidebar-section-heading:hover .sidebar-add') && controlsCss.includes('.tabbar:hover .tabtools [data-a=newterm]') && scripts.check?.includes('scripts/ui-affordance-check.mjs'),
    'AWB065', 'src/renderer/ProjectSidebar.tsx', '项目标题统一添加项目；加号按行悬停与键盘焦点显示，保留行为回归')
  require(files.get('src/main/store.ts')?.includes("theme: 'light'") && files.get('src/renderer/index.html')?.includes('data-theme="light"') && controlsCss.includes('font:calc(var(--fs,13px) * var(--content-zoom,1))/1.7 var(--mono)') && files.get('src/renderer/icons.tsx')?.includes("fill={name === 'more' ? 'currentColor' : undefined}"),
    'AWB066', 'src/main/store.ts', '默认浅色，Diff 双栏实时沿用终端字号，更多菜单使用实心图标')
  const sidebarCss = files.get('src/renderer/styles/extra.css') || ''
  require(sidebar.includes('sidebar-heading-label') && sidebar.includes('sidebar-disclosure') && hasString(source('src/renderer/ProjectSidebar.tsx'), '最近') && sidebar.includes("collapsed[project.id] ? 'folder' : 'folder-open'") && sidebarCss.includes('.sidebar-section-heading > [aria-expanded=true] .sidebar-disclosure { opacity:0; }') && sidebarCss.includes('.sidebar-disclosure { flex:none; pointer-events:none; }') && !sidebarCss.includes('white-space:nowrap; padding-right:34px;'),
    'AWB067', 'src/renderer/ProjectSidebar.tsx', '折叠箭头紧邻分组文字，展开时按悬停与焦点显示、折叠常驻；加号不受折叠影响')
  const media = files.get('src/renderer/MediaPreview.tsx') || ''
  require(files.get('src/renderer/FilePane.tsx')?.includes('<MediaPreview') && media.includes('task?.destroy()') && files.get('electron.vite.config.ts')?.includes('bundled-pdf-assets') && scripts.check?.includes('scripts/media-preview-check.mjs'),
    'AWB068', 'src/renderer/MediaPreview.tsx', '媒体在文件标签中预览，PDF 资源离线分发，离开时释放任务并保留行为回归')
  const picker = files.get('src/renderer/DirectoryBrowser.tsx') || ''
  require(picker.includes('<ResourceDialog') && picker.includes('onDoubleClick=') && files.get('src/renderer/Dialogs.tsx')?.includes("if (document.querySelector('dialog[open]')) return") && scripts.check?.includes('scripts/directory-browser-check.mjs'),
    'AWB069', 'src/renderer/DirectoryBrowser.tsx', '远程目录浏览使用独立模态窗口，双击进入，外层焦点约束让位给选择器')
  require(media.includes('usePreviewWheel(viewport') && media.includes('target.scrollTop + target.clientHeight') && files.get('src/renderer/usePreviewWheel.ts')?.includes('passive: false') && files.get('src/renderer/FilePane.tsx')?.includes('useContentZoom()') && files.get('src/renderer/DiffPane.tsx')?.includes('useContentZoom()') && scripts.check?.includes('scripts/preview-wheel-check.mjs'),
    'AWB070', 'src/renderer/usePreviewWheel.ts', 'PDF 滚轮在页面边缘翻页，媒体、文件及 Diff 支持局部 Ctrl+滚轮缩放并保留行为回归')
  const search = files.get('src/renderer/DocumentSearch.tsx') || ''
  const workspaceText = files.get(workspaceFile) || ''
  const groupTabs = files.get('src/renderer/WorkspaceTabs.tsx') || ''
  // The splits a pane offers are listed by the kernel, in the Rust build, as
  // the Electron build's main process listed them: one list for a document's menu and a pane's.
  const kernelMenu = files.get('src-tauri/core/src/menu.rs') || ''
  const i18nTable = files.get('src-tauri/core/src/i18n.rs') || ''
  const layoutItems = kernelMenu.includes('fn layout_menu_items(') && /fn file_menu[\s\S]*?template\.extend\(layout_menu_items\(language, &options\["layout"\]\)\)/.test(kernelMenu) && /fn pane_menu[\s\S]*?items\.extend\(layout_menu_items\(language, options\)\)/.test(kernelMenu)
  require(workspaceText.includes('[...terms, ...mine.filter') && workspaceText.includes('documents[key]') && workspaceText.includes('diffs[key]') && workspaceText.includes('onBaseline(tab.id, text)') && workspaceText.includes('reconcileGroups(') && workspaceText.includes('tabs={group.tabs.map((id) => tabById.get(id)!)}') && groupTabs.includes('tabs.map((tab)') && !workspaceText.includes('pane-caption') && declarations('.panes').get('display') === 'grid' && search.includes("closest('.pane:not(.focus)')") && layoutItems && scripts.check?.includes('scripts/workspace-split-check.mjs') && scripts.check?.includes('scripts/editor-groups-check.mjs'),
    'AWB077', workspaceFile, '终端、文件与 Diff 统一分栏，按内容管理草稿与比较基准，查找只接管当前栏并保留混合分栏回归')
  require(files.get('src/renderer/MarkdownEditor.tsx')?.includes('revealSearchRect(scroller') && scripts.check?.includes('scripts/search-navigation-check.mjs'),
    'AWB072', 'src/renderer/MarkdownEditor.tsx', '查找和上下导航定位实际匹配文字，使用所属视口并保留长文档及虚拟代码块回归')
  require(search.includes('useDocumentSearch') && search.includes('event.isComposing') && sidebarCss.includes('.document-search { position: absolute;') && sidebarCss.includes('.editor-surface { position: relative;') && files.get('src/renderer/MarkdownEditor.tsx')?.includes('tr.insertText(value, position(match.from)') && files.get('src/renderer/SettingsView.tsx')?.includes("'Ctrl F'") && !media.includes('正在加载预览') && !files.get('src/renderer/FilePane.tsx')?.includes('正在加载预览') && scripts.check?.includes('scripts/document-search-check.mjs'),
    'AWB071', 'src/renderer/DocumentSearch.tsx', '搜索替换悬浮在编辑器内且保留行为回归，Markdown 通过模型替换，快捷键列入设置，预览不显示加载文字')
  const containers = postcss.parse(sidebarCss).nodes.filter((node) => node.type === 'atrule' && node.name === 'container')
  const contentSearch = files.get('src/main/content-search.ts') || ''
  require(contentSearch.includes('class ContentSearch') && contentSearch.includes('this.controller.abort()') && contentSearch.includes('treePath(target, rel)') && contentSearch.includes("!entry.name.startsWith('.')") && files.get('src/main/content-search-scripts.ts')?.includes('os.O_NOFOLLOW') && files.get('src/renderer/RightPanel.tsx')?.includes('file-name-search') && files.get('src/renderer/RightPanel.tsx')?.includes('project-search-options') && !files.get('src/renderer/RightPanel.tsx')?.includes('project-search-modes') && files.get('src/renderer/ContentSearchResults.tsx')?.includes('contentSearchCancel(id)') && files.get('src/renderer/FilePane.tsx')?.includes('field.setSelectionRange(match.from, match.to)') && files.get('AGENTS.md')?.includes('项目搜索') && scripts.check?.includes('scripts/content-search-check.mjs'),
    'AWB074', 'src/main/content-search.ts', '文件页常驻名称搜索，内容搜索独立并提供框内选项；沿用边界、取消与定位回归')
  require(files.get('src/main/search-matcher.ts')?.includes('new Worker(') && files.get('src/main/search-matcher.ts')?.includes('}, 500)') && files.get('src/renderer/App.tsx')?.includes('onSearchKey') && files.get('src/renderer/App.tsx')?.includes('event.isComposing') && files.get('src/renderer/SettingsView.tsx')?.includes("'Ctrl E'") && files.get('src/renderer/SettingsView.tsx')?.includes("'Ctrl Shift F'"),
    'AWB075', 'src/main/search-matcher.ts', '正则在可终止 Worker 中限时执行，两个项目搜索快捷键同步列入设置并跳过输入法组合')
  const resultView = files.get('src/renderer/ContentSearchResults.tsx') || ''
  require(!resultView.includes('content-search-count') && !resultView.includes('content-search-line') && !resultView.includes('state.skipped ?') && !resultView.includes('分布于') && declarations('.file-name-search .tx').get('height') === '24px' && declarations('.project-search-input input').get('height') === '24px' && declarations('.content-search-hit').get('font') === 'inherit' && declarations('.content-search-hit mark').get('font') === 'inherit' && !declarations('.content-search-hit mark').has('font-weight'),
    'AWB076', 'src/renderer/ContentSearchResults.tsx', '搜索输入框保持紧凑，结果不显示跳过统计、文件分布、行号或文件内匹配数')
  require(declarations('.editor-surface').get('container') === 'editor / inline-size' && /width:\s*clamp\([^;]*cqi/.test(sidebarCss) && containers.some((node) => node.params.startsWith('editor ')) && containers.some((node) => node.params.startsWith('media ')) && declarations('.media-zoom').get('flex-wrap') === 'wrap' && files.get('AGENTS.md')?.includes('日常自适应检查'),
    'AWB073', 'src/renderer/styles/extra.css', '搜索按实际编辑区宽度收窄，媒体工具栏允许换行，窄容器检查纳入日常开发约定')
  // A menu's editing items are roles, as the Electron build's are: the kernel
  // says which each is, the shell carries it out on the page's focused control
  // and returns nothing of it to the page, and the preview's menu is the
  // kernel's own template.
  const shellLib = files.get('src-tauri/src/lib.rs') || ''
  const shellEdit = files.get('src-tauri/src/edit.rs') || ''
  require(kernelMenu.includes('let role = |id: &str, label: &str, on: bool| json!({ "id": id, "label": said(label), "enabled": on, "edit": id });') && ['cut', 'copy', 'paste', 'pasteAndMatchStyle', 'selectAll'].every((id) => kernelMenu.includes('role("' + id + '", ')) && /fn preview_menu[\s\S]*?role\("copy", "复制"\),/.test(kernelMenu) && files.get('src-tauri/core/src/workbench.rs')?.includes('"menu:preview" => Ok(menu::preview_menu(&language))'),
    'AWB078', 'src-tauri/core/src/menu.rs', '文档菜单的剪切、复制、粘贴、粘贴为纯文本与全选是 role，预览菜单由内核提供模板')
  require(shellLib.includes('if edit::is_role(&edit) { edit::run(window, &edit); return Value::Null }') && shellLib.includes('Ok(if menu_choice_enabled(template, &choice) { chosen(window, template, &choice) } else { Value::Null })') && shellEdit.includes(String.raw`"pasteAndMatchStyle" => Some((b'V', true))`) && shellEdit.includes('Input.dispatchKeyEvent') && !shellEdit.includes('document.execCommand') && scripts.check?.includes('scripts/edit-roles-check.mjs'),
    'AWB078', 'src-tauri/src/edit.rs', '编辑 role 由外壳在页面焦点控件上执行且不返回页面，保留行为回归')
  // Testing an executor runs its command in a terminal of its own, in the
  // shell it is written for and with the executor's environment: the page
  // is told nothing of that terminal and it leaves no history. What is
  // asked of a terminal while the workbench closes is ignored, and closing
  // a terminal deletes its history.
  const kernel = files.get('src-tauri/core/src/workbench.rs') || ''
  const kernelPty = files.get('src-tauri/core/src/pty.rs') || ''
  require(kernel.includes('const TEST_KIND: &str = "__executor_test__";') && kernel.includes('const TEST_WATCH: Duration = Duration::from_millis(8000);') && kernel.includes('translate(language, "请先填写命令。", &[] as &[String])') && kernel.includes('"pwsh" => format!("{command}; $pelloOk = $?; $pelloCode = if ($pelloOk) {{ 0 }} elseif ($global:LASTEXITCODE) {{ $global:LASTEXITCODE }} else {{ 1 }}; [Console]::Out.Write(([char]27).ToString()+\'{}\'+$pelloCode+([char]7))", marker[1..].replace(\'\\\'\', "\'\'")),') && kernel.includes('"cmd" => format!("{command} & echo {id}:!ERRORLEVEL!"),') && kernel.includes('const TEST_SETTLE: Duration = Duration::from_millis(180);') && kernel.includes('if let Some((code, at, len)) = launch_exit(&kept, &exit_begins, shell == "cmd") {') && kernel.includes('kept.replace_range(at..at + len, "");') && kernel.includes('if running { result["running"] = json!(true); }') && kernelPty.includes('for (key, value) in extra { builder.env(key, value); }'),
    'AWB079', 'src-tauri/core/src/workbench.rs', '执行器测试用独立终端会话在对应 Shell 中运行命令并带执行器环境，8 秒仍在运行时如实报告，页面不被告知也不留历史')
  require(kernel.includes('"pty:write" if self.closing.load(Ordering::SeqCst) => Ok(Value::Null),') && kernel.includes('if self.closing.load(Ordering::SeqCst) { return Ok(json!("signal")) }') && kernel.includes('pty::delete_history(&self.paths.data, &id);') && kernelPty.includes('pub fn delete_history(data: &Path, id: &str) {') && kernelPty.includes('if !chunk.is_empty() && recorded_for_restore && !closing { let _ = append_ansi(&data, id, chunk); }'),
    'AWB079', 'src-tauri/core/src/pty.rs', '工作台关闭中忽略终端的写入、缩放与重启，关闭终端时删除其历史且不再续写记录')
  require((JSON.parse(files.get('package.json') || '{}').scripts || {}).check?.includes('scripts/executor-test-check.mjs') && i18nTable.includes('("请先填写命令。", "Enter a command first."),'),
    'AWB079', 'package.json', '执行器测试的界面回归纳入日常检查，内核翻译表包含其固定消息')
  // What the file tree's menu does goes through the desktop layer of the
  // kernel: a copied path is on the clipboard and nothing is returned to the
  // page, an entry is acted on only while it is still of the kind the page
  // showed, a file is saved elsewhere only under a free name through a copy
  // published in one step, and on Windows the system's own calls open a file
  // and show it in its folder.
  const kernelShell = files.get('src-tauri/core/src/shell.rs') || ''
  require(kernel.includes('if action == "copy-full" || action == "copy-relative" {') && kernel.includes('shell::set_clipboard_text(if action == "copy-full" { &place.root } else { &relative });') && kernel.includes('if place.local && files::is_directory(Path::new(&place.root)) != Some(directory) {') && kernel.includes('if files::is_directory(&full) != Some(directory) {') && kernel.includes('shell::copy_to_new_file(') && kernel.includes('translate(language, "源文件已更改"') && kernelShell.includes('ShellExecuteW(') && kernelShell.includes('.args(["/select,", &target])') && kernelShell.includes('SetClipboardData(CF_UNICODETEXT as u32, memory)') && kernelShell.includes('match crate::sys::rename_noreplace(&temporary, destination) {'),
    'AWB080', 'src-tauri/core/src/shell.rs', '文件树菜单经内核桌面层复制、打开、另存为：复制写剪贴板且不返回页面，动作前复核类型，另存为只发布到空闲文件名，Windows 走系统调用')
  // Where a project is asked through one door, as the Electron build's
  // `projectTarget` asks: a project that is not there, a machine whose record
  // was removed and a machine that is not connected are said so, in that
  // order, in the user's language; and a channel that goes to a project's
  // machine goes through it rather than to the machine on its own.
  const door = /fn project_target\([\s\S]*?\n {4}\}/.exec(kernel)?.[0] || ''
  const saysRemoved = /fn optional_host[\s\S]*?\.ok_or_else\(\|\| translate\(language, "机器已移除", &\[\] as &\[String\]\)\)/.test(kernel)
  // The body of a method, and no further: what follows its closing brace
  // belongs to the next one, and must not vouch for this.
  const body = (name) => new RegExp('\\n    fn ' + name + '\\([\\s\\S]*?\\n    \\}').exec(kernel)?.[0] || ''
  require(/let project = self\.project\(project_id, language\)\?;\r?\n\s*let host = self\.optional_host\([^;]+, language\)\?;\r?\n\s*if host\.as_ref\(\)\.is_some_and\(\|host\| host\["on"\] == false\) \{\r?\n\s*return Err\(translate\(language, "这台机器未连接", &\[\] as &\[String\]\)\);/.test(door) && saysRemoved && !kernel.includes('主机不存在') && ['remote_place', 'transfer_drop', 'transfer_retry', 'tree_place'].every((name) => body(name).includes('self.project_target(')) && i18nTable.includes('("机器已移除", "Machine has been removed"),'),
    'AWB081', 'src-tauri/core/src/workbench.rs', '项目所在机器经统一入口查找：项目不存在、机器已移除、这台机器未连接按序翻译报错，文件树与传输经该入口而非各自查主机')
  // A path is checked and listed on a machine by its id alone, as the
  // Electron build does it, and not through the door a project goes through:
  // an id that is no machine's is the first machine's, whether the machine is
  // connected is not asked, a path is absolute as its machine spells it, and
  // what a machine that refuses says is what the page is told.
  const pathCheck = body('path_check')
  const pathHost = body('path_host')
  // The branch's name is left empty when it cannot be read, as the Electron
  // build leaves it; it is the directory question whose refusal is passed on.
  const asksDirectory = /let exists = match exists \{\r?\n(?:\s*\/\/[^\n]*\r?\n)*\s*Ok\(text\) => text\.trim\(\) == "yes",\r?\n(?:\s*\/\/[^\n]*\r?\n)*\s*Err\(detail\) => return Ok\(json!\(\{ "kind": "error", "detail": detail \}\)\),\r?\n(?:\s*\/\/[^\n]*\r?\n)*\s*\};/.test(pathCheck)
  require(pathHost.includes('.find(|host| host["id"] == host_id).or_else(|| hosts.first())?') && pathCheck.includes('self.path_host(host_id)') && body('path_list').includes('self.path_host(host_id)') && !pathCheck.includes('optional_host(') && !pathCheck.includes('project_target(') && /fn absolute_on[\s\S]*?if platform == "windows" \{ return bytes\.len\(\) >= 3 && bytes\[0\]\.is_ascii_alphabetic\(\) && bytes\[1\] == b':' && bytes\[2\] == b'\\\\' \}/.test(kernel) && asksDirectory && !/let exists = [^;]*unwrap_or_default\(\)/.test(pathCheck),
    'AWB082', 'src-tauri/core/src/workbench.rs', '路径检查与列举按机器 id 查找并回退到第一台机器，不经项目统一入口；绝对路径按目标平台判断，机器拒绝时如实返回错误而非路径不存在')
  // A document is as large as the Electron build's `MAX_DOCUMENT_BYTES`, and
  // no larger: a file is asked its size before a byte of it is read, so that
  // a file beyond the limit is not read whole to be refused; one beyond it is
  // opened as empty with no version, so that it can be neither saved nor
  // previewed; and what is asked locally is asked of a remote file too.
  const kernelFiles = files.get('src-tauri/core/src/files.rs') || ''
  const kernelGit = files.get('src-tauri/core/src/git.rs') || ''
  const kernelPreview = files.get('src-tauri/core/src/preview.rs') || ''
  // The size is asked of the file's stamp before a byte is read, where the
  // plain read and the refresh both come.
  const readLocal = /fn read_local\(root: &Path, rel: &str, language: &str\) -> Result<Value, String> \{[\s\S]*?\r?\n\}/.exec(kernelFiles)?.[0] || ''
  const readLocalStamped = /pub fn read_local_stamped\(root: &Path, rel: &str, known: Option<&str>, language: &str\) -> Result<Option<Value>, String> \{[\s\S]*?\r?\n\}/.exec(kernelFiles)?.[0] || ''
  const oversized = /fn oversized_file\(\)[\s\S]*?\n\}/.exec(kernelFiles)?.[0] || ''
  require(kernelFiles.includes('pub const DOCUMENT_LIMIT: u64 = 10_000_000;') && kernelFiles.includes('pub const MEDIA_LIMIT: u64 = 12_000_000;') && /fn limit_for\(rel: &str\) -> u64 \{\r?\n\s*if media_kind\(rel\)\.is_some\(\) \{ MEDIA_LIMIT \} else \{ DOCUMENT_LIMIT \}/.test(kernelFiles) && readLocal.includes('Ok(read_local_stamped(root, rel, None, language)?.unwrap_or(missing_file()))') && readLocalStamped.includes('if before.size > limit_for(&relative) {') && readLocalStamped.indexOf('if before.size > limit_for(&relative) {') < readLocalStamped.indexOf('let bytes = fs::read(&full)') && oversized.includes('"version": Value::Null, "tooBig": true') && kernelFiles.includes('if bytes.len() as u64 > DOCUMENT_LIMIT {') && kernelGit.includes('if bytes.len() as u64 > files::DOCUMENT_LIMIT {') && kernelPreview.includes('const DRAFT_LIMIT: usize = crate::files::DOCUMENT_LIMIT as usize;'),
    'AWB083', 'src-tauri/core/src/files.rs', '文档上限为 Electron 的 MAX_DOCUMENT_BYTES（10 MB，媒体 12 MB）：本机先看大小再读取，超限文件按空内容且无版本返回，本机与远程保存及预览草稿沿用同一上限')
  // A message that reaches the user is said by the kernel's catalog and in
  // no other way: what is said of a folder that cannot be listed names the
  // system's reason as Node names it, and falls back to a translated word
  // and not to Chinese written into the code; a skill that cannot be
  // recycled, and the name of a shell that was not detected, are translated
  // too; so is the word said of a server whose URL cannot be read, which
  // is asked of the parser by the rule that follows. The full coverage of
  // callers and menu texts is asked by
  // `scripts/i18n-check.mjs`, which runs with the daily checks.
  const kernelResources = files.get('src-tauri/core/src/resources.rs') || ''
  const kernelShells = files.get('src-tauri/core/src/shells.rs') || ''
  const trashPath = /fn trash_path\(path: &Path, language: &str\)[\s\S]*?\n\}/.exec(kernelResources)?.[0] || ''
  const mcpDescription = /fn mcp_description\(value: &Value, language: &str\) -> String \{[\s\S]*?\n\}/.exec(kernelResources)?.[0] || ''
  const discover = /fn discover\(root: &Path, language: &str\)[\s\S]*?\n\}/.exec(kernelGit)?.[0] || ''
  const errnoName = /pub fn errno_name\(error: &std::io::Error\) -> Option<&'static str> \{[\s\S]*?\n\}/.exec(kernelFiles)?.[0] || ''
  require(discover.includes('translate(language, "{{0}}：{{1}}", &[rel, reason])') && discover.includes('unwrap_or_else(|| translate(language, "无法读取", &[] as &[String]))') && discover.includes('files::errno_name(&error)') && !/format!\("[^"]*[\u3400-\u9fff]/.test(kernelGit) && kernelGit.includes('translate(language, "{{0}}：无法读取 Git 状态", &[prefix.clone()])') && errnoName.includes('ERROR_ACCESS_DENIED | ERROR_PRIVILEGE_NOT_HELD => "EPERM"') && errnoName.includes('| ERROR_PATH_NOT_FOUND => "ENOENT"') && trashPath.includes('let unmovable = || t(language, "无法移入回收站");') && !/^[^/]*"([^"]*[\u3400-\u9fff][^"]*)"/m.test(trashPath.replace(/t\(language, "[^"]*"\)/g, '')) && (mcpDescription.match(/t\(language, "无效 URL"\)/g) || []).length === 1 && !/^[^/]*"([^"]*[\u3400-\u9fff][^"]*)"/m.test(mcpDescription.replace(/t\(language, "[^"]*"\)/g, '')) && kernelShells.includes('translate(language, "Git Bash 或本机 Bash", &[] as &[String])') && i18nTable.includes('("{{0}}：{{1}}", "{{0}}: {{1}}"),') && i18nTable.includes('("无法读取", "Cannot read"),') && i18nTable.includes('("{{0}}：无法读取 Git 状态", "{{0}}: cannot read Git status"),') && i18nTable.includes('("无法移入回收站", "Cannot move to the Recycle Bin"),') && i18nTable.includes('("Git Bash 或本机 Bash", "Git Bash or local Bash"),') && i18nTable.includes('("无效 URL", "Invalid URL"),') && i18nTable.includes('("粘贴为纯文本", "Paste as plain text"),') && i18nTable.includes('("重新读取", "Reload"),') && (JSON.parse(files.get('package.json') || '{}').scripts || {}).check?.includes('scripts/i18n-check.mjs'),
    'AWB084', 'src-tauri/core/src/git.rs', '内核面向用户的消息一律经翻译表：无法列出的目录按 Node 的错误码报告并以翻译兜底，回收站失败与未检测到的 Shell 名称同样翻译，菜单文本有词条，覆盖检查纳入日常检查')
  // A server's URL is read by the URL standard's own parser, wherever a URL
  // is read, and never by how its text begins; the parser's own message is
  // passed on as it is, as the Electron build passes on what `new URL`
  // throws. A string is trimmed to the characters JavaScript's `trim` takes
  // off, among which the byte order mark is and the next line character is
  // not. Where a list of servers is looked for, a value JavaScript calls
  // false stands for an empty object, the last one on the way included, as
  // `object(value || {})` has it.
  const whitespace = /fn is_js_whitespace\(character: char\) -> bool \{[\s\S]*?\n\}/.exec(kernelResources)?.[0] || ''
  const mcpRoot = /fn mcp_root<'a>\([\s\S]*?\n\}/.exec(kernelResources)?.[0] || ''
  const parsed = (kernelResources.match(/ada_url::Url::parse\(/g) || []).length
  const parsedAlone = (kernelResources.match(/ada_url::Url::parse\([^;]*?, None\)/g) || []).length
  require(parsed === 4 && parsedAlone === 4 && !/(?<!ada_)url::Url::parse/.test(kernelResources) && !/starts_with\("https?:/.test(kernelResources) && (kernelResources.match(/"Invalid URL"\.to_string\(\)/g) || []).length === 3 && !kernelResources.includes('t(language, "Invalid URL")') && !i18nTable.includes('"Invalid URL",') && whitespace.includes(`'\\u{0009}'..='\\u{000d}'`) && whitespace.includes(`'\\u{feff}'`) && !whitespace.includes('u{85}') && kernelResources.includes('fn js_trim(text: &str) -> &str { text.trim_matches(is_js_whitespace) }') && (kernelResources.match(/js_trim\(/g) || []).length === 3 && kernelResources.includes('Some(value) if !js_trim(value).is_empty() && !value.contains(\'\\0\') => {}') && kernelResources.includes('js_trim(text).is_empty() || text.contains(\'\\0\')') && mcpRoot.includes('fn asked<\'a>(value: &\'a Value, language: &str)') && mcpRoot.includes('if is_truthy(value) { object_or(value, language) } else { Ok(EMPTY_MAP.get_or_init(Map::new)) }') && (mcpRoot.match(/asked\(value, language\)\?/g) || []).length === 2 && mcpRoot.includes('let servers = asked(value, language)?;'),
    'AWB085', 'src-tauri/core/src/resources.rs', 'MCP 的 URL 一律由 URL 标准的解析器读取而非按文本前缀判断，解析器自身的 Invalid URL 不翻译；trim 取 JavaScript 的空白集；查找服务器集合时假值视为空对象且最终值同样处理')

  // A configuration file is decoded strictly, as the Electron build's
  // `readText` decodes it, so that bytes that are not UTF-8 are refused
  // with the decoder's own message instead of being read as replacement
  // characters; the byte order mark is kept in what is read and each edit
  // takes it off and puts it back. A TOML document the parser cannot read
  // is refused in the build's own words. A file is not written through
  // unless it is the same file it was read from: the staged file is
  // compared with what was read by identity, the backup is moved onto its
  // name rather than copied onto it, a file that was not there is linked
  // into place, and no staged file is left behind. A Skill description is
  // taken up to 8192 characters. A duplicate alone is said to be skipped.
  // A Skill file is renamed by a link and an unlink, never by a rename.
  // The configuration OpenCode is told to use by its environment wins.
  const readText = /fn read_text\(path: &Path, language: &str\) -> Result<String, String> \{[\s\S]*?\n\}/.exec(kernelResources)?.[0] || ''
  const atomicText = /fn atomic_text\(path: &Path, before: &str, next: &str, language: &str\) -> Result<\(\), String> \{[\s\S]*?\r?\n\}\r?\n\r?\n\/\/\/ A file written whole/.exec(kernelResources)?.[0] || ''
  const skillInfo = /fn skill_info\(files: &dyn ResourceFiles, file: &str, language: &str\) -> Result<SkillInfo, String> \{[\s\S]*?\r?\n\}/.exec(kernelResources)?.[0] || ''
  const distribute = /fn distribute\([\s\S]*?\r?\n\}\r?\n/.exec(kernelResources)?.[0] || ''
  const renameSkill = /fn rename_skill\(root: &Path, source: &Path, dest: &Path, language: &str\) -> Result<\(\), String> \{[\s\S]*?\r?\n\}/.exec(kernelResources)?.[0] || ''
  // The built-in executors' paths come from the environment of the machine
  // that has them, or from none when a resource home is given for a test.
  const nativeResourceTargets = /fn native_resource_targets\(home: &str, env: impl Fn\(&str\) -> Option<String>, windows: bool, exists: impl Fn\(&str\) -> bool\) -> Vec<Target> \{[\s\S]*?\r?\n\}/.exec(kernelResources)?.[0] || ''
  const nativeTargets = /fn native_targets\(\) -> Vec<Target> \{[\s\S]*?\r?\n\}/.exec(kernelResources)?.[0] || ''
  // The files of the machine that has them stand between every resource
  // operation and a configuration. The local ones lead to the functions
  // above, so that nothing steps around the strict decoding, the BOM or the
  // check of the file's identity.
  const localFiles = /impl ResourceFiles for LocalFiles \{[\s\S]*?\r?\n\}/.exec(kernelResources)?.[0] || ''
  require(localFiles.includes('        read_text(Path::new(file), &self.language)') && !localFiles.includes('fs::read_to_string') && localFiles.includes('        atomic_text(Path::new(file), before, next, &self.language)') && !localFiles.includes('fs::write(') && localFiles.includes('        rename_skill(Path::new(root), Path::new(source), Path::new(dest), &self.language)') && !localFiles.includes('fs::rename('),
    'AWB086', 'src-tauri/core/src/resources.rs', '本机文件实现必须把读取、写入、Skill 改名分别交给 read_text、atomic_text、rename_skill，不得直接用 fs::read_to_string / fs::write / fs::rename 绕过严格解码、BOM、身份核对与链接改名')
  require(readText.includes('let data = fs::read(path)') && readText.includes('Ok(text) => Ok(text)') && readText.includes('Err("The encoded data was not valid for encoding utf-8".to_string())') && !readText.includes('read_to_string') && !readText.includes('from_utf8_lossy') && !kernelResources.includes('t(language, "The encoded data was not valid for encoding utf-8")') && !i18nTable.includes('"The encoded data was not valid for encoding utf-8",') && atomicText.includes('current.regular && current.number == previous.number') && atomicText.includes('|| read_text(path, language)? != before') && atomicText.includes('fs::rename(&backup_stage, &backup)') && atomicText.includes('fs::hard_link(&temp, path)') && atomicText.includes('for staged in [&temp, &backup_stage] {') && !atomicText.includes('fs::copy(') && !kernelResources.includes('trim().is_empty() { "{\\n}\\n".to_string() }') && (kernelResources.match(/let \(order, (source|rest)\) = json_edit_source\(&before\);/g) || []).length === 4 && (kernelResources.match(/with_mark\(order, &\w+\)/g) || []).length === 5 && skillInfo.includes('description.chars().count() > 8192') && i18nTable.includes('"Skill 需要 1 到 8192 字符的 description",') && !i18nTable.includes('1 到 1024 字符的 description') && kernelResources.includes('.map_err(|_| t(language, "TOML 配置存在语法错误，请修复后重试"))') && i18nTable.includes('"TOML 配置存在语法错误，请修复后重试",') && distribute.includes('json!({ "ok": false, "error": error.message, "skipped": error.duplicate })') && (distribute.match(/"skipped": error\.duplicate/g) || []).length === 1 && !distribute.includes('"skipped": true') && distribute.includes('let failed = |error: &Refused| json!({ "ok": false, "error": error.message, "skipped": error.duplicate });') && distribute.includes('result["skipped"] = json!(outcome["skipped"].as_bool().unwrap_or(false));') && (kernelResources.match(/Refused::duplicate\(/g) || []).length === 3 && renameSkill.includes('fs::hard_link(source, dest)') && renameSkill.includes('let _ = fs::remove_file(dest);') && !renameSkill.includes('fs::rename(') && nativeResourceTargets.includes('env("OPENCODE_CONFIG")'),
    'AWB086', 'src-tauri/core/src/resources.rs', '配置文件严格按 UTF-8 解码且 BOM 保留并在编辑时摘下复原；TOML 语法错误使用统一词条；写回前按文件身份与内容核对，备份经暂存改名，文件不存在时以硬链接发布，不留暂存；description 上限 8192；仅重复标记 skipped；Skill 改名用链接而非 rename；尊重 OPENCODE_CONFIG')

  // A built-in agent's configuration is a file in the user's own home. A
  // behaviour case that names a built-in agent in a resource channel must
  // isolate the resource home, or it reads and writes the user's own files;
  // one such case once added a server to the user's Claude configuration.
  const behaviour = files.get('src-tauri/core/tests/behavior.rs') || ''
  const builtins = ['claude', 'codex', 'opencode', 'pi', 'omp']
  const resourceChannels = ['resources:mcp', 'resources:toggle', 'resources:import-mcp', 'resources:import-skills', 'resources:skill-delete', 'resources:target', 'resources:list', 'resources:detail', 'resources:skill-directory', 'resources:skill-open']
  const liveCases = [...behaviour.matchAll(/(#\[test\]\r?\nfn (\w+)\(\) \{[\s\S]*?\r?\n\}\r?\n)/g)]
    .filter(([, body]) => resourceChannels.some((channel) => body.includes(`"${channel}"`)) && builtins.some((id) => body.includes(`json!("${id}")`)) && !body.includes('var_guard("AWB_RESOURCE_HOME"'))
    .map(([, , name]) => name)
  require(liveCases.length === 0,
    'AWB087', 'src-tauri/core/tests/behavior.rs', `行为用例把内置 Agent 用于资源通道时必须隔离 AWB_RESOURCE_HOME，否则会读写用户主目录里的真实配置：${liveCases.join('、')}`)
  // A template is lent to an executor on one machine. The Electron build
  // keeps the environment a terminal was created with on the terminal itself
  // (`terminalOptions.env`), so that one started again has it whatever the
  // template says since; hides every value marked secret from what testing an
  // executor shows, the longest first; and refuses a path that is not
  // absolute as its machine spells it, a loan across machines, and a format
  // an executor's native one does not take.
  const templates = files.get('src-tauri/core/src/templates.rs') || ''
  const templatesPath = /pub fn resource_path\(input: &str, windows: bool, language: &str\) -> Result<String, String> \{[\s\S]*?\r?\n\}/.exec(templates)?.[0] || ''
  const templatesRedact = /pub fn redact_output\(text: &str, env: &\[Value\]\) -> String \{[\s\S]*?\r?\n\}/.exec(templates)?.[0] || ''
  const templatesCompatible = /pub fn template_compatible\(template: &Value, executor_id: &str\) -> bool \{[\s\S]*?\r?\n\}/.exec(templates)?.[0] || ''
  const templatesBind = /pub fn bind\(db: &mut Value, scope: &Value, template_id: &str, language: &str\) -> Result<\(\), String> \{[\s\S]*?\r?\n\}/.exec(templates)?.[0] || ''
  const templatesSession = /pub fn validate_custom_session\(config: Option<&Value>, language: &str\) -> Result<\(\), String> \{[\s\S]*?\r?\n\}/.exec(templates)?.[0] || ''
  const templatesMigrate = /pub fn migrate\(db: &mut Value, old_targets: &Value, language: &str\) \{[\s\S]*?\r?\n\}/.exec(templates)?.[0] || ''
  require(templatesPath.includes('if has_control(input) || !absolute || forbidden {') && templatesPath.includes("(bytes[2] == b'\\\\' || bytes[2] == b'/')") && templatesPath.includes("after_drive.contains(['<', '>', '\"', '|', '?', '*'])") && templatesPath.includes('Ok(normalize(input, windows))') && !templatesPath.includes("trim_end_matches(['\\\\', '/'])") && !/\.replace\([^)]*norm/.test(templatesPath),
    'AWB088', 'src-tauri/core/src/templates.rs', '资源路径按机器平台判绝对：控制字符、盘符后 <>:"|?* 一律拒绝，结尾分隔符保留，不能用 std::path 归一化替代')
  require(templatesRedact.includes('filter(|row| row["secret"] == true)') && templatesRedact.includes('.filter(|value| !value.is_empty())') && templatesRedact.includes('secrets.sort_by_key(|value| std::cmp::Reverse(value.chars().count()))') && templatesRedact.includes('out = out.replace(secret, "••••")') && templatesRedact.indexOf('secrets.sort_by_key') < templatesRedact.indexOf('for secret in secrets'),
    'AWB088', 'src-tauri/core/src/templates.rs', '测试执行器的输出必须把标记为 secret 的非空值按长度降序替换成 ••••，长密钥先替换，否则短密钥会残留在长密钥的替换结果里')
  require(templatesCompatible.includes('"codex" => format == "codex" && adapter == "codex"') && templatesCompatible.includes('"opencode" => format == "opencode" && adapter == "opencode"') && templatesCompatible.includes('"claude" | "pi" | "omp" => format == "standard" && adapter == executor_id') && templatesCompatible.includes('_ => true'),
    'AWB088', 'src-tauri/core/src/templates.rs', '模板与执行器的兼容表：codex/opencode 各取同名的 format 与 adapter，claude/pi/omp 取 standard 加同名 adapter，自定义执行器全兼容')
  require(templatesBind.includes('machine(db, host_id, false, language)?') && templatesBind.includes('"执行器不存在"') && templatesBind.includes('if text(&template, "hostId") != host_id { return Err(t(language, "模板必须属于所选机器")); }') && templatesBind.includes('check_compatibility(&template, executor_id, language)?') && templatesBind.indexOf('check_compatibility') < templatesBind.indexOf('db["templateBindings"] = Value::Array(kept)'),
    'AWB088', 'src-tauri/core/src/templates.rs', '绑定模板必须先校验机器存在、执行器存在、模板属于该机器且与执行器格式兼容，全部通过后才替换绑定')
  require(templatesSession.includes('"startArgs"') && templatesSession.includes('"resumeArgs"') && templatesSession.includes('{sessionId}') && templatesSession.includes('新建和恢复参数都必须包含 {sessionId}'),
    'AWB088', 'src-tauri/core/src/templates.rs', '自定义执行器的 startArgs 与 resumeArgs 都必须包含 {sessionId}')
  require(templatesMigrate.includes('if executor_template(db, "local", &id).is_some() { continue; }') && templatesMigrate.includes('if let Some(own) = executor.get("resources").and_then(|value| value.as_object()) { for (key, value) in own { old[key] = value.clone(); } }') && templatesMigrate.indexOf('old_targets.get(&id)') < templatesMigrate.indexOf('executor.get("resources")') && templatesMigrate.includes('object.remove("resources")') && templatesMigrate.includes('let _ = bind(db, &json!({ "hostId": "local", "executorId": id }), &template_id, "zh-CN");'),
    'AWB088', 'src-tauri/core/src/templates.rs', '迁移旧资源路径：已借到模板的执行器跳过，执行器自身 resources 覆盖旧 targets 文件，迁出的模板借回原执行器并删除旧 resources 字段')
  const templatesAdopt = /pub fn adopt\(db: &mut Value, raw: Option<&Value>, old_targets: &Value, language: &str\) -> bool \{[\s\S]*?\r?\n\}/.exec(templates)?.[0] || ''
  require(templatesAdopt.includes('let first_time = raw.and_then(|raw| raw.get("templates")).is_none_or(|value| !value.is_array());') && templatesAdopt.includes('if !first_time { return false; }') && templatesAdopt.indexOf('if !first_time { return false; }') < templatesAdopt.indexOf('migrate(db, old_targets, language);') && templatesAdopt.includes('item.get("id").is_some_and(|value| value.is_string()) && item.get("name").is_some_and(|value| value.is_string()) && item["env"].is_array()'),
    'AWB088', 'src-tauri/core/src/templates.rs', '旧路径只在数据库尚无 templates 数组时迁移一次，已有 templates 的库原样保留；模板须有字符串 id、name 与数组 env，绑定须有字符串 executorId')
  const workbench = files.get('src-tauri/core/src/workbench.rs') || ''
  const workbenchSaved = /pub const SAVED_CHANNELS: \[&'static str; \d+\] = \[([^\]]*)\]/.exec(workbench)?.[1] || ''
  const workbenchReplace = /fn replace\(&self, next: Value\) -> Result<Value, String> \{[\s\S]*?\r?\n\x20{4}\}/.exec(workbench)?.[0] || ''
  const workbenchTest = /pub fn test_exec\(&self, request: Value, language: &str\) -> Result<Value, String> \{[\s\S]*?\r?\n\x20{4}\}\r?\n/.exec(workbench)?.[0] || ''
  const workbenchRestart = /fn pty_restart\(&self, id: &str, language: &str\) -> Result<Value, String> \{[\s\S]*?\r?\n\x20{4}\}/.exec(workbench)?.[0] || ''
  const workbenchCustom = /fn save_custom\(&self, custom: Value, bindings: Value, language: &str\) -> Result<Value, String> \{[\s\S]*?\r?\n\x20{4}\}/.exec(workbench)?.[0] || ''
  require(['templates:save', 'templates:bind', 'templates:delete', 'db:custom'].every((channel) => workbenchSaved.includes(`"${channel}"`)) && !workbenchSaved.includes('"db:hosts"') && workbenchSaved.split(',').length === Number(/SAVED_CHANNELS: \[&'static str; (\d+)\]/.exec(workbench)?.[1]),
    'AWB088', 'src-tauri/core/src/workbench.rs', 'SAVED_CHANNELS 必须包含 templates:save/bind/delete 与 db:custom，不含 db:hosts（Electron 的 db:hosts 不走 mutate 的保存顺序），且长度与元素数一致')
  require(workbenchReplace.indexOf('store::save_database(&self.database_path(), &next)?') < workbenchReplace.indexOf('*self.db.lock().expect("db") = next.clone()') && workbenchReplace.includes('Ok(next)'),
    'AWB088', 'src-tauri/core/src/workbench.rs', 'replace 必须先写盘再换内存：写失败时内存数据库保持原样，不能先改内存再回滚')
  require(workbenchTest.includes('templates::executor_template(&self.db.lock().expect("db"), host_id, executor_id).map(|template| template["env"].as_array().cloned().unwrap_or_default()).unwrap_or_else(|| request["env"].as_array().cloned().unwrap_or_default()),') && !/template\["env"\][^;]*request\["env"\][^;]*\)[^;]*\.map\(/.test(workbenchTest) && !/\[\s*template\["env"\]/.test(workbenchTest) && workbenchTest.includes('templates::redact_output(&collected.lock().expect("test output"), &rows)') && workbenchTest.indexOf('let rows: Vec<Value>') < workbenchTest.indexOf('templates::redact_output'),
    'AWB088', 'src-tauri/core/src/workbench.rs', 'exec:test 有模板时用模板 env（整体替换而非合并对话框 env），输出必须经 redact_output 脱敏后再返回')
  require(workbenchRestart.includes('launch_meta(id)') && workbenchRestart.includes('self.emit.clone(), &env)') && !workbenchRestart.includes('self.emit.clone(), &[])'),
    'AWB088', 'src-tauri/core/src/workbench.rs', 'pty:restart 重建终端必须把 launch_meta 返回的创建时环境传回 create，不能传空切片：重建后的自定义执行器会丢失模板环境')
  require(workbenchCustom.includes('templates::machine(&next, "local", false, language)?') && workbenchCustom.includes('templates::validate_custom_session(executor.get("session"), language)?') && workbenchCustom.includes('templates::prune(&mut next)') && workbenchCustom.includes('translate(language, "执行器不存在"') && workbenchCustom.indexOf('templates::prune(&mut next)') < workbenchCustom.indexOf('templates::bind(&mut next'),
    'AWB088', 'src-tauri/core/src/workbench.rs', 'db:custom 保存：先校验本机资源路径与会话参数，再修剪失效绑定，再逐条绑定（执行器不在本次保存列表内则拒绝）')
  // Resources work on a scope: an executor on a machine, or a bare executor
  // id for this machine. A machine that is not there, one that is not
  // connected and an executor that is not there are refused in that order;
  // what an executor has is the template lent to it there, else what it
  // finds for itself on this machine, else nothing. What a scope comes to is
  // taken before an operation and compared after, so that a machine or a
  // template changed in between is refused rather than written to as it was.
  // A distribution names one result per scope and entry, chooses each scope
  // once, and writes a file once however many executors share it.
  const scopedKernel = files.get('src-tauri/core/src/resources.rs') || ''
  const scopedScopeOf = /pub fn scope_of\(scope: &Value\) -> \(String, String\) \{[\s\S]*?\r?\n\}/.exec(scopedKernel)?.[0] || ''
  const scopedDescribe = /fn describe\(db: &Value, scope: &Value, defaults: &\[Target\], language: &str\) -> Result<Target, String> \{[\s\S]*?\r?\n\}/.exec(scopedKernel)?.[0] || ''
  const scopedTargetJson = /fn target_json\(target: &Target\) -> Value \{[\s\S]*?\r?\n\}/.exec(scopedKernel)?.[0] || ''
  const scopedFingerprint = /pub fn fingerprint\(db: &Value, scope: &Value, language: &str\) -> Result<Fingerprint, String> \{[\s\S]*?\r?\n\}/.exec(scopedKernel)?.[0] || ''
  const scopedGuardCheck = /pub fn check\(&self, db: &Value, scope: &Value, language: &str\) -> Result<\(\), String> \{[\s\S]*?\r?\n\x20{4}\}/.exec(scopedKernel)?.[0] || ''
  const scopedSkillDirectory = /pub fn skill_directory\(data: &Path, db: &Value, scope: &Value, item: &Value, removing: bool, language: &str\) -> Result<PathBuf, String> \{[\s\S]*?\r?\n\}/.exec(scopedKernel)?.[0] || ''
  const scopedDistribute = /fn distribute\(resources: &Resources, data: &Path, db: &Value, kind: &str, entries: &\[Value\], scopes: &\[Value\], language: &str, run: &mut dyn FnMut\(&mut Resolved, &Value, &str\) -> Result<\(\), Refused>\) -> Result<Value, String> \{[\s\S]*?\r?\n\}/.exec(scopedKernel)?.[0] || ''
  // An executor's resources on any machine: asked of the host at once, and
  // what is changed in them published to it as one request.
  const scopedResolve = /fn resolve_with\(data: &Path, db: &Value, scope: &Value, kind: &str, profiles: &mut std::collections::BTreeMap<String, Vec<Target>>, language: &str\) -> Result<Resolved, String> \{[\s\S]*?\r?\n\}/.exec(scopedKernel)?.[0] || ''
  const scopedRemoteTargets = /fn remote_targets\(data: &Path, host: &Value, language: &str\) -> Result<Vec<Target>, String> \{[\s\S]*?\r?\n\}/.exec(scopedKernel)?.[0] || ''
  const scopedPublish = /\x20{4}fn publish\(&self, data: &Path, db: &Value, language: &str\) -> Result<\(\), String> \{[\s\S]*?\r?\n\x20{8}\}/.exec(scopedKernel)?.[0] || ''
  const scopedDispatch = /pub fn dispatch\(&self, channel: &str, args: &\[Value\]\) -> Result<Value, String> \{[\s\S]*?\r?\n\x20{4}\}/.exec(files.get('src-tauri/core/src/workbench.rs') || '')?.[0] || ''
  const scopedBridge = files.get('src/renderer/tauri-awb.ts') || ''
  require(scopedScopeOf.includes('Some(id) => ("local".into(), id.to_string()),') && scopedScopeOf.includes('None => (field(scope, "hostId"), field(scope, "executorId")),'),
    'AWB089', 'src-tauri/core/src/resources.rs', '作用域：裸字符串按本机执行器解释为 {local, id}，对象取 hostId 与 executorId')
  require(scopedDescribe.includes('crate::templates::machine(db, &host_id, true, language)?;') && scopedDescribe.indexOf('crate::templates::machine(db, &host_id, true, language)?;') < scopedDescribe.indexOf('"执行器不存在"') && scopedDescribe.includes('let template = crate::templates::executor_template(db, &host_id, &id);') && scopedDescribe.includes('Some(template) => (template_target(template), false),') && scopedDescribe.includes('None => match defaults.iter().find(|item| item.id == id) {'),
    'AWB089', 'src-tauri/core/src/resources.rs', '描述执行器资源：先问机器（须已连接）再找执行器，借到的模板优先于本机原生路径')
  require(scopedTargetJson.includes('if !target.bare { value["skillAdapter"] = json!(target.skill_adapter); }') && scopedTargetJson.includes('if !target.template_name.is_empty() { value["templateName"] = json!(target.template_name); }') && scopedTargetJson.includes('if !target.skill_config_path.is_empty() { value["skillConfigPath"] = json!(target.skill_config_path); }'),
    'AWB089', 'src-tauri/core/src/resources.rs', '目标的 JSON：没有适配器、模板名或配置路径时不输出该键')
  require(scopedFingerprint.includes('let host = crate::templates::machine(db, &host_id, true, language)?;') && scopedFingerprint.includes('if !rows(db).iter().any(|item| item["id"] == id) { return Err(t(language, "执行器不存在")) }') && scopedFingerprint.includes('let material = json!([host["id"], host["addr"], host["user"], host["port"], host["platform"], host["auth"], template]).to_string();'),
    'AWB089', 'src-tauri/core/src/resources.rs', '守卫指纹必须覆盖机器的 id、地址、端口、用户、平台、认证方式与借到的模板')
  require(scopedGuardCheck.includes('if fingerprint(db, scope, language)?.0 != self.0 { return Err(t(language, "资源目标已改变，请刷新后重试")) }'),
    'AWB089', 'src-tauri/core/src/resources.rs', '守卫复查必须重新取指纹并整体比较，不同即拒绝')
  require(scopedDistribute.includes('if resources.busy.swap(true, Ordering::SeqCst) { return Err(t(language, "正在分发资源，请稍候")) }') && scopedDistribute.includes('if scopes.is_empty() { return Err(t(language, "请选择至少一个 Code Agent")) }') && scopedDistribute.includes('if !unique.contains(&pair) { unique.push(pair); }') && scopedDistribute.includes('if file.is_empty() { return Err(t(language, "请先设置执行器的资源路径").into()) }') && scopedDistribute.includes('let windows = resolved.target.windows;') && scopedDistribute.includes('let identity = if windows { canonical.to_lowercase() } else { canonical.clone() };') && scopedDistribute.includes('&json!({ "op": "canonical", "path": &file })') && scopedDistribute.includes('let key = json!([host_id, identity, entry.get("id").filter(|item| item.is_string()).unwrap_or(&entry["name"])]).to_string();'),
    'AWB089', 'src-tauri/core/src/resources.rs', '分发：忙时拒绝、空选择拒绝、同作用域只取一次、无路径逐项报错、规范路径本机取真实名而远端问主机，文件按 [机器, 规范路径(该机器为 Windows 则小写), 条目 id 或名] 去重')
  require(scopedDistribute.includes('for entry in entries { results.push(outcome(entry, &failed(&refused))); }') && scopedDistribute.includes('result["skipped"] = json!(outcome["skipped"].as_bool().unwrap_or(false));') && scopedDistribute.includes('resources.busy.store(false, Ordering::SeqCst);') && scopedDistribute.includes('resolved.check(db, language).map_err(Refused::from).and_then(|()| run(&mut resolved, entry, &canonical));') && scopedDistribute.includes('let tried = tried.and_then(|()| resolved.publish(data, db, language).map_err(Refused::from));'),
    'AWB089', 'src-tauri/core/src/resources.rs', '作用域不可用时逐条目报告而非整体抛错；失败项总带 skipped；忙标记在任何结果后清除；每个条目写入前先复查守卫再把可写的文件交给操作，另一台机器上的改动发布成功后才算完成')
  require(scopedResolve.includes('if !template && !profiles.contains_key(&host_id) { profiles.insert(host_id.clone(), remote_targets(data, &host, language)?); }') && scopedResolve.includes('let snapshot = crate::remote_resources::remote_snapshot(data, &host, &files, &roots, &|| mark.check(db, scope, language), None, language)?;') && scopedResolve.indexOf('remote_snapshot(data, &host, &files, &roots') < scopedResolve.lastIndexOf('mark.check(db, scope, language)?;') && scopedResolve.includes('machine: Machine::Remote(snapshot)'),
    'AWB089', 'src-tauri/core/src/resources.rs', '解析远端作用域：有模板不问 profile，一台机器一次分发只问一次 profile；操作所需的文件与 Skill 根一次快照取回，快照后复查守卫，文件以远端快照交给操作')
  require(scopedRemoteTargets.includes('let profile: crate::remote_resources::RemoteProfile = crate::remote_resources::remote_resource(data, host, &json!({ "op": "profile" }), &|| Ok(()), None, language)?;') && scopedRemoteTargets.includes('let windows = host["platform"].as_str() == Some("windows");') && scopedRemoteTargets.includes('native_resource_targets(&profile.home, |name| profile.env.get(name).cloned(), windows, |file| file == profile.jsonc)'),
    'AWB089', 'src-tauri/core/src/resources.rs', '远端原生路径来自主机自己说的 profile：主目录、它设置的环境变量、OpenCode 的 JSONC 文件是否存在，按主机平台拼路径')
  require(nativeResourceTargets.includes('env("OPENCODE_CONFIG").unwrap_or_else(|| {') && nativeResourceTargets.includes('env("XDG_CONFIG_HOME")') && nativeResourceTargets.includes('env("CLAUDE_CONFIG_DIR")') && nativeResourceTargets.includes('env("CODEX_HOME")') && nativeResourceTargets.includes('env("PI_CODING_AGENT_DIR")') && nativeTargets.includes('std::env::var_os(name)') && nativeTargets.includes('let isolated = std::env::var_os("AWB_RESOURCE_HOME").is_some();') && nativeTargets.includes('if isolated { None } else'),
    'AWB086', 'src-tauri/core/src/resources.rs', '原生路径尊重 XDG_CONFIG_HOME / CLAUDE_CONFIG_DIR / CODEX_HOME / PI_CODING_AGENT_DIR / OPENCODE_CONFIG，由所在机器的环境给出；给了测试用的资源主目录时环境一律不取')
  require(scopedPublish.includes('let Machine::Remote(snapshot) = &self.machine else { return Ok(()) };') && scopedPublish.includes('snapshot.publish(data, &self.host, &|| self.check(db, language), language)'),
    'AWB089', 'src-tauri/core/src/resources.rs', '发布：本机无可发布，远端把保留的改动交给主机，守卫复查指纹')
  require(scopedSkillDirectory.includes('let mark = fingerprint(db, scope, language)?;') && scopedSkillDirectory.indexOf('let mark = fingerprint(db, scope, language)?;') < scopedSkillDirectory.indexOf('if scope_of(scope).0 != "local" { return Err(t(language, "此操作仅适用于本机 Skill")) }') && scopedSkillDirectory.includes('mark.check(db, scope, language)?;'),
    'AWB089', 'src-tauri/core/src/resources.rs', '打开/删除 Skill 目录：先取指纹再拒绝非本机，读列表后复查守卫')
  require(!/"resources:scope"|"resources:target"|"resources:skill-directory"/.test(scopedDispatch) && scopedDispatch.includes('"resources:open-recommendation"') && scopedDispatch.includes('"resources:targets" => resources::targets(&self.paths.data, &self.db.lock().expect("db").clone(), args.first().and_then(|value| value.as_str()).unwrap_or("local"), &language)'),
    'AWB089', 'src-tauri/core/src/workbench.rs', '资源通道：无 resources:scope / target / skill-directory；有 open-recommendation；targets 取 hostId')
  require(scopedDispatch.includes('"resources:skill-open" => resources::open_skill(&self.paths.data, &self.db.lock().expect("db").clone(), args.first().unwrap_or(&Value::Null), args.get(1).unwrap_or(&Value::Null), &language)') && scopedDispatch.includes('"resources:skill-delete" => resources::delete_skill(&self.paths.data, &self.db.lock().expect("db").clone(), args.first().unwrap_or(&Value::Null), args.get(1).unwrap_or(&Value::Null), &language)'),
    'AWB089', 'src-tauri/core/src/workbench.rs', 'skill-open / skill-delete 的参数是 (作用域, 条目)')
  require(scopedDispatch.includes('str_arg(args, 0), args.get(1).and_then(|value| value.as_array()).map(|list| list.as_slice()).unwrap_or(&[]), args.get(2).and_then(|value| value.as_array()).map(|list| list.iter().filter_map(|item| item.as_str().map(|item| item.to_string())).collect::<Vec<_>>()).as_ref(), &language),'),
    'AWB089', 'src-tauri/core/src/workbench.rs', 'resources:skills 的参数是 (来源, 作用域列表, 名称列表)')
  require(!scopedBridge.includes("call('resources:target'") && !scopedBridge.includes("call('resources:scope'") && scopedBridge.includes('openSkillRecommendation: (id) => call(\'resources:open-recommendation\', [id])'),
    'AWB089', 'src/renderer/tauri-awb.ts', '桥接层不再调用 resources:target / resources:scope，并声明 openSkillRecommendation')
  // A folder on an SSH machine, to choose a path on it as that machine
  // writes it. This machine has its own picker, and nothing that is not an
  // absolute path of the host's platform is asked of the host.
  const scopedBrowse = /pub fn browse\(data: &Path, db: &Value, host_id: &str, input: &str, files: bool, language: &str\) -> Result<Value, String> \{[\s\S]*?\r?\n\}/.exec(scopedKernel)?.[0] || ''
  const scopedBrowseRemote = /pub fn browse_remote_resources\(data: &Path, host: &Value, input: &str, files: bool, language: &str\) -> Result<Value, String> \{[\s\S]*?\r?\n\}/.exec(files.get('src-tauri/core/src/remote_resources.rs') || '')?.[0] || ''
  require(scopedDispatch.includes('"resources:browse" => resources::browse(&self.paths.data, &self.db.lock().expect("db").clone(), str_arg(args, 0), str_arg(args, 1), bool_arg(args, 2).unwrap_or(false), &language),'),
    'AWB090', 'src-tauri/core/src/workbench.rs', 'resources:browse 的参数是 (机器, 输入路径, 是否带文件)，缺省不带文件')
  require(scopedBrowse.includes('let host = crate::templates::machine(db, host_id, true, language)?.clone();') && scopedBrowse.indexOf('crate::templates::machine(db, host_id, true, language)?') < scopedBrowse.indexOf('if host_id == "local" { return Err(t(language, "请选择 SSH 机器")) }'),
    'AWB090', 'src-tauri/core/src/resources.rs', '浏览机器的文件夹：先问机器（须已连接），本机拒绝')
  require(scopedBrowse.includes('let path = if input.is_empty() { String::new() } else { crate::templates::resource_path(input, windows, language)? };'),
    'AWB090', 'src-tauri/core/src/resources.rs', '浏览：空输入是主机的家目录，其余按主机平台归一化为绝对路径')
  require(scopedBrowseRemote.includes('if files { result["files"] = json!(entries(listed.files)); }'),
    'AWB090', 'src-tauri/core/src/remote_resources.rs', '浏览：只在要求时带出文件')
  // The About page is told where the workbench is published, and the link on
  // it opens that very address: one constant is both, and the author is named
  // in the language of the interface.
  const homepage = /const HOMEPAGE: &str = "([^"]+)";/.exec(workbench)?.[0] || ''
  require(homepage === 'const HOMEPAGE: &str = "https://github.com/FangYang970206/Pello";' && workbench.split(homepage).length === 2 && scopedDispatch.includes('"version": env!("CARGO_PKG_VERSION")') && scopedDispatch.includes('"author": if language == "en" { "FangYang" } else { "方阳" }') && scopedDispatch.includes('"homepage": HOMEPAGE') && scopedDispatch.includes('"app:homepage" => { shell::open_external(HOMEPAGE); Ok(Value::Null) }'),
    'AWB091', 'src-tauri/core/src/workbench.rs', '关于页：版本、随界面语言的作者与唯一的主页地址；app:homepage 打开的就是告诉页面的那个地址')
  require(/browseResources: \(hostId, input, files\) => call\('resources:browse', \[hostId, input, files\]\)/.test(scopedBridge) && /openHomepage: \(\) => call\('app:homepage'\)/.test(scopedBridge),
    'AWB091', 'src/renderer/tauri-awb.ts', '桥接层声明 browseResources 与 openHomepage')
  // A file read says what it was, and asked again with that is not sent
  // again until it changes. A file found changed while it was read is
  // refused, not shown half old and half new; a file over its limit is not
  // read; and a host that cannot be asked is an error, not a file gone.
  // The local read's slice is the one the size limit is checked in.
  const readRemoteStamped = /pub fn read_remote_stamped\(data: &Path, host: &Value, root: &str, rel: &str, known: Option<&str>, language: &str\) -> Result<Option<Value>, String> \{[\s\S]*?\r?\n\}/.exec(files.get('src-tauri/core/src/git.rs') || '')?.[0] || ''
  require(readLocalStamped.includes('let stamp = file_stamp_text(&before);') && readLocalStamped.includes('if Some(stamp.as_str()) == known { return Ok(None) }') && readLocalStamped.indexOf('if Some(stamp.as_str()) == known { return Ok(None) }') < readLocalStamped.indexOf('let bytes = fs::read(&full)') && readLocalStamped.includes('if before.size > limit_for(&relative) {') && readLocalStamped.indexOf('if before.size > limit_for(&relative) {') < readLocalStamped.indexOf('let bytes = fs::read(&full)') && readLocalStamped.includes('Some((_, Some(after))) if after == before =>') && readLocalStamped.includes('_ => Err(translate(language, "读取版本期间文件已更改"'),
    'AWB092', 'src-tauri/core/src/files.rs', '读取本机文件：先取版本戳，相同则不再发送；超限不读；读后复核未变，变了拒绝')
  require(readRemoteStamped.includes('crate::ssh::run(data, host, &script, None, language)?;') && readRemoteStamped.includes('"PELLO-MISSING" => Ok(Some(files::missing_file())),') && readRemoteStamped.split('if Some(stamp) == known { return Ok(None) }').length === 3 && !/Err\(_\) => Ok\(files::missing_file\(\)\)/.test(files.get('src-tauri/core/src/git.rs') || ''),
    'AWB092', 'src-tauri/core/src/git.rs', '读取主机文件：只有主机说文件不存在才算丢失，主机问不到是错误；版本戳相同则不再发送')
  require(scopedDispatch.includes('"git:refresh" => Ok(self.git_refresh(&str_arg(args, 0), str_arg(args, 1), args.get(2).and_then(|value| value.as_str()), &language)?.unwrap_or(Value::Null)),') && /gitRefresh: \(projectId, rel, stamp\) => call\('git:refresh', \[projectId, rel, stamp \?\? null\]\)/.test(scopedBridge),
    'AWB092', 'src-tauri/core/src/workbench.rs', 'git:refresh 的第三参是可选的版本戳；未变时返回 null')
  return errors
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = checkInvariants(projectFiles())
  for (const error of errors) console.error(`${error.file}: ${error.id} ${error.message}`)
  if (errors.length) process.exitCode = 1
  else console.log('Project invariant lint passed')
}
