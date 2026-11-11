import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { _electron as electron } from 'playwright'

const root = path.resolve('.')
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-session-restore-'))
const project = path.join(data, 'workspace')
fs.mkdirSync(path.join(project, '.hidden'), { recursive: true })
fs.writeFileSync(path.join(project, '.hidden', 'secret.txt'), 'hidden fixture')
fs.writeFileSync(path.join(project, 'visible.txt'), 'visible fixture')
fs.writeFileSync(path.join(project, 'restored.txt'), 'restored fixture')
const shell = process.platform === 'win32' ? 'pwsh' : 'bash'
const marker = `AWB_SESSION_MARKER_${Date.now()}`
const longLine = 'x'.repeat(500)
const quote = (value) => process.platform === 'win32' ? JSON.stringify(value) : `'${value.replaceAll("'", `'\\''`)}'`
const node = process.platform === 'win32' ? `& ${quote(process.execPath)}` : quote(process.execPath)
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true })
git(project, 'init', '-q')
git(project, 'config', 'user.name', 'Fixture')
git(project, 'config', 'user.email', 'fixture@example.invalid')
fs.writeFileSync(path.join(project, 'long-diff.txt'), `${longLine} original\n`)
git(project, 'add', 'long-diff.txt')
git(project, 'commit', '-qm', 'fixture')
fs.writeFileSync(path.join(project, 'long-diff.txt'), `${longLine} changed\n`)
  fs.writeFileSync(path.join(project, 'diff-depth.txt'), `${Array.from({ length: 80 }, (_, index) => `line ${index + 1}`).join('\n')}\n`)
  git(project, 'add', 'diff-depth.txt')
  git(project, 'commit', '-qm', 'depth fixture')
  fs.writeFileSync(path.join(project, 'diff-depth.txt'), `${Array.from({ length: 80 }, (_, index) => `changed ${index + 1}`).join('\n')}\n`)
const db = {
  settings: { layout: 'balanced', theme: 'dark', restore: true, defShell: shell, defAgent: 'shell', confirmKill: false },
  custom: [{ id: 'native', name: 'Native fixture', cmd: node, args: `${quote(path.join(root, 'scripts/fixtures/program-status.cjs'))} claude session-42`, shell, letter: 'N', color: '#a9c3df', env: [] }],
  hosts: [
    { id: 'local', name: '本机', addr: '', user: '', os: 'Local', on: true, port: 22, platform: process.platform === 'win32' ? 'windows' : 'linux', auth: 'key', color: 'blue' },
    { id: 'remote', name: '离线机器', addr: 'example.invalid', user: 'test', os: 'Linux', on: false, port: 22, platform: 'linux', auth: 'key', color: 'purple' }
  ],
  projects: [
    { id: 'p1', name: '长期项目', host: 'local', path: project, agent: 'shell', branch: '' },
    { id: 'p2', name: '置顶项目', host: 'local', path: project, agent: 'shell', branch: '' },
    { id: 'p3', name: '远程项目', host: 'remote', path: '/srv/remote', agent: 'shell', branch: '' }
  ],
  workSessions: {
    p1: [{ id: 'session:p1', name: '会话一', activeTab: 'shell-check' }, { id: 'session:p1:second', name: '会话二', activeTab: 'hidden-agent' }],
    p3: [{ id: 'session:p3', name: '会话一', activeTab: 'remote-term' }]
  },
  activeSession: { p1: 'session:p1', p3: 'session:p3' },
  sessions: {
    p1: [
      { id: 'agent-term', kind: 'native', shell, sessionId: 'session:p1', agentSessionId: 'session-42' },
      { id: 'shell-check', kind: 'shell', shell, sessionId: 'session:p1' },
      { id: 'hidden-agent', kind: 'native', shell, sessionId: 'session:p1:second', agentSessionId: 'session-43' },
      { id: 'hidden-shell', kind: 'shell', shell, sessionId: 'session:p1:second' }
    ],
    p3: [{ id: 'remote-term', kind: 'shell', shell: 'bash' }]
  },
  activeTab: { p1: 'shell-check', p3: 'remote-term' }
}
fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify(db, null, 2))
const env = { ...process.env, AWB_USER_DATA: data }
delete env.ELECTRON_RUN_AS_NODE

const launch = async () => {
  const app = await electron.launch({ args: [root], cwd: root, env })
  const page = await app.firstWindow()
  page.setDefaultTimeout(20000)
  await page.locator('.plist').waitFor()
  return { app, page }
}

let { app, page } = await launch()
try {
  await page.locator('.plist [data-a=proj][data-id=p1]').waitFor()
  await page.locator('.tab [data-a=tab][data-id=agent-term][data-state=running]').waitFor()
  await page.waitForFunction(() => window.__awbBuffer('agent-term')?.includes('STATUS_PROBE_OK'))
  const liveAgent = (await page.evaluate(() => window.awb.getState())).db.sessions.p1.find((term) => term.id === 'agent-term')
  assert.equal(liveAgent.agentSessionId, 'session-42', 'Agent restore must retain the persisted native session ID')
  const term = 'shell-check'
  await page.locator('.tab [data-a=tab][data-id=shell-check][data-state=idle]').waitFor()
  await page.locator('.pane:not([hidden]) .xterm').click()
  await page.keyboard.type(`echo ${marker}`)
  await page.keyboard.press('Enter')
  await page.waitForFunction(({ id, marker }) => window.__awbBuffer(id).includes(marker), { id: term, marker })
  await page.waitForTimeout(4000)
  assert.ok((await page.evaluate((id) => window.awb.terminalHistory(id), term)).includes(marker), 'persisted terminal history missing marker')
  const exported = path.join(data, 'complete-history.ansi')
  await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, exported)
  await page.evaluate((id) => window.awb.exportTerminalHistory(id), term)
  assert.ok(fs.readFileSync(exported, 'utf8').includes(marker), 'full output journal must be exportable')

  // A saved Agent session ID must survive normalization and be reused on launch.
  const normalized = (await page.evaluate(() => window.awb.getState())).db
  assert.equal(normalized.sessions.p1[0].agentSessionId, 'session-42')
  await page.waitForFunction(() => window.__awbBuffer('hidden-agent')?.includes('STATUS_PROBE_OK'))
  await page.evaluate(({ marker }) => {
    window.awb.ptyWrite('hidden-agent', 'hidden-conversation-' + marker + '\r')
    window.awb.ptyWrite('hidden-shell', 'echo hidden-shell-' + marker + '\r')
  }, { marker })
  await page.waitForFunction((marker) => window.__awbBuffer('hidden-agent')?.includes('STATUS_COMMAND_hidden-conversation-' + marker) && window.__awbBuffer('hidden-shell')?.includes('hidden-shell-' + marker), marker)

  // Pin lives in the project menu and orders the sidebar immediately.
  const pinMenu = page.getByLabel('项目菜单 置顶项目', { exact: true })
  await pinMenu.click()
  await page.getByRole('menuitem', { name: '置顶项目', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.sidebar-projects .proj')?.getAttribute('data-id') === 'p2')
  assert.equal(await page.locator('.sidebar-projects .project-pin').count(), 1)

  // Changes is a Git icon without a count; search stays visible in both
  // modes and opens the file view with a collapsed search field.
  const modes = page.locator('.right .rh .seg.plain-seg button')
  assert.equal((await modes.nth(0).innerText()).trim(), '')
  assert.equal((await modes.nth(1).innerText()).trim(), '')
  assert.equal(await page.locator('.right .rh .mode-cluster [data-a=file-search]').count(), 1)
  assert.equal(await page.locator('.right .rh .seg.plain-seg').evaluate((node) => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)')
  await page.locator('[data-a=rmode][data-id=changes]').hover()
  await page.waitForTimeout(250)
  assert.match(await page.locator('[data-a=rmode][data-id=changes]').evaluate((node) => getComputedStyle(node).backgroundColor), /^rgba\(255, 255, 255, 0\.043\)$/)
  assert.equal(await page.locator('[data-a=rmode][data-id=changes]').evaluate((node) => getComputedStyle(node).color), 'rgb(232, 233, 236)')
  assert.equal(await page.locator('[data-a=rmode][data-id=changes]').getAttribute('aria-checked'), 'true')
  assert.equal(await page.locator('[data-a=file-search]').count(), 1)
  assert.equal(await page.getByLabel('搜索文件', { exact: true }).count(), 0)
  assert.equal((await page.locator('[data-a=file-search]').innerText()).trim(), '')
  await page.locator('[data-a=file-search]').click()
  const search = page.getByLabel('搜索文件', { exact: true })
  await search.waitFor()
  assert.equal(await page.locator('[data-a=rmode][data-id=files]').getAttribute('aria-checked'), 'true')
  await search.fill('secret')
  await page.getByText('没有匹配的文件').waitFor()
  await search.fill('visible')
  await page.locator('[data-a=search-file][data-id="visible.txt"]').waitFor()
  await search.fill('')
  await page.locator('[data-a=file-search]').click()
  assert.equal(await page.getByLabel('搜索文件', { exact: true }).count(), 0)

  // Split diff behavior is covered by diff-editor-check.mjs.

  // The only show-panel button is the tab-bar one; its baseline follows tabs.
  const collapseBox = await page.getByRole('button', { name: '收起文件面板', exact: true }).boundingBox()
  await page.getByRole('button', { name: '收起文件面板', exact: true }).click()
  assert.equal(await page.getByRole('button', { name: '显示文件面板', exact: true }).count(), 1)
  const showBox = await page.getByRole('button', { name: '显示文件面板', exact: true }).boundingBox()
  assert.ok(collapseBox && showBox && Math.abs(showBox.y + showBox.height - (collapseBox.y + collapseBox.height)) <= 2, `Show-panel button must align with the collapse control: ${JSON.stringify({ collapseBox, showBox })}`)

  // A remote host that is offline must not erase its saved session.
  await page.locator('[data-a=proj][data-id=p3]').click()
  await page.locator('.tab [data-a=tab][data-id=remote-term][data-state=failed]').waitFor()
  await page.waitForFunction(() => window.__awbBuffer('remote-term')?.includes('无法恢复会话'))
  await page.waitForTimeout(1200)
  const saved = (await page.evaluate(() => window.awb.getState())).db
  assert.ok(saved.sessions.p3.some((item) => item.id === 'remote-term'), 'Failed remote restore must keep the saved terminal')
  assert.equal(saved.workSessions.p3.length, 1)
  await page.locator('[data-a=proj][data-id=p1]').click()

  // Let the periodic terminal snapshot run before quitting.
  await page.waitForTimeout(3500)
} finally {
  const exited = app.waitForEvent('close', { timeout: 30000 })
  await page.getByRole('button', { name: '关闭窗口', exact: true }).click()
  await exited
  await app.close()
}

;({ app, page } = await launch())
try {
  await page.locator('.plist [data-a=proj][data-id=p2]').waitFor()
  assert.equal(await page.locator('.sidebar-projects .proj').first().getAttribute('data-id'), 'p2', 'Pinned project must stay first after restart')
  await page.locator('[data-a=proj][data-id=p1]').click()
  await page.locator('.tab.on [data-a=tab]').waitFor()
  await page.waitForFunction((marker) => window.__awbBuffer('shell-check').includes('上次会话记录') && window.__awbBuffer('shell-check').includes(marker), marker)
  const restoredTabs = await page.locator('.tabs [data-a=tab]').count()
  assert.equal(restoredTabs, 2, 'The project session must reopen its shell and Agent terminals')
  assert.equal((await page.evaluate(() => window.awb.getState())).db.sessions.p1[0].agentSessionId, 'session-42')
  assert.ok((await page.evaluate(() => window.__awbBuffer('agent-term'))).includes('上次会话记录'), 'Agent restore must replay its previous visible history')
  // All groups restore eagerly; the user never needs to select each session to
  // trigger reconnection or replay. Check real conversation content, not counts.
  await page.waitForFunction((marker) => window.__awbBuffer('hidden-agent')?.includes('STATUS_COMMAND_hidden-conversation-' + marker) && window.__awbBuffer('hidden-shell')?.includes('hidden-shell-' + marker), marker)
  const all = (await page.evaluate(() => window.awb.getState())).db
  assert.equal(all.workSessions.p1.length, 2)
  assert.equal(all.sessions.p1.length, 4)

  // Search never enters dot folders, including after a restart.
  await page.locator('[data-a=rmode][data-id=files]').click()
  await page.locator('[data-a=file-search]').click()
  const search = page.getByLabel('搜索文件', { exact: true })
  await search.fill('secret')
  await page.getByText('没有匹配的文件').waitFor()
  await search.fill('restored')
  await page.locator('[data-a=search-file][data-id="restored.txt"]').waitFor()

  // The offline remote terminal is still present and still failed, not deleted.
  await page.locator('[data-a=proj][data-id=p3]').click()
  await page.locator('.tab [data-a=tab][data-id=remote-term][data-state=failed]').waitFor()
  const saved = (await page.evaluate(() => window.awb.getState())).db
  assert.ok(saved.sessions.p3.some((item) => item.id === 'remote-term'))
  console.log(`PASS sessions restore with terminal history, pinned projects, icon-only file controls and dot-folder search exclusion (${data})`)
} finally {
  await app.close()
}
