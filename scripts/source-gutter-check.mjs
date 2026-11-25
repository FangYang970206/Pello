import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright'
import { savePaintSample, budgets, median } from './fixtures/performance-metrics.mjs'

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pello-source-gutter-'))
const original = '\ufeff' + Array.from({ length: 50000 }, (_, index) => `source line ${index + 1}\r\n`).join('')
fs.writeFileSync(path.join(data, 'large.txt'), original)
fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify({ settings: { restore: false, layout: 'balanced' }, projects: [{ id: 'p', name: 'Source gutter', path: data, host: 'local', agent: 'shell' }] }))
const env = { ...process.env, AWB_USER_DATA: data }; delete env.ELECTRON_RUN_AS_NODE
const dpi = Number(process.env.AWB_TEST_DPI || 1), output = path.resolve('output/source-gutter')
fs.mkdirSync(output, { recursive: true })
const executablePath = process.env.AWB_APP_EXE
const app = await electron.launch({ executablePath, args: [...(executablePath ? [] : ['.']), `--force-device-scale-factor=${dpi}`], env })
try {
  const page = await app.firstWindow(); page.setDefaultTimeout(15000)
  const open = async () => {
    await page.locator('[data-a=proj][data-id=p]').waitFor()
    await page.keyboard.press('Control+e')
    await page.locator('[data-a=preview][data-id="large.txt"]').click()
    await page.getByLabel('文件内容', { exact: true }).waitFor()
  }
  await open()
  const editor = page.getByLabel('文件内容', { exact: true })
  const initial = await page.locator('.editor-gutter').evaluate((node) => ({ elements: node.childElementCount, labels: node.textContent.split('\n') }))
  assert.ok(initial.elements <= 4, '50,001 source lines must not mount 50,001 gutter elements')
  assert.equal(initial.labels.length, 50001); assert.equal(initial.labels[0], '1'); assert.equal(initial.labels.at(-1), '50001')
  assert.equal(fs.readFileSync(path.join(data, 'large.txt'), 'utf8'), original)
  for (const theme of ['light', 'dark', 'nord', 'dracula', 'catppuccin', 'solarized-light']) for (const [width, height, font] of [[1024, 680, 16], [1440, 900, 12]]) {
    await page.evaluate(async ({ theme, font }) => { const { db } = await window.awb.getState(); await window.awb.saveSettings({ ...db.settings, theme, uiFontSize: font }) }, { theme, font })
    await page.reload(); await open()
    await page.evaluate(([width, height]) => window.awb.winResize(width, height), [width, height])
    await page.waitForFunction((width) => innerWidth === width, width)
    await editor.press('Control+End')
    await page.waitForFunction(() => Math.abs(document.querySelector('.editor-gutter').scrollTop - document.querySelector('.source-editor textarea').scrollTop) < 2)
    const bottom = await page.locator('.editor-gutter').evaluate((node) => {
      const text = node.firstChild, range = document.createRange(); range.setStart(text, text.textContent.lastIndexOf('50001')); range.setEnd(text, text.textContent.length)
      const label = range.getBoundingClientRect(), box = node.getBoundingClientRect()
      return { top: label.top, bottom: label.bottom, viewTop: box.top, viewBottom: box.bottom, font: getComputedStyle(node).fontSize, elements: node.childElementCount }
    })
    assert.ok(bottom.top >= bottom.viewTop && bottom.bottom <= bottom.viewBottom + 1, JSON.stringify(bottom))
    assert.equal(bottom.font, await editor.evaluate((node) => getComputedStyle(node).fontSize))
    assert.ok(bottom.elements <= 4)
    await page.screenshot({ path: path.join(output, `${theme}-${width}-${dpi}.png`) })
    await editor.press('Control+Home')
    await page.waitForFunction(() => document.querySelector('.source-editor textarea').selectionStart === 0)
    await page.waitForFunction(() => Math.abs(document.querySelector('.editor-gutter').scrollTop - document.querySelector('.source-editor textarea').scrollTop) < 2)
    const first = await page.locator('.editor-gutter').evaluate((node) => {
      const range = document.createRange(); range.setStart(node.firstChild, 0); range.setEnd(node.firstChild, 1)
      const label = range.getBoundingClientRect(), box = node.getBoundingClientRect()
      return { top: label.top, bottom: label.bottom, viewTop: box.top, viewBottom: box.bottom, scroll: node.scrollTop, sourceScroll: document.querySelector('.source-editor textarea').scrollTop }
    })
    assert.ok(first.top >= first.viewTop - 1 && first.bottom <= first.viewBottom, JSON.stringify(first))
    assert.ok(Math.abs(first.scroll - first.sourceScroll) < 2, JSON.stringify(first))
  }
  const samples = []
  for (let run = 0; run < 3; run++) { await editor.press('Control+End'); await editor.press('p'); samples.push(await savePaintSample(page, editor)) }
  assert.ok(median(samples) <= budgets.regression.limits.savePaintMs, `Large-source save paint ${median(samples)}ms exceeds existing budget`)
  assert.ok(fs.readFileSync(path.join(data, 'large.txt'), 'utf8').startsWith('\ufeffsource line 1\r\n'))
  await editor.press('Control+z'); assert.ok(!(await editor.inputValue()).endsWith('ppp'), 'Saving retains undo history')
  await editor.press('Control+y'); assert.ok((await editor.inputValue()).endsWith('ppp'), 'Redo restores the saved draft')
  await page.waitForFunction(() => !document.querySelector('.dot.unsaved'))
  await page.evaluate(() => window.awb.getState())
  fs.writeFileSync(path.join(output, `metrics-${dpi}.json`), JSON.stringify({ dpi, lines: 50001, samples, median: median(samples) }, null, 2))
  console.log(`PASS ${dpi}x DPI: 50,001 complete gutter labels, bounded DOM, first/last line navigation, synchronized scroll, all six themes, two windows, UI 12/16, BOM/CRLF, save paint and undo`)
} finally { await app.close() }
