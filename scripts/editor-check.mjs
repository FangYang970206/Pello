import { installDocumentHarness, documentCommand } from './fixtures/document-harness.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-editor-'))
const project = path.join(data, 'project')
fs.mkdirSync(path.join(project, 'docs/assets'), { recursive: true })
const mdPath = path.join(project, 'docs/guide.md')
const original = Buffer.from('\ufeff---\r\ntitle: 原文\r\n---\r\n# 原文\r\n\r\n这是一段 **加粗** 文本。\r\n\r\n| 名称 | 值 |\r\n| --- | --- |\r\n| 示例 | 1 |\r\n\r\n```js\r\nconst answer = 42\r\n```\r\n\r\n![示意](assets/pixel.png)\r\n\r\n<script>window.__documentScriptRan=true</script>\r\n')
fs.writeFileSync(mdPath, original)
fs.writeFileSync(path.join(project, 'docs/assets/pixel.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT1cAAAAASUVORK5CYII=', 'base64'))
fs.writeFileSync(path.join(project, 'docs/page.html'), '<!doctype html><link rel="stylesheet" href="assets/site.css"><h1>浏览器预览</h1><script src="assets/site.js"></script>')
fs.writeFileSync(path.join(project, 'docs/assets/site.css'), 'h1{color:rgb(10,120,180)}')
fs.writeFileSync(path.join(project, 'docs/assets/site.js'), 'document.title="preview-ready"')
fs.writeFileSync(path.join(project, 'docs/assets/module.mjs'), 'export const ready = "module-ready"')
fs.writeFileSync(path.join(project, 'note.txt'), 'original\n')
fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify({
  settings: { layout: 'balanced', theme: 'dark', fontSize: 13, defShell: process.platform === 'win32' ? 'pwsh' : 'bash', defAgent: 'shell', restore: false, confirmKill: false },
  projects: [{ id: 'p', name: 'Markdown editor', host: 'local', path: project, agent: 'shell' }]
}))
const env = { ...process.env, AWB_USER_DATA: data }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: [root], cwd: root, env })
const until = async (predicate, message) => {
  const end = Date.now() + 10000
  while (Date.now() < end) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 50)) }
  throw new Error(message)
}
try {
  const page = await app.firstWindow()
  await installDocumentHarness(app, page)
  page.setDefaultTimeout(15000)
  page.on('pageerror', (error) => console.error('Renderer:', error.message))
  await page.click('[data-a=rmode][data-id=files]')
  await page.locator('[data-a=tog][data-id=docs]').press('ArrowRight')
  await page.click('[data-a=preview][data-id="docs/guide.md"]')
  const rich = page.getByRole('textbox', { name: 'Markdown 内容', exact: true })
  await rich.waitFor()
  assert.equal(await page.locator('.filebar').count(), 0, 'Document toolbar should be absent')
  assert.equal(await rich.locator('h1').textContent(), '原文')
  assert.equal(await rich.locator('strong').textContent(), '加粗')
  assert.ok(await rich.locator('table').count())
  await rich.locator('img').first().waitFor()
  await page.waitForFunction(() => [...document.querySelectorAll('.markdown-editor img')].some((image) => image.complete && image.naturalWidth > 0))
  await new Promise((resolve) => setTimeout(resolve, 1100))
  assert.deepEqual(fs.readFileSync(mdPath), original, 'Opening Markdown must not rewrite its source')
  assert.equal(await page.evaluate(() => window.__documentScriptRan), undefined)
  console.log('PASS rendered headings, emphasis, tables, code and relative images; opening leaves source unchanged')

  await rich.locator('h1').click()
  await page.keyboard.press('End')
  await page.keyboard.insertText(' 修改')
  await until(() => fs.readFileSync(mdPath, 'utf8').includes('# 原文 修改'), 'Markdown did not autosave')
  assert.ok((await page.evaluate(() => window.__autosaveDelays)).every((delay) => delay === 120000))
  await page.getByText('已自动保存', { exact: true }).waitFor()
  await page.getByText('已自动保存', { exact: true }).waitFor({ state: 'detached', timeout: 3000 })
  assert.ok(fs.readFileSync(mdPath, 'utf8').startsWith('\ufeff---\r\ntitle: 原文\r\n---\r\n'))
  await rich.press('Control+z')
  await until(() => fs.readFileSync(mdPath).equals(original), 'Undo did not survive autosave')
  await rich.press('Control+Shift+z')
  await until(() => fs.readFileSync(mdPath, 'utf8').includes('# 原文 修改'), 'Redo did not autosave')
  console.log('PASS Markdown autosave, Ctrl+Z / Ctrl+Shift+Z after saving, front matter, BOM and CRLF preservation')

  await documentCommand(app, page, 'mode')
  const source = page.getByRole('textbox', { name: '文件内容', exact: true })
  assert.ok((await source.inputValue()).includes('# 原文 修改'))
  await documentCommand(app, page, 'mode')
  await rich.waitFor()
  await rich.locator('h1').click()
  await page.keyboard.press('End')
  await page.keyboard.insertText(' 即时切页')
  await page.click('[data-a=preview][data-id="note.txt"]')
  await until(() => fs.readFileSync(mdPath, 'utf8').includes('即时切页'), 'Last rich-text input was lost on tab switch')
  await page.click('[data-a=preview][data-id="docs/guide.md"]')
  await rich.waitFor()
  assert.ok((await rich.locator('h1').textContent()).includes('即时切页'))
  await rich.press('Control+z')
  await until(() => !fs.readFileSync(mdPath, 'utf8').includes('即时切页'), 'History did not survive editor remount')
  console.log('PASS rich/source switching, immediate tab switch without dropped input and history across remounts')

  await page.click('[data-a=preview][data-id="note.txt"]')
  await source.fill('autosaved text')
  await until(() => fs.readFileSync(path.join(project, 'note.txt'), 'utf8') === 'autosaved text', 'Plain text did not autosave')
  await source.press('Control+z')
  await until(() => fs.readFileSync(path.join(project, 'note.txt'), 'utf8') === 'original\n', 'Plain text undo after save failed')
  await source.dispatchEvent('compositionstart')
  await source.fill('组合输入中')
  await new Promise((resolve) => setTimeout(resolve, 1100))
  assert.equal(fs.readFileSync(path.join(project, 'note.txt'), 'utf8'), 'original\n')
  await source.dispatchEvent('compositionend')
  await until(() => fs.readFileSync(path.join(project, 'note.txt'), 'utf8') === '组合输入中', 'IME completion did not autosave')
  console.log('PASS text autosave and undo; composition input is saved only after completion')

  await source.fill('keep my draft')
  fs.writeFileSync(path.join(project, 'note.txt'), 'external change')
  await page.getByRole('alert').filter({ hasText: '文件已被其他程序修改' }).waitFor()
  assert.equal(await source.inputValue(), 'keep my draft')
  await source.fill('keep editing after conflict')
  await new Promise((resolve) => setTimeout(resolve, 1100))
  assert.equal(fs.readFileSync(path.join(project, 'note.txt'), 'utf8'), 'external change')
  assert.equal(await page.locator('.toast.bad').count(), 0, 'Autosave must not repeatedly toast errors')
  await documentCommand(app, page, 'reload')
  await page.click('[data-a=confirm]')
  console.log('PASS conflicting autosave pauses and keeps the draft without overwriting external changes')

  await source.fill('discard this draft')
  await page.locator('.tab.on [data-a=close]').click()
  await page.getByRole('dialog').filter({ hasText: '文件尚未保存' }).waitFor()
  await new Promise((resolve) => setTimeout(resolve, 1100))
  assert.equal(fs.readFileSync(path.join(project, 'note.txt'), 'utf8'), 'external change', 'A discard dialog must pause autosave')
  await page.click('[data-a=confirm]')
  assert.equal(fs.readFileSync(path.join(project, 'note.txt'), 'utf8'), 'external change')
  console.log('PASS discard confirmation pauses autosave without writing the abandoned draft')

  await page.click('[data-a=preview][data-id="docs/page.html"]')
  await page.evaluate(() => { window.__autosaveDelay = 120000 })
  const frame = page.frameLocator('iframe[title="HTML 预览"]')
  await frame.locator('h1').waitFor()
  const url = await page.locator('iframe').getAttribute('src')
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\//)
  await frame.locator('h1').evaluate(() => { if (document.title !== 'preview-ready') throw new Error('Relative JS did not load') })
  assert.equal(await frame.locator('h1').evaluate((node) => getComputedStyle(node).color), 'rgb(10, 120, 180)')
  assert.equal(await frame.locator('h1').evaluate(() => typeof window.awb), 'undefined')
  const moduleResult = await frame.locator('h1').evaluate(async () => {
    try { return (await import('./assets/module.mjs')).ready } catch { return 'module-failed' }
  })
  assert.equal(moduleResult, 'module-ready', 'HTML module scripts must load in the isolated preview')
  const unrelatedOrigin = await fetch(new URL('assets/module.mjs', url), { headers: { Origin: 'https://example.invalid' } })
  assert.equal(unrelatedOrigin.headers.get('access-control-allow-origin'), null, 'Preview must not grant CORS to unrelated websites')
  assert.equal(await frame.locator('h1').evaluate(() => { try { return !!parent.document } catch { return false } }), false)
  await app.evaluate(() => { globalThis.__documentMenuCommand = 'source' })
  await frame.locator('h1').click({ button: 'right' })
  await source.waitFor()
  assert.ok((await source.inputValue()).includes('浏览器预览'))
  // Preview-only behavior uses the real autosave delay, not accelerated time.
  await source.fill('<!doctype html><h1>草稿预览</h1>')
  await documentCommand(app, page, 'mode')
  await frame.getByRole('heading', { name: '草稿预览' }).waitFor()
  assert.ok(fs.readFileSync(path.join(project, 'docs/page.html'), 'utf8').includes('浏览器预览'), 'Rendering a draft must not silently save it')
  await page.evaluate(() => { window.__autosaveDelay = 800 })
  const forbidden = new URL(url)
  forbidden.pathname = '/not-a-project-token/secret.txt'
  assert.equal((await fetch(forbidden)).status, 404)
  console.log('PASS embedded HTML default, native right-click source switch, relative CSS/JS, sandbox isolation and scoped URLs')

  await page.click('[data-a=preview][data-id="docs/guide.md"]')
  await rich.waitFor()
  await documentCommand(app, page, 'mode')
  const beforeLoad = await source.inputValue()
  await source.fill(beforeLoad + '\n\nPending editor load')
  await app.evaluate(({ ipcMain }, url) => {
    ipcMain.removeHandler('file:preview-url')
    ipcMain.handle('file:preview-url', async () => {
      await new Promise((resolve) => setTimeout(resolve, 500))
      return url
    })
  }, url)
  await documentCommand(app, page, 'mode')
  await documentCommand(app, page, 'undo')
  await rich.waitFor()
  assert.ok(!(await rich.textContent()).includes('Pending editor load'), 'An undo during initialization must reach the new editor')
  console.log('PASS undo during delayed editor initialization keeps the current draft visible')
  fs.mkdirSync(path.join(root, 'output/playwright'), { recursive: true })
  await page.screenshot({ path: path.join(root, 'output/playwright/markdown-wysiwyg.png') })
} finally {
  await app.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 1 }).catch(() => {})
  const page = app.windows()[0]
  const closed = app.waitForEvent('close')
  await page.getByRole('button', { name: '关闭窗口', exact: true }).click()
  await closed
}
console.log('Editor checks passed')
