import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright'
import { installDocumentHarness, documentCommand } from './fixtures/document-harness.mjs'

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-html-switch-'))
const file = path.join(data, 'page.html')
fs.writeFileSync(file, '<h1>original</h1>')
fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify({ settings: { layout: 'balanced', restore: false }, projects: [{ id: 'p', name: 'HTML switching', host: 'local', path: data, agent: 'shell' }] }))
const env = { ...process.env, AWB_USER_DATA: data }; delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: ['.'], env })
try {
  const page = await app.firstWindow()
  await installDocumentHarness(app, page, false)
  await page.click('[data-a=rmode][data-id=files]')
  await page.click('[data-a=preview][data-id="page.html"]')
  for (let index = 0; index < 20; index++) {
    const frame = page.frameLocator('iframe')
    await frame.locator('h1').waitFor()
    // The iframe DOM can be ready before Chromium updates its input hit-test surface.
    await frame.locator('h1').evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await app.evaluate(() => { globalThis.__documentMenuCommand = 'source' })
    await frame.locator('h1').click({ button: 'right' })
    const source = page.getByRole('textbox', { name: '文件内容', exact: true })
    await source.waitFor()
    await source.fill(`<h1>Draft ${index}</h1>`)
    await documentCommand(app, page, 'mode')
    await frame.getByRole('heading', { name: `Draft ${index}`, exact: true }).waitFor({ timeout: 5000 })
    assert.equal(fs.readFileSync(file, 'utf8'), '<h1>original</h1>')
  }
  console.log('PASS 20 consecutive native HTML source/preview switches render the latest draft without saving')
  await documentCommand(app, page, 'mode')
  await page.getByRole('textbox', { name: '文件内容', exact: true }).press('Control+s')
  await page.waitForFunction(() => !document.querySelector('.tab.on .unsaved'))
  await documentCommand(app, page, 'mode')
  await page.frameLocator('iframe').getByRole('heading', { name: 'Draft 19', exact: true }).waitFor()
  const oldPreview = await page.locator('iframe').getAttribute('src')
  const imported = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-html-replacement-'))
  const source = path.join(imported, 'page.html')
  fs.writeFileSync(source, fs.readFileSync(file))
  await page.evaluate((source) => window.awb.transferDrop('p', '', [source]), source)
  const task = page.locator('.transfer-task').last()
  await task.getByRole('button', { name: '覆盖冲突文件', exact: true }).click()
  await task.getByText('导入结束', { exact: true }).waitFor()
  await page.waitForFunction((old) => { const frame = document.querySelector('iframe'); return frame && frame.getAttribute('src') !== old }, oldPreview)
  await page.frameLocator('iframe').getByRole('heading', { name: 'Draft 19', exact: true }).waitFor()
  assert.equal(fs.readFileSync(file, 'utf8'), '<h1>Draft 19</h1>')
  console.log('PASS identical-content HTML overwrite renews the scoped preview URL without stale iframe navigation')
} finally {
  await app.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 1 }).catch(() => {})
  await app.close()
}
