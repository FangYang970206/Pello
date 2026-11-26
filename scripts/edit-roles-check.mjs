// A document's menu offers cutting, copying, pasting and selecting as the
// Electron build's roles do: carried out on the page's focused control, so
// the text really is cut, the clipboard really is read, and the page is told
// nothing of it. An HTML preview's menu copies and selects the preview's own
// text, where the right click was. Drives the running app over the WebView2
// debugging port.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchWorkbench } from './fixtures/launch-workbench.mjs'

if (process.platform !== 'win32') {
  console.log('SKIP editing roles: the roles are the WebView2 shell\'s, Windows only')
  process.exit(0)
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pello-edit-roles-'))
const project = path.join(data, 'project')
fs.mkdirSync(project)
fs.writeFileSync(path.join(project, 'note.txt'), 'alpha beta gamma\nsecond line\n')
fs.writeFileSync(path.join(project, 'page.html'), '<!doctype html><html><body><p>hello preview world</p></body></html>')
fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify({
  settings: { layout: 'balanced', restore: false, confirmKill: false, defShell: 'bash', defAgent: 'shell' },
  projects: [{ id: 'p', name: 'Editing roles', host: 'local', path: project, agent: 'shell' }],
}))
const env = { ...process.env, AWB_USER_DATA: data }
delete env.ELECTRON_RUN_AS_NODE
const app = await launchWorkbench({ args: ['.'], env, cwd: root })
try {
  const page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  // A choice is made without opening the menu: the shell reads it from the
  // file and takes it as the menu's own.
  const choose = async (menuFile, command, open) => {
    fs.writeFileSync(menuFile, command)
    await open()
    const end = Date.now() + 5000
    while (Date.now() < end) {
      if (fs.readFileSync(menuFile, 'utf8').trim() !== command) return
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error(`menu choice was not consumed: ${command}`)
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 400))
  const openFile = async (name) => {
    await page.click('[data-a=rmode][data-id=files]')
    await page.click(`[data-a=preview][data-id="${name}"]`)
  }
  const source = page.getByRole('textbox', { name: '文件内容', exact: true })
  const inDocument = (command) => choose(app.menuFile, command, () => page.locator('.file-content').dispatchEvent('contextmenu'))
  const select = (from, to) => source.evaluate((el, range) => { el.focus(); el.setSelectionRange(range[0], range[1]) }, [from, to])

  await openFile('note.txt')
  await source.waitFor()
  await source.fill('alpha beta gamma\nsecond line\n')
  await page.evaluate(() => { window.__autosaveDelay = 3600000 })

  // The menu says which editing items a document may take: all of them for
  // one that can be edited, and only copying and selecting for one that cannot.
  const offered = async (open) => {
    fs.rmSync(`${app.menuFile}.json`, { force: true })
    fs.writeFileSync(app.menuFile, '')
    await open()
    const end = Date.now() + 5000
    while (Date.now() < end) {
      if (fs.existsSync(`${app.menuFile}.json`)) return JSON.parse(fs.readFileSync(`${app.menuFile}.json`, 'utf8'))
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error('the menu was not asked for')
  }
  const items = await offered(() => page.locator('.file-content').dispatchEvent('contextmenu'))
  const state = (menu, id) => menu.find((item) => item.id === id)?.enabled
  assert.deepEqual(['cut', 'copy', 'paste', 'pasteAndMatchStyle', 'selectAll'].map((id) => state(items, id)), [true, true, true, true, true])
  console.log('PASS a document\'s menu offers cutting, copying, pasting and selecting')

  // Cutting removes the selection and copying keeps it.
  await select(6, 10)
  await inDocument('cut'); await settle()
  assert.equal(await source.inputValue(), 'alpha  gamma\nsecond line\n', 'Cut must remove the selected text')
  await source.fill('alpha beta gamma\nsecond line\n')
  await select(6, 10)
  await inDocument('copy'); await settle()
  assert.equal(await source.inputValue(), 'alpha beta gamma\nsecond line\n', 'Copy must leave the text')

  // Pasting reads what was copied last, at the caret; pasting without the
  // formatting reads it too. What the clipboard holds is known only through
  // what a paste brings, so the copy above is what is looked for.
  await select(0, 0)
  await inDocument('paste'); await settle()
  assert.equal(await source.inputValue(), 'betaalpha beta gamma\nsecond line\n', 'Paste must put the copied text at the caret')
  await source.fill('alpha beta gamma\nsecond line\n')
  await select(18, 18)
  await inDocument('pasteAndMatchStyle'); await settle()
  assert.equal(await source.inputValue(), 'alpha beta gamma\nsbetaecond line\n', 'Pasting as plain text must put the copied text at the caret')
  console.log('PASS cut removes the selection, paste and paste-as-plain-text put the copied text at the caret')

  // Selecting covers the whole document.
  await select(6, 10)
  await inDocument('selectAll'); await settle()
  assert.deepEqual(await source.evaluate((el) => [el.selectionStart, el.selectionEnd, el.value.length]), [0, 33, 33], 'Select all must select the whole document')
  console.log('PASS select all selects the whole document')

  // A role is not the page's to know: nothing of it reaches the page as a
  // command, and the text is untouched when the choice is not offered.
  const before = await source.inputValue()
  await page.evaluate(() => { window.__editRoleCommands = []; const original = window.awb.documentMenu; window.awb.documentMenu = async (...args) => { const choice = await original(...args); if (['cut', 'copy', 'paste', 'pasteAndMatchStyle', 'selectAll'].includes(choice)) window.__editRoleCommands.push(choice); return choice } })
  await select(0, 0)
  await inDocument('copy'); await settle()
  assert.equal(await source.inputValue(), before)
  assert.deepEqual(await page.evaluate(() => window.__editRoleCommands), [], 'A role must be carried out by the shell, not returned to the page')
  console.log('PASS the shell carries a role out itself and returns nothing of it to the page')

  // An HTML preview's menu: back to the source, and copying and selecting the
  // preview's text itself.
  await openFile('page.html')
  const frame = page.frameLocator('iframe.html-preview')
  await frame.locator('p').waitFor()
  // A real right click: it is what gives the preview the keyboard, which the
  // shell's keys then go to.
  const inPreview = (command) => choose(app.menuFile, command, () => frame.locator('p').click({ button: 'right' }))
  const previewMenu = await offered(() => frame.locator('p').click({ button: 'right' }))
  assert.deepEqual(previewMenu.filter((item) => item.id).map((item) => item.id), ['source', 'reload', 'copy', 'selectAll'])
  await inPreview('selectAll')
  assert.equal(await frame.locator('body').evaluate(() => String(getSelection())), 'hello preview world', 'Select all in a preview must select the preview\'s text')
  await inPreview('copy')
  // What the preview copied is what a document pastes.
  await openFile('note.txt')
  await source.waitFor()
  await source.fill('x\n')
  await select(1, 1)
  await inDocument('paste'); await settle()
  assert.equal(await source.inputValue(), 'xhello preview world\n', 'What the preview copied must be on the clipboard')
  console.log('PASS an HTML preview\'s menu selects and copies the preview\'s own text')
  await openFile('page.html')
  await frame.locator('p').waitFor()
  await inPreview('source')
  await source.waitFor()
  assert.equal(await page.locator('iframe.html-preview').count(), 0, 'Source must leave the preview for its source')
  console.log('PASS an HTML preview\'s menu returns to the source')

  assert.deepEqual(errors, [])
} finally {
  await app.close()
}
