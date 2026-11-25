// Record actual Pello UI states in an isolated profile. No paid Agent calls.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { _electron as electron } from 'playwright'
import { installDocumentHarness } from '../fixtures/document-harness.mjs'

const root = process.cwd(), output = path.resolve('assets/tutorials'), raw = path.resolve('output/playwright/documentation')
fs.mkdirSync(output, { recursive: true }); fs.mkdirSync(raw, { recursive: true })
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pello-tutorial-')), project = path.join(data, 'pello-demo'), home = path.join(data, 'agent-home')
fs.mkdirSync(project); fs.mkdirSync(home)
fs.mkdirSync(path.join(project, 'examples'))
const write = (name, text) => fs.writeFileSync(path.join(project, name), text)
write('guide.md', '# 一次任务，一个工作区\n\n终端、文件和 Git 变更，都留在这里。\n\n## 先运行，再审阅\n\n- [x] 创建项目和会话\n- [x] 打开终端与文件\n- [ ] 审阅代码变更\n\n## 常用操作\n\n| 想做什么 | 怎么操作 |\n| --- | --- |\n| 查找文件 | Ctrl+E |\n| 搜索项目 | Ctrl+Shift+F |\n| 保存草稿 | Ctrl+S |\n\n## 示例代码\n\n```typescript\nconst workspace = "Pello"\nconsole.log(workspace)\n```\n\n## 保留工作现场\n\n切换文件与会话后，原来的终端仍然保留。\n')
const codeHeader = 'export type Terminal = {\n  id: string\n  name: string\n  kind: "agent" | "shell"\n}\n\nexport type Session = {\n  id: string\n  name: string\n  terminals: Terminal[]\n  activeTerminal?: string\n}\n\nexport const project = "Pello"\nexport const theme = "light"\n\n'
const codeTail = '\nexport function addTerminal(session: Session, terminal: Terminal) {\n  session.terminals.push(terminal)\n  session.activeTerminal = terminal.id\n}\n\nexport function findTerminal(session: Session, id: string) {\n  return session.terminals.find((terminal) => terminal.id === id)\n}\n\nexport function renameSession(session: Session, name: string) {\n  const trimmed = name.trim()\n  if (!trimmed) throw new Error("Name is required")\n  session.name = trimmed\n}\n'
write('workspace.ts', codeHeader + 'export function createSession(name: string): Session {\n  return { id: crypto.randomUUID(), name, terminals: [] }\n}\n' + codeTail)
write('notes.txt', 'Pello 工作清单\n\nTODO 启动开发终端\nTODO 打开项目文件\nTODO 审阅 Git 变更\n\n每个文件都有自己的草稿与撤销记录。\n')
write('preview.html', '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>body{font:20px "Segoe UI","Microsoft YaHei",sans-serif;padding:50px;color:#243e33;background:#f3f6f0}h1{font-size:42px}small{color:#426348}article{border-top:2px solid #73a67a;margin-top:40px;padding-top:24px}b{font-size:56px}</style><small>PELLO / 项目内 HTML</small><h1>让想法留在工作区</h1><p>编辑源码，切回预览，看到当前草稿。</p><article><b>01</b><p>运行任务 → 编辑文件 → 审阅变更</p></article></html>')
write('diagram.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600" viewBox="0 0 900 600"><rect width="900" height="600" fill="#f2f5ef"/><g font-family="Segoe UI" fill="#234539"><text x="60" y="100" font-size="40">Pello / workspace</text><text x="60" y="150" font-size="22">One task. Everything within reach.</text></g><g fill="#d7e8d4"><rect x="60" y="230" width="230" height="230" rx="12"/><rect x="335" y="230" width="230" height="230" rx="12"/><rect x="610" y="230" width="230" height="230" rx="12"/></g><g fill="#234539" font-size="28" font-family="Segoe UI"><text x="95" y="315">01</text><text x="95" y="390">Terminal</text><text x="370" y="315">02</text><text x="370" y="390">Files</text><text x="645" y="315">03</text><text x="645" y="390">Git diff</text></g></svg>')
const git = (...args) => execFileSync('git', args, { cwd: project, windowsHide: true, stdio: 'ignore' })
git('init', '-b', 'main'); git('config', 'core.autocrlf', 'false'); git('add', '.'); git('-c', 'user.name=Pello Demo', '-c', 'user.email=demo@example.invalid', 'commit', '-qm', 'Start workspace')
write('workspace.ts', codeHeader + 'export function createSession(name: string): Session {\n  const trimmed = name.trim()\n  if (!trimmed) throw new Error("Name is required")\n  return {\n    id: crypto.randomUUID(),\n    name: trimmed,\n    terminals: [],\n    activeTerminal: undefined\n  }\n}\n' + codeTail)
for (const name of ['project-review', 'writing-guide']) {
  const dir = path.join(home, '.claude/skills', name); fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name === 'project-review' ? '按项目约定检查代码、测试与变更范围' : '编写清晰的操作指南与示例'}\n---\n# ${name}\n\n## 使用步骤\n\n1. 阅读当前项目。\n2. 解释具体操作与结果。\n3. 完成相关验证。\n`)
}
fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { 'project-files': { command: 'node', args: ['./tools/files.mjs'] } } }))
fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify({
  settings: { theme: 'light', layout: 'balanced', uiFontSize: 14, editorFontSize: 16, fontSize: 16, restore: true, confirmKill: false, defShell: 'pwsh', defAgent: 'shell', autoCheckUpdates: false },
  projects: [{ id: 'p', name: 'Pello Demo', host: 'local', path: project, agent: 'shell' }],
  sessions: { p: [{ id: 'dev', kind: 'shell', shell: 'pwsh', name: '开发终端', sessionId: 'development' }, { id: 'review', kind: 'shell', shell: 'pwsh', name: '审阅终端', sessionId: 'reviewing' }] },
  workSessions: { p: [{ id: 'development', name: '功能开发', activeTab: 'dev' }, { id: 'reviewing', name: '变更审阅', activeTab: 'review' }] },
  activeTab: { p: 'dev' }, activeSession: { p: 'development' }
}))
const env = { ...process.env, AWB_USER_DATA: data, AWB_RESOURCE_HOME: home }; delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: [root, '--force-device-scale-factor=1'], env })
const extras = process.argv.includes('--extras'), polish = process.argv.includes('--polish')
const tutorials = extras || polish ? JSON.parse(fs.readFileSync(path.join(output, 'manifest.json'), 'utf8')).tutorials.filter((item) => !extras || !['17-executors', '18-ssh'].includes(item.id)) : []
try {
  const page = await app.firstWindow(); page.setDefaultTimeout(12000)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900))
  await installDocumentHarness(app, page, false)
  await page.waitForFunction(() => window.__awbBuffer?.('dev')?.includes('>'))
  const shell = async (id, text) => {
    await page.evaluate(({ id, text }) => window.awb.ptyWrite(id, text + '\r'), { id, text })
    await page.waitForTimeout(500)
  }
  for (const id of ['dev', 'review']) await shell(id, "function prompt { 'PS pello-demo> ' }; Clear-Host")
  await shell('dev', 'git -c color.ui=always diff -- workspace.ts')
  await shell('dev', "Write-Host 'Pello workspace ready' -ForegroundColor Green; Write-Host 'TODO build | TODO review | TODO document'")
  await shell('review', 'git status --short')
  const files = () => page.click('[data-a=rmode][data-id=files]')
  const open = async (file) => { await files(); await page.click(`[data-a=preview][data-id="${file}"]`); await page.waitForTimeout(700) }
  const tab = (id) => page.locator(`[data-a=tab][data-id="${id}"]`)
  const section = async (id) => { if (!await page.locator('[data-a=sec]').count()) await page.click('[data-a=settings]'); await page.click(`[data-a=sec][data-id=${id}]`) }
  let current
  const start = (id, title, wiki, note = '') => { current = { id, title, wiki, note, steps: [] }; tutorials.push(current) }
  const shot = async (caption, target = null) => {
    await page.evaluate(() => document.fonts.ready); await page.mouse.move(1400, 880); await page.waitForTimeout(350)
    const file = `${current.id}-${current.steps.length + 1}.jpg`
    const box = target ? await page.locator(target).first().boundingBox() : null
    const dialog = target?.includes('dlg') || target === 'dialog'
    const zoom = box ? Math.max(1, Math.min(1.85, 1440 / Math.max(box.width + 160, 780), dialog ? 900 / (box.height + 60) : 2)) : 1
    const focus = box ? [Math.round(box.x + box.width / 2), Math.round(dialog || box.height < 500 ? box.y + box.height / 2 : box.y + 220), zoom] : [720, 450, 1]
    await page.screenshot({ path: path.join(output, file), type: 'jpeg', quality: 91, animations: 'disabled' })
    current.steps.push({ file, caption, focus }); fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify({ width: 1440, height: 900, tutorials }, null, 2))
    console.log(`${current.id}: ${caption}`)
  }
  if (!extras && !polish) {
  start('01-start', '启动第一个终端', 'Getting-Started')
  await page.locator('[data-a=proj][data-id=p]').hover(); await page.click('[data-a=new-session][data-id=p]')
  await shot('01  项目旁的加号：为任务选择执行器', '#modal .dlg')
  await page.click('[data-a=ntk][data-id=shell]'); await shot('02  首次体验选「仅 Shell」，Agent 需预先安装', '#modal .dlg')
  await page.click('[data-a=nt-ok]'); await page.locator('#modal .dlg').waitFor({ state: 'detached' })
  await shot('03  出现终端标签，就可以输入命令了', '#center')
  await page.click('[data-a=side-session][data-id=development]'); await tab('dev').click()

  start('02-sessions', '项目与会话，保留工作现场', 'Sessions')
  await shot('01  同一个项目，把开发与审阅分成两个会话', '.side')
  await page.click('[data-a=side-session][data-id=reviewing]'); await shot('02  切到「变更审阅」，查看另一个终端', '#center')
  await page.click('[data-a=side-session][data-id=development]'); await tab('dev').click(); await shot('03  切回开发，原来的输出还在', '#center')
  await page.locator('[data-a=proj][data-id=p]').dispatchEvent('contextmenu'); await shot('04  右键项目可置顶、改名、复制路径', '[role=menu]'); await page.keyboard.press('Escape')

  start('03-terminal', '终端内搜索与高亮', 'Terminal')
  await page.locator('.xterm:visible').click(); await page.keyboard.press('Control+f'); await page.getByRole('textbox', { name: '查找内容', exact: true }).fill('TODO')
  await shot('01  Ctrl+F 搜索当前终端，显示匹配计数', '.terminal-search')
  await page.getByRole('button', { name: '下一个匹配', exact: true }).click(); await shot('02  前后导航，直接定位输出中的匹配文字', '#center')
  await page.keyboard.press('Escape')
  const screen = await page.locator('.xterm-screen:visible').boundingBox(), geometry = await page.evaluate(() => window.__awbGeometry('dev'))
  const line = geometry.visibleText.split('\n').findIndex((text) => text.startsWith('TODO build'))
  const cell = screen.width / geometry.cols, row = screen.height / geometry.rows
  await page.mouse.move(screen.x + cell * 0.1, screen.y + row * (line + 0.5)); await page.mouse.down()
  await page.mouse.move(screen.x + cell * 4.1, screen.y + row * (line + 0.5), { steps: 12 }); await page.mouse.up()
  await page.locator('.xterm:visible').dispatchEvent('contextmenu'); await shot('03  选中文字后右键，用六色高亮标记关键输出', '[role=menu]')
  await page.locator('[data-command=highlight-amber]').click(); await shot('04  同一关键词的多处匹配一起高亮', '#center')

  start('04-files', '文件标签与草稿', 'Files-and-Editing')
  await open('notes.txt'); await shot('01  单击文件，打开自己的标签', '#center')
  const source = page.getByRole('textbox', { name: '文件内容', exact: true })
  await source.fill('Pello 工作清单\n\nDONE 启动开发终端\nTODO 打开项目文件\nTODO 审阅 Git 变更\n\n草稿还没有写入磁盘。\n'); await shot('02  编辑后标签出现未保存标记，Ctrl+Z 可撤销', '#center')
  await source.press('Control+s'); await shot('03  Ctrl+S 保存当前文件，撤销历史仍然保留', '#center')

  start('05-search', '从项目搜索直达源码', 'Project-Search')
  await page.keyboard.press('Control+e'); await page.getByRole('textbox', { name: '搜索文件', exact: true }).fill('workspace'); await shot('01  Ctrl+E 按文件名或相对路径查找', '.right')
  await page.getByRole('textbox', { name: '搜索文件', exact: true }).fill('')
  await page.keyboard.press('Control+Shift+f'); await page.getByRole('textbox', { name: '搜索内容', exact: true }).fill('createSession'); await page.waitForTimeout(900); await shot('02  Ctrl+Shift+F 搜索内容，可选大小写、全字、正则', '.right')
  await page.locator('.content-search-hit').first().click(); await shot('03  点击片段定位源码，搜索结果继续留在右侧', '#center')

  start('06-replace', '查找、替换与撤销', 'Find-and-Replace')
  await open('notes.txt'); await source.click(); await page.keyboard.press('Control+h'); await page.getByRole('textbox', { name: '查找内容', exact: true }).fill('TODO'); await shot('01  Ctrl+H 展开替换，正文不会被挤走', '.document-search')
  await page.getByRole('textbox', { name: '替换为', exact: true }).fill('DONE'); await page.getByRole('button', { name: '全部替换', exact: true }).click(); await shot('02  全部替换只修改草稿，保存仍由你决定', '#center')
  await page.keyboard.press('Escape'); await source.press('Control+z'); await shot('03  Ctrl+Z 撤销替换，回到原来的内容', '#center')

  start('07-markdown', '直接阅读与编辑 Markdown', 'Markdown-and-HTML')
  await open('guide.md'); await page.getByRole('textbox', { name: 'Markdown 内容', exact: true }).waitFor(); await shot('01  Markdown 默认以排版后的内容打开', '#center')
  await page.keyboard.press('Control+f'); await page.getByRole('textbox', { name: '查找内容', exact: true }).fill('会话'); await shot('02  在渲染模式查找，自动定位匹配内容', '#center'); await page.keyboard.press('Escape')
  await page.locator('.markdown-editor').hover(); await page.keyboard.down('Control'); await page.mouse.wheel(0, -360); await page.keyboard.up('Control'); await shot('03  Ctrl+滚轮放大当前文档，便于阅读', '#center')

  start('08-html', '在工作区预览网页', 'Markdown-and-HTML')
  await open('preview.html'); await page.locator('iframe').waitFor(); await shot('01  HTML 在独立沙箱内预览', '#center')
  await app.evaluate(() => { globalThis.__documentMenuCommand = 'mode' }); await page.locator('.file-content:visible').dispatchEvent('contextmenu'); await page.waitForTimeout(500); await shot('02  正文右键切到源码，编辑当前文件', '#center')
  await app.evaluate(() => { globalThis.__documentMenuCommand = 'mode' }); await page.locator('.file-content:visible').dispatchEvent('contextmenu'); await page.waitForTimeout(500); await shot('03  切回预览，查看当前草稿', '#center')

  start('09-media', '图片与 PDF 留在标签里', 'Media-Preview')
  await open('diagram.svg'); await page.locator('.media-preview img').waitFor(); await shot('01  项目内图片直接预览，不必切换应用', '#center')
  await page.getByRole('button', { name: '放大', exact: true }).click(); await shot('02  放大查看细节，缩放范围 25%–400%', '.media-preview')
  await page.getByRole('button', { name: '适应窗口', exact: true }).click(); await shot('03  一键适应窗口，回到完整画面', '#center')

  start('10-git', '边审阅，边修改', 'Git-Review')
  await page.click('[data-a=rmode][data-id=changes]'); await page.click('[data-a=diff][data-id="workspace.ts"]'); await shot('01  进入变更，点击文件打开 Diff', '#center')
  await page.click('[data-a=dmode][data-id=split]'); await shot('02  并排查看比较基准与工作区，两侧均可编辑', '#center')
  await page.click('[data-a=dmode][data-id=unified]'); await shot('03  同一按钮组切回统一视图，Ctrl+S 保存工作区', '#center')

  start('11-split', '终端、文件与 Diff 混合分栏', 'Split-Workspace')
  await open('workspace.ts'); const id = await page.locator('[data-a=editor-group][data-focused=true] .tab.on [data-a=tab]').getAttribute('data-id')
  await shot('01  标签右键支持上下左右分栏，最多四栏', '#center')
  await app.evaluate(() => { globalThis.__documentMenuCommand = 'split-right' }); await tab(id).dispatchEvent('contextmenu'); await page.waitForTimeout(500); await shot('02  向右分栏，同一个文件拥有独立视图', '#center')
  await tab('dev').click(); await shot('03  一侧保留终端，一侧阅读代码', '#center')
  await app.evaluate(() => { globalThis.__documentMenuCommand = 'merge' }); await tab('dev').dispatchEvent('contextmenu'); await page.waitForTimeout(350)

  start('12-resources', 'MCP 与 Skill 原生资源', 'Agent-Resources', '示例资源只用于演示配置，不启动 MCP 服务器。')
  await section('mcp'); await shot('01  设置 → MCP，按 Agent 查看实际配置', '.scol')
  await page.getByRole('button', { name: '查看 project-files 详情', exact: true }).click(); await shot('02  详情查看命令与参数，认证信息会脱敏', 'dialog, #modal .dlg'); await page.keyboard.press('Escape')
  await section('skills'); await page.getByRole('button', { name: '查看 project-review 详情', exact: true }).click(); await shot('03  Skill 可阅读完整说明，再决定是否启用', 'dialog, #modal .dlg'); await page.keyboard.press('Escape')

  start('13-discovery', '浏览推荐 Skill', 'Skill-Discovery')
  await page.getByRole('button', { name: '推荐', exact: true }).click(); await shot('01  「推荐」列出五个仓库，点击在系统浏览器打开', 'dialog')
  await page.keyboard.press('Escape'); await page.getByRole('button', { name: '添加', exact: true }).click(); await shot('02  「添加」可从本机导入目录或 ZIP', 'dialog'); await page.keyboard.press('Escape')

  start('14-appearance', '语言、主题与独立字号', 'Appearance')
  await section('look'); await shot('01  六套主题，终端与界面同步切换', '.themes')
  await page.click('[data-a=theme][data-id=dark]'); await shot('02  深色主题立即生效，终端实例保持不变', '.scol')
  await page.click('[data-a=theme][data-id=light]'); await page.getByLabel('终端字体', { exact: true }).selectOption('JetBrains Mono'); await shot('03  字体、终端字号、界面字号与源码字号分别设置', '.scol')
  await section('general'); await page.locator('[data-set=language]').selectOption('en'); await shot('04  English / 简体中文，即时切换并保存', '.scol'); await page.locator('[data-set=language]').selectOption('zh-CN')

  start('15-updates', '更新与数据随安装目录保存', 'Updates-and-Data', '开发版只展示真实设置入口，下载与安装步骤见文字指南。')
  await section('general'); await page.locator('.app-update-settings').scrollIntoViewIfNeeded(); await shot('01  设置 → 通用 → 应用更新，统一完成更新操作', '.app-update-settings')
  await page.getByRole('switch', { name: '自动检查更新', exact: true }).click(); await shot('02  自动检查可以关闭，发行版仍可手动检查', '.app-update-settings')
  await section('about'); await shot('03  关于页查看实际版本，再选择对应发行说明', '.scol')
  await page.click('[data-a=back]')

  start('16-temporary', '为临时任务创建独立目录', 'Sessions')
  await page.locator('[data-a=temporary-toggle]').hover(); await page.click('[data-a=temporary-session]'); await shot('01  临时会话分组的加号，选择运行环境与根目录', '#modal .dlg')
  await page.getByLabel('临时会话目录', { exact: true }).fill(path.join(data, 'TempSessions')); await page.getByRole('button', { name: '保存并新建', exact: true }).click(); await shot('02  先选择执行器，取消时不会创建任务目录', '#modal .dlg')
  await page.click('[data-a=ntk][data-id=shell]'); await page.click('[data-a=nt-ok]'); await page.locator('#modal .dlg').waitFor({ state: 'detached' }); await page.waitForTimeout(600); await shot('03  每个新任务拥有 UUID 目录与 AGENTS.md 约束', '#center')
  }
  if (extras) {
    start('17-executors', '选择与扩展 Agent 执行器', 'Executors')
    await section('agents'); await shot('01  内置五种 Code Agent，也支持纯 Shell', '.scol')
    await page.click('[data-a=custom]:not([data-id])'); await shot('02  自定义 CLI：填写命令、参数与 Shell', '#modal .dlg')
    await page.click('[data-a=ce-more]'); await shot('03  高级属性配置原生资源路径与会话恢复参数', '#modal .dlg'); await page.keyboard.press('Escape')
    await page.click('[data-a=back]')
    // Two small, locally generated PDF pages; no user document is read.
    const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 700] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 700] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
    for (const [heading, body] of [['Pello / Project brief', '01  Run a terminal.'], ['Pello / Review checklist', '02  Read files.  03  Review changes.']]) {
      const stream = `0.15 0.27 0.21 rg BT /F1 30 Tf 55 590 Td (${heading}) Tj 0 -80 Td /F1 20 Tf (${body}) Tj ET`
      objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`)
    }
    let body = '%PDF-1.4\n'; const offsets = [0]
    objects.forEach((object, i) => { offsets.push(Buffer.byteLength(body)); body += `${i + 1} 0 obj\n${object}\nendobj\n` })
    const xref = Buffer.byteLength(body)
    body += `xref\n0 8\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
    write('brief.pdf', body)
    await open('brief.pdf'); await page.locator('.pdf-page[data-rendered=true]').waitFor()
    current = tutorials.find((item) => item.id === '09-media')
    await shot('04  PDF 也在标签内阅读，支持页码与跨页查找', '#center')
    await page.getByRole('button', { name: '下一页', exact: true }).click(); await page.locator('.pdf-page[data-rendered=true][data-page="2"]').waitFor(); await shot('05  翻到下一页，继续保留其他文件的标签与草稿', '#center')
    start('18-ssh', '连接远程机器与浏览目录', 'SSH-and-Transfer', '回环地址上的隔离 SSH 服务；真实认证并执行本机 PowerShell 目录查询。')
    const { generateKeyPairSync } = await import('node:crypto'), { spawn } = await import('node:child_process'), { default: ssh2 } = await import('ssh2')
    const hostKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' })
    const clients = new Set(), workers = new Set(), authKey = 'pass' + 'word'
    const server = new ssh2.Server({ hostKeys: [hostKey] }, (client) => {
      clients.add(client); client.on('error', () => {}); client.once('close', () => clients.delete(client))
      client.on('authentication', (ctx) => ctx.method === authKey && ctx[authKey] === 'tutorial-only' ? ctx.accept() : ctx.reject([authKey]))
      client.on('ready', () => client.on('session', (accept) => accept().on('exec', (accept, _reject, info) => {
        const stream = accept(), encoded = /-EncodedCommand\s+([A-Za-z0-9+/=]+)/i.exec(info.command)?.[1]
        const child = encoded ? spawn('powershell.exe', ['-NoProfile', '-EncodedCommand', encoded], { windowsHide: true }) : spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', info.command], { windowsHide: true })
        workers.add(child); child.stdin.on('error', () => {}); child.stdout.on('data', (chunk) => { if (!stream.destroyed) stream.write(chunk) }); child.stderr.on('data', (chunk) => { if (!stream.destroyed) stream.stderr.write(chunk) })
        stream.on('data', (chunk) => child.stdin.write(chunk)); stream.on('end', () => child.stdin.end()); if (!encoded) child.stdin.end()
        stream.once('close', () => { if (child.exitCode === null) child.kill() }); child.once('close', (code) => { workers.delete(child); if (!stream.destroyed) { stream.exit(code || 0); stream.end() } })
      })))
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      await section('hosts'); await page.click('[data-a=host]:not([data-id])')
      await page.getByLabel('名称', { exact: true }).fill('Demo SSH'); await page.getByLabel('用户', { exact: true }).fill('demo')
      await page.getByLabel('地址', { exact: true }).fill('127.0.0.1'); await page.getByLabel('端口', { exact: true }).fill(String(server.address().port))
      await page.getByLabel('认证方式', { exact: true }).selectOption(authKey); await page.getByLabel('登录密码', { exact: true }).fill('tutorial-only')
      await shot('01  填写主机与认证，连接通过后才能保存', '#modal .dlg')
      await page.click('[data-a=hsave]'); await page.locator('#modal .dlg').waitFor({ state: 'detached' })
      await page.click('[data-a=back]'); await page.locator('[data-a=projects-toggle]').hover(); await page.click('[data-a=newproj]'); await page.locator('[data-a=nph]').filter({ hasText: 'Demo SSH' }).click()
      await page.locator('[data-np=path]').fill(project); await shot('02  新建项目选择通过连接验证的 SSH 机器', '#modal .dlg')
      await page.click('[data-a=browse]'); await page.getByLabel('浏览路径', { exact: true }).waitFor(); await page.getByRole('button', { name: 'examples', exact: true }).waitFor()
      await shot('03  浏览打开独立目录选择器，可直接编辑路径', 'dialog')
      await page.getByLabel('浏览路径', { exact: true }).fill(data); await page.getByLabel('浏览路径', { exact: true }).press('Enter'); await page.locator('.directory-entry').filter({ hasText: 'pello-demo' }).waitFor()
      await page.locator('.directory-entry').filter({ hasText: 'pello-demo' }).click(); await shot('04  单击选中，双击进入；确认后返回项目表单', 'dialog')
      await page.getByRole('button', { name: /^使用此目录/ }).click(); await shot('05  所选远程目录回填，后续文件与终端使用此项目', '#modal .dlg'); await page.keyboard.press('Escape')
    } finally { for (const child of workers) child.kill(); for (const client of clients) client.destroy(); await new Promise((resolve) => server.close(resolve)) }
  }
  if (polish) {
    current = tutorials.find((item) => item.id === '01-start'); current.steps = current.steps.slice(0, 2)
    await page.locator('[data-a=proj][data-id=p]').hover(); await page.click('[data-a=new-session][data-id=p]'); await page.click('[data-a=ntk][data-id=shell]'); await page.click('[data-a=nt-ok]')
    await page.locator('#modal .dlg').waitFor({ state: 'detached' })
    const created = await page.locator('[data-a=editor-group][data-focused=true] .tab.on [data-a=tab]').getAttribute('data-id')
    await page.waitForFunction((id) => window.__awbBuffer?.(id)?.includes('>'), created)
    await shell(created, "function prompt { 'PS pello-demo> ' }; Clear-Host; echo 'Hello Pello'")
    await page.waitForFunction((id) => window.__awbBuffer(id).includes('Hello Pello'), created)
    await shot('03  输入 echo Hello Pello，看到第一条输出', '#center')
    current = tutorials.find((item) => item.id === '08-html'); current.steps = []
    await open('preview.html'); await page.frameLocator('iframe:visible').getByRole('heading', { name: '让想法留在工作区', exact: true }).waitFor(); await shot('01  HTML 在独立沙箱内预览', '#center')
    await app.evaluate(() => { globalThis.__documentMenuCommand = 'mode' }); await page.locator('.file-content:visible').dispatchEvent('contextmenu')
    const html = page.getByRole('textbox', { name: '文件内容', exact: true }); await html.waitFor()
    await html.fill((await html.inputValue()).replace('让想法留在工作区', '预览跟着草稿一起更新').replaceAll('><', '>\n<'))
    await shot('02  正文右键切源码，修改标题，保留未保存草稿', '#center')
    await app.evaluate(() => { globalThis.__documentMenuCommand = 'mode' }); await page.locator('.file-content:visible').dispatchEvent('contextmenu')
    await page.frameLocator('iframe:visible').getByRole('heading', { name: '预览跟着草稿一起更新', exact: true }).waitFor(); await shot('03  切回预览，立即看到草稿里的新标题', '#center')
    const originalHtml = fs.readFileSync(path.join(project, 'preview.html'), 'utf8')
    if (!originalHtml.includes('让想法留在工作区') || originalHtml.includes('预览跟着草稿一起更新')) throw new Error('Preview unexpectedly saved the draft')
    // Reset only the synthetic draft before leaving; native quit confirmation
    // blocks Electron's debugger and must never be bypassed by a test hook.
    await app.evaluate(() => { globalThis.__documentMenuCommand = 'mode' }); await page.locator('.file-content:visible').dispatchEvent('contextmenu')
    await html.fill(originalHtml)
    current = tutorials.find((item) => item.id === '16-temporary'); current.steps = []
    await page.locator('[data-a=temporary-toggle]').hover(); await page.click('[data-a=temporary-session]'); await shot('01  临时会话分组的加号，选择运行环境与根目录', '#modal .dlg')
    await page.getByLabel('临时会话目录', { exact: true }).fill(path.join(data, 'TempSessions')); await page.getByRole('button', { name: '保存并新建', exact: true }).click(); await shot('02  先选择执行器，取消时不会创建任务目录', '#modal .dlg')
    await page.click('[data-a=ntk][data-id=shell]'); await page.click('[data-a=nt-ok]'); await page.locator('#modal .dlg').waitFor({ state: 'detached' })
    const temp = await page.locator('[data-a=editor-group][data-focused=true] .tab.on [data-a=tab]').getAttribute('data-id')
    await page.waitForFunction((id) => window.__awbBuffer?.(id)?.includes('>'), temp)
    await shell(temp, "Get-ChildItem -Name; Get-Content AGENTS.md -TotalCount 8")
    await page.waitForFunction((id) => window.__awbBuffer(id).includes('CLAUDE.md'), temp)
    await shot('03  UUID 目录里已生成 AGENTS.md 与 CLAUDE.md', '#center')
  }
} catch (error) {
  const page = await app.firstWindow(); await page.screenshot({ path: path.join(raw, 'failure.png') }); fs.writeFileSync(path.join(raw, 'failure.html'), await page.content()); throw error
} finally { await app.close() }
console.log(`Recorded ${tutorials.length} tutorials; source profile: ${data}`)
