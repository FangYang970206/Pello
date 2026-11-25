import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchWorkbench } from './fixtures/launch-workbench.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pello-panes-'))
const project = path.join(data, 'project')
const pidFile = path.join(data, 'pids.txt')
fs.mkdirSync(project)
const shell = 'bash'
fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify({
  settings: { layout: 'balanced', restore: true, confirmKill: true, defShell: shell, defAgent: 'shell' },
  projects: [{ id: 'p', name: 'Panes', host: 'local', path: project, agent: 'shell' }],
  sessions: { p: [{ id: 'shell-1', kind: 'shell', shell, name: 'bash' }] },
  activeTab: { p: 'shell-1' },
}))
const env = { ...process.env, AWB_USER_DATA: data }
delete env.ELECTRON_RUN_AS_NODE
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`
const fixture = path.join(root, 'scripts/fixtures/session-tree.cjs')
const alive = () => {
  if (!fs.existsSync(pidFile)) return []
  return fs.readFileSync(pidFile, 'utf8').trim().split(/\s+/).map(Number).filter((pid) => {
    try { process.kill(pid, 0); return true } catch { return false }
  })
}

const app = await launchWorkbench({ args: ['.'], env })
try {
  const page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  const split = async (id, command) => {
    fs.writeFileSync(app.menuFile, command)
    await page.locator(`[data-a=pane][data-id="${id}"]`).dispatchEvent('contextmenu')
  }
  await page.locator('[data-a=tab][data-id=shell-1]').waitFor()
  await page.waitForFunction(() => !!document.querySelector('[data-a=pane][data-id=shell-1]'))
  // The pane is drawn before its terminal has started. A split asked for in
  // between is refused, as the terminal is not there to split yet.
  await page.locator('[data-a=tab][data-id=shell-1][data-state=idle]').waitFor()
  await split('shell-1', 'split-right')
  await page.waitForFunction(() => document.querySelectorAll('.pane:not([hidden])').length === 2)
  const second = await page.locator('.tab.on [data-a=tab]').getAttribute('data-id')
  await split('shell-1', 'split-down')
  await page.waitForFunction(() => document.querySelectorAll('.pane:not([hidden])').length === 3)
  await split(second, 'split-down')
  await page.waitForFunction(() => document.querySelectorAll('.pane:not([hidden])').length === 4)
  const before = await page.locator('.pane:not([hidden])').count()
  assert.equal(before, 4)
  // With four panes the menu offers no further split, so the limit is seen
  // before anything is asked for; merging stays offered. A split asked for
  // all the same does nothing: no pane and no terminal is added.
  fs.rmSync(`${app.menuFile}.json`, { force: true })
  fs.writeFileSync(app.menuFile, '')
  await page.locator(`[data-a=pane][data-id="${second}"]`).dispatchEvent('contextmenu')
  let items
  const menuDeadline = Date.now() + 5000
  while (Date.now() < menuDeadline && !items) {
    if (fs.existsSync(`${app.menuFile}.json`)) items = JSON.parse(fs.readFileSync(`${app.menuFile}.json`, 'utf8'))
    else await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.ok(items, 'The terminal menu must open on a fourth pane')
  assert.deepEqual(['split-left', 'split-right', 'split-up', 'split-down'].map((id) => items.find((item) => item.id === id)?.enabled), [false, false, false, false])
  assert.equal(items.find((item) => item.id === 'merge')?.enabled, true)
  const terminals = await page.evaluate(async () => (await window.awb.getState()).db.sessions.p.length)
  await split(second, 'split-right')
  await new Promise((resolve) => setTimeout(resolve, 800))
  assert.equal(fs.readFileSync(app.menuFile, 'utf8'), '', 'The menu must have been shown for the split that was asked for')
  assert.equal(await page.locator('.pane:not([hidden])').count(), before)
  assert.equal(await page.evaluate(async () => (await window.awb.getState()).db.sessions.p.length), terminals, 'A split past four must not create a terminal')
  console.log('PASS a terminal splits into at most four panes')

  await page.locator('[data-a=tab][data-id=shell-1][data-state=idle]').waitFor()
  await page.evaluate((command) => window.awb.ptyWrite('shell-1', command), `${quote(process.execPath)} ${quote(fixture)} ${quote(pidFile)}\n`)
  await page.locator('[data-a=tab][data-id=shell-1][data-state=running]').waitFor()
  const end = Date.now() + 10000
  while (alive().length < 3 && Date.now() < end) await page.waitForTimeout(50)
  assert.equal(alive().length, 3, 'The process tree did not start')
  const tree = alive()
  await page.locator('[data-a=close][data-id=shell-1]').click()
  await page.getByRole('dialog').filter({ hasText: '关闭标签' }).waitFor()
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'detached' })
  assert.equal(await page.locator('[data-a=tab][data-id=shell-1]').count(), 1)
  assert.deepEqual(alive(), tree, 'Canceling the close must not kill the terminal process tree')
  await page.locator('[data-a=close][data-id=shell-1]').click()
  await page.click('[data-a=confirm]')
  await page.locator('[data-a=tab][data-id=shell-1]').waitFor({ state: 'detached' })
  const gone = Date.now() + 5000
  while (alive().length && Date.now() < gone) await page.waitForTimeout(40)
  assert.deepEqual(alive(), [], 'Closing waits until the process tree has exited')
  console.log('PASS canceling a terminal close leaves the process tree running, and confirming the close waits for it to exit')
} finally {
  await app.close()
  for (const pid of alive()) { try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ } }
}
