import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ts from 'typescript'
import { launchWorkbench } from './fixtures/launch-workbench.mjs'
import { loadTypeScript } from './fixtures/load-ts.mjs'
import { installDocumentHarness } from './fixtures/document-harness.mjs'
import { kernelMessages } from './fixtures/kernel-messages.mjs'

const { t, setLanguage, hasMessageFragment, isMessage } = await loadTypeScript(new URL('../src/shared/i18n.ts', import.meta.url))
const { en } = await loadTypeScript(new URL('../src/shared/locales/en.ts', import.meta.url))
// Every application message must have a translation with the same parameters.
for (const directory of ['src/main', 'src/renderer', 'src/shared']) for (const name of fs.readdirSync(directory).filter((name) => /\.tsx?$/.test(name))) {
  const ast = ts.createSourceFile(name, fs.readFileSync(path.join(directory, name), 'utf8'), ts.ScriptTarget.Latest, true)
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 't') {
      assert.ok(ts.isStringLiteral(node.arguments[0]), `${directory}/${name}: translate fixed application messages only`)
      const source = node.arguments[0].text
      assert.ok(Object.hasOwn(en, source), `Missing translation: ${source}`)
      const parameters = (value) => [...value.matchAll(/\{\{\d+\}\}/g)].map((match) => match[0]).sort()
      assert.deepEqual(parameters(en[source]), parameters(source), `Parameter mismatch: ${source}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
}
// The Rust kernel carries the Electron build's main-process messages, and
// says each one as the catalog says it. A message of the kernel's own is
// listed here with what makes it the kernel's, and in no other way.
const { entries, callers, menu } = kernelMessages()
const parameters = (value) => [...value.matchAll(/\{\{\d+\}\}/g)].map((match) => match[0]).sort()
const english = new Map(entries.map((entry) => [entry.source, entry.english]))
assert.equal(english.size, entries.length, 'The kernel catalog has a message twice')
for (const entry of entries) {
  assert.deepEqual(parameters(entry.english), parameters(entry.source), `src-tauri/core/src/i18n.rs:${entry.line}: Parameter mismatch: ${entry.source}`)
  if (Object.hasOwn(en, entry.source)) assert.equal(entry.english, en[entry.source], `src-tauri/core/src/i18n.rs:${entry.line}: The kernel words "${entry.source}" other than the catalog`)
}
const kernelOnly = new Map([
  // The Electron build lets Electron's own calls fail, and shows what they
  // said. This build has to say it itself. A source is compared as it is
  // written in the Rust sources, so the newline is written as Rust writes it.
  ['无法使用安装目录中的数据文件夹：{{0}}。请确认该目录可写。\\n{{1}}', 'the data folder is found by the kernel, where Electron found it'],
  ['无法移入回收站', 'Electron shows the error of its own trashItem'],
  ['无法在资源管理器中打开', 'Electron shows the error of its own shell.openPath'],
  ['目录选择器已关闭', 'Electron shows the error of its own showOpenDialog'],
  ['项目记录被意外修改', 'said of a save the kernel refused'],
  ['SSH 连接超时', 'Electron kept waiting, and its ssh2 said something else'],
  ['图表渲染器不可用', 'the kernel runs the diagram renderer in a process of its own'],
  ['内容搜索进程无法启动', 'the kernel runs the search in a process of its own'],
  // Said by a control of this build that the Electron build did not have.
  ['退出', 'the application menu of this shell'],
  ['所有文件', 'the save dialog of this shell offers a filter by name'],
  // A port that is not finished says so, and does not pretend.
  ['此功能尚未在 Rust 移植中实现：{{0}}', 'a feature that is not ported yet'],
  ['上传不再询问同名处理', 'the port is ahead of the catalog here'],
  // The Electron build ends a cancelled search without a word.
  ['搜索已取消', 'the kernel reports a cancelled search as an error'],
  // The Electron build says this from a change that is not ported yet
  // (e665eb5), so the catalog of this branch does not have it: it goes with
  // the port, and this line with it.
  ['刷新文件', 'the Electron build says it, from a change not ported yet (e665eb5)'],
])
for (const entry of entries) {
  if (Object.hasOwn(en, entry.source)) continue
  assert.ok(kernelOnly.has(entry.source), `src-tauri/core/src/i18n.rs:${entry.line}: Not in the catalog and not the kernel's own: ${entry.source}`)
}
for (const [source] of kernelOnly) assert.ok(english.has(source), `Listed as the kernel's own and no longer said: ${source}`)
for (const caller of callers.filter((caller) => caller.source !== null)) {
  assert.ok(english.has(caller.source), `src-tauri/core/src/${caller.file}:${caller.line}: The kernel has no English for: ${caller.source}`)
}
// A message that reaches `translate` through a variable comes from one of
// these helpers, each of which translates what it is given and nothing else:
// a closure of the menu module, whose texts are the menu's; a helper that
// translates and quotes what it is given for a remote script; a helper that
// writes what it is given as a quoted string; the two names a search error
// goes by; and the shorthand of the resource and template modules, each
// called with a literal message only. A function that translates a variable
// is not one of them until it is said here.
const passesVariable = new Map([
  ['menu.rs', ['layout_menu_items', 'tree_menu', 'file_menu', 'preview_menu']],
  ['resources.rs', ['t']],
  ['templates.rs', ['t']],
  ['search.rs', ['from_remote_output', 'next']],
  ['ssh.rs', ['ps_error']],
  ['upload.rs', ['quoted_message', 'windows_upload_library', 'windows_write_script']],
])
for (const caller of callers.filter((caller) => caller.source === null)) {
  assert.ok(passesVariable.get(caller.file)?.includes(caller.within), `src-tauri/core/src/${caller.file}:${caller.line} (${caller.within}): translate fixed messages only, or say here what passes ${caller.passed} on`)
}
for (const [file, names] of passesVariable) for (const name of names) assert.ok(callers.some((caller) => caller.source === null && caller.file === file && caller.within === name), `Said to pass a message on, and no longer does: ${file} ${name}`)
for (const { line, text } of menu) assert.ok(english.has(text), `src-tauri/core/src/menu.rs:${line}: A menu text with no English: ${text}`)
console.log(`PASS kernel messages (${entries.length} in the catalog, ${callers.filter((caller) => caller.source !== null).length} translated in place, ${kernelOnly.size} of the kernel's own)`)
setLanguage('en')
assert.equal(t('临时会话'), 'TempSessions')
assert.equal(t('会话 {{0}}', '会话一 $& {{1}}'), 'Session 会话一 $& {{1}}', 'Names must remain verbatim')
assert.ok(hasMessageFragment('临时上传保留于 D:/safe', '保留于'))
assert.ok(hasMessageFragment('staged upload retained at D:/safe', '保留于'))
assert.ok(isMessage('部分内容未能上传', '部分内容未能上传'))
assert.ok(isMessage('Some content could not be uploaded', '部分内容未能上传'))
setLanguage('invalid')
assert.equal(t('新建项目'), '新建项目')
console.log(`PASS translation coverage and interpolation (${Object.keys(en).length} messages)`)

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pello-i18n-'))
const shell = process.platform === 'win32' ? 'pwsh' : 'bash'
const projects = ['normal', 'old-temp-a', 'old-temp-b'].map((id, index) => {
  const directory = path.join(data, id)
  fs.mkdirSync(directory)
  return { id, name: ['普通项目 $&', '旧临时会话 A', '旧临时会话 B'][index], host: 'local', path: directory, agent: 'shell', temporary: index > 0 }
})
fs.writeFileSync(path.join(projects[0].path, 'draft.txt'), 'ORIGINAL_TEXT\n')
fs.writeFileSync(path.join(projects[0].path, 'guide.md'), '# 原始标题\n\n```js\nconst greeting = "原文内容"\n```\n')
fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify({ settings: { restore: true, confirmKill: false, defAgent: 'shell', defShell: shell, layout: 'balanced' }, projects,
  sessions: Object.fromEntries(projects.map((project) => [project.id, [{ id: `term-${project.id}`, kind: 'shell', shell }]])) }))
const env = { ...process.env, AWB_USER_DATA: data }
delete env.ELECTRON_RUN_AS_NODE
const shots = path.resolve('output/playwright/i18n')
fs.mkdirSync(shots, { recursive: true })
let app = await launchWorkbench({ args: ['.'], env })
let page
try {
  page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  await installDocumentHarness(app, page, false)
  const state = () => page.evaluate(() => window.awb.getState())
  const session = (id) => page.locator(`[data-a=side-session][data-id="session:${id}"]`)
  const tab = (id) => page.locator(`[data-a=tab][data-id="${id}"]`)
  const rename = async (value, method = 'enter') => {
    const input = page.getByRole('textbox', { name: /^(新名称|New name)$/ })
    await input.fill(value)
    if (method === 'enter') await input.press('Enter')
    else await page.getByRole('button', { name: /^(保存名称|Save name)$/ }).click()
    await input.waitFor({ state: 'detached' })
  }
  await session('old-temp-a').waitFor()
  assert.equal((await page.locator('[data-a=temporary-toggle]').textContent()).trim(), '临时会话')
  assert.equal(await page.locator('[data-a=temporary-toggle] svg').count(), 1, 'Only the disclosure chevron remains before the heading')
  assert.equal(await page.locator('[data-a=proj]').count(), 1)
  assert.equal(await page.locator('.temporary-group [data-a=side-session]').count(), 2)
  assert.ok((await session('old-temp-a').textContent()).includes('旧临时会话 A'))
  assert.equal((await state()).db.settings.language, 'zh-CN', 'Existing users retain Chinese by default')
  await page.locator('[data-a=temporary-toggle]').press('ArrowLeft')
  assert.equal(await page.locator('.temporary-group [data-a=side-session]').count(), 0)
  await page.locator('[data-a=temporary-toggle]').press('ArrowRight')
  await session('old-temp-a').click()
  await page.waitForFunction((windows) => { const text = window.__awbBuffer('term-old-temp-a'); return typeof text === 'string' && (windows ? text.includes('>') : text.includes('$')) }, process.platform === 'win32')
  await page.evaluate(() => { window.__localeTerminal = document.querySelector('[data-term="term-old-temp-a"] .xterm') })
  await session('old-temp-a').dblclick()
  await rename('临时排查 $&')
  assert.equal((await state()).db.workSessions['old-temp-a'][0].name, '临时排查 $&')
  await page.locator('[data-a=newterm]').locator('..').hover()
  await page.click('[data-a=newterm]')
  await page.click('[data-a=ntk][data-id=shell]'); await page.click('[data-a=nt-ok]')
  await page.locator('.dlg').waitFor({ state: 'detached' })
  const added = await page.locator('.tab.on [data-a=tab]').getAttribute('data-id')
  await page.waitForFunction(({ id, cwd }) => window.__awbBuffer(id).includes(cwd), { id: added, cwd: 'old-temp-a' })
  assert.equal((await state()).db.projects.length, 3, 'Tab plus must reuse the session directory')
  assert.equal((await state()).db.workSessions['old-temp-a'].length, 1)
  await tab('term-old-temp-a').dblclick(); await rename('终端日志 $&')
  await page.locator('[data-a=proj][data-id=normal]').press('F2'); await rename('项目重命名 $&')
  await session('normal').press('F2'); await rename('会话重命名 $&')
  await session('normal').click()
  await page.click('[data-a=rmode][data-id=files]')
  await page.locator('[data-a=preview][data-id="draft.txt"]').click()
  await page.getByRole('textbox', { name: '文件内容', exact: true }).fill('UNSAVED_DRAFT 中文')
  await page.click('[data-a=settings]')
  await page.locator('[data-set=language]').selectOption('en')
  await page.waitForFunction(() => document.documentElement.lang === 'en')
  await page.getByRole('heading', { name: 'General', exact: true }).waitFor()
  assert.equal(await page.locator('[data-set=language]').inputValue(), 'en')
  assert.equal((await page.locator('[data-a=temporary-toggle]').textContent()).trim(), 'TempSessions')
  assert.equal((await page.locator('[data-a=agents-toggle]').textContent()).trim(), 'Recent')
  const blockedSave = path.join(data, 'workbench.json.tmp')
  fs.mkdirSync(blockedSave)
  try {
    await page.locator('[data-set=language]').selectOption('zh-CN')
    await page.locator('.toast.bad').filter({ hasText: 'workbench.json.tmp' }).waitFor()
    assert.equal(await page.locator('[data-set=language]').inputValue(), 'en')
    assert.equal((await state()).db.settings.language, 'en', 'Failed save must preserve the active configuration')
  } finally { fs.rmdirSync(blockedSave) }
  for (const section of ['look', 'agents', 'hosts', 'keys']) {
    await page.locator(`[data-a=sec][data-id=${section}]`).click()
    const chinese = await page.locator('.scontent').evaluate((node) => /[\u3400-\u9fff]/.test(node.innerText.replaceAll('项目重命名 $&', '').replaceAll('会话重命名 $&', '').replaceAll('本机', '')))
    assert.equal(chinese, false, `${section} settings must use English`)
  }
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'New project', exact: true }).waitFor()
  const draft = page.getByRole('textbox', { name: 'File content', exact: true })
  assert.equal(await draft.inputValue(), 'UNSAVED_DRAFT 中文')
  await draft.press('Control+z')
  await page.waitForFunction(() => document.querySelector('textarea[aria-label="File content"]')?.value === 'ORIGINAL_TEXT\n')
  await draft.press('Control+y')
  await page.waitForFunction(() => document.querySelector('textarea[aria-label="File content"]')?.value === 'UNSAVED_DRAFT 中文')
  assert.equal(fs.readFileSync(path.join(projects[0].path, 'draft.txt'), 'utf8'), 'ORIGINAL_TEXT\n')
  await draft.press('Control+z')
  await page.locator('[data-a=preview][data-id="guide.md"]').click()
  await page.getByRole('textbox', { name: 'Markdown content', exact: true }).waitFor()
  await page.waitForFunction(() => [...document.querySelectorAll('.milkdown-code-block button')].some((button) => button.textContent.includes('Copy')))
  await page.evaluate(() => { window.__localeRich = document.querySelector('.ProseMirror') })
  await page.click('[data-a=settings]'); await page.click('[data-a=sec][data-id=general]'); await page.locator('[data-set=language]').selectOption('zh-CN')
  await page.waitForFunction(() => document.documentElement.lang === 'zh-CN')
  await page.keyboard.press('Escape')
  await page.getByRole('textbox', { name: 'Markdown 内容', exact: true }).waitFor()
  await page.waitForFunction(() => [...document.querySelectorAll('.milkdown-code-block button')].some((button) => button.textContent.includes('复制')))
  assert.equal(await page.evaluate(() => window.__localeRich === document.querySelector('.ProseMirror')), true)
  await page.click('[data-a=settings]'); await page.click('[data-a=sec][data-id=general]'); await page.locator('[data-set=language]').selectOption('en')
  await page.waitForFunction(() => document.documentElement.lang === 'en')
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => [...document.querySelectorAll('.milkdown-code-block button')].some((button) => button.textContent.includes('Copy')))
  assert.ok(fs.readFileSync(path.join(projects[0].path, 'guide.md'), 'utf8').includes('原文内容'))
  assert.ok((await session('normal').textContent()).includes('会话重命名 $&'), 'Language changes preserve user names')
  await session('old-temp-a').click()
  assert.ok((await tab('term-old-temp-a').textContent()).includes('终端日志 $&'))
  assert.equal(await page.evaluate(() => window.__localeTerminal === document.querySelector('[data-term="term-old-temp-a"] .xterm')), true)
  await tab('term-old-temp-a').press('F2')
  const input = page.getByRole('textbox', { name: 'New name', exact: true })
  await input.fill('   '); await input.press('Enter')
  await page.getByRole('alert').filter({ hasText: 'Name cannot be empty' }).waitFor()
  assert.equal(await input.inputValue(), '   ')
  await input.press('Escape')
  assert.equal(await tab('term-old-temp-a').evaluate((node) => node === document.activeElement), true)
  let menuLabels
  if (app.menuFile) {
    fs.rmSync(`${app.menuFile}.json`, { force: true })
    fs.writeFileSync(app.menuFile, 'rename')
    await tab('term-old-temp-a').click({ button: 'right' })
    const end = Date.now() + 5000
    while (Date.now() < end) {
      if (fs.existsSync(`${app.menuFile}.json`)) { menuLabels = JSON.parse(fs.readFileSync(`${app.menuFile}.json`, 'utf8')).map((item) => item.label); break }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  } else {
    await app.evaluate(({ Menu }) => {
      Menu.prototype.popup = function (options) { globalThis.__localeMenuLabels = this.items.map((item) => item.label); this.getMenuItemById('rename')?.click(); options?.callback?.() }
    })
    await tab('term-old-temp-a').click({ button: 'right' })
    menuLabels = await app.evaluate(() => globalThis.__localeMenuLabels)
  }
  await rename('Renamed terminal 中文', 'button')
  assert.ok(menuLabels.includes('Rename terminal'))
  const error = await page.evaluate(async () => { try { await window.awb.configureTemporaryDirectory('relative') } catch (error) { return String(error) } })
  assert.ok(error.includes('Choose an absolute directory for temporary sessions'), 'Main-process errors follow the selected language')
  // Cancellation creates neither a UUID folder nor a project record.
  await page.locator('[data-a=temporary-session]').locator('..').hover()
  await page.click('[data-a=temporary-session]')
  await page.getByRole('heading', { name: 'Configure temporary session directory', exact: true }).waitFor()
  await page.keyboard.press('Escape')
  const base = path.join(data, 'new-temporary-root')
  await page.evaluate((base) => window.awb.configureTemporaryDirectory(base), base)
  await page.locator('[data-a=temporary-session]').locator('..').hover()
  await page.click('[data-a=temporary-session]')
  // The dialog is waited for before it is dismissed: a key sent while it is
  // still being drawn reaches nothing, and it stays open over what follows.
  await page.getByRole('dialog').waitFor()
  await page.keyboard.press('Escape')
  await page.getByRole('dialog').waitFor({ state: 'detached' })
  assert.equal(fs.readdirSync(base).length, 0)
  for (let index = 0; index < 2; index++) {
    await page.locator('[data-a=temporary-session]').locator('..').hover()
    await page.click('[data-a=temporary-session]'); await page.click('[data-a=ntk][data-id=shell]'); await page.click('[data-a=nt-ok]')
    await page.locator('.dlg').waitFor({ state: 'detached' })
  }
  const created = (await state()).db.projects.filter((project) => project.temporary && !project.id.startsWith('old-'))
  assert.equal(created.length, 2)
  assert.notEqual(created[0].path, created[1].path)
  assert.equal(await page.locator('[data-a=proj]').count(), 1)
  assert.equal(await page.locator('.temporary-group [data-a=side-session]').count(), 4)
  for (const project of created) {
    assert.equal(path.dirname(project.path), base)
    assert.ok(fs.readFileSync(path.join(project.path, 'AGENTS.md'), 'utf8').includes(project.path))
  }
  await page.locator('[data-a=preview][data-id="AGENTS.md"]').waitFor()
  for (const theme of ['dark', 'light']) for (const size of [[1440, 900], [1024, 680]]) {
    if (app.shell === 'tauri') await page.setViewportSize({ width: size[0], height: size[1] })
    else await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), size)
    await page.click('[data-a=settings]'); await page.click('[data-a=sec][data-id=look]'); await page.click(`[data-a=theme][data-id=${theme}]`)
    await page.waitForFunction((theme) => document.documentElement.dataset.palette === theme, theme)
    await page.screenshot({ path: path.join(shots, `${theme}-${size[0]}-settings.png`) })
    await page.keyboard.press('Escape')
    await page.evaluate(() => document.fonts.ready)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    await page.screenshot({ path: path.join(shots, `${theme}-${size[0]}-workspace.png`) })
  }
  await session('old-temp-a').click(); await tab('term-old-temp-a').click()
  await page.evaluate(() => window.awb.ptyWrite('term-old-temp-a', 'echo PELLO_LOCALE_HISTORY\r'))
  await page.waitForFunction(() => window.__awbBuffer('term-old-temp-a').includes('PELLO_LOCALE_HISTORY'))
  await app.close()
  app = await launchWorkbench({ args: ['.'], env }); page = await app.firstWindow(); page.setDefaultTimeout(15000)
  await page.waitForFunction(() => document.documentElement.lang === 'en')
  await session('old-temp-a').click(); await tab('term-old-temp-a').click()
  assert.ok((await tab('term-old-temp-a').textContent()).includes('Renamed terminal 中文'))
  assert.ok((await session('normal').textContent()).includes('会话重命名 $&'))
  assert.equal((await state()).db.projects.find((project) => project.id === 'normal').name, '项目重命名 $&')
  await page.waitForFunction(() => window.__awbBuffer('term-old-temp-a').includes('PELLO_LOCALE_HISTORY'))
  assert.equal(await page.locator('.temporary-group [data-a=side-session]').count(), 4)
  assert.equal((await state()).db.projects.find((project) => project.id === 'old-temp-a').path, projects[1].path)
  await page.click('[data-a=settings]'); await page.click('[data-a=sec][data-id=general]'); await page.locator('[data-set=language]').selectOption('zh-CN')
  await page.waitForFunction(() => document.documentElement.lang === 'zh-CN')
  await page.keyboard.press('Escape'); await page.getByRole('button', { name: '新建项目', exact: true }).waitFor()
  console.log('PASS grouped legacy/new temporary sessions, isolated directories, same-session terminal cwd, project/session/tab rename, empty-name validation, cancellation/focus, live bilingual settings/native menus/errors, failed-save rollback, drafts/undo and Markdown controls, restart names/history and eight theme/size captures')
} catch (error) {
  console.error(error)
  await page?.screenshot({ path: path.join(shots, 'failure.png') }).catch(() => {})
  throw error
} finally {
  // The fixture intentionally creates unsaved drafts. Do not let an assertion
  // failure open a native unsaved-file prompt and hide the original failure.
  await page?.evaluate(() => { window.awb.setUnsavedChanges(false); return window.awb.getState() }).catch(() => {})
  await app.close()
}
