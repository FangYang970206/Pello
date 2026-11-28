import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launchWorkbench } from './fixtures/launch-workbench.mjs'
import { installDocumentHarness } from './fixtures/document-harness.mjs'

const shots = path.resolve('output/playwright/tab-navigation')
fs.mkdirSync(shots, { recursive: true })
// Without an explicit DPI the page takes the desktop's own scale: a forced
// factor below the desktop's leaves the window too few physical pixels for
// the page sizes below, as `app.resize` refuses with the reason.
const dpiArg = process.argv.find((arg) => arg.startsWith('--dpi='))?.slice(6)
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pello-tab-navigation-'))
const names = Array.from({ length: 10 }, (_, i) => `long-tab-navigation-fixture-${i}.txt`)
for (const name of names) fs.writeFileSync(path.join(data, name), `${name}\n`)
const shell = process.platform === 'win32' ? 'pwsh' : 'bash'
fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify({
  settings: { theme: 'light', restore: true, confirmKill: false, autoCheckUpdates: false, layout: 'balanced' },
  projects: [{ id: 'p', name: 'Tab navigation', path: data, host: 'local', agent: 'shell' }],
  sessions: { p: [{ id: 'term', kind: 'shell', shell }] }, activeTab: { p: 'term' }
}))
const env = { ...process.env, AWB_USER_DATA: data }; delete env.ELECTRON_RUN_AS_NODE
const app = await launchWorkbench({ args: ['.'], env, scale: dpiArg ? Number(dpiArg) : null })
try {
  const page = await app.firstWindow(); page.setDefaultTimeout(15000)
  await installDocumentHarness(app, page, false)
  await page.locator('[data-a=proj]').click()
  if (!await page.locator('[data-a=rmode]').count()) await page.locator('[data-a=right]').click()
  await page.locator('[data-a=rmode][data-id=files]').click()
  await page.locator('[data-term=term] .xterm').waitFor()
  await page.evaluate(() => { window.__tabNavigationTerm = document.querySelector('[data-term=term] .xterm') })
  for (const name of names) await page.locator(`[data-a=preview][data-id="${name}"]`).click()
  const group = page.locator('[data-a=editor-group]').first()
  const ids = await group.locator('[data-a=tab]').evaluateAll((nodes) => nodes.map((node) => node.dataset.id))
  const active = () => group.locator('.tab.on [data-a=tab]').getAttribute('data-id')
  const trigger = group.locator('[data-a=tabs-menu]')
  const menu = page.locator('.tabs-popover')
  await trigger.click()
  await menu.waitFor()
  const anchored = async () => {
    const a = await trigger.boundingBox(), m = await menu.boundingBox()
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
    assert.ok(Math.abs(m.y - a.y - a.height - 4) < 2, 'List immediately below arrow')
    assert.ok(Math.abs(m.x - Math.max(12, Math.min(a.x, viewport.width - m.width - 12))) < 2, 'List tracks arrow horizontally')
    assert.ok(m.x >= 0 && m.x + m.width <= viewport.width && m.y + m.height <= viewport.height)
  }
  await anchored()
  await page.locator('.title .brand').click()
  await menu.waitFor({ state: 'detached' })
  await group.locator('.tabs').hover()
  await page.mouse.wheel(0, -100); await page.waitForTimeout(150)
  assert.equal(await active(), ids.at(-2), 'Mouse wheel switches to previous tab')
  await page.mouse.wheel(100, 0); await page.waitForTimeout(150)
  assert.equal(await active(), ids.at(-1), 'Horizontal wheel switches to next tab')
  await page.mouse.wheel(0, 100); await page.waitForTimeout(150)
  assert.equal(await active(), ids.at(-1), 'Last tab does not wrap')
  await page.keyboard.down('Control'); await page.mouse.wheel(0, -100); await page.keyboard.up('Control')
  assert.equal(await active(), ids.at(-1), 'Ctrl+wheel does not change tabs')
  await trigger.click(); await page.keyboard.press('Home'); await page.keyboard.press('Enter')
  assert.equal(await active(), 'term', 'Keyboard selects first tab')
  await group.locator('.tabs').hover(); await page.mouse.wheel(0, -100); await page.waitForTimeout(150)
  assert.equal(await active(), 'term', 'First tab does not wrap')
  await page.mouse.wheel(0, 100); await page.waitForTimeout(150)
  assert.equal(await active(), ids[1], 'Wheel switches terminal to file')
  const source = page.locator(`[data-a=pane][data-id="${ids[1]}"] textarea`)
  await source.fill('Retained unsaved tab draft\n')
  await group.locator('.tabs').hover(); await page.mouse.wheel(0, 100); await page.waitForTimeout(150)
  await page.mouse.wheel(0, -100); await page.waitForTimeout(150)
  assert.equal(await source.inputValue(), 'Retained unsaved tab draft\n')
  await source.press('Control+z'); assert.equal(await source.inputValue(), `${names[0]}\n`)
  // Keep the other split visible and prove wheel selection stays in its own group.
  fs.writeFileSync(app.menuFile, 'split-right')
  await group.locator('.tab.on').click({ button: 'right' })
  await page.waitForFunction(() => document.querySelectorAll('[data-a=editor-group]').length === 2)
  const otherId = await page.locator('[data-a=editor-group]').nth(1).locator('.tab.on [data-a=tab]').getAttribute('data-id')
  for (const theme of ['light', 'dark']) for (const [width, height] of [[1024, 680], [1440, 900]]) for (const size of [12, 16]) {
    await app.resize(width, height)
    await page.click('[data-a=settings]'); await page.click('[data-a=sec][data-id=look]')
    await page.click(`[data-a=theme][data-id=${theme}]`)
    await page.getByLabel('界面字号', { exact: true }).selectOption(String(size)); await page.click('[data-a=back]')
    await trigger.click(); await menu.waitFor()
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await anchored()
    await menu.getByRole('option').last().scrollIntoViewIfNeeded()
    await page.screenshot({ path: path.join(shots, `${theme}-${width}-${size}.png`) })
    await page.keyboard.press('Escape')
    assert.equal(await trigger.evaluate((node) => node === document.activeElement), true)
    await trigger.click(); await trigger.click(); await menu.waitFor({ state: 'detached' })
    await trigger.click(); await menu.getByRole('option').first().click(); await menu.waitFor({ state: 'detached' })
    await group.locator('.tabs').hover(); await page.mouse.wheel(0, 100); await page.waitForTimeout(150)
    assert.equal(await active(), ids[1])
    assert.equal(await page.locator('[data-a=editor-group]').nth(1).locator('.tab.on [data-a=tab]').getAttribute('data-id'), otherId)
    await trigger.click(); await page.locator('.title .brand').click(); await menu.waitFor({ state: 'detached' })
  }
  await page.click('[data-a=settings]'); await page.click('[data-a=sec][data-id=general]')
  await page.locator('[data-set=language]').selectOption('en'); await page.click('[data-a=back]')
  await trigger.click()
  assert.equal(await trigger.getAttribute('aria-label'), 'All tabs')
  // A sidebar drag moves the arrow without a window resize.
  const resizeHandle = page.locator('.sidebar-resize'), handle = await resizeHandle.boundingBox()
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
  await page.mouse.down(); await page.mouse.move(handle.x + 80, handle.y + handle.height / 2); await page.mouse.up()
  // Pointerdown outside dismisses the menu; reopen then resize its actual container.
  await trigger.click(); await menu.waitFor()
  await page.locator('#app').evaluate((node) => node.style.setProperty('--sidebar-width', '300px'))
  await page.waitForTimeout(150)
  const anchor = await trigger.boundingBox(), box = await menu.boundingBox()
  assert.ok(Math.abs(anchor.x - box.x) < 2, 'Open menu tracks container resizing without window resize')
  await page.screenshot({ path: path.join(shots, 'english-container-resize.png') })
  await page.keyboard.press('Escape')
  await group.locator('[data-a=tab][data-id=term]').evaluate((node) => node.scrollIntoView())
  await group.locator('[data-a=tab][data-id=term]').dblclick()
  const rename = group.locator('.sidebar-name-editor input')
  await rename.waitFor(); await rename.hover(); await page.mouse.wheel(0, 100); await page.waitForTimeout(150)
  assert.equal(await group.locator('.tab.on .sidebar-name-editor input').count(), 1, 'Wheel leaves rename input and tab selection intact')
  await rename.press('Escape')
  assert.equal(await active(), 'term')
  assert.equal(await page.evaluate(() => window.__tabNavigationTerm === document.querySelector('[data-term=term] .xterm')), true)
  console.log('PASS wheel switching, bounds, modifiers, draft/undo, stable terminal, split isolation, anchored menu, outside/Escape/toggle/selection dismissal; nine fresh screenshots')
} catch (error) {
  const page = await app.firstWindow(); await page.screenshot({ path: path.join(shots, 'failure.png') }); throw error
} finally { await app.close() }