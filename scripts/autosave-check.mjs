import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright'

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-autosave-'))
const project = path.join(data, 'project'), file = path.join(project, 'note.txt')
fs.mkdirSync(project); fs.writeFileSync(file, 'original')
fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify({ settings: { restore: false }, projects: [{ id: 'p', name: 'Autosave timing', host: 'local', path: project, agent: 'shell' }] }))
const env = { ...process.env, AWB_USER_DATA: data }; delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: ['.'], env })
try {
  const page = await app.firstWindow()
  page.setDefaultTimeout(10000)
  await page.click('[data-a=rmode][data-id=files]')
  await page.click('[data-a=preview][data-id="note.txt"]')
  const editor = page.getByRole('textbox', { name: '文件内容', exact: true })
  await editor.waitFor()
  const epoch = new Date('2026-11-03T00:00:00Z')
  await page.clock.install({ time: epoch })
  await page.clock.pauseAt(new Date(epoch.getTime() + 1000))
  await editor.fill('first edit')
  await page.waitForFunction(() => !!document.querySelector('.unsaved'))
  await page.clock.fastForward(119999)
  assert.equal(fs.readFileSync(file, 'utf8'), 'original')
  await editor.fill('latest edit')
  await page.evaluate(() => Promise.resolve())
  await page.clock.fastForward(119999)
  assert.equal(fs.readFileSync(file, 'utf8'), 'original', 'A new edit resets the two-minute debounce')
  await page.clock.fastForward(1)
  await page.getByText('已自动保存', { exact: true }).waitFor()
  assert.equal(fs.readFileSync(file, 'utf8'), 'latest edit')
  await page.clock.fastForward(1999)
  assert.equal(await page.getByText('已自动保存', { exact: true }).count(), 1)
  await page.clock.fastForward(1)
  assert.equal(await page.getByText('已自动保存', { exact: true }).count(), 0)
  console.log('PASS exact 120000ms per-file debounce and exact 2000ms autosave toast using browser clock')
} finally {
  await app.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 1 }).catch(() => {})
  await app.close()
}
