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
  require(JSON.stringify(ids) === JSON.stringify(['claude', 'codex', 'opencode', 'pi']), 'AWB010', typesFile, '内置预设仅 claude/codex/opencode/pi')
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

  const cssFiles = ['src/renderer/styles/workbench.css', 'src/renderer/styles/extra.css']
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
  require(['review', 'terminal', 'ssh-password', 'render', 'workspace', 'editor', 'design', 'resources', 'host-management', 'autosave'].every((name) => scripts.check?.includes(`scripts/${name}-check.mjs`)),
    'AWB018', 'package.json', '保留已有行为回归入口，不能删检查来绕过失败')
  require(files.get('AGENTS.md')?.includes('npm run lint') && files.get('AGENTS.md')?.includes('npm run check'), 'AWB019', 'AGENTS.md', '项目规则必须注明静态与行为验证入口')
  return errors
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = checkInvariants(projectFiles())
  for (const error of errors) console.error(`${error.file}: ${error.id} ${error.message}`)
  if (errors.length) process.exitCode = 1
  else console.log('Project invariant lint passed')
}
