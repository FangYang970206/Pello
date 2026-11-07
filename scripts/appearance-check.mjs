import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { buildSync } from 'esbuild'
import { _electron as electron } from 'playwright'

const compiled = path.resolve('.cache/goal-upgrade/themes-check.cjs')
buildSync({ entryPoints: ['src/shared/themes.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: compiled })
const { THEMES } = createRequire(import.meta.url)(compiled)
const luminance = (hex) => [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255).map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0)
const contrast = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05) }
for (const theme of THEMES) {
  for (const foreground of ['text', 'muted', 'faint']) for (const surface of ['bg', 'side', 'panel', 'elev', 'elev2']) assert.ok(contrast(theme.colors[foreground], theme.colors[surface]) >= 4.5, `${theme.id} ${foreground}/${surface} contrast`)
  assert.ok(contrast(theme.colors.ink, theme.colors.accent) >= 4.5, `${theme.id} accent text contrast`)
}
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-appearance-'))
const shell = process.platform === 'win32' ? 'pwsh' : 'bash'
const quote = (value) => `'${value.replaceAll("'", process.platform === 'win32' ? "''" : "'\\''")}'`
const command = `${process.platform === 'win32' ? '& ' : ''}${quote(process.execPath)}`
fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify({ settings: { theme: 'dark', restore: true, defShell: shell, confirmKill: false },
  projects: [{ id: 'p', name: 'Appearance fixture', host: 'local', path: data, branch: '', agent: 'tui' }],
  custom: [{ id: 'tui', name: 'Persistent TUI', cmd: command, args: `${quote(path.resolve('scripts/fixtures/terminal-ui.cjs'))} ${quote(path.join(data, 'input.txt'))}`, shell, letter: 'T', color: '#95cfaa', env: [] }],
  sessions: { p: [{ id: 'tui', kind: 'tui', shell }] }, activeTab: { p: 'tui' }
}))
const env = { ...process.env, AWB_USER_DATA: data }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: ['.'], env })
try {
  const page = await app.firstWindow()
  await page.waitForFunction(() => window.__awbBuffer?.('tui')?.includes('TERM_HEADER'))
  await page.evaluate(() => { window.__appearanceNode = document.querySelector('.termhost .xterm') })
  const mouse = await page.evaluate(() => window.__awbGeometry('tui').mouse)
  const shots = path.resolve('.cache/goal-upgrade/appearance')
  fs.mkdirSync(shots, { recursive: true })
  async function settings() { await page.click('[data-a=settings]'); await page.click('[data-a=sec][data-id=look]') }
  assert.equal((await page.evaluate(() => window.awb.getState())).db.settings.layout, 'focus', 'Missing layout settings must default to terminal focus')
  assert.equal(await page.locator('.right').count(), 0)
  await page.screenshot({ path: path.join(shots, 'default-focus.png') })
  await page.getByRole('button', { name: '显示文件面板', exact: true }).click()
  await page.locator('.right').waitFor()
  assert.equal(await page.evaluate(() => window.__appearanceNode === document.querySelector('.termhost .xterm')), true)
  await settings()
  await page.getByLabel('工作布局', { exact: true }).selectOption('balanced')
  await page.click('[data-a=back]')
  await page.locator('.right').waitFor()
  for (const theme of THEMES) {
    await settings()
    await page.click(`[data-a=theme][data-id="${theme.id}"]`)
    await page.waitForFunction((id) => document.documentElement.dataset.palette === id, theme.id)
    await page.click('[data-a=back]')
    for (const [width, height] of [[1024, 680], [1440, 900]]) {
      await page.evaluate(([width, height]) => window.awb.winResize(width, height), [width, height])
      await page.waitForFunction((width) => innerWidth === width, width)
      await page.screenshot({ path: path.join(shots, `${theme.id}-${width}.png`) })
      assert.equal(await page.evaluate(() => window.__appearanceNode === document.querySelector('.termhost .xterm')), true)
      assert.ok(await page.evaluate(() => window.__awbBuffer('tui').includes('TERM_HEADER')))
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    }
  }
  for (const font of ['Fira Code', 'IBM Plex Mono', 'JetBrains Mono']) {
    await settings(); await page.getByLabel('终端字体', { exact: true }).selectOption(font); await page.click('[data-a=back]')
    await page.evaluate((font) => document.fonts.load(`14px "${font}"`), font)
    assert.equal(await page.evaluate(() => window.__appearanceNode === document.querySelector('.termhost .xterm')), true)
    assert.equal(await page.evaluate(() => window.__awbGeometry('tui').mouse), mouse)
  }
  await settings()
  await page.getByLabel('工作布局', { exact: true }).selectOption('focus')
  await page.click('[data-a=back]')
  assert.equal(await page.locator('.right').count(), 0)
  await settings()
  await page.getByLabel('工作布局', { exact: true }).selectOption('review')
  await page.getByLabel('文件与变更面板位置', { exact: true }).selectOption('left')
  await page.getByLabel('界面密度', { exact: true }).selectOption('compact')
  await page.click('[data-a=back]')
  const boxes = await page.evaluate(() => ({ panel: document.querySelector('.right').getBoundingClientRect().toJSON(), center: document.querySelector('.center').getBoundingClientRect().toJSON() }))
  assert.ok(boxes.panel.right <= boxes.center.left + 1, 'Left panel must appear between projects and terminal')
  await page.getByRole('separator', { name: '调整文件面板宽度', exact: true }).press('ArrowRight')
  await page.waitForFunction((width) => document.querySelector('.right').getBoundingClientRect().width > width + 10, boxes.panel.width)
  assert.equal(await page.evaluate(() => window.__appearanceNode === document.querySelector('.termhost .xterm')), true)
  const saved = (await page.evaluate(() => window.awb.getState())).db.settings
  assert.equal(saved.theme, 'solarized-light'); assert.equal(saved.fontFamily, 'JetBrains Mono'); assert.equal(saved.layout, 'review'); assert.equal(saved.panelSide, 'left'); assert.equal(saved.density, 'compact')
  await page.screenshot({ path: path.join(shots, 'review-left-compact.png') })
  console.log('PASS default terminal focus, manual panel expansion, six accessible themes, bundled fonts, focus/review layouts, panel position, density and persistent terminal TUI state')
} finally { await app.close() }
