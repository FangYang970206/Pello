import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { _electron as electron } from 'playwright'

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pello-background-work-'))
const git = (...args) => execFileSync('git', args, { cwd: data, windowsHide: true })
git('init', '-q'); fs.writeFileSync(path.join(data, 'initial.txt'), 'initial')
fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify({ settings: { layout: 'focus', restore: false, autoCheckUpdates: false }, projects: [{ id: 'p', name: 'Background work', path: data, host: 'local', agent: 'shell' }] }))
const env = { ...process.env, AWB_USER_DATA: data }; delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: ['.', '--force-device-scale-factor=1'], env })
try {
  const page = await app.firstWindow(); page.setDefaultTimeout(10000)
  await page.locator('[data-a=proj][data-id=p]').waitFor()
  await page.getByRole('button', { name: '显示文件面板', exact: true }).waitFor()
  // Observe actual IPC invocations in the pinned Electron test runtime; no
  // production API is replaced and the real scanner still handles every call.
  await app.evaluate(({ ipcMain }) => {
    const handler = ipcMain._invokeHandlers.get('git:status')
    if (typeof handler !== 'function') throw new Error('Missing real Git status handler')
    globalThis.__backgroundGitCalls = 0
    ipcMain.removeHandler('git:status')
    ipcMain.handle('git:status', (...args) => { globalThis.__backgroundGitCalls++; return handler(...args) })
  })
  await page.waitForTimeout(4300)
  const hidden = await app.evaluate(() => globalThis.__backgroundGitCalls)
  console.log(`Hidden-panel Git polls across two periods: ${hidden}`)
  assert.equal(hidden, 0, 'A collapsed file panel must not keep scanning the active repository')
  fs.writeFileSync(path.join(data, 'created-hidden.txt'), 'must appear on reopen')
  await page.getByRole('button', { name: '显示文件面板', exact: true }).click()
  await page.locator('[data-a=diff][data-id="created-hidden.txt"]').waitFor()
  assert.ok(await app.evaluate(() => globalThis.__backgroundGitCalls) > 0, 'Opening the panel refreshes immediately')
  fs.writeFileSync(path.join(data, 'created-visible.txt'), 'must appear during polling')
  await page.locator('[data-a=diff][data-id="created-visible.txt"]').waitFor()
  await page.getByRole('button', { name: '收起文件面板', exact: true }).click()
  const closed = await app.evaluate(() => globalThis.__backgroundGitCalls)
  await page.waitForTimeout(4300)
  assert.equal(await app.evaluate(() => globalThis.__backgroundGitCalls), closed)
  await page.keyboard.press('Control+e')
  await page.locator('[data-a=preview][data-id="created-hidden.txt"]').click()
  const editor = page.getByLabel('文件内容', { exact: true }); await editor.waitFor()
  assert.equal(await editor.inputValue(), 'must appear on reopen')
  await editor.press('Control+End'); await editor.press('!')
  await page.getByRole('button', { name: '收起文件面板', exact: true }).click()
  assert.equal(await editor.inputValue(), 'must appear on reopen!', 'Collapsing preserves the file draft and focus target')
  await page.screenshot({ path: path.resolve('output/performance/background-work.png') })
  await editor.press('Control+z')
  assert.equal(await editor.inputValue(), 'must appear on reopen', 'Undo survives collapsing the panel')
  await page.waitForFunction(() => !document.querySelector('.dot.unsaved'))
  console.log('PASS hidden-panel idle work, immediate refresh, visible polling, repeated collapse, Ctrl+E reopening and retained draft')
} finally { await app.close() }
