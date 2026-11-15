import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { buildSync } from 'esbuild'
import { launchWorkbench } from './fixtures/launch-workbench.mjs'

const compiled = path.resolve('.cache/goal-upgrade/themes-check.cjs')
buildSync({ entryPoints: ['src/shared/themes.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: compiled })
const { THEMES } = createRequire(import.meta.url)(compiled)
const luminance = (hex) => [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255).map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0)
const contrast = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05) }
for (const theme of THEMES) {
  for (const foreground of ['text', 'muted', 'faint']) for (const surface of ['bg', 'side', 'panel', 'elev', 'elev2']) assert.ok(contrast(theme.colors[foreground], theme.colors[surface]) >= 4.5, `${theme.id} ${foreground}/${surface} contrast`)
  assert.ok(contrast(theme.colors.ink, theme.colors.accent) >= 4.5, `${theme.id} accent text contrast`)
}
const shell = process.platform === 'win32' ? 'pwsh' : 'bash'
const quote = (value) => `'${value.replaceAll("'", process.platform === 'win32' ? "''" : "'\\''")}'`
const command = `${process.platform === 'win32' ? '& ' : ''}${quote(process.execPath)}`
const shots = path.resolve('.cache/goal-upgrade/appearance')
fs.mkdirSync(shots, { recursive: true })
for (const scale of [1, 1.25, 1.5, 2]) {
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-appearance-'))
fs.writeFileSync(path.join(data, 'note.txt'), 'saved line\n')
fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify({ settings: { theme: 'dark', restore: true, defShell: shell, confirmKill: false },
  projects: [{ id: 'p', name: 'Appearance fixture', host: 'local', path: data, branch: '', agent: 'tui' }],
  custom: [{ id: 'tui', name: 'Persistent TUI', cmd: command, args: `${quote(path.resolve('scripts/fixtures/terminal-ui.cjs'))} ${quote(path.join(data, 'input.txt'))}`, shell, letter: 'T', color: '#95cfaa', env: [] }],
  sessions: { p: [{ id: 'tui', kind: 'tui', shell }] }, activeTab: { p: 'tui' }
}))
const env = { ...process.env, AWB_USER_DATA: data }
delete env.ELECTRON_RUN_AS_NODE
const app = await launchWorkbench({ args: ['.', `--force-device-scale-factor=${scale}`], env, scale })
try {
  const page = await app.firstWindow()
  await page.waitForFunction(() => window.__awbBuffer?.('tui')?.includes('TERM_HEADER'))
  assert.ok(Math.abs(await page.evaluate(() => devicePixelRatio) - scale) < .01, `Appearance must run at ${scale * 100}% device scale`)
  await page.evaluate(() => { window.__appearanceNode = document.querySelector('.termhost .xterm') })
  const mouse = await page.evaluate(() => window.__awbGeometry('tui').mouse)
  async function settings() { await page.click('[data-a=settings]'); await page.click('[data-a=sec][data-id=look]') }
  assert.equal((await page.evaluate(() => window.awb.getState())).db.settings.layout, 'focus', 'Missing layout settings must default to terminal focus')
  assert.equal(await page.locator('.right').count(), 0)
  await page.screenshot({ path: path.join(shots, `default-focus-${scale * 100}.png`) })
  await page.getByRole('button', { name: '显示文件面板', exact: true }).click()
  await page.locator('.right').waitFor()
  await page.click('[data-a=rmode][data-id=files]')
  await page.click('[data-a=preview][data-id="note.txt"]')
  const draft = page.getByRole('textbox', { name: '文件内容', exact: true })
  await draft.fill('saved line\nunsaved draft')
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
      await page.screenshot({ path: path.join(shots, `${theme.id}-${width}-${scale * 100}.png`) })
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
    assert.equal(await draft.inputValue(), 'saved line\nunsaved draft', 'Font switch must keep the open file draft')
    assert.equal(fs.readFileSync(path.join(data, 'note.txt'), 'utf8'), 'saved line\n', 'Font switch must not write the draft')
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
  await page.screenshot({ path: path.join(shots, `review-left-compact-${scale * 100}.png`) })
  assert.equal(await draft.inputValue(), 'saved line\nunsaved draft')
  console.log(`PASS ${scale * 100}% DPI: default terminal focus, manual panel expansion, six accessible themes, bundled fonts, focus/review layouts, panel position, density, persistent terminal and unsaved draft`)
} finally { await app.close() }
}
