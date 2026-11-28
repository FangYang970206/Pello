import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { _electron as electron } from 'playwright'
import { installDocumentHarness } from './fixtures/document-harness.mjs'
import { loadTypeScript } from './fixtures/load-ts.mjs'

const { splitTile } = await loadTypeScript(new URL('../src/renderer/terminal-layout.ts', import.meta.url))
const { reconcileGroups, splitGroup } = await loadTypeScript(new URL('../src/renderer/workspace-layout.ts', import.meta.url))
const initial = reconcileGroups(undefined, ['a'], 'a')
for (const direction of ['left', 'right', 'up', 'down']) {
  const split = splitGroup(initial, 'a', 'b', direction)
  const added = reconcileGroups(split, ['a', 'b', 'c'], 'c', 'b')
  assert.deepEqual(added.find((group) => group.id === 'b').tabs, ['b', 'c'])
  assert.equal(added.find((group) => group.id === 'a').active, 'a')
  assert.equal(reconcileGroups(split, ['a'], 'a').length, 1)
}
const four = splitGroup(splitGroup(splitGroup(initial, 'a', 'b', 'right'), 'a', 'c', 'down'), 'b', 'd', 'down')
for (const id of ['a', 'b', 'c', 'd']) {
  const ids = four.filter((tile) => tile.id !== id).map((tile) => tile.id)
  const remaining = reconcileGroups(four, ids, ids[0])
  assert.equal(remaining.length, 3)
  assert.equal(remaining.reduce((sum, tile) => sum + tile.width * tile.height, 0), 4)
}
assert.throws(() => splitTile(four, 'a', 'e', 'right'))
console.log('PASS four directions, group-local new tabs, independent selection, empty group reflow and four-group limit')

const shots = path.resolve('output/playwright/workspace-split')
fs.mkdirSync(shots, { recursive: true })
for (const dpi of process.argv.includes('--visual') ? [1, 1.25, 1.5, 2] : [1]) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pello-workspace-split-'))
  const repo = path.join(data, 'repo')
  fs.mkdirSync(repo)
  const git = (...args) => execFileSync('git', args, { cwd: repo, windowsHide: true })
  git('init', '-q')
  fs.writeFileSync(path.join(repo, 'alpha.txt'), 'alpha original\n' + 'readable source line\n'.repeat(100))
  fs.writeFileSync(path.join(repo, 'beta.txt'), 'beta original\n')
  const markdownContent = '# Guide\n\nMarkdown split content.\n\n```mermaid\ngraph LR\n A[Input] --> B[Output]\n```\n'
  fs.writeFileSync(path.join(repo, 'guide.md'), markdownContent)
  fs.writeFileSync(path.join(repo, 'preview.html'), '<!doctype html><html><body><h1>Split HTML</h1></body></html>')
  fs.writeFileSync(path.join(repo, 'image.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="90"><rect width="180" height="90" fill="green"/></svg>')
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] >>']
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((value, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${value}\nendobj\n` })
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  fs.writeFileSync(path.join(repo, 'pages.pdf'), pdf)
  git('add', '.')
  git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture')
  fs.writeFileSync(path.join(repo, 'alpha.txt'), 'alpha changed\n' + 'readable source line\n'.repeat(100))
  fs.writeFileSync(path.join(repo, 'beta.txt'), 'beta changed\n')
  const shell = process.platform === 'win32' ? 'pwsh' : 'bash'
  fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify({
    settings: { layout: 'balanced', restore: true, confirmKill: false, defShell: shell, defAgent: 'shell' },
    projects: [{ id: 'p', name: 'Split workspace', path: repo, host: 'local', agent: 'shell' }],
    sessions: { p: [{ id: 'term', kind: 'shell', shell }] }, activeTab: { p: 'term' }
  }))
  const env = { ...process.env, AWB_USER_DATA: data }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ args: ['.', `--force-device-scale-factor=${dpi}`], env })
  try {
    const page = await app.firstWindow()
    page.setDefaultTimeout(15000)
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await installDocumentHarness(app, page, false)
    const pane = (id) => page.locator(`[data-a=pane][data-id="${id}"]`)
    const tab = (id) => page.locator(`[data-a=tab][data-id="${id}"]`)
    const visible = () => page.locator('.pane:not([hidden])')
    const activeId = () => page.locator('.tabbar[data-focused=true] .tab.on [data-a=tab]').getAttribute('data-id')
    const command = async (id, action, content = false) => {
      await app.evaluate((_electron, value) => { globalThis.__documentMenuCommand = value }, action)
      await (content ? pane(id).locator('.file-content') : tab(id)).dispatchEvent('contextmenu')
    }
    const count = (value) => page.waitForFunction((value) => document.querySelectorAll('.pane:not([hidden])').length === value, value)
    const openFile = async (name) => {
      await page.click('[data-a=rmode][data-id=files]')
      await page.locator(`[data-a=preview][data-id="${name}"]`).click()
      return activeId()
    }
    const openDiff = async (name) => {
      await page.click('[data-a=rmode][data-id=changes]')
      await page.locator(`[data-a=diff][data-id="${name}"]`).click()
      return activeId()
    }
    await page.waitForFunction(() => window.__awbBuffer?.('term')?.includes('>'))
    await page.evaluate(() => { window.__splitTerminal = document.querySelector('[data-term=term] .xterm') })
    const file = await openFile('alpha.txt')
    const text = (id) => pane(id).getByRole('textbox', { name: '文件内容', exact: true })
    await text(file).fill('alpha unsaved draft\n')
    await command(file, 'split-right', true)
    await count(2)
    const clone = await activeId()
    assert.notEqual(file, clone)
    assert.equal(await text(clone).inputValue(), 'alpha unsaved draft\n')
    await text(clone).press('Control+z')
    assert.equal(await text(file).inputValue(), fs.readFileSync(path.join(repo, 'alpha.txt'), 'utf8'))
    await text(file).fill('shared draft\n')
    await text(clone).press('Control+s')
    await page.waitForFunction(() => !document.querySelector('.dot.unsaved'))
    assert.equal(fs.readFileSync(path.join(repo, 'alpha.txt'), 'utf8'), 'shared draft\n')
    for (const id of [file, clone]) {
      await text(id).focus(); await page.keyboard.press('Control+f')
      await pane(id).getByLabel('查找内容', { exact: true }).fill('shared')
    }
    await page.waitForFunction(() => CSS.highlights.get('document-matches')?.size === 2)
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => CSS.highlights.get('document-matches')?.size === 1)
    await text(file).focus(); await page.keyboard.press('Escape')
    await page.evaluate((id) => { window.__splitSource = document.querySelector(`[data-a=pane][data-id="${id}"] textarea`) }, file)
    await tab(clone).click()
    const alpha = await openDiff('alpha.txt')
    await count(2)
    assert.ok((await pane(alpha).locator('.diff').textContent()).includes('shared draft'))
    assert.equal(await page.evaluate((id) => window.__splitSource === document.querySelector(`[data-a=pane][data-id="${id}"] textarea`), file), true)
    await pane(alpha).locator('[data-a=dmode][data-id=split]').click()
    await pane(alpha).locator('.cm-merge-a .cm-content').fill('alpha baseline draft')
    await command(alpha, 'split-down')
    await count(3)
    const alphaClone = await activeId()
    const beta = await openDiff('beta.txt')
    await count(3)
    await pane(beta).locator('[data-a=dmode][data-id=split]').click()
    await pane(beta).locator('.cm-merge-a .cm-content').fill('beta baseline draft')
    assert.equal(await pane(alpha).locator('.cm-merge-a .cm-content').textContent(), 'alpha baseline draft')
    assert.equal(await pane(beta).locator('.cm-merge-b .cm-content').textContent(), 'beta changed')
    // Editing a nonselected pane must address its own model, independent of active tab state.
    await pane(alpha).locator('.cm-merge-b .cm-content').fill('alpha through diff')
    assert.equal(await text(file).inputValue(), 'alpha through diff')
    await pane(alpha).getByRole('button', { name: '保存文件', exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('.dot.unsaved'))
    assert.equal(fs.readFileSync(path.join(repo, 'beta.txt'), 'utf8'), 'beta changed\n')
    await tab(beta).click()
    await command(file, 'split-down')
    await count(4)
    const fileClone = await activeId()
    await tab('term').click()
    await count(4)
    assert.equal(await page.evaluate(() => window.__splitTerminal === document.querySelector('[data-term=term] .xterm')), true)
    assert.deepEqual((await visible().evaluateAll((nodes) => nodes.map((node) => node.dataset.type))).sort(), ['diff', 'diff', 'file', 'term'])
    await app.evaluate(({ Menu }) => {
      const original = Menu.prototype.popup
      Menu.prototype.popup = function (options) {
        if (this.getMenuItemById('split-left') && !globalThis.__documentMenuCommand) {
          globalThis.__splitDisabled = ['split-left', 'split-right', 'split-up', 'split-down'].every((id) => !this.getMenuItemById(id).enabled)
          options?.callback?.(); return
        }
        return original.call(this, options)
      }
    })
    await tab(file).dispatchEvent('contextmenu')
    assert.equal(await app.evaluate(() => globalThis.__splitDisabled), true)
    // Search routes exclusively to the focused pane, and preserves focus while typing.
    await tab(file).click()
    await text(file).focus()
    await page.keyboard.press('Control+h')
    await pane(file).getByLabel('查找内容', { exact: true }).fill('alpha')
    assert.equal(await page.locator('.document-search').count(), 1)
    assert.equal(await pane(file).getByLabel('查找内容', { exact: true }).evaluate((node) => document.activeElement === node), true)
    await pane(beta).locator('.cm-merge-b .cm-content').focus()
    await page.keyboard.press('Control+f')
    await pane(beta).getByLabel('查找内容', { exact: true }).fill('beta')
    assert.equal(await pane(beta).getByLabel('查找内容', { exact: true }).evaluate((node) => document.activeElement === node), true)
    console.log(`PASS ${dpi * 100}% mixed views, shared draft/undo/save, independent diff models/baselines, instance preservation and focused search`)

    for (const theme of ['light', 'dark']) for (const [width, height] of [[1440, 900], [1024, 680]]) for (const size of [12, 16]) {
      await page.evaluate(([width, height]) => window.awb.winResize(width, height), [width, height])
      await page.click('[data-a=settings]'); await page.click('[data-a=sec][data-id=look]')
      await page.click(`[data-a=theme][data-id=${theme}]`)
      await page.getByLabel('界面字号', { exact: true }).selectOption(String(size))
      await page.click('[data-a=back]')
      await page.waitForTimeout(120)
      const geometry = await visible().evaluateAll((nodes) => nodes.map((node) => {
        const box = node.getBoundingClientRect(), content = node.querySelector('.file-content,.diff,.termhost')?.getBoundingClientRect()
        return { type: node.dataset.type, width: box.width, height: box.height, content: content?.height,
          controls: [...node.querySelectorAll('.diffbar button,.document-search button,.document-search input')].filter((item) => item.getBoundingClientRect().width > 0).map((item) => {
            const b = item.getBoundingClientRect(); return { label: item.getAttribute('aria-label') || item.textContent, left: b.left >= box.left - 1, right: b.right <= box.right + 1, bottom: b.bottom <= box.bottom + 1, input: item.tagName !== 'INPUT' || b.width >= 64 }
          }) }
      }))
      assert.ok(geometry.every((item) => item.width > 150 && item.content > 80 && item.controls.every((control) => control.left && control.right && control.bottom && control.input)), JSON.stringify(geometry))
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
      await page.screenshot({ path: path.join(shots, `${dpi}-${theme}-${width}-${size}.png`) })
    }
    // Closing an active tab keeps the group when it still owns another tab.
    await page.locator(`[data-a=close][data-id="${beta}"]`).click()
    await count(4)
    await pane(alphaClone).waitFor({ state: 'visible' })
    await command(file, 'merge')
    await count(1)
    assert.equal(await text(file).inputValue(), 'alpha through diff')
    assert.equal(await page.evaluate(() => window.__splitTerminal === document.querySelector('[data-term=term] .xterm')), true)
    await tab(alphaClone).click()
    assert.ok((await pane(alphaClone).locator('.diff').textContent()).includes('alpha through diff'))
    await tab(fileClone).click()
    assert.equal(await text(fileClone).inputValue(), 'alpha through diff')
    const markdown = await openFile('guide.md')
    await command(markdown, 'split-left')
    await count(2)
    await page.waitForFunction(() => document.querySelectorAll('.ProseMirror[role=textbox]').length === 2)
    assert.equal(await page.getByRole('textbox', { name: 'Markdown 内容', exact: true }).count(), 2)
    await page.waitForFunction(() => document.querySelectorAll('.diagram-preview[data-loading=false] img').length === 2)
    const markdownClone = await activeId()
    await page.locator(`[data-a=close][data-id="${markdownClone}"]`).click()
    await count(1)
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((window) => window.getTitle() === 'Pello diagram renderer').length), 1, 'Closing one Markdown view must retain its neighbour\'s diagram renderer')
    assert.equal(fs.readFileSync(path.join(repo, 'guide.md'), 'utf8'), markdownContent)
    const html = await openFile('preview.html')
    await pane(html).frameLocator('iframe').locator('h1').waitFor()
    await command(html, 'split-right')
    await count(2)
    const htmlClone = await activeId()
    await pane(htmlClone).frameLocator('iframe').locator('h1').waitFor()
    await app.evaluate((_electron) => { globalThis.__documentMenuCommand = 'source' })
    await pane(html).frameLocator('iframe').locator('h1').click({ button: 'right' })
    await text(html).waitFor()
    assert.equal(await pane(htmlClone).locator('iframe').count(), 1, 'Only the originating HTML frame switches to source')
    assert.ok((await text(html).inputValue()).includes('Split HTML'))
    await command(html, 'merge')
    const image = await openFile('image.svg')
    await pane(image).locator('.media-preview img').waitFor()
    await command(image, 'split-up')
    await count(2)
    const imageClone = await activeId()
    await pane(imageClone).locator('.media-preview img').waitFor()
    await pane(image).getByRole('button', { name: '实际大小', exact: true }).click()
    await pane(image).getByRole('button', { name: '放大', exact: true }).click()
    assert.equal(await pane(image).locator('.media-scale').textContent(), '125%')
    assert.equal(await pane(imageClone).locator('.media-scale').textContent(), '100%')
    await command(image, 'merge')
    const pdfId = await openFile('pages.pdf')
    await pane(pdfId).locator('.pdf-page[data-rendered=true]').waitFor()
    await command(pdfId, 'split-down')
    await count(2)
    const pdfClone = await activeId()
    await pane(pdfClone).locator('.pdf-page[data-rendered=true]').waitFor()
    await pane(pdfId).locator('.pdf-page[data-rendered=true]').waitFor()
    await pane(pdfId).getByLabel('PDF 页面', { exact: true }).press('PageDown')
    await pane(pdfId).locator('.pdf-page[data-page="2"][data-rendered=true]').waitFor()
    assert.equal(await pane(pdfClone).locator('.pdf-page').getAttribute('data-page'), '1')
    await page.screenshot({ path: path.join(shots, `${dpi}-pdf.png`) })
    assert.equal(fs.readFileSync(path.join(repo, 'pages.pdf'), 'utf8'), pdf)
    assert.equal(fs.readFileSync(path.join(repo, 'preview.html'), 'utf8'), '<!doctype html><html><body><h1>Split HTML</h1></body></html>')
    await command(pdfId, 'merge')
    await tab(alpha).click()
    await command(alpha, 'split-right')
    await count(2)
    const discardView = await activeId()
    await tab(file).click()
    await pane(discardView).locator('[data-a=discard]').click()
    await page.locator('#modal').getByRole('button', { name: '还原更改', exact: true }).click()
    await count(1)
    assert.ok((await text(file).inputValue()).startsWith('alpha original\n'), 'Git discard refreshes the shared file draft')
    assert.ok(fs.readFileSync(path.join(repo, 'alpha.txt'), 'utf8').replaceAll('\r\n', '\n').startsWith('alpha original\n'))
    assert.equal(await page.locator('.dot.unsaved').count(), 0)
    assert.deepEqual(errors, [])
    console.log(`PASS ${dpi * 100}% themes, window/container sizes, UI fonts, close/merge, Markdown/Mermaid, isolated HTML source, independent image zoom and PDF pages`)
  } catch (error) {
    const page = await app.firstWindow()
    const state = await page.locator('.pane:not([hidden])').evaluateAll((nodes) => nodes.map((node) => ({
      id: node.dataset.id, text: node.textContent.slice(0, 800),
      canvases: [...node.querySelectorAll('canvas.pdf-page')].map((canvas) => ({ page: canvas.dataset.page, rendered: canvas.dataset.rendered, width: canvas.width, height: canvas.height }))
    })))
    console.error(JSON.stringify(state))

    await page.screenshot({ path: path.join(shots, `failure-${dpi}.png`) })
    throw error
  } finally { await app.close() }
}
