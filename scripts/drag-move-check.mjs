import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright'

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pello-drag-move-'))
const project = path.join(data, 'project')
for (const dir of ['source/bundle', 'target/bundle']) fs.mkdirSync(path.join(project, dir), { recursive: true })
for (const [file, content] of Object.entries({
  'source/item.txt': 'original source', 'target/item.txt': 'original destination',
  'source/bundle/new.txt': 'new folder content', 'target/bundle/old.txt': 'old folder content',
  'loose.txt': 'move to empty target', 'source/race.txt': 'source race', 'target/race.txt': 'target race'
})) fs.writeFileSync(path.join(project, file), content)
const shell = process.platform === 'win32' ? 'pwsh' : 'bash'
fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify({
  settings: { layout: 'balanced', restore: true, autoCheckUpdates: false },
  projects: [{ id: 'p', name: 'Drag and drop', host: 'local', path: project, agent: 'shell' }],
  sessions: { p: ['first', 'middle', 'last'].map((id) => ({ id, name: id, kind: 'shell', shell })) },
  activeTab: { p: 'first' }
}))
const env = { ...process.env, AWB_USER_DATA: data }; delete env.ELECTRON_RUN_AS_NODE
const launch = () => electron.launch({ args: ['.'], env })
let app = await launch()
try {
  let page = await app.firstWindow()
  const order = () => page.locator('.tabbar [data-a=tab][data-state]').evaluateAll((nodes) => nodes.map((node) => node.dataset.id))
  await page.locator('[data-a=tab][data-id=last]').waitFor()
  await page.evaluate(() => { window.__firstTerm = document.querySelector('[data-term=first] .xterm') })
  await page.locator('[data-drag-tab=last]').dragTo(page.locator('[data-drag-tab=first]'), { targetPosition: { x: 3, y: 12 } })
  await page.waitForFunction(() => document.querySelector('.tabbar [data-a=tab]').dataset.id === 'last')
  assert.deepEqual(await order(), ['last', 'first', 'middle'])
  assert.ok(await page.evaluate(() => !!window.__firstTerm && window.__firstTerm === document.querySelector('[data-term=first] .xterm')))
  await app.close()
  app = await launch()
  page = await app.firstWindow()
  await page.locator('[data-a=tab][data-id=last]').waitFor()
  assert.deepEqual(await order(), ['last', 'first', 'middle'])
  console.log('PASS pointer terminal reorder retains instances and survives restart')

  await app.evaluate(({ dialog }, toChange) => {
    globalThis.__moveChoice = 0
    globalThis.__movePrompts = []
    const original = dialog.showMessageBox
    dialog.showMessageBox = async (window, options) => {
      if (options?.title !== '覆盖同名对象？') return original.call(dialog, window, options)
      globalThis.__movePrompts.push(options.message)
      if (globalThis.__moveChoice === 2) process.getBuiltinModule('fs').writeFileSync(toChange, 'concurrent change')
      return { response: globalThis.__moveChoice ? 1 : 0, checkboxChecked: false }
    }
  }, path.join(project, 'target/race.txt'))
  await page.locator('[data-a=rmode][data-id=files]').click()
  const dir = (id) => page.locator(`[data-a=tog][data-id="${id}"]`)
  const file = (id) => page.locator(`[data-a=preview][data-id="${id}"]`)
  const editor = page.getByRole('textbox', { name: '文件内容', exact: true })
  await dir('source').dblclick()
  await dir('target').dblclick()
  await file('target/item.txt').click()
  await editor.waitFor()
  await file('source/item.txt').click()
  await editor.fill('unsaved source draft')
  await file('source/item.txt').dragTo(dir('target'))
  await page.waitForFunction(() => !document.querySelector('.tree-drop-hint'))
  const waitFor = async (predicate) => {
    for (let retry = 0; retry < 100; retry++) {
      if (await predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.fail('Timed out waiting for file operation')
  }
  await waitFor(async () => (await app.evaluate(() => globalThis.__movePrompts)).length === 1)
  assert.equal(fs.readFileSync(path.join(project, 'source/item.txt'), 'utf8'), 'original source')
  assert.equal(fs.readFileSync(path.join(project, 'target/item.txt'), 'utf8'), 'original destination')

  await app.evaluate(() => { globalThis.__moveChoice = 1 })
  await file('source/item.txt').dragTo(dir('target'))
  await waitFor(() => !fs.existsSync(path.join(project, 'source/item.txt')))
  await file('source/item.txt').waitFor({ state: 'detached' })
  assert.equal(fs.readFileSync(path.join(project, 'target/item.txt'), 'utf8'), 'original source')
  assert.equal(await editor.inputValue(), 'unsaved source draft')
  await editor.press('Control+s')
  await waitFor(() => fs.readFileSync(path.join(project, 'target/item.txt'), 'utf8') === 'unsaved source draft')
  await dir('source/bundle').dragTo(dir('target'))
  await waitFor(() => !fs.existsSync(path.join(project, 'source/bundle')))
  assert.deepEqual(fs.readdirSync(path.join(project, 'target/bundle')), ['new.txt'])
  await file('loose.txt').dragTo(dir('source'))
  await waitFor(() => fs.existsSync(path.join(project, 'source/loose.txt')))
  await file('source/loose.txt').dragTo(page.getByRole('group', { name: '文件树', exact: true }), { targetPosition: { x: 30, y: 320 } })
  await waitFor(() => fs.existsSync(path.join(project, 'loose.txt')))
  await file('loose.txt').waitFor()
  await file('source/loose.txt').waitFor({ state: 'detached' })

  await app.evaluate(() => { globalThis.__moveChoice = 2 })
  const transfer = await page.evaluateHandle(() => new DataTransfer())
  await file('source/race.txt').dispatchEvent('dragstart', { dataTransfer: transfer })
  await dir('target').dispatchEvent('dragover', { dataTransfer: transfer })
  await dir('target').dispatchEvent('drop', { dataTransfer: transfer })
  await file('source/race.txt').dispatchEvent('dragend', { dataTransfer: transfer })
  await transfer.dispose()
  await page.getByRole('alert').filter({ hasText: '目标已更改' }).waitFor()
  assert.equal(fs.readFileSync(path.join(project, 'source/race.txt'), 'utf8'), 'source race')
  assert.equal(fs.readFileSync(path.join(project, 'target/race.txt'), 'utf8'), 'concurrent change')
  console.log('PASS pointer moves to directory/root, cancellation, file/folder replacement, concurrent target protection, and draft save at the new path')
} finally {
  await app.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 1 }).catch(() => {})
  await app.close()
}
