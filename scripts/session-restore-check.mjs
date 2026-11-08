import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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
const db = {
  settings: { layout: 'balanced', theme: 'dark', restore: true, defShell: shell, defAgent: 'shell', confirmKill: false },
  hosts: [
    { id: 'local', name: '本机', addr: '', user: '', os: 'Local', on: true, port: 22, platform: process.platform === 'win32' ? 'windows' : 'linux', auth: 'key', color: 'blue' },
    { id: 'remote', name: '离线机器', addr: 'example.invalid', user: 'test', os: 'Linux', on: false, port: 22, platform: 'linux', auth: 'key', color: 'purple' }
  ],
  projects: [
    { id: 'p1', name: '长期项目', host: 'local', path: project, agent: 'shell', branch: '' },
    { id: 'p2', name: '置顶项目', host: 'local', path: project, agent: 'shell', branch: '' },
    { id: 'p3', name: '远程项目', host: 'remote', path: '/srv/remote', agent: 'shell', branch: '' }
  ],
  sessions: { p3: [{ id: 'remote-term', kind: 'shell', shell: 'bash' }] },
  activeTab: { p3: 'remote-term' }
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
  await page.locator('[data-a=quick]').click()
  await page.locator('.tab.on [data-a=tab][data-state=idle]').waitFor()
  const term = await page.locator('.tab.on [data-a=tab]').getAttribute('data-id')
  assert.ok(term)
  await page.locator('.pane:not([hidden]) .xterm').click()
  await page.keyboard.type(`echo ${marker}`)
  await page.keyboard.press('Enter')
  await page.waitForFunction(({ id, marker }) => window.__awbBuffer(id).includes(marker), { id: term, marker })
  await page.waitForTimeout(4000)
  assert.ok((await page.evaluate((id) => window.awb.terminalHistory(id), term)).includes(marker), 'persisted terminal history missing marker')

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

  // A remote host that is offline must not erase its saved session.
  await page.locator('[data-a=proj][data-id=p3]').click()
  await page.locator('.tab [data-a=tab][data-id=remote-term][data-state=failed]').waitFor()
  await page.waitForFunction(() => window.__awbBuffer('remote-term')?.includes('无法恢复会话'))
  await page.waitForTimeout(1200)
  const saved = (await page.evaluate(() => window.awb.getState())).db
  assert.ok(saved.sessions.p3.some((item) => item.id === 'remote-term'), 'Failed remote restore must keep the saved terminal')
  assert.equal(saved.workSessions.p3.length, 1)

  // Let the periodic terminal snapshot run before quitting.
  await page.waitForTimeout(3500)
} finally {
  await app.close()
}

;({ app, page } = await launch())
try {
  await page.locator('.plist [data-a=proj][data-id=p2]').waitFor()
  assert.equal(await page.locator('.sidebar-projects .proj').first().getAttribute('data-id'), 'p2', 'Pinned project must stay first after restart')
  await page.locator('[data-a=proj][data-id=p1]').click()
  await page.locator('.tab.on [data-a=tab]').waitFor()
  await page.waitForFunction((marker) => {
    const id = document.querySelector('.tabs .tab.on [data-a=tab]')?.getAttribute('data-id')
    return !!id && window.__awbBuffer(id).includes('上次会话记录') && window.__awbBuffer(id).includes(marker)
  }, marker)
  const restoredTabs = await page.locator('.tabs [data-a=tab]').count()
  assert.equal(restoredTabs, 1, 'The local shell session must reopen')

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
