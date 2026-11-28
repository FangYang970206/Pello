import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launchWorkbench } from './fixtures/launch-workbench.mjs'

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pello-close-shortcut-'))
const shell = process.platform === 'win32' ? 'pwsh' : 'bash'
const quote = (value) => `'${value.replaceAll("'", process.platform === 'win32' ? "''" : "'\\''")}'`
fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify({
  settings: { restore: true, confirmKill: false, autoCheckUpdates: false },
  projects: [{ id: 'p', name: 'Close shortcut', host: 'local', path: data, agent: 'shell' }],
  custom: [
    { id: 'fixture', name: 'Fixture agent', cmd: `${process.platform === 'win32' ? '& ' : ''}${quote(process.execPath)}`, args: `${quote(path.resolve('scripts/fixtures/session-tree.cjs'))} ${quote(path.join(data, 'pids.txt'))}`, shell, env: [], letter: 'F', color: '#dcc07f' },
    { id: 'done', name: 'Exited agent', cmd: `${process.platform === 'win32' ? '& ' : ''}${quote(process.execPath)}`, args: '-e "process.exit(0)"', shell, env: [], letter: 'D', color: '#dcc07f' }
  ],
  sessions: { p: [{ id: 'one', kind: 'shell', shell }, { id: 'idle', kind: 'done', shell }, { id: 'two', kind: 'fixture', shell }] },
  activeTab: { p: 'two' }
}))
const env = { ...process.env, AWB_USER_DATA: data }
delete env.ELECTRON_RUN_AS_NODE
const app = await launchWorkbench({ args: ['.'], env, scale: null })
try {
  const page = await app.firstWindow()
  page.setDefaultTimeout(10000)
  await page.locator('[data-a=tab][data-id=two][data-state=running]').waitFor()
  // The Tauri shell has no native close accelerator to race: the page's
  // capture listener owns Ctrl+W, held repeats included, exactly as the
  // Electron build's before-input-event hook does.
  const closeKey = (repeat = false) => page.evaluate((repeat) => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, repeat, bubbles: true, cancelable: true }))
  }, repeat)
  await page.locator('.pane.focus .xterm-helper-textarea').focus()
  await closeKey()
  await page.locator('[data-a=confirm]').waitFor()
  // The next shortcut must be consumed while confirmation owns focus.
  for (let i = 0; i < 6; i++) {
    await closeKey(i % 2 === 0)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  await new Promise((resolve) => setTimeout(resolve, 700))
  assert.equal(page.isClosed(), false, 'Repeated Ctrl+W must never close the application')
  assert.equal(await page.locator('[data-a=confirm]').count(), 1, 'One terminal confirmation must remain open')
  assert.equal(await page.locator('.btn[data-a=mclose]').evaluate((node) => node === document.activeElement), true, 'Confirmation must initially focus Cancel')
  fs.mkdirSync(path.resolve('output/playwright/terminal-close'), { recursive: true })
  await page.screenshot({ path: path.resolve('output/playwright/terminal-close/repeated-confirmation.png') })
  assert.equal(await page.locator('[data-a=tab]').count(), 3, 'Unconfirmed terminals must stay open')
  await page.keyboard.press('Escape')
  assert.equal(await page.locator('[data-a=tab]').count(), 3, 'Cancel must preserve all terminals')
  assert.equal(await page.evaluate(() => !!document.activeElement.closest('.xterm')), true, 'Cancel must restore terminal focus')
  await page.locator('.pane.focus .xterm-helper-textarea').focus()
  await closeKey()
  await page.locator('[data-a=confirm]').click()
  await page.locator('[data-a=tab][data-id=two]').waitFor({ state: 'detached' })
  assert.equal(await page.locator('[data-a=tab][data-id=one]').count(), 1)
  await page.locator('[data-a=tab][data-id=idle][data-state=exited]').waitFor()
  await page.locator('[data-a=close][data-id=idle]').click()
  await page.locator('[data-a=confirm]').waitFor()
  assert.equal(await page.locator('[data-a=tab][data-id=idle]').count(), 1, 'Exited agents still require explicit close confirmation')
  await page.locator('[data-a=confirm]').click()
  await page.locator('[data-a=tab][data-id=idle]').waitFor({ state: 'detached' })
  await page.locator('[data-a=tab][data-id=one]').click()
  await page.locator('.pane.focus .xterm-helper-textarea').focus()
  await closeKey()
  await page.locator('[data-a=confirm]').waitFor()
  await closeKey(true)
  await page.locator('[data-a=confirm]').click()
  await page.locator('[data-a=tab][data-id=one]').waitFor({ state: 'detached' })
  await closeKey()
  assert.equal(page.isClosed(), false, 'Ctrl+W with no remaining tabs must keep the application open')
  await page.locator('[data-a=settings]').click()
  await closeKey()
  assert.equal(await page.locator('.settings').count(), 1, 'Ctrl+W must leave settings open')
  console.log('PASS repeated/held Ctrl+W, confirmation despite disabled legacy setting, cancel, exited agent, last terminal, empty workspace and settings')
} finally {
  await app.close()
}