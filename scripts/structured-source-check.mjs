import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright'
import { documentCommand, installDocumentHarness } from './fixtures/document-harness.mjs'

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pello-structured-source-'))
const project = path.join(data, 'project')
fs.mkdirSync(project)
const jsonFile = path.join(project, 'sample.JSON')
const compact = '{"config":{"first":"中文  🧪","nested":{"target":9007199254740993}},"same":1,"same":2}'
const original = '\ufeff ' + compact + '\r\n'
fs.writeFileSync(jsonFile, original)
fs.writeFileSync(path.join(project, 'sample.yaml'), 'server:\n  hostname: example.test\n  ports:\n    - 443\n    - 8443\nother: true\n')
for (const name of ['main.ts', 'Dockerfile', 'file.unknown']) fs.writeFileSync(path.join(project, name), '')
const dark = process.argv.includes('--dark')
fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify({
  settings: { layout: 'balanced', theme: dark ? 'dark' : 'light', uiFontSize: dark ? 16 : 12, language: dark ? 'en' : 'zh-CN', restore: false, autoCheckUpdates: false },
  projects: [{ id: 'p', name: 'Structured source', host: 'local', path: project, agent: 'shell' }]
}))
const env = { ...process.env, AWB_USER_DATA: data }; delete env.ELECTRON_RUN_AS_NODE
const dpi = Number(process.env.AWB_TEST_DPI || 1)
const app = await electron.launch({ args: ['.', `--force-device-scale-factor=${dpi}`], env })
try {
  const page = await app.firstWindow()
  page.setDefaultTimeout(12000)
  await installDocumentHarness(app, page, false)
  await app.evaluate(({ BrowserWindow }, dark) => BrowserWindow.getAllWindows()[0].setContentSize(dark ? 1024 : 1440, dark ? 680 : 900), dark)
  await page.click('[data-a=rmode][data-id=files]')
  const row = (name) => page.locator(`[data-a=preview][data-id="${name}"]`)
  const current = page.locator('.pane.focus')
  const source = current.locator('.cm-content')
  const preview = current.locator('.structured-fold-preview')
  const expand = (index = 0) => preview.nth(index).click()
  const foldColumn = current.locator('.cm-foldGutter')
  const expandedMarkers = foldColumn.locator('.structured-fold-toggle[data-expanded="true"]')
  const collapsedMarker = foldColumn.locator('.structured-fold-toggle[data-expanded="false"]:visible')
  const fold = (index) => expandedMarkers.nth(index).click()
  const text = () => source.locator('.cm-line').allTextContents().then((lines) => lines.join('\n'))
  const output = path.resolve('output/structured-source')
  fs.mkdirSync(output, { recursive: true })

  const names = ['sample.JSON', 'sample.yaml', 'main.ts', 'Dockerfile']
  const artwork = []
  for (const name of names) {
    const icon = row(name).locator('img.file-type-icon')
    await icon.waitFor()
    assert.ok(await icon.evaluate((image) => image.complete && image.naturalWidth > 0))
    const src = await icon.getAttribute('src')
    assert.match(src, /^(data:image\/svg\+xml|file:|\/)/, 'File artwork is bundled')
    artwork.push(src)
  }
  assert.equal(new Set(artwork).size, names.length)
  assert.equal(await row('file.unknown').locator('svg').count(), 1)
  await page.keyboard.press('Control+e')
  await page.locator('.file-name-search input').fill('sample')
  await page.locator('[data-a=search-file][data-id="sample.JSON"] img.file-type-icon').waitFor()
  await page.locator('.file-name-search input').press('Escape')
  await row('sample.JSON').click()
  await source.waitFor()
  if (dark) {
    const handle = page.getByRole('separator', { name: 'Resize file panel', exact: true })
    for (let i = 0; i < 8; i++) await handle.press('ArrowLeft')
    const bounds = await current.locator('.cm-scroller').boundingBox()
    assert.ok(bounds.width >= 220 && bounds.width <= 500, 'Folding remains available in a narrow editor')
  }
  await documentCommand(app, page, 'json-format')
  await source.locator('.cm-line').filter({ hasText: '"first":' }).nth(0).waitFor()
  await page.waitForFunction(() => document.querySelectorAll('.pane.focus .cm-line').length > 3)
  const formatted = await text()
  assert.match(formatted, /\n {2}"config": \{\n {4}"first": "中文 {2}🧪",\n/)
  assert.ok(formatted.includes('9007199254740993') && formatted.includes('"same": 1,\n  "same": 2'))
  await documentCommand(app, page, 'json-compact')
  await page.waitForFunction(() => document.querySelectorAll('.pane.focus .cm-line').length === 1)
  assert.equal(await text(), compact)
  assert.equal(fs.readFileSync(jsonFile, 'utf8'), original)
  await source.press('Control+z')
  assert.equal(await text(), formatted)
  await source.press('Control+z')
  assert.equal(await text(), original.slice(1).replaceAll('\r\n', '\n'))
  await source.press('Control+Shift+z')
  assert.equal(await text(), formatted)

  const foldBounds = await foldColumn.boundingBox()
  const numberColumn = current.locator('.cm-lineNumbers')
  const numberBounds = await numberColumn.boundingBox()
  const beforeHover = await source.locator('.cm-line').first().boundingBox()
  assert.ok(foldBounds.width >= 23.9, 'Fold controls have a dedicated 24px click column')
  assert.ok(foldBounds.x >= numberBounds.x + numberBounds.width - 0.1 && foldBounds.x + foldBounds.width <= beforeHover.x + 0.1,
    'The fold column sits between line numbers and code')
  await source.locator('.cm-line').first().hover()
  await expandedMarkers.first().locator('svg').waitFor({ state: 'hidden' })
  await numberColumn.hover({ position: { x: 10, y: 20 } })
  await expandedMarkers.first().locator('svg').waitFor()
  assert.equal((await source.locator('.cm-line').first().boundingBox()).x, beforeHover.x, 'Revealing fold controls does not shift the code')
  assert.equal(await expandedMarkers.first().getAttribute('title'), dark ? 'Fold block' : '折叠区块')
  await page.screenshot({ path: path.join(output, `fold-gutter-${dark ? 'dark' : 'light'}-${dpi}.png`) })
  const foldKey = process.platform === 'darwin' ? 'Meta+Alt+BracketLeft' : 'Control+Shift+BracketLeft'
  const unfoldKey = process.platform === 'darwin' ? 'Meta+Alt+BracketRight' : 'Control+Shift+BracketRight'
  await source.press('Control+Home')
  await source.press(foldKey)
  await preview.first().waitFor()
  const baselines = await preview.first().evaluate((summary) => {
    const line = summary.closest('.cm-line')
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
    const positions = {}
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const inSummary = summary.contains(node)
      const index = inSummary ? 0 : node.data.search(/[{}]/)
      if (index < 0 || !node.data.length) continue
      const range = document.createRange()
      range.setStart(node, index)
      range.setEnd(node, index + 1)
      positions[inSummary ? 'summary' : node.data[index]] = range.getBoundingClientRect().top
    }
    return positions
  })
  assert.ok(Math.abs(baselines.summary - baselines['{']) < 1 && Math.abs(baselines.summary - baselines['}']) < 1,
    `Folded text and both braces share a baseline: ${JSON.stringify(baselines)}`)
  assert.ok(Math.abs((await source.locator('.cm-line').first().boundingBox()).height - beforeHover.height) < 1,
    'Folding preserves the source line height')
  await page.screenshot({ path: path.join(output, `fold-baseline-${dark ? 'dark' : 'light'}-${dpi}.png`) })
  await source.press(unfoldKey)
  await preview.first().waitFor({ state: 'detached' })
  await fold(1)
  assert.match(await preview.first().innerText(), /"first": "中文 {2}🧪"/)
  assert.equal((await text()).includes('9007199254740993'), false)
  const line = await source.locator('.cm-line').first().boundingBox()
  const number = await current.locator('.cm-lineNumbers .cm-gutterElement').filter({ hasText: /^1$/ }).last().boundingBox()
  assert.ok(Math.abs(line.y - number.y) < 2, 'Number and source line stay aligned')
  await row('sample.yaml').hover()
  await collapsedMarker.locator('svg').waitFor()
  assert.equal(await collapsedMarker.getAttribute('title'), dark ? 'Expand block' : '展开区块')
  await expandedMarkers.first().locator('svg').waitFor({ state: 'hidden' })
  await row('sample.yaml').click()
  await fold(0)
  assert.match(await preview.first().innerText(), /hostname: example.test/)
  assert.equal((await text()).includes('8443'), false)
  await expand()
  assert.ok((await text()).includes('8443'))
  await fold(1)
  assert.match(await preview.first().innerText(), /443/)
  await page.screenshot({ path: path.join(output, `yaml-${dark ? 'dark' : 'light'}-${dpi}.png`) })
  await row('sample.JSON').click()
  await preview.first().waitFor()
  await page.screenshot({ path: path.join(output, `json-${dark ? 'dark' : 'light'}-${dpi}.png`) })
  await source.press('Control+f')
  await page.locator('.search-query').fill('9007199254740993')
  await current.locator('.cm-content .search-active').waitFor()
  assert.equal(await preview.count(), 0, 'Searching hidden text unfolds the containing block')
  await page.locator('.search-query').press('Escape')
  await source.press('Control+s')
  await page.waitForFunction(() => !document.querySelector('[data-a=tab].on .dirty'))
  await assert.doesNotReject(async () => {
    for (let i = 0; i < 100; i++) {
      if (fs.readFileSync(jsonFile, 'utf8') === '\ufeff' + formatted.replaceAll('\n', '\r\n')) return
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error('Formatted save did not preserve BOM/CRLF')
  })
  await source.fill('{"incomplete":}')
  await documentCommand(app, page, 'json-compact')
  await current.getByRole('alert').waitFor()
  assert.equal(await text(), '{"incomplete":}')
  console.log('PASS file icons, native JSON menu, undo/redo, CRLF/BOM, fold column, aligned summaries, keyboard folding and search reveal')
} finally {
  await app.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 1 }).catch(() => {})
  await app.close()
}
