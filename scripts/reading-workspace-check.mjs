import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright'
import { installDocumentHarness, documentCommand } from './fixtures/document-harness.mjs'

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pello-reading-'))
const original = '# 阅读测试\n\n- Java 21\n- Spring Boot\n\n[跳到第二节](#第二节)\n\n' + '长文导航回归段落。\n\n'.repeat(30) + '## 第二节\n\n```json\n{"answer": 42, "enabled": true}\n```\n\n```mermaid\ngraph LR\n  A[输入] --> B[输出]\n```\n\n```plantuml\n@startuml\nAlice -> Bob: Hello\n@enduml\n```\n\n' + '后续内容。\n\n'.repeat(30)
fs.writeFileSync(path.join(data, 'guide.md'), original)
fs.writeFileSync(path.join(data, 'chapter.md'), '# 下一页\n\n' + '下一页内容。\n\n'.repeat(25) + '## 目标\n\n导航目标正文。\n')
fs.writeFileSync(path.join(data, 'config.json'), '{"answer": 42, "enabled": true}\n')
fs.writeFileSync(path.join(data, 'config.yaml'), 'enabled: true\nname: sample\n')
fs.writeFileSync(path.join(data, 'config.xml'), '<root enabled="true"><name>sample</name></root>\n')
fs.writeFileSync(path.join(data, 'code.py'), 'def greet(name):\n    return "Hello " + name\n')
fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify({ settings: { layout: 'balanced', theme: 'dark', restore: false, defAgent: 'shell', confirmKill: false }, projects: [{ id: 'p', name: 'Reading', host: 'local', path: data, agent: 'shell' }] }))
const env = { ...process.env, AWB_USER_DATA: data }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: ['.'], env })
const failures = []
async function check(name, run) {
  try { await run(); console.log(`PASS ${name}`) }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message}`) }
}
try {
  const page = await app.firstWindow()
  await installDocumentHarness(app, page, false)
  page.on('pageerror', (error) => console.error('Renderer:', error.message))
  page.setDefaultTimeout(10000)
  await page.click('[data-a=rmode][data-id=files]')
  await page.click('[data-a=preview][data-id="guide.md"]')
  await page.getByRole('textbox', { name: 'Markdown 内容', exact: true }).waitFor()
  await check('Markdown outline floats beside the body instead of above the title', async () => {
    const layout = await page.locator('.markdown-outline').evaluate((outline) => {
      const title = document.querySelector('.ProseMirror h1').getBoundingClientRect(), panel = outline.getBoundingClientRect()
      return { position: getComputedStyle(outline).position, right: panel.right, titleLeft: title.left, panelTop: panel.top, titleTop: title.top }
    })
    assert.equal(layout.position, 'absolute', JSON.stringify(layout))
    assert.ok(layout.right <= layout.titleLeft, JSON.stringify(layout))
  })
  await check('single clicks keep separate file tabs and their original contents', async () => {
    await page.click('[data-a=preview][data-id="config.json"]')
    await page.click('[data-a=preview][data-id="code.py"]')
    try {
      for (const name of ['guide.md', 'config.json', 'code.py']) assert.equal(await page.locator('.tab [data-a=tab]').filter({ hasText: name }).count(), 1, `${name} must remain open`)
      await page.locator('.tab [data-a=tab]').filter({ hasText: 'config.json' }).click()
      const source = page.getByRole('textbox', { name: '文件内容', exact: true })
      assert.equal(await source.inputValue(), '{"answer": 42, "enabled": true}\n')
      await source.fill('{"draft": true}\n')
      await page.locator('.tab [data-a=tab]').filter({ hasText: 'code.py' }).click()
      await page.locator('.tab [data-a=tab]').filter({ hasText: 'config.json' }).click()
      assert.equal(await source.inputValue(), '{"draft": true}\n')
      await source.press('Control+z')
      assert.equal(await source.inputValue(), '{"answer": 42, "enabled": true}\n')
      assert.equal(fs.readFileSync(path.join(data, 'config.json'), 'utf8'), '{"answer": 42, "enabled": true}\n')
    } finally { await page.click('[data-a=preview][data-id="guide.md"]'); await page.getByRole('textbox', { name: 'Markdown 内容', exact: true }).waitFor() }
  })
  await check('local project menu offers Explorer and path copy instead of file creation', async () => {
    await page.getByLabel('项目菜单 Reading', { exact: true }).click()
    try {
      assert.equal(await page.getByRole('menuitem', { name: '新建文件', exact: true }).count(), 0)
      assert.equal(await page.getByRole('menuitem', { name: '新建文件夹', exact: true }).count(), 0)
      assert.equal(await page.getByRole('menuitem', { name: '在资源管理器中打开', exact: true }).count(), 1)
      await page.getByRole('menuitem', { name: '复制路径', exact: true }).click()
      assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), data)
      await app.evaluate(({ shell }) => { globalThis.__projectOpenPath = ''; globalThis.__projectOriginalOpenPath = shell.openPath; shell.openPath = async (target) => { globalThis.__projectOpenPath = target; return '' } })
      try {
        await page.getByLabel('项目菜单 Reading', { exact: true }).click()
        await page.getByRole('menuitem', { name: '在资源管理器中打开', exact: true }).click()
        await page.waitForFunction(() => !document.querySelector('[role=menu]'))
        assert.equal(await app.evaluate(() => globalThis.__projectOpenPath), data)
      } finally { await app.evaluate(({ shell }) => { shell.openPath = globalThis.__projectOriginalOpenPath }) }
    } finally { await page.keyboard.press('Escape') }
  })
  await check('list markers share the first text line', async () => {
    const offset = await page.locator('.milkdown-list-item-block').first().evaluate((node) => {
      const label = node.querySelector('.label-wrapper'), paragraph = node.querySelector('p')
      const a = label.getBoundingClientRect(), b = paragraph.getBoundingClientRect()
      return { delta: Math.abs((a.top + a.height / 2) - (b.top + parseFloat(getComputedStyle(paragraph).lineHeight) / 2)), label: [a.top, a.height], paragraph: [b.top, b.height], style: { lineHeight: getComputedStyle(paragraph).lineHeight, padding: getComputedStyle(paragraph).padding, margin: getComputedStyle(paragraph).margin } }
    })
    assert.ok(offset.delta < 3, JSON.stringify(offset))
  })
  await check('Markdown navigation exposes document headings', async () => {
    if (await page.getByRole('button', { name: '展开文档目录', exact: true }).count()) await page.getByRole('button', { name: '展开文档目录', exact: true }).click()
    assert.ok(await page.getByRole('navigation', { name: '文档目录' }).count())
    await page.getByRole('navigation', { name: '文档目录' }).getByRole('button', { name: '第二节', exact: true }).click()
    assert.ok(await page.locator('.markdown-editor').evaluate((node) => node.scrollTop > 200))
    const clearance = await page.locator('.markdown-editor').evaluate((node) => node.querySelector('h2').getBoundingClientRect().top - node.getBoundingClientRect().top)
    assert.ok(clearance >= 16 && clearance <= 32, `Heading must be visible near the top: ${clearance}px`)
    await page.getByRole('navigation', { name: '文档目录' }).getByRole('button', { name: '第二节', exact: true }).and(page.locator('[aria-current=location]')).waitFor()
  })
  await check('Mermaid renders an actual SVG image', async () => {
    await page.waitForFunction(() => document.querySelector('.diagram-preview[data-language=mermaid] img')?.naturalWidth > 0, null, { timeout: 20000 }).catch(async () => { throw new Error(await page.locator('.diagram-preview[data-language=mermaid]').textContent()) })
    const src = await page.locator('.diagram-preview[data-language=mermaid] img').getAttribute('src')
    assert.match(decodeURIComponent(src), /输入/)
  })
  await check('PlantUML renders through its online service', async () => {
    await page.waitForFunction(() => document.querySelector('.diagram-preview[data-language=plantuml] img')?.naturalWidth > 0, null, { timeout: 20000 })
    assert.match(await page.locator('.diagram-preview[data-language=plantuml] img').getAttribute('src'), /^https:\/\/www\.plantuml\.com\/plantuml\/svg\//)
  })
  await check('light mode updates every code gutter', async () => {
    await page.evaluate(() => { const root = document.documentElement; root.dataset.theme = 'light'; for (const key of [...root.style]) if (key.startsWith('--')) root.style.removeProperty(key) })
    const color = await page.locator('.cm-activeLineGutter').first().evaluate((node) => getComputedStyle(node).backgroundColor)
    assert.ok(!['rgb(34, 51, 34)', 'rgb(44, 49, 58)', 'rgb(0, 0, 0)'].includes(color), color)
    const colors = await page.locator('.cm-activeLineGutter').first().evaluate((node) => ({ active: getComputedStyle(node).backgroundColor, surface: getComputedStyle(node.closest('.cm-gutters')).backgroundColor }))
    assert.equal(colors.active, colors.surface, JSON.stringify(colors))
  })
  assert.equal(fs.readFileSync(path.join(data, 'guide.md'), 'utf8'), original)
  await check('relative document navigation validates boundaries and scrolls to anchors', async () => {
    const link = await page.evaluate(() => window.awb.documentLink('p', 'guide.md', 'chapter.md#目标'))
    assert.deepEqual(link, { path: 'chapter.md', anchor: '目标' })
    await assert.rejects(page.evaluate(() => window.awb.documentLink('p', 'guide.md', '../outside.md')), /路径|目录/)
    await assert.rejects(page.evaluate(() => window.awb.documentLink('p', 'guide.md', 'javascript:alert(1)')), /仅支持/)
    await documentCommand(app, page, 'mode')
    await page.getByRole('textbox', { name: '文件内容', exact: true }).fill(original + '\n[下一页](chapter.md#目标)\n')
    await documentCommand(app, page, 'mode')
    await page.getByRole('link', { name: '下一页', exact: true }).click()
    await page.getByRole('textbox', { name: 'Markdown 内容', exact: true }).locator('h2').filter({ hasText: '目标' }).waitFor()
    await page.waitForFunction(() => document.querySelector('.markdown-editor').scrollTop > 200)
  })
  await page.click('[data-a=preview][data-id="guide.md"]')
  await page.getByRole('textbox', { name: 'Markdown 内容', exact: true }).waitFor()
  await check('invalid diagrams show an error and edits render the latest content', async () => {
    await documentCommand(app, page, 'mode')
    const source = page.getByRole('textbox', { name: '文件内容', exact: true })
    await source.fill('# Invalid diagram\n\n```mermaid\nthis is not a supported diagram\n```\n')
    await documentCommand(app, page, 'mode')
    await page.locator('.diagram-preview [role=alert]').waitFor()
    await documentCommand(app, page, 'mode')
    await source.fill(original.replace('输出', '最新输出'))
    await documentCommand(app, page, 'mode')
    await page.locator('.milkdown-code-block').nth(1).scrollIntoViewIfNeeded()
    await page.waitForFunction(() => decodeURIComponent(document.querySelector('.diagram-preview[data-language=mermaid] img')?.src || '').includes('最新输出')).catch(async () => {
      const previews = await page.locator('.diagram-preview').evaluateAll((nodes) => nodes.map((node) => ({ text: node.textContent, id: node.dataset.diagramId, source: node.querySelector('img')?.getAttribute('src')?.slice(0, 200) })))
      throw new Error(JSON.stringify({ previews, codeViews: await page.locator('.milkdown-code-block').count(), codeEditors: await page.locator('.cm-editor').count() }))
    })
    await documentCommand(app, page, 'mode'); await source.fill(original); await documentCommand(app, page, 'mode')
    await page.getByRole('textbox', { name: 'Markdown 内容', exact: true }).waitFor()
    assert.equal(fs.readFileSync(path.join(data, 'guide.md'), 'utf8'), original)
  })
  await page.click('[data-a=preview][data-id="config.json"]')
  await check('JSON source contains actual syntax tokens', async () => {
    assert.ok(await page.locator('.source-highlight .hljs-attr').count(), 'no highlighted JSON property')
    assert.equal(await page.getByRole('textbox', { name: '文件内容', exact: true }).inputValue(), '{"answer": 42, "enabled": true}\n')
  })
  for (const [file, token] of [['config.yaml', 'attr'], ['config.xml', 'tag'], ['code.py', 'keyword']]) {
    await page.click(`[data-a=preview][data-id="${file}"]`)
    await check(`${file} has language tokens`, async () => assert.ok(await page.locator(`.source-highlight .hljs-${token}`).count()))
  }
  await page.locator('[data-a=file-search]').click()
  await page.getByLabel('搜索文件', { exact: true }).fill('guide')
  await page.locator('[data-a=search-file][data-id="guide.md"]').waitFor()
  await page.locator('[data-a=search-file][data-id="guide.md"]').click()
  await check('opening search result preserves query and results', async () => {
    assert.equal(await page.getByLabel('搜索文件', { exact: true }).inputValue(), 'guide')
    assert.ok(await page.locator('[data-a=search-file][data-id="guide.md"]').count())
  })
  await page.screenshot({ path: path.resolve('output/playwright/reading-workspace.png') })
  if (await page.getByRole('button', { name: '展开文档目录', exact: true }).count()) await page.getByRole('button', { name: '展开文档目录', exact: true }).click()
  await page.getByRole('navigation', { name: '文档目录' }).getByRole('button', { name: '第二节', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.diagram-preview[data-language=mermaid] img')?.naturalWidth > 0)
  await page.screenshot({ path: path.resolve('output/playwright/markdown-diagrams.png') })
  await check('floating outline works in both themes and window sizes without pushing the title down', async () => {
    for (const theme of ['dark', 'light']) for (const [width, height] of [[1440, 900], [1024, 680]]) {
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), [width, height])
      await page.evaluate((theme) => { document.documentElement.dataset.theme = theme }, theme)
      await page.waitForFunction(() => { const frame = document.querySelector('.markdown-view'); return frame.dataset.compact === String(frame.clientWidth < 720) })
      await page.locator('.markdown-editor').evaluate((node) => { node.scrollTop = 0 })
      if (await page.getByRole('button', { name: '收起文档目录', exact: true }).count()) await page.getByRole('button', { name: '收起文档目录', exact: true }).click()
      const titleTop = await page.locator('.ProseMirror h1').evaluate((node) => node.getBoundingClientRect().top)
      await page.getByRole('button', { name: '展开文档目录', exact: true }).click()
      assert.ok(Math.abs(await page.locator('.ProseMirror h1').evaluate((node) => node.getBoundingClientRect().top) - titleTop) < 1)
      const bounds = await page.locator('.markdown-outline').evaluate((node) => { const a = node.getBoundingClientRect(), b = node.closest('.markdown-view').getBoundingClientRect(); return a.left >= b.left && a.right <= b.right && a.top >= b.top && a.bottom <= b.bottom })
      assert.equal(bounds, true)
      assert.equal(await page.locator('.markdown-outline').evaluate((node) => node.getBoundingClientRect().right <= document.querySelector('.ProseMirror h1').getBoundingClientRect().left), true, 'The expanded outline must stay left of the body in narrow windows too')
      await page.screenshot({ path: path.resolve(`output/playwright/markdown-floating-outline-${theme}-${width}.png`) })
      await page.getByRole('navigation', { name: '文档目录' }).getByRole('button', { name: '第二节', exact: true }).click()
      await page.waitForFunction(() => document.querySelector('.markdown-editor').scrollTop > 200)
      if (await page.locator('.markdown-view[data-compact=true]').count()) {
        assert.equal(await page.getByRole('navigation', { name: '文档目录' }).count(), 0, 'Narrow outline closes after navigation')
        assert.equal(await page.getByRole('button', { name: '展开文档目录', exact: true }).evaluate((node) => node === document.activeElement), true)
      }
    }
  })
} finally {
  // A failed draft assertion must not leave an unattended native exit dialog.
  await app.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 1 }).catch(() => {})
  await app.close()
  fs.rmSync(data, { recursive: true, force: true })
}
assert.deepEqual(failures, [], `${failures.length} reading/workspace regressions`)
