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
  for (const rel of ['package.json', 'AGENTS.md']) files.set(rel, fs.readFileSync(path.join(root, rel), 'utf8'))
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

  const ptyFile = 'src/main/pty.ts', pty = source(ptyFile), dispose = named(pty, 'dispose'), close = named(pty, 'closeSession')
  const awaited = close && nodes(close, (node) => ts.isAwaitExpression(node) && called(node, 'dispose').length)[0]
  require(dispose && hasString(dispose, 'taskkill') && hasString(dispose, '/T') && hasString(dispose, '/F') && awaited &&
    called(close, 'delete').some((call) => call.pos > awaited.end), 'AWB006', ptyFile, '关闭必须等待进程树清理完成后再删除会话')
  require(dispose && called(dispose, 'then').some((call) => call.expression.getText() === 'this.processExit!.then'),
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
  const diagramRenderer = files.get('src/main/diagram-renderer.ts') || ''
  require(diagramRenderer.includes('show: false') && diagramRenderer.includes('sandbox: true') && diagramRenderer.includes('nodeIntegration: false') && diagramRenderer.includes('source.length > 100_000') && diagramRenderer.includes('cancelDiagramRenderer') && files.get('src/renderer/diagram-renderer.ts')?.includes("securityLevel: 'strict'") && !files.get('src/renderer/diagram-preview.ts')?.includes("import('mermaid')") && files.get('src/main/index.ts')?.includes('disposeDiagramRenderer()'), 'AWB046', 'src/main/diagram-renderer.ts', 'Mermaid 在独立隐藏沙箱渲染，限制输入与缓存，关闭时清理；不得阻塞工作台渲染线程')
  const declarations = (selector) => {
    const values = new Map()
    for (const file of cssFiles) postcss.parse(files.get(file) || '').walkRules((rule) => {
      if (rule.selector === selector) rule.walkDecls((decl) => values.set(decl.prop, decl.value))
    })
    return values
  }
  const host = declarations('.termhost'), frame = declarations('.termframe')
  require(![...host].some(([key, value]) => key.startsWith('padding') && !/^0(?:px)?$/.test(value)) && frame.get('position') === 'absolute' && !frame.has('padding'),
    'AWB015', cssFiles[1], 'fit 父节点无 padding，终端边距由外框 inset 提供')
  require(declarations('.tabs').get('flex')?.startsWith('0 ') && declarations('.tabtools').get('align-self') === 'flex-end',
    'AWB016', cssFiles[0], '加号紧贴标签并底部对齐')
  require(declarations('.dot.terminal-status.busy').get('background') === 'var(--amber)' && declarations('.dot.terminal-status.ready').get('background') === 'var(--green)',
    'AWB017', cssFiles[0], '运行黄点、可输入绿点，不与连接状态混用')
  const scripts = JSON.parse(files.get('package.json') || '{}').scripts || {}
  require(nodes(named(main, 'startRemoteUpload'), (node) => ts.isPropertyAssignment(node) && node.name.getText() === 'automatic' && node.initializer.getText() === '!keepBoth').length && called(source('src/main/remote-file.ts'), 'publishRemoteStage').length,
    'AWB037', mainFile, '远程上传默认自动覆盖，同名目录经临时上传完成后整体替换')
  const uploadFile = 'src/renderer/UploadStatus.tsx', upload = source(uploadFile)
  const uploadTags = nodes(upload, (node) => ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))
  require(!nodes(upload, (node) => ts.isPropertyAccessExpression(node) && ['task.current', 'task.destination', 'task.overallBytes', 'task.overallTotal'].includes(node.getText())).length && !uploadTags.some((node) => node.tagName.getText() === 'progress') && hasString(upload, '上传中') && hasString(upload, '上传成功') && called(upload, 'transferCancel').length &&
    nodes(upload, (node) => ts.isVariableDeclaration(node) && node.name.getText() === 'UPLOAD_SUCCESS_DURATION' && node.initializer?.getText() === '2000').length &&
    called(app, 'setTimeout').some((call) => call.arguments[1]?.getText() === 'UPLOAD_SUCCESS_DURATION') && named(upload, 'uploadSucceeded')?.getText().includes('!task.warnings?.length') && called(named(upload, 'uploadSucceeded'), 'every').length,
  'AWB038', uploadFile, '上传只显示状态与取消，全部成功且无警告才在 2 秒后移除，不能恢复路径或进度明细')
  require(['review', 'windows-icon', 'shell-profile', 'terminal', 'terminal-shutdown', 'ssh-password', 'remote-terminal', 'render', 'workspace', 'multi-repo', 'program-status', 'sidebar', 'editor', 'design', 'appearance', 'resources', 'resource-import', 'resource-import-ui', 'opencode-mcp', 'host-management', 'directory-browser', 'autosave', 'resources-ui', 'resource-dialog', 'html-preview'].every((name) => scripts.check?.includes(`scripts/${name}-check.mjs`)) && scripts.check?.includes('npm run check:shells') && scripts['check:shells']?.includes('scripts/local-shells-check.mjs'),
    'AWB018', 'package.json', '保留已有行为回归入口，不能删检查来绕过失败')
  require(files.get('AGENTS.md')?.includes('npm run lint') && files.get('AGENTS.md')?.includes('npm run check'), 'AWB019', 'AGENTS.md', '项目规则必须注明静态与行为验证入口')
  require(scripts['check:files']?.includes('scripts/upload-replace-check.mjs') && scripts['check:files']?.includes('scripts/upload-status-check.mjs'), 'AWB018', 'package.json', '保留上传整体替换、草稿和简洁状态的实际行为回归')
  require(scripts.check?.includes('scripts/reading-workspace-check.mjs') && scripts.check?.includes('scripts/terminal-layout-check.mjs'), 'AWB018', 'package.json', '保留文档高亮、导航、图表与临时会话、分栏、状态和侧栏行为回归')
  require(scripts.check?.includes('scripts/document-performance-check.mjs'), 'AWB018', 'package.json', '保留大文档编辑、目录跳转、代码虚拟化高度和图表进程隔离回归')
  return errors
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = checkInvariants(projectFiles())
  for (const error of errors) console.error(`${error.file}: ${error.id} ${error.message}`)
  if (errors.length) process.exitCode = 1
  else console.log('Project invariant lint passed')
}
