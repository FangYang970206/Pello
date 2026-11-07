import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { _electron as electron } from 'playwright'

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-sidebar-'))
const shell = process.platform === 'win32' ? 'pwsh' : 'bash'
const quote = (text) => `'${text.replaceAll("'", process.platform === 'win32' ? "''" : "'\\''")}'`
const command = `${process.platform === 'win32' ? '& ' : ''}${quote(process.execPath)}`
const pidFile = path.join(data, 'fixture-pids.txt')
fs.writeFileSync(path.join(data, 'keep.txt'), 'Keep the actual project files')
fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify({
  settings: { theme: 'dark', restore: true, defShell: shell, confirmKill: true },
  projects: [{ id: 'p1', name: 'First project', host: 'local', path: data, agent: 'shell', branch: '' }, { id: 'p2', name: 'Second project', host: 'local', path: data, agent: 'shell', branch: '' }],
  custom: [{ id: 'ready', name: 'Completed agent', cmd: command, args: '-e "console.log(\'SIDEBAR_READY\')"', letter: 'R', color: '#95cfaa', shell, env: [] },
    { id: 'failed', name: 'Failed agent', cmd: command, args: '-e "process.exit(3)"', letter: 'F', color: '#e39e9c', shell, env: [] },
    { id: 'busy', name: 'Busy agent', cmd: command, args: `${quote(path.resolve('scripts/fixtures/session-tree.cjs'))} ${quote(pidFile)}`, letter: 'B', color: '#dcc07f', shell, env: [] }],
  sessions: { p1: [{ id: 'shell', kind: 'shell', shell }, { id: 'failed', kind: 'failed', shell }, { id: 'busy', kind: 'busy', shell }], p2: [{ id: 'ready', kind: 'ready', shell }] }, activeTab: { p1: 'shell', p2: 'ready' }
}))
const nativeCommand = `${quote(path.resolve('scripts/fixtures/program-status.cjs'))}`
const configFile = path.join(data, 'workbench.json')
const config = JSON.parse(fs.readFileSync(configFile, 'utf8'))
config.custom.push({ id: 'native', name: 'Native agent', cmd: command, args: nativeCommand, letter: 'N', color: '#a9c3df', shell, env: [] })
config.sessions.p2.push({ id: 'native', kind: 'native', shell })
const disappearing = path.join(data, 'disappearing-project')
fs.mkdirSync(disappearing)
config.projects.push({ id: 'p3', name: 'Missing directory', host: 'local', path: disappearing, agent: 'shell', branch: '' })
config.hosts = [{ id: 'local', name: '本机', platform: process.platform === 'win32' ? 'windows' : 'linux', os: 'Local', on: true, port: 22, auth: 'key', addr: '', user: '', color: 'teal' },
  { id: 'remote', name: '测试机器', platform: 'linux', os: 'Linux', on: false, port: 22, auth: 'key', addr: 'example.invalid', user: 'test', color: 'purple' }]
fs.writeFileSync(configFile, JSON.stringify(config))
const env = { ...process.env, AWB_USER_DATA: data }
delete env.ELECTRON_RUN_AS_NODE
const shots = path.resolve('output/playwright/sidebar-sessions')
fs.mkdirSync(shots, { recursive: true })
let app = await electron.launch({ args: ['.'], env })
try {
  let page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  const state = () => page.evaluate(() => window.awb.getState())
  const agent = (id) => page.locator(`[data-a=side-term][data-id="${id}"]`)
  const select = (id) => page.locator(`[data-a=tab][data-id="${id}"]`)
  const session = (id) => page.locator(`[data-a=side-session][data-id="${id}"]`)
  const toggleFilter = async (label) => {
    await page.getByLabel('筛选 Agents', { exact: true }).click()
    await page.getByRole('menuitemcheckbox', { name: label, exact: true }).click()
    await page.keyboard.press('Escape')
  }
  const menu = async (label, action) => {
    const button = page.getByLabel(label, { exact: true })
    await button.locator('..').hover(); await button.click()
    await page.getByRole('menuitem', { name: action, exact: true }).click()
  }
  await session('session:p1').waitFor()
  await page.waitForFunction(() => window.__awbBuffer('native').includes('STATUS_PROBE_OK')).catch(async (error) => { console.error(await page.evaluate(() => ({ native: window.__awbBuffer('native'), html: document.querySelector('.plist').textContent }))); throw error })
  assert.equal(await page.locator('[data-a=agents-toggle]').getAttribute('aria-expanded'), 'false')
  assert.equal(await page.locator('[data-a=side-term]').count(), 0, 'Agents starts folded')
  assert.equal(await page.locator('.sidebar-sessions .dot,.sidebar-sessions small,.proj .m,.proj .pi').count(), 0, 'No session status or host subtitle')
  assert.equal(await page.locator('.project-folder').first().getAttribute('data-color'), 'teal')
  assert.equal((await page.locator('.project-open').first().boundingBox()).height, 34)
  await page.locator('[data-a=proj][data-id=p1]').dblclick()
  assert.equal(await session('session:p1').count(), 0)
  await page.locator('[data-a=proj][data-id=p1]').dblclick()
  await session('session:p1').waitFor()
  await page.locator('[data-a=proj][data-id=p1]').press('ArrowLeft')
  assert.equal(await session('session:p1').count(), 0)
  await page.locator('[data-a=proj][data-id=p1]').press('ArrowRight')
  await session('session:p1').waitFor()
  await page.locator('[data-a=agents-toggle]').click()
  await agent('busy').filter({ has: page.locator('.spinning') }).waitFor()
  await agent('native').waitFor()
  assert.equal(await agent('native').getAttribute('data-status'), 'waiting')
  assert.equal(await agent('failed').count(), 0)
  await agent('native').click()
  await page.locator('.tab.on [data-a=tab][data-id=native]').waitFor()
  const nativeInput = async (text) => {
    await page.evaluate(({ id, text }) => window.awb.ptyWrite(id, text + '\r'), { id: 'native', text })
  }
  await nativeInput('work')
  await page.locator('[data-a=side-term][data-id=native][data-status=running]').waitFor()
  assert.equal(await select('native').locator('.spinning').count(), 1)
  await nativeInput('blocked')
  await page.locator('[data-a=side-term][data-id=native][data-status=waiting]').waitFor()
  assert.equal(await select('native').locator('.spinning').count(), 0, 'Waiting agent process remains alive without a spinner')
  await nativeInput('work')
  await page.locator('[data-a=side-term][data-id=native][data-status=running]').waitFor()
  await nativeInput('done')
  await page.locator('[data-a=side-term][data-id=native][data-status=waiting]').waitFor()
  await toggleFilter('运行中')
  assert.equal(await agent('busy').count(), 0)
  await agent('native').waitFor()
  await toggleFilter('运行中')
  await page.getByLabel('筛选 Agents', { exact: true }).click()
  assert.equal(await page.getByRole('menuitemcheckbox').count(), 2)
  await page.keyboard.press('Escape')
  assert.equal(await agent('failed').count(), 0)
  assert.equal(await agent('shell').count(), 0)
  assert.equal(await agent('ready').count(), 0)
  await page.locator('[data-a=proj][data-id=p1]').click()
  await select('failed').waitFor()
  assert.ok((await select('failed').getAttribute('title')).includes('退出码 3'))
  // Cross-project jump activates the actual terminal, without replacing its xterm.
  await page.locator('[data-a=proj][data-id=p2]').press('ArrowLeft')
  await agent('native').click()
  await session('session:p2').waitFor()
  assert.equal(await page.locator('.proj.on').count(), 0)
  assert.equal(await page.locator('.sidebar-session.on').count(), 1)
  await select('ready').click()
  await page.locator('.tab.on [data-a=tab][data-id=ready]').waitFor()
  assert.ok(await page.evaluate(() => window.__awbBuffer('ready').includes('SIDEBAR_READY')))
  await page.evaluate(() => { window.__sidebarTerminal = document.querySelector('.pane:not([hidden]) .xterm') })
  await menu('项目菜单 Second project', '重命名项目')
  await page.getByLabel('新名称', { exact: true }).fill('跨项目排查')
  await page.getByLabel('新名称', { exact: true }).press('Enter')
  await page.getByRole('button', { name: '打开项目 跨项目排查', exact: true }).waitFor()
  await select('ready').press('F2')
  await page.getByLabel('新名称', { exact: true }).fill('接口排查')
  await page.getByLabel('新名称', { exact: true }).press('Enter')
  assert.ok((await select('ready').textContent()).includes('接口排查'))
  await select('ready').press('F2')
  await page.getByLabel('新名称', { exact: true }).fill('cancel this rename')
  await page.getByLabel('新名称', { exact: true }).press('Escape')
  assert.equal(await page.getByLabel('新名称', { exact: true }).count(), 0)
  assert.ok((await select('ready').textContent()).includes('接口排查'))
  await session('session:p2').press('F2')
  await page.getByLabel('新名称', { exact: true }).fill('原有会话')
  await page.getByLabel('新名称', { exact: true }).press('Enter')
  assert.equal(await page.evaluate(() => window.__sidebarTerminal === document.querySelector('.pane:not([hidden]) .xterm')), true)
  // Project plus creates a separate session; tab plus adds within it.
  await page.locator('[data-a=new-session][data-id=p2]').click()
  await page.getByRole('heading', { name: '新建会话', exact: true }).waitFor()
  assert.equal(await page.locator('[data-a=side-session]').count(), 2, 'No group created before choosing an executor')
  await page.click('[data-a=ntk][data-id=shell]')
  await page.click('[data-a=nt-ok]')
  await page.locator('.dlg').waitFor({ state: 'detached' })
  let db = (await state()).db
  const newGroup = db.workSessions.p2.find((item) => item.id !== 'session:p2')
  assert.ok(newGroup)
  assert.equal(await page.locator('.tabs [data-a=tab]').count(), 1)
  assert.equal(await select('ready').count(), 0)
  await page.locator('.addtab[data-a=newterm]').click()
  await page.getByRole('heading', { name: '新建终端', exact: true }).waitFor()
  await page.click('[data-a=ntk][data-id=shell]'); await page.click('[data-a=nt-ok]')
  await page.locator('.dlg').waitFor({ state: 'detached' })
  assert.equal(await page.locator('.tabs [data-a=tab]').count(), 2)
  assert.equal((await state()).db.workSessions.p2.length, 2)
  const newerTerm = await page.locator('.tab.on [data-a=tab]').getAttribute('data-id')
  await session('session:p2').click()
  assert.equal(await page.locator('.tabs [data-a=tab]').count(), 2)
  assert.equal(await select(newerTerm).count(), 0)
  await select('ready').click()
  assert.equal(await page.evaluate(() => window.__sidebarTerminal === document.querySelector('.pane:not([hidden]) .xterm')), true)
  await session(newGroup.id).click()
  await page.locator(`.tab.on [data-a=tab][data-id="${newerTerm}"]`).waitFor()
  // Environment editor, duplicate warning, persistent folder color.
  await page.click('[data-a=settings]'); await page.click('[data-a=sec][data-id=hosts]')
  await page.click('[data-a=local-host][data-id=local]')
  await page.getByRole('button', { name: '紫色', exact: true }).click()
  assert.ok((await page.locator('.host-color-picker small').textContent()).includes('建议选择其他颜色'))
  await page.getByRole('button', { name: '橙色', exact: true }).click()
  await page.click('[data-a=hsave]'); await page.locator('.dlg').waitFor({ state: 'detached' })
  await page.keyboard.press('Escape')
  assert.equal(await page.locator('.project-folder').first().getAttribute('data-color'), 'orange')
  // Batch captures at both sizes and themes, with real terminal content.
  for (const theme of ['dark', 'light']) for (const [width, height] of [[1440, 900], [1024, 680]]) {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), [width, height])
    await page.click('[data-a=settings]'); await page.click('[data-a=sec][data-id=look]'); await page.click(`[data-a=theme][data-id=${theme}]`); await page.keyboard.press('Escape')
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({ path: path.join(shots, `${theme}-${width}.png`) })
    const overflow = await page.evaluate(() => [...document.querySelectorAll('.project-open,.sidebar-session-open,.sidebar-term-open')].filter((node) => node.getClientRects().length).some((node) => node.getBoundingClientRect().right > document.querySelector('.side').getBoundingClientRect().right))
    assert.equal(overflow, false)
  }
  // Closing from Agents must still stop the identified full process tree.
  for (let tries = 0; tries < 50 && (!fs.existsSync(pidFile) || fs.readFileSync(pidFile, 'utf8').trim().split(/\s+/).length < 3); tries++) await page.waitForTimeout(100)
  assert.equal(fs.readFileSync(pidFile, 'utf8').trim().split(/\s+/).length, 3)
  await menu('终端菜单 Busy agent', '删除终端')
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await agent('busy').waitFor()
  await menu('终端菜单 Busy agent', '删除终端'); await page.click('[data-a=confirm]')
  await agent('busy').waitFor({ state: 'detached' })
  if (process.platform === 'win32') {
    const result = execFileSync('powershell.exe', ['-NoProfile', '-Command', `@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*${pidFile.replaceAll("'", "''")}*' }).Count`], { encoding: 'utf8', windowsHide: true })
    assert.equal(Number(result.trim()), 0)
  }
  await session(newGroup.id).click()
  // Restart proves grouping, names, active terminal and actual output survive.
  await app.close()
  app = await electron.launch({ args: ['.'], env }); page = await app.firstWindow(); page.setDefaultTimeout(15000)
  await session(newGroup.id).waitFor()
  assert.equal(await page.locator('[data-a=agents-toggle]').getAttribute('aria-expanded'), 'false')
  await session(newGroup.id).click()
  await page.locator(`.tab.on [data-a=tab][data-id="${newerTerm}"]`).waitFor()
  assert.equal(await page.locator('.tabs [data-a=tab]').count(), 2)
  await page.locator(`[data-a=tab][data-id="${newerTerm}"][data-state=idle]`).waitFor()
  const sessionPidFile = path.join(data, 'session-pids.txt')
  const treeCommand = `${command} ${quote(path.resolve('scripts/fixtures/session-tree.cjs'))} ${quote(sessionPidFile)}\r`
  await page.evaluate(({ id, text }) => window.awb.ptyWrite(id, text), { id: newerTerm, text: treeCommand })
  for (let tries = 0; tries < 100 && (!fs.existsSync(sessionPidFile) || fs.readFileSync(sessionPidFile, 'utf8').trim().split(/\s+/).length < 3); tries++) await page.waitForTimeout(100)
  assert.equal(fs.readFileSync(sessionPidFile, 'utf8').trim().split(/\s+/).length, 3)
  await session('session:p2').click(); await select('ready').click()
  await page.waitForFunction(() => window.__awbBuffer('ready').includes('SIDEBAR_READY'))
  assert.ok((await select('ready').textContent()).includes('接口排查'))
  assert.ok((await session('session:p2').textContent()).includes('原有会话'))
  // Session deletion supports cancellation and preserves other session terminals.
  const sessionMenu = page.locator(`[data-a=side-session][data-id="${newGroup.id}"]`).locator('..').getByRole('button', { name: '会话菜单 ' + newGroup.name, exact: true })
  await session(newGroup.id).focus(); await sessionMenu.click(); await page.getByRole('menuitem', { name: '删除会话', exact: true }).click()
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await page.getByRole('dialog', { name: '删除会话？', exact: true }).waitFor({ state: 'detached' })
  await session(newGroup.id).waitFor()
  await session(newGroup.id).focus(); await sessionMenu.click(); await page.getByRole('menuitem', { name: '删除会话', exact: true }).click(); await page.click('[data-a=confirm]')
  await session(newGroup.id).waitFor({ state: 'detached' }); await select('ready').waitFor()
  if (process.platform === 'win32') {
    const result = execFileSync('powershell.exe', ['-NoProfile', '-Command', `@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*${sessionPidFile.replaceAll("'", "''")}*' }).Count`], { encoding: 'utf8', windowsHide: true })
    assert.equal(Number(result.trim()), 0, 'Deleting a whole session must stop hidden child and grandchild processes')
  } else for (const pid of fs.readFileSync(sessionPidFile, 'utf8').trim().split(/\s+/)) {
    try { assert.ok(!fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(sessionPidFile)) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  db = (await state()).db
  assert.equal(db.workSessions.p2.length, 1)
  assert.ok(db.sessions.p2.every((term) => term.sessionId === 'session:p2'))
  fs.rmdirSync(disappearing)
  await page.locator('[data-a=new-session][data-id=p3]').click()
  await page.click('[data-a=ntk][data-id=shell]'); await page.click('[data-a=nt-ok]')
  await page.getByRole('alert').filter({ hasText: '终端启动失败' }).waitFor()
  assert.equal(await page.getByRole('heading', { name: '新建会话', exact: true }).count(), 1, 'Failure keeps the chooser open')
  assert.equal((await state()).db.workSessions.p3.length, 0, 'Failed launch must not leave an empty session')
  await page.keyboard.press('Escape')
  await menu('项目菜单 跨项目排查', '移除项目'); await page.click('[data-a=confirm]')
  await page.getByRole('button', { name: '打开项目 跨项目排查', exact: true }).waitFor({ state: 'detached' })
  assert.equal(fs.readFileSync(path.join(data, 'keep.txt'), 'utf8'), 'Keep the actual project files')
  console.log('PASS compact sidebar, session migration/isolation/restore, double-click and keyboard collapse, native running/waiting spinners, Agents filters/jumps, host colors, persistent names and safe process-tree/session/project deletion; four theme/size captures')
} finally { await app.close() }
