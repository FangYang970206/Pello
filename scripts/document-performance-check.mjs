import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { _electron as electron } from 'playwright'
import { installDocumentHarness } from './fixtures/document-harness.mjs'

const actual = process.argv.includes('--gqe')
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pello-document-perf-'))
const project = data
const markdown = actual ? 'docs/functiondesign/GQE功能设计说明书.md' : 'long.md'
const html = actual ? 'gqe-course/GQE-深度代码课程.html' : 'long.html'
if (actual) for (const rel of [markdown, html]) {
  fs.mkdirSync(path.dirname(path.join(data, rel)), { recursive: true })
  fs.copyFileSync(path.join('D:/AI_Project/GQE', rel), path.join(data, rel))
}
if (!actual) {
  fs.writeFileSync(path.join(data, markdown), '# Long document\n\n' + Array.from({ length: process.argv.includes('--small') ? 3 : 70 }, (_, i) => `## ${i + 1}.1 Section ${i + 1}\n\nParagraph ${i + 1} for editing without layout movement.\n\n| Column | Value |\n| --- | --- |\n${'| sample | content |\n'.repeat(7)}\n\n\`\`\`java\nint answer = 42;\nString name = "sample";\nreturn answer;\n\`\`\`\n\n`).join(''))
  fs.writeFileSync(path.join(data, html), '<!doctype html><html><head><title>Long HTML</title></head><body>' + '<section><h2>Section</h2><p>HTML content remains readable and interactive.</p></section>'.repeat(300) + '</body></html>')
}
const files = [markdown, html].map((rel) => path.join(project, rel))
const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const originals = files.map(hash)
const sourceFiles = actual ? [markdown, html].map((rel) => path.join('D:/AI_Project/GQE', rel)) : []
const sourceHashes = sourceFiles.map(hash)
fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify({ settings: { layout: 'balanced', restore: false, confirmKill: false }, projects: [{ id: 'p', name: 'Document performance', host: 'local', path: project, agent: 'shell' }] }))
const env = { ...process.env, AWB_USER_DATA: data }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: ['.'], env })
const failures = [], results = { actual }
async function check(name, run) {
  try { await run(); console.log(`PASS ${name}`) }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.stack || error.message}`) }
}
try {
  const page = await app.firstWindow()
  page.setDefaultTimeout(30000)
  await page.locator('.side [data-a=newproj]').waitFor()
  await installDocumentHarness(app, page, false)
  await page.evaluate(() => {
    const originalTimeout = window.setTimeout.bind(window)
    window.setTimeout = (callback, delay, ...args) => originalTimeout(callback, delay === 5000 ? 200 : delay, ...args)
    window.__documentPerf = { tasks: [], frames: [] }
    new PerformanceObserver((list) => window.__documentPerf.tasks.push(...list.getEntries().map(({ startTime, duration }) => ({ startTime, duration })))).observe({ type: 'longtask', buffered: false })
  })
  await page.evaluate(({ markdown, html }) => {
    document.addEventListener('click', (event) => {
      const target = event.target.closest('[data-a=search-file]')
      if (target?.dataset.id === html) window.__documentPerf.htmlClick = performance.timeOrigin + performance.now()
      if (target?.dataset.id !== markdown) return
      window.__documentPerf.markdownClick = performance.now()
      const observer = new MutationObserver(() => {
        if (!document.querySelector('.ProseMirror[aria-label="Markdown 内容"]')) return
        observer.disconnect()
        requestAnimationFrame(() => requestAnimationFrame(() => { window.__documentPerf.markdownPaintMs = performance.now() - window.__documentPerf.markdownClick }))
      })
      observer.observe(document.querySelector('#center'), { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-label'] })
    }, true)
  }, { markdown, html })
  await page.click('[data-a=rmode][data-id=files]')
  await page.locator('[data-a=file-search]').click()
  const open = async (rel) => {
    const query = page.getByLabel('搜索文件', { exact: true })
    await query.fill(path.basename(rel))
    const row = page.locator(`[data-a=search-file][data-id="${rel}"]`)
    await row.waitFor()
    const start = Date.now()
    await row.click()
    return start
  }
  const mdStart = await open(markdown)
  await page.locator('.ProseMirror[aria-label="Markdown 内容"]').waitFor()
  await page.locator('.markdown-outline nav button').last().waitFor({ state: 'attached' })
  results.markdownOpenMs = Date.now() - mdStart
  await page.waitForTimeout(500)
  results.markdownPaintMs = await page.evaluate(() => window.__documentPerf.markdownPaintMs)
  results.document = await page.locator('.ProseMirror').evaluate((node) => ({ nodes: node.querySelectorAll('*').length, headings: node.querySelectorAll('h1,h2,h3,h4,h5,h6').length, ids: node.querySelectorAll('h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]').length, codeEditors: node.querySelectorAll('.cm-editor').length }))
  await check('long Markdown outline reaches the last heading after initialization', async () => {
    if (await page.getByRole('button', { name: '展开文档目录', exact: true }).count()) await page.getByRole('button', { name: '展开文档目录', exact: true }).click()
    const last = page.locator('.markdown-outline nav button').last()
    const title = await last.textContent()
    const before = Date.now()
    await last.click()
    await page.waitForTimeout(100)
    const target = await page.locator('.ProseMirror').evaluate((node, title) => {
      const heading = [...node.querySelectorAll('h1,h2,h3,h4,h5,h6')].findLast((item) => item.textContent === title)
      const scroller = node.closest('.markdown-editor'), rect = heading.getBoundingClientRect(), box = scroller.getBoundingClientRect()
      return { title, id: heading.id, delta: rect.top - box.top, bottom: rect.bottom - box.top, height: box.height, scroll: scroller.scrollTop }
    }, title)
    results.navigation = { ...target, elapsedMs: Date.now() - before }
    assert.ok(target.delta >= -2 && target.delta < target.height - 30, JSON.stringify(target))
  })
  await check('editing long Markdown retains the viewport without intermediate jumps', async () => {
    const paragraphs = page.locator('.ProseMirror > p').filter({ hasText: /\S/ })
    const paragraph = paragraphs.nth(Math.floor(await paragraphs.count() / 2))
    await paragraph.scrollIntoViewIfNeeded()
    await paragraph.click()
    await page.keyboard.press('End')
    await page.waitForTimeout(300)
    await page.evaluate(() => {
      const scroller = document.querySelector('.markdown-editor')
      window.__documentPerf.frames = []
      let keyTime = 0
      document.addEventListener('keydown', (event) => { if (event.key === 'x') keyTime = performance.now() }, { once: true })
      document.addEventListener('input', () => { requestAnimationFrame(() => { window.__documentPerf.inputPaintMs = performance.now() - keyTime }) }, { once: true })
      window.__documentPerf.collect = true
      window.__documentPerf.idWrites = 0
      const observer = new MutationObserver((records) => { window.__documentPerf.idWrites += records.filter((record) => record.attributeName === 'id' && record.target.matches('h1,h2,h3,h4,h5,h6')).length })
      observer.observe(document.querySelector('.ProseMirror'), { attributes: true, subtree: true })
      window.__documentPerf.observer = observer
      const frame = () => {
        window.__documentPerf.frames.push({ time: performance.now(), scroll: scroller.scrollTop })
        if (window.__documentPerf.collect) requestAnimationFrame(frame)
      }
      requestAnimationFrame(frame)
    })
    const profiler = process.argv.includes('--profile') ? await page.context().newCDPSession(page) : null
    if (profiler) { await profiler.send('Profiler.enable'); await profiler.send('Profiler.start') }
    const start = Date.now()
    await page.keyboard.type('x')
    await page.waitForTimeout(800)
    results.driverEditMs = Date.now() - start - 800
    results.inputPaintMs = await page.evaluate(() => window.__documentPerf.inputPaintMs)
    if (profiler) {
      const { profile } = await profiler.send('Profiler.stop')
      fs.writeFileSync(path.resolve(`output/document-input-${actual ? 'gqe' : 'fixture'}.cpuprofile`), JSON.stringify(profile))
      await profiler.detach()
    }
    results.idWrites = await page.evaluate(() => { window.__documentPerf.observer.disconnect(); return window.__documentPerf.idWrites })
    const frames = await page.evaluate(() => { window.__documentPerf.collect = false; return window.__documentPerf.frames })
    const scroll = frames.map((item) => item.scroll)
    results.editScrollRange = Math.max(...scroll) - Math.min(...scroll)
    results.editFrameGap = Math.max(...frames.slice(1).map((item, i) => item.time - frames[i].time))
    assert.ok(results.editScrollRange < 8, JSON.stringify(results))
    assert.equal(results.idWrites, 0, 'Paragraph editing must not rewrite heading IDs')
    assert.ok(results.inputPaintMs < 200, JSON.stringify(results))
    assert.ok(results.editFrameGap < 250, JSON.stringify(results))
  })
  await check('Markdown code lines have one uniform background', async () => {
    const block = page.locator('.milkdown-code-block').nth(actual ? 2 : 0)
    await block.scrollIntoViewIfNeeded()
    await block.locator('.cm-line').nth(1).waitFor()
    results.codeColors = {}
    for (const theme of ['dark', 'light']) {
      await page.evaluate((theme) => { const root = document.documentElement; root.dataset.theme = theme; for (const key of [...root.style]) if (key.startsWith('--')) root.style.removeProperty(key) }, theme)
      const colors = await block.locator('.cm-line').evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).backgroundColor))
      results.codeColors[theme] = colors
      assert.equal(new Set(colors).size, 1, `${theme}: ${JSON.stringify(colors)}`)
      await page.locator('.file-content').screenshot({ path: path.resolve(`output/document-code-${actual ? 'gqe' : 'fixture'}-${theme}.png`) })
    }
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
  })
  await check('offscreen code virtualization preserves the rendered block height', async () => {
    const block = page.locator('.milkdown-code-block').nth(actual ? 2 : 0)
    await block.scrollIntoViewIfNeeded()
    await block.locator('.cm-line').nth(1).waitFor()
    const height = await block.evaluate((node) => node.getBoundingClientRect().height)
    await page.locator('.ProseMirror').evaluate((node) => node.lastElementChild.scrollIntoView({ block: 'end' }))
    await block.locator(':scope > .milkdown-code-block-placeholder').waitFor({ state: 'attached' })
    const placeholderHeight = await block.evaluate((node) => node.getBoundingClientRect().height)
    results.virtualizedHeights = [height, placeholderHeight]
    assert.ok(Math.abs(height - placeholderHeight) < 2, `Code block changed height after leaving the viewport: ${height} -> ${placeholderHeight}`)
  })
  await check('Mermaid layout is cached and isolated from the workbench renderer', async () => {
    await page.evaluate(() => window.awb.renderMermaid('graph LR\n A-->B'))
    await app.evaluate(({ BrowserWindow }) => {
      const helper = BrowserWindow.getAllWindows().find((window) => window.getTitle() === 'Pello diagram renderer')
      const original = helper.webContents.executeJavaScript.bind(helper.webContents)
      globalThis.__diagramExecutions = 0
      helper.webContents.executeJavaScript = (script, ...args) => { if (script.includes('MEASURED_CACHE_SENTINEL')) globalThis.__diagramExecutions++; return original(script, ...args) }
    })
    const source = 'graph LR\n  A[MEASURED_CACHE_SENTINEL] --> B[Isolated]'
    const first = await page.evaluate((source) => window.awb.renderMermaid(source), source)
    const start = Date.now()
    const second = await page.evaluate((source) => window.awb.renderMermaid(source), source)
    results.cachedDiagramMs = Date.now() - start
    assert.equal(second, first)
    assert.equal(await app.evaluate(() => globalThis.__diagramExecutions), 1, 'A cached diagram must not execute the layout engine again')
    const isolation = await app.evaluate(async ({ BrowserWindow }) => {
      const windows = BrowserWindow.getAllWindows(), helper = windows.find((window) => window.getTitle() === 'Pello diagram renderer')
      const prefs = helper.webContents.getLastWebPreferences()
      return { count: windows.filter((window) => window.getTitle() === 'Pello diagram renderer').length, visible: helper.isVisible(), separate: helper.webContents.getOSProcessId() !== windows.find((window) => window !== helper).webContents.getOSProcessId(), sandbox: prefs.sandbox, node: prefs.nodeIntegration, preload: !!prefs.preload, bridges: await helper.webContents.executeJavaScript('({api: typeof window.awb, node: typeof require})') }
    })
    assert.deepEqual(isolation, { count: 1, visible: false, separate: true, sandbox: true, node: false, preload: false, bridges: { api: 'undefined', node: 'undefined' } })
    await assert.rejects(page.evaluate(() => window.awb.renderMermaid('x'.repeat(100001))))
  })
  const htmlProfiler = process.argv.includes('--profile') ? await page.context().newCDPSession(page) : null
  if (htmlProfiler) { await htmlProfiler.send('Profiler.enable'); await htmlProfiler.send('Profiler.start') }
  const htmlStart = await open(html)
  const preview = page.frameLocator('iframe[title="HTML 预览"]')
  await preview.locator('body').waitFor()
  await preview.locator('h1,h2').first().waitFor()
  results.htmlOpenMs = Date.now() - htmlStart
  await check('closing Markdown stops its diagram process and keeps completed cached results', async () => {
    await page.waitForTimeout(100)
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((window) => window.getTitle() === 'Pello diagram renderer')), false)
    const cached = await page.evaluate(() => window.awb.renderMermaid('graph LR\n  A[MEASURED_CACHE_SENTINEL] --> B[Isolated]'))
    assert.ok(cached.includes('<svg'))
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((window) => window.getTitle() === 'Pello diagram renderer')), false)
  })
  if (htmlProfiler) { const { profile } = await htmlProfiler.send('Profiler.stop'); fs.writeFileSync(path.resolve('output/document-html.cpuprofile'), JSON.stringify(profile)); await htmlProfiler.detach() }
  results.htmlFonts = await preview.locator('body').evaluate(async () => {
    const start = performance.now()
    const initial = [...document.fonts].map(({ family, status }) => ({ family, status }))
    const loaded = await Promise.race([document.fonts.ready.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 8000))])
    return { initial, loaded, waitMs: performance.now() - start, timeOrigin: performance.timeOrigin, paints: performance.getEntriesByType('paint').map(({ name, startTime }) => ({ name, startTime })), navigation: performance.getEntriesByType('navigation').map(({ domContentLoadedEventEnd }) => ({ domContentLoadedEventEnd })), resources: performance.getEntriesByType('resource').map(({ name, duration }) => ({ name, duration })) }
  })
  await check('HTML opens one stable preview and remains responsive', async () => {
    const navigation = []
    page.on('framenavigated', (frame) => { if (frame !== page.mainFrame() && frame.url().startsWith('http://127.0.0.1:')) navigation.push(frame.url()) })
    await page.waitForTimeout(500)
    assert.equal(navigation.length, 0, `Preview navigated again: ${navigation.length}`)
    results.htmlText = await preview.locator('body').evaluate((node) => node.textContent.length)
    assert.ok(results.htmlOpenMs < 2500, JSON.stringify(results))
    const paint = results.htmlFonts.paints.find((entry) => entry.name === 'first-contentful-paint')
    const parsed = results.htmlFonts.navigation[0]?.domContentLoadedEventEnd || 0
    results.htmlFontBlockMs = paint ? paint.startTime - parsed : null
    const clicked = await page.evaluate(() => window.__documentPerf.htmlClick)
    results.htmlClickToPaintMs = paint ? results.htmlFonts.timeOrigin + paint.startTime - clicked : null
    assert.ok(paint && results.htmlFontBlockMs < 250, `HTML must paint text without waiting for remote fonts: ${JSON.stringify(results.htmlFonts)}`)
  })
  results.tasks = await page.evaluate(() => window.__documentPerf.tasks)
  results.maxLongTask = Math.max(0, ...results.tasks.map((item) => item.duration))
  console.log('MEASURE', JSON.stringify(results))
  fs.writeFileSync(path.resolve(`output/document-performance-${actual ? 'gqe' : 'fixture'}.json`), JSON.stringify(results, null, 2))
} finally {
  await app.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 1 }).catch(() => {})
  await app.close()
  assert.deepEqual(files.map(hash), originals, 'Original documents must never be rewritten by measurement')
  assert.deepEqual(sourceFiles.map(hash), sourceHashes, 'The user-provided source files must remain unchanged')
  fs.rmSync(data, { recursive: true, force: true })
}
assert.deepEqual(failures, [])
