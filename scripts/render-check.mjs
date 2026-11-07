import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import { installDocumentHarness } from './fixtures/document-harness.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const shots = path.join(root, 'output/playwright')
fs.mkdirSync(shots, { recursive: true })
const isWin = process.platform === 'win32'
const shell = isWin ? 'pwsh' : 'bash'
const quote = (value) => `'${value.replaceAll("'", isWin ? "''" : "'\\''")}'`
const requestedFonts = process.argv.slice(2)
for (const fontFamily of requestedFonts.length ? requestedFonts : ['Cascadia Mono']) for (const scale of [1, 1.25, 1.5, 2]) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-render-'))
  fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify({
    settings: { theme: 'dark', fontSize: 13, fontFamily, defShell: shell, defAgent: 'shell', restore: true, confirmKill: false },
    custom: [{ id: 'glyphs', name: 'Glyphs', cmd: `${isWin ? '& ' : ''}${quote(process.execPath)}`,
      args: quote(path.join(root, 'scripts/fixtures/terminal-glyphs.cjs')), shell, letter: 'G', color: '#7fb2ff', env: [] }],
    projects: [{ id: 'p', name: 'Rendering', host: 'local', path: data, agent: 'shell' }],
    sessions: { p: [{ id: 'glyphs', kind: 'glyphs', shell }] }
  }))
  const env = { ...process.env, AWB_USER_DATA: data }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ args: [root, `--force-device-scale-factor=${scale}`], cwd: root, env })
  try {
    const page = await app.firstWindow()
    await page.waitForFunction(() => window.__awbBuffer?.('glyphs')?.includes('终端边线测试'))
    await page.evaluate(() => document.fonts.ready)
    assert.equal((await page.evaluate(() => window.awb.getState())).db.settings.fontFamily, fontFamily)
    if (['Fira Code', 'IBM Plex Mono', 'JetBrains Mono'].includes(fontFamily)) assert.equal(await page.evaluate((family) => [...document.fonts].some((font) => font.family.replaceAll('"', '') === family && font.status === 'loaded'), fontFamily), true, `${fontFamily} must load its bundled font`)
    const alignment = await page.evaluate(() => {
      const tab = document.querySelector('.tab [data-a=tab]').getBoundingClientRect()
      const plus = document.querySelector('.addtab[data-a=newterm]').getBoundingClientRect()
      return Math.abs((tab.top + tab.bottom - plus.top - plus.bottom) / 2)
    })
    assert.ok(alignment <= 1, `Plus is vertically offset by ${alignment}px at ${scale}x`)
    const png = await page.locator('.pane:not([hidden]) .xterm-screen').screenshot()
    fs.writeFileSync(path.join(shots, `terminal-glyphs-${fontFamily.replaceAll(' ', '-')}-${scale * 100}.png`), png)
    const pixels = await app.evaluate(({ nativeImage }, png) => {
      const im = nativeImage.createFromBuffer(Buffer.from(png, 'base64'))
      const { width, height } = im.getSize()
      const bitmap = im.toBitmap()
      const rows = []
      for (let y = 0; y < Math.min(height, 400); y++) {
        let blue = false
        for (let x = 0; x < Math.min(width, 8); x++) {
          const at = (y * width + x) * 4
          const b = bitmap[at], g = bitmap[at + 1], r = bitmap[at + 2]
          if (b > 180 && g > 130 && r < 130) blue = true
        }
        rows.push(blue)
      }
      const first = rows.indexOf(true)
      let end = first
      while (rows[end]) end++
      return { first, uninterrupted: end - first, rendererWidth: width }
    }, png.toString('base64'))
    assert.ok(pixels.first >= 0 && pixels.uninterrupted >= 8 * 13 * scale - 4,
      `Broken vertical glyph at ${scale}x: ${JSON.stringify(pixels)}`)
    assert.equal(await page.locator('[data-renderer=webgl]').count(), 1)
    console.log(`PASS ${fontFamily} ${scale * 100}% DPI: plus offset ${alignment}px, continuous vertical line ${pixels.uninterrupted}px`)
    await installDocumentHarness(app, page, false)
    const split = async (id, direction, count) => {
      await app.evaluate((_electron, command) => { globalThis.__documentMenuCommand = command }, `split-${direction}`)
      await page.locator(`[data-a=pane][data-id="${id}"]`).dispatchEvent('contextmenu')
      await page.waitForFunction((count) => document.querySelectorAll('.pane:not([hidden])').length === count, count)
      return page.locator('.tab.on [data-a=tab]').getAttribute('data-id')
    }
    await page.evaluate(() => { window.__renderOriginal = document.querySelector('[data-term=glyphs] .xterm') })
    const right = await split('glyphs', 'right', 2)
    await split('glyphs', 'down', 3)
    await split(right, 'down', 4)
    await page.waitForFunction(() => [...document.querySelectorAll('.pane:not([hidden])')].every((node) => window.__awbBuffer(node.dataset.id).includes('终端边线测试')))
    await page.getByRole('separator', { name: '调整项目侧栏宽度', exact: true }).press('ArrowRight')
    await page.waitForTimeout(150)
    assert.equal(await page.evaluate(() => window.__renderOriginal === document.querySelector('[data-term=glyphs] .xterm')), true)
    const fitAll = await page.locator('.pane:not([hidden])').evaluateAll((nodes) => nodes.every((node) => {
      const frame = node.querySelector('.termframe').getBoundingClientRect(), screen = node.querySelector('.xterm-screen').getBoundingClientRect()
      return screen.width > 50 && screen.height > 50 && screen.right <= frame.right + 1 && screen.bottom <= frame.bottom + 1
    }))
    assert.equal(fitAll, true, `Four split panes must fit after sidebar resizing at ${scale}x`)
    assert.equal(await page.locator('[data-renderer=webgl]').count(), 4)
    await page.screenshot({ path: path.join(shots, `terminal-split-${scale * 100}.png`) })
    console.log(`PASS ${scale * 100}% DPI: four split terminals retain content, renderers and pixel bounds after sidebar resizing`)
    const closed = app.waitForEvent('close')
    await page.getByRole('button', { name: '关闭窗口', exact: true }).click()
    await closed
  } finally { await app.close().catch(() => {}) }
}
