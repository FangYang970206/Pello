import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright'
import { installDocumentHarness } from './fixtures/document-harness.mjs'

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pello-file-tabs-'))
const baseline = process.argv.includes('--baseline')
const file = path.join(data, 'page.html')
const html = (title) => `<h1>${title}</h1><script>window.visit = Math.random()</script><!--${'a'.repeat(1_500_000)}-->`
fs.writeFileSync(file, html('Original'))
fs.writeFileSync(path.join(data, 'other.txt'), 'Other file')
const largeSource = 'source line with data\n'.repeat(454_545)
const largeFile = path.join(data, 'large.txt')
fs.writeFileSync(largeFile, largeSource.padEnd(9_999_999, 'x'))
fs.writeFileSync(path.join(data, 'too-large.txt'), 'x'.repeat(10_000_001))
fs.writeFileSync(path.join(data, 'large.html'), `<h1>10 MB preview</h1><!--${'x'.repeat(9_999_960)}-->`)
fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify({
  settings: { layout: 'balanced', restore: false, autoCheckUpdates: false },
  projects: [{ id: 'p', name: 'File tabs', host: 'local', path: data, agent: 'shell' }]
}))
const env = { ...process.env, AWB_USER_DATA: data }; delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: ['.'], env })
try {
  const page = await app.firstWindow()
  await installDocumentHarness(app, page, false)
  await page.locator('[data-a=rmode][data-id=files]').click()
  await page.locator('[data-a=preview][data-id="page.html"]').click()
  const heading = page.frameLocator('iframe.html-preview').locator('h1')
  await heading.getByText('Original').waitFor()
  const visit = await heading.evaluate(() => window.visit)
  await page.locator('[data-a=preview][data-id="other.txt"]').click()
  await page.getByRole('textbox', { name: '文件内容', exact: true }).fill('Unsaved draft')
  const fileTab = page.locator('[data-a=tab]').filter({ hasText: 'page.html' })
  const otherTab = page.locator('[data-a=tab]').filter({ hasText: 'other.txt' })
  const switchTimes = []
  let priorVisit = visit
  for (let round = 0; round < 3; round++) {
    if (round) await otherTab.click()
    const start = performance.now()
    await fileTab.click()
    await heading.waitFor()
    switchTimes.push(Math.round(performance.now() - start))
    const nextVisit = await heading.evaluate(() => window.visit)
    if (baseline) assert.notEqual(nextVisit, priorVisit, 'Baseline should rerun page scripts')
    else assert.equal(nextVisit, visit, 'Switching tabs must preserve the HTML browsing context')
    priorVisit = nextVisit
  }
  console.log(`HTML tab switch to visible heading: ${switchTimes.join(', ')} ms (median ${switchTimes.toSorted((a, b) => a - b)[1]} ms)`)
  if (!baseline) {
    fs.writeFileSync(file, html('Updated'))
    await otherTab.click()
    await fileTab.click()
    await heading.getByText('Updated').waitFor({ timeout: 5000 })
    const updated = await heading.evaluate(() => window.visit)
    await app.evaluate(() => { globalThis.__documentMenuCommand = 'reload' })
    await page.locator('[data-a=preview][data-id="page.html"]').click({ button: 'right' })
    await heading.evaluate((previous) => new Promise((resolve, reject) => {
      const expires = performance.now() + 3000
      function check() {
        if (window.visit !== previous) resolve()
        else if (performance.now() > expires) reject(new Error('Preview did not rerender'))
        else requestAnimationFrame(check)
      }
      requestAnimationFrame(check)
    }), updated).catch(async () => {
      await heading.getByText('Updated').waitFor()
      assert.notEqual(await heading.evaluate(() => window.visit), updated)
    })
    console.log('PASS HTML tab preserves browsing context, checks external edits and refreshes unchanged HTML from the tree menu')
    await otherTab.click()
    fs.writeFileSync(path.join(data, 'other.txt'), 'External update')
    const source = page.getByRole('textbox', { name: '文件内容', exact: true })
    assert.equal(await source.inputValue(), 'Unsaved draft')
    await app.evaluate(() => { globalThis.__documentMenuCommand = 'reload' })
    await page.locator('[data-a=preview][data-id="other.txt"]').click({ button: 'right' })
    await page.getByRole('button', { name: '取消', exact: true }).click()
    assert.equal(await source.inputValue(), 'Unsaved draft')
    await app.evaluate(() => { globalThis.__documentMenuCommand = 'reload' })
    await page.locator('[data-a=preview][data-id="other.txt"]').click({ button: 'right' })
    await page.getByRole('button', { name: '放弃并重新读取', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.pane.focus textarea')?.value === 'External update')
    fs.writeFileSync(path.join(data, 'other.txt'), 'Live change')
    await page.waitForFunction(() => document.querySelector('.pane.focus textarea')?.value === 'Live change')
    console.log('PASS active local source refresh, explicit refresh confirmation, and preservation of an unsaved draft')

    await page.locator('[data-a=preview][data-id="large.txt"]').click()
    await source.waitFor()
    assert.equal(await source.evaluate((node) => node.value.length), 9_999_999)
    assert.ok(await source.evaluate((node) => getComputedStyle(node).webkitTextFillColor !== 'rgba(0, 0, 0, 0)'), 'Large source text must be visible')
    assert.ok(await page.locator('.pane.focus .editor-gutter').evaluate((node) => node.textContent.endsWith('454546')))
    await source.press('Control+End')
    await page.keyboard.type('!')
    await source.press('Control+s')
    await page.waitForFunction(() => !document.querySelector('.tab.on .unsaved'), { timeout: 10000 })
    assert.equal(fs.statSync(largeFile).size, 10_000_000)
    assert.equal(fs.readFileSync(largeFile, 'utf8').at(-1), '!')
    await page.locator('[data-a=preview][data-id="large.html"]').click()
    await page.locator('.pane.focus').frameLocator('iframe').getByRole('heading', { name: '10 MB preview' }).waitFor()
    await page.locator('[data-a=preview][data-id="too-large.txt"]').click()
    await page.getByText('文件超过 10 MB，请使用外部编辑器', { exact: true }).waitFor()
    console.log('PASS text opens and saves at 10 MB, large HTML actually renders, and larger text is refused')
  }
} finally {
  await app.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 1 }).catch(() => {})
  await app.close()
}
