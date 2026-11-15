import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launchWorkbench } from './fixtures/launch-workbench.mjs'

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-autosave-'))
const project = path.join(data, 'project'), file = path.join(project, 'note.txt')
fs.mkdirSync(project); fs.writeFileSync(file, 'original')
fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify({ settings: { layout: 'balanced', restore: false }, projects: [{ id: 'p', name: 'Autosave timing', host: 'local', path: project, agent: 'shell' }] }))
const env = { ...process.env, AWB_USER_DATA: data }; delete env.ELECTRON_RUN_AS_NODE
const app = await launchWorkbench({ args: ['.'], env })
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

  await page.evaluate(() => {
    const native = window.__awbNativeTimeout
    const original = window.awb.gitWrite.bind(window.awb)
    window.__awbGitWrite = original
    window.awb.gitWrite = (...args) => new Promise((resolve, reject) => native(() => original(...args).then(resolve, reject), 400))
  })
  await editor.fill('version-a')
  await page.clock.fastForward(120000)
  await editor.fill('version-b')
  await page.waitForFunction(() => document.querySelector('textarea')?.value === 'version-b')
  const untilFile = async (text, message) => {
    const end = Date.now() + 5000
    while (Date.now() < end) {
      if (fs.readFileSync(file, 'utf8') === text) return
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
    throw new Error(`${message}: ${JSON.stringify(fs.readFileSync(file, 'utf8'))}`)
  }
  await untilFile('version-a', 'The in-flight save wrote the draft it started with')
  assert.equal(await editor.inputValue(), 'version-b', 'A newer draft must stay after the older write returns')
  await page.evaluate(() => { window.awb.gitWrite = window.__awbGitWrite })
  await page.clock.fastForward(120000)
  await untilFile('version-b', 'The newer draft saves on its own debounce')
  console.log('PASS an older in-flight save does not overwrite a newer draft')

  await editor.dispatchEvent('compositionstart')
  await editor.fill('组合输入中')
  await page.clock.fastForward(120000)
  assert.equal(fs.readFileSync(file, 'utf8'), 'version-b', 'IME composition pauses autosave')
  await editor.dispatchEvent('compositionend')
  await page.clock.fastForward(120000)
  await untilFile('组合输入中', 'IME completion starts the two-minute debounce')
  console.log('PASS autosave stays paused during IME composition and runs after it ends')

  fs.writeFileSync(file, 'external change')
  await editor.fill('keep my draft')
  await page.clock.fastForward(120000)
  await page.getByRole('alert').filter({ hasText: '文件已被其他程序修改' }).waitFor()
  assert.equal(fs.readFileSync(file, 'utf8'), 'external change')
  assert.equal(await editor.inputValue(), 'keep my draft')
  console.log('PASS a failed save keeps the draft and does not overwrite the external file')

  await page.locator('.tab.on [data-a=close]').click()
  await page.getByRole('dialog').filter({ hasText: '文件尚未保存' }).waitFor()
  await page.clock.fastForward(120000)
  assert.equal(fs.readFileSync(file, 'utf8'), 'external change', 'The discard confirmation pauses autosave')
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'detached' })
  assert.equal(await editor.inputValue(), 'keep my draft')
  assert.equal(fs.readFileSync(file, 'utf8'), 'external change')
  console.log('PASS discard confirmation pauses autosave and cancel keeps the draft')
} finally {
  await app.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 1 }).catch(() => {})
  await app.close()
}
