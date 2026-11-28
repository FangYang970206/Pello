// Terminal search and the terminal's own context menu, as the Electron build's
// `terminal-search-check` reads them: Ctrl+F opens a search over the scrollback
// without sending a control byte; matches are counted, navigated and painted
// without taking the mouse selection; the context menu copies, pastes with
// bracketed paste, highlights in six colors and clears; a TUI that owns the
// mouse still gets its Alt-clicks while a plain drag selects text. The tab's
// own layout menu stays separate (the native menu, read through its stand-in
// file). Six themes, two window sizes and interface font 12 and 16, the
// alternate buffer and the IME guard. Drives the app over the WebView2 port.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launch, sleep } from './tauri-app.mjs'

if (process.platform !== 'win32') {
  console.log('SKIP terminal search: drives the Windows WebView2, Windows only')
  process.exit(0)
}

const quote = (s) => `'${s.replaceAll("'", "''")}'`
const shots = path.resolve('output/playwright/terminal-search')
fs.mkdirSync(shots, { recursive: true })
// The native tab menu writes its template to `<file>.json` and takes its
// choice from `<file>`; both live outside the app's data directory.
const menuDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pello-term-menu-'))
const menuFile = path.join(menuDir, 'menu')

const app = await launch({
  prepare: (data) => {
    fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify({
      settings: { restore: true, confirmKill: false, layout: 'focus' },
      projects: [{ id: 'p', name: 'Search', path: data, host: 'local', agent: 'probe' }],
      custom: [{ id: 'probe', name: 'Search probe', cmd: `& ${quote(process.execPath)}`, args: `${quote(path.resolve('scripts/fixtures/terminal-search.cjs'))} ${quote(path.join(data, 'input.log'))}`, shell: 'pwsh', env: [], letter: 'S', color: '#a9c3df' }],
      sessions: { p: [{ id: 's', kind: 'probe', shell: 'pwsh' }] }, activeTab: { p: 's' }
    }))
  },
  env: { AWB_MENU_FILE: menuFile },
})

const { page } = app
const log = path.join(app.data, 'input.log')
const host = page.locator('[data-term=s]')
const search = host.getByRole('search', { name: '终端搜索' })
const query = search.getByRole('textbox')
const ptyLog = () => (fs.existsSync(log) ? fs.readFileSync(log) : Buffer.alloc(0))
const geometry = () => page.evaluate(() => window.__awbGeometry('s'))
const screenCells = async () => {
  const screen = await page.locator('[data-term=s] .xterm-screen').boundingBox()
  const size = await geometry()
  return { screen, cell: screen.width / size.cols, row: screen.height / size.rows, lines: size.visibleText.split('\n') }
}
const openSearchAt = async (text) => {
  if (!(await geometry()).visibleText.includes(text)) {
    await page.locator('[data-term=s] textarea').press('Control+f')
    await query.fill(text)
    await page.waitForFunction((text) => window.__awbGeometry('s').visibleText.includes(text), text)
    await page.keyboard.press('Escape')
  }
}
const selectText = async (cells = 9) => {
  await openSearchAt('SELECT_ME')
  const { screen, cell, row, lines } = await screenCells()
  const line = lines.findIndex((text) => text.startsWith('SELECT_ME'))
  assert.ok(line >= 0, lines.join('\n'))
  await page.mouse.move(screen.x + cell * .2, screen.y + row * (line + .5))
  await page.mouse.down()
  await page.mouse.move(screen.x + cell * (cells + .2), screen.y + row * (line + .5), { steps: 12 })
  await page.mouse.up()
}
const pinned = (color) => page.locator(`[data-term=s] .terminal-hit[data-pinned=true]${color ? `[data-color=${color}]` : ''}`)

try {
  page.setDefaultTimeout(10000)
  await page.waitForFunction(() => window.__awbBuffer?.('s')?.includes('READY_SEARCH'), null, { timeout: 20000 })
  await page.locator('[data-term=s] textarea').focus()
  await page.keyboard.press('Control+f')
  await page.getByRole('search', { name: '终端搜索' }).waitFor()
  assert.ok(!ptyLog().includes(6), 'Ctrl+F must not reach the PTY')
  console.log('PASS Ctrl+F opens terminal search without sending a control byte')
  await query.fill('FIND_ME')
  await page.waitForFunction(() => document.querySelector('.terminal-search [role=status]')?.textContent === '1 / 100')
  assert.ok((await geometry()).visibleText.includes('line 0 FIND_ME'))
  await query.press('Enter')
  assert.equal(await search.getByRole('status').textContent(), '2 / 100')
  await query.press('Shift+Enter')
  assert.equal(await search.getByRole('status').textContent(), '1 / 100')
  await query.fill('find_me')
  await search.getByRole('button', { name: '区分大小写' }).click()
  await page.waitForFunction(() => document.querySelector('.terminal-search [role=status]')?.textContent === '无匹配')
  await search.getByRole('button', { name: '区分大小写' }).click()
  await query.fill('SELECT_ME')
  await query.press('Escape')
  await page.waitForFunction(() => !!document.activeElement?.closest('.xterm'))

  const menu = async (command) => {
    await host.click({ button: 'right', position: { x: 20, y: 45 } })
    const popup = host.getByRole('menu', { name: '终端文字操作' })
    await popup.waitFor()
    const items = await popup.locator('button').evaluateAll((buttons) => buttons.map((button) => ({ id: button.dataset.command, enabled: !button.disabled })))
    if (command) await popup.locator(`[data-command="${command}"]`).click()
    else await popup.press('Escape')
    await popup.waitFor({ state: 'detached' })
    return items
  }
  await selectText(18)
  const textMenu = await menu('copy')
  assert.ok(textMenu.some((item) => item.id === 'paste'))
  assert.ok(!textMenu.some((item) => item.id?.startsWith('split-') || item.id === 'rename'))
  const copied = await page.evaluate(() => navigator.clipboard.readText())
  assert.ok(copied.includes('SELECT_ME') && copied.includes('中文选择'), copied)
  await page.evaluate(() => navigator.clipboard.writeText('paste 中文\nsecond line'))
  await menu('paste')
  await page.waitForFunction(() => !!document.activeElement?.closest('.xterm'))
  await page.waitForTimeout(150)
  assert.ok(ptyLog().includes(Buffer.from('\x1b[200~paste 中文\rsecond line\x1b[201~')), 'Paste must use bracketed paste and retain Chinese')
  await page.evaluate(() => navigator.clipboard.writeText('KEYBOARD_PASTE'))
  const beforePaste = ptyLog().length
  await host.locator('textarea').press('Control+v')
  await page.waitForTimeout(300)
  assert.equal(ptyLog().subarray(beforePaste).toString(), '\x1b[200~KEYBOARD_PASTE\x1b[201~', 'A keyboard paste must reach the PTY exactly once')
  await selectText()
  await menu('highlight-amber')
  await page.waitForFunction(() => document.querySelectorAll('[data-term=s] .terminal-hit[data-pinned=true]').length > 0)
  // A background redraw must not replace a user's subsequent mouse selection.
  await selectText(18)
  assert.equal((await geometry()).selection, 'SELECT_ME 中文选择')
  await page.evaluate(() => window.awb.ptyWrite('s', 'REFRESH'))
  await page.waitForFunction(() => window.__awbBuffer('s').includes('BACKGROUND_REFRESH'))
  await page.waitForTimeout(400)
  assert.equal((await geometry()).selection, 'SELECT_ME 中文选择')
  await host.locator('textarea').press('Control+c')
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'SELECT_ME 中文选择', 'Selection must survive mouse release and background output after highlighting')
  await menu('highlight-green')
  await page.waitForFunction(() => ['amber', 'green'].every((color) => document.querySelector(`[data-term=s] .terminal-hit[data-pinned=true][data-color=${color}]`)))
  for (const color of ['cyan', 'blue', 'magenta', 'red']) {
    await menu(`highlight-${color}`)
    await page.waitForFunction((color) => !!document.querySelector(`[data-term=s] .terminal-hit[data-pinned=true][data-color=${color}]`), color)
    assert.equal(await pinned('amber').count(), 1, 'Other highlighted text keeps its color')
  }
  const highlighted = await menu(null)
  assert.equal(highlighted.find((item) => item.id === 'clear-highlight').enabled, true)
  await menu('clear-highlight')
  await page.waitForFunction(() => document.querySelectorAll('[data-term=s] .terminal-hit[data-pinned=true]').length === 0)
  await page.evaluate(() => window.awb.ptyWrite('s', 'MOUSE_ON'))
  await page.waitForFunction(() => window.__awbGeometry('s').mouse !== 'none')
  const beforeMouse = ptyLog().length
  await host.locator('.xterm-screen').click({ modifiers: ['Alt'] })
  await page.waitForTimeout(150)
  assert.ok(ptyLog().subarray(beforeMouse).includes(Buffer.from('\x1b[<')), 'Alt-click must still reach the TUI mouse protocol')
  await selectText()
  await page.waitForTimeout(400)
  assert.equal((await geometry()).selection, 'SELECT_ME', 'TUI drag selection survives release')
  await menu('copy')
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'SELECT_ME')
  await menu('search')
  await query.waitFor()
  assert.equal(await query.inputValue(), 'SELECT_ME')
  await selectText(18)
  await page.evaluate(() => window.awb.ptyWrite('s', 'REFRESH'))
  await page.waitForTimeout(400)
  assert.equal((await geometry()).selection, 'SELECT_ME 中文选择', 'An open search must not reselect its match on background output')
  await query.press('Escape')
  // A normal TUI drag must select successive text lines, not an Alt rectangle.
  const drag = await screenCells()
  const dragLine = drag.lines.findIndex((text) => text.startsWith('SELECT_ME'))
  const beforeDrag = ptyLog().length
  await page.mouse.move(drag.screen.x + drag.cell * .2, drag.screen.y + drag.row * (dragLine + .5))
  await page.mouse.down()
  await page.mouse.move(drag.screen.x + drag.cell * 6.2, drag.screen.y + drag.row * (dragLine + 1.5), { steps: 12 })
  await page.mouse.up()
  await page.waitForTimeout(100)
  assert.equal((await geometry()).selection.replaceAll('\r\n', '\n'), 'SELECT_ME 中文选择\nline 0')
  assert.equal(ptyLog().length, beforeDrag, 'Normal TUI selection must not send mouse reports')
  await menu('highlight-cyan')
  await page.waitForFunction(() => document.querySelectorAll('[data-term=s] .terminal-hit[data-pinned=true]').length === 2)
  await menu('clear-highlight')
  await selectText()
  await host.locator('textarea').press('Shift+F10')
  await host.getByRole('menu').waitFor()
  await page.keyboard.press('End')
  assert.equal(await page.evaluate(() => document.activeElement.dataset.command), 'highlight-red', 'Keyboard navigation skips disabled clear action')
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => !!document.activeElement?.closest('.xterm'))
  console.log('PASS scrollback navigation, case matching, Chinese drag-copy after output, six highlight colors, recoloring, bracketed paste and TUI selection')
  await page.evaluate(() => { window.__searchTerminal = document.querySelector('[data-term=s] .xterm') })
  // The tab's own menu is the native one: it offers the layout, not the text
  // actions, and splitting the tab does not rebuild the terminal.
  const tab = page.locator('[data-a=tab][data-id=s]')
  // Opened with no choice written, the native menu only writes its template
  // and returns nothing; the page then carries on as if it were dismissed.
  fs.rmSync(`${menuFile}.json`, { force: true })
  fs.writeFileSync(menuFile, '')
  await tab.click({ button: 'right' })
  let template = null
  for (let tries = 0; tries < 40 && !template; tries++) { await new Promise((resolve) => setTimeout(resolve, 100)); try { template = JSON.parse(fs.readFileSync(`${menuFile}.json`, 'utf8')) } catch { template = null } }
  assert.ok(Array.isArray(template), 'the tab menu did not write its template')
  const tabMenu = template.map((item) => ({ id: item.id, enabled: item.enabled !== false }))
  assert.ok(tabMenu.some((item) => item.id === 'split-right'))
  assert.ok(!tabMenu.some((item) => item.id === 'copy'))
  // The same menu, answered with "split right", splits the tab: the choice
  // is read by the kernel and handed back to the page.
  fs.rmSync(`${menuFile}.json`, { force: true })
  fs.writeFileSync(menuFile, 'split-right')
  await tab.click({ button: 'right' })
  await page.waitForFunction(() => document.querySelectorAll('.pane:not([hidden])').length === 2)
  await tab.click()
  await host.locator('textarea').press('Control+f')
  await query.fill('FIND_ME')
  await page.waitForFunction(() => document.querySelector('.terminal-search [role=status]')?.textContent.endsWith('/ 100'))
  const other = page.locator('.pane:not([hidden]):not([data-id=s]) .termhost')
  await other.locator('textarea').press('Control+f')
  await other.getByRole('search').getByRole('textbox').fill('READY_SEARCH')
  assert.equal(await query.inputValue(), 'FIND_ME', 'Each split keeps its own query')
  await other.getByRole('search').getByRole('textbox').press('Escape')
  await tab.click()
  for (const theme of ['light', 'dark', 'nord', 'dracula', 'catppuccin', 'solarized-light']) for (const [width, height] of [[1440, 900], [1024, 680]]) for (const uiSize of [12, 16]) {
    await page.click('[data-a=settings]')
    await page.click('[data-a=sec][data-id=look]')
    await page.click(`[data-a=theme][data-id=${theme}]`)
    await page.getByRole('combobox', { name: /^(界面字号|Interface font size)$/ }).selectOption(String(uiSize))
    await page.click('[data-a=back]')
    await page.evaluate(([w, h]) => window.awb.winResize(w, h), [width, height])
    await sleep(900)
    const separator = page.getByRole('separator', { name: '调整项目侧栏宽度', exact: true })
    const sidebarTarget = width === 1024 ? 380 : 240
    for (let step = 0; step < 200 && Number(await separator.getAttribute('aria-valuenow')) !== sidebarTarget; step++) {
      await separator.press(Number(await separator.getAttribute('aria-valuenow')) < sidebarTarget ? 'ArrowRight' : 'ArrowLeft')
    }
    await page.waitForTimeout(150)
    await query.focus()
    const rect = await search.boundingBox(), terminal = await host.boundingBox(), input = await query.boundingBox()
    assert.ok(input.width >= 64, `Input must stay usable: ${input.width}`)
    assert.ok(rect.x >= terminal.x && rect.x + rect.width <= terminal.x + terminal.width)
    assert.ok(rect.width / terminal.width <= (terminal.width > 480 ? .7 : 1))
    assert.ok(terminal.height - rect.height > 300, 'Search must preserve visible terminal content')
    await search.getByRole('button', { name: '下一个匹配' }).click()
    // ConPTY redraws the fixture's rows when resized; count the actual buffer.
    await page.waitForFunction(() => document.querySelector('.terminal-search [role=status]')?.textContent.endsWith(`/ ${(window.__awbBuffer('s').match(/FIND_ME/g) || []).length}`))
    assert.ok((await geometry()).visibleText.includes('FIND_ME'))
    // Open at the lower/right corner: the menu is kept inside the window.
    await host.click({ button: 'right', position: { x: terminal.width - 6, y: terminal.height - 6 } })
    const popup = host.getByRole('menu')
    await popup.waitFor()
    const menuBox = await popup.boundingBox()
    assert.ok(menuBox.x >= 0 && menuBox.y >= 0 && menuBox.x + menuBox.width <= width && menuBox.y + menuBox.height <= height)
    const balls = popup.getByRole('menuitemradio')
    assert.equal(await balls.count(), 6)
    const ballBoxes = await balls.evaluateAll((buttons) => buttons.map((button) => { const box = button.getBoundingClientRect(); return { y: box.y, width: box.width, height: box.height } }))
    assert.ok(ballBoxes.every((box) => box.y === ballBoxes[0].y && box.width >= 28 && box.height >= 28), 'Color balls stay on one usable row')
    await page.screenshot({ path: path.join(shots, `${theme}-${width}-ui${uiSize}.png`) })
    await popup.locator('[data-command=highlight-blue]').click()
    await page.waitForFunction(() => !!document.querySelector('[data-term=s] .terminal-hit[data-pinned=true][data-color=blue]'))
    assert.equal(await page.evaluate(() => window.__searchTerminal === document.querySelector('[data-term=s] .xterm')), true)
  }
  await query.focus()
  await query.dispatchEvent('keydown', { key: 'Enter', isComposing: true })
  await query.press('Escape')
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.imeSetComposition', { text: 'pin', selectionStart: 3, selectionEnd: 3 })
  await host.locator('textarea').dispatchEvent('keydown', { key: 'f', ctrlKey: true, isComposing: true })
  assert.equal(await search.count(), 0, 'IME composition must not open search')
  await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 })
  assert.ok(!ptyLog().includes(6), 'Search shortcut must never send Ctrl+F')
  await page.evaluate(() => window.awb.ptyWrite('s', 'ALT_ON'))
  await page.waitForFunction(() => window.__awbGeometry('s').buffer === 'alternate')
  await host.locator('textarea').press('Control+f')
  await query.fill('ALT_FIND')
  await page.waitForFunction(() => document.querySelector('.terminal-search [role=status]')?.textContent === '1 / 2')
  await page.waitForFunction(() => document.querySelectorAll('[data-term=s] .terminal-hit[data-pinned=false]').length === 2)
  await query.press('Enter')
  assert.equal(await search.getByRole('status').textContent(), '2 / 2')
  await page.screenshot({ path: path.join(shots, 'alternate.png') })
  await menu('highlight-magenta')
  await query.press('Escape')
  await page.waitForFunction(() => document.querySelectorAll('[data-term=s] .terminal-hit[data-pinned=true]').length === 2)
  await menu('clear-highlight')
  await page.waitForFunction(() => document.querySelectorAll('[data-term=s] .terminal-hit').length === 0)
  await host.locator('.xterm-screen').click({ position: { x: 10, y: 100 } })
  const emptyMenu = await menu(null)
  assert.ok(emptyMenu.filter((item) => item.id === 'copy' || item.id.startsWith('highlight-') || item.id === 'clear-highlight').every((item) => !item.enabled), 'No selection disables copy/colors; no marks disables clear')
  // Dismissed by clicking outside, and an English keyboard menu.
  await host.click({ button: 'right', position: { x: 30, y: 100 } })
  await host.getByRole('menu').waitFor()
  await tab.click()
  assert.equal(await host.getByRole('menu').count(), 0)
  await page.click('[data-a=settings]')
  await page.click('[data-a=sec][data-id=general]')
  await page.locator('[data-set=language]').selectOption('en')
  await page.waitForFunction(() => document.documentElement.lang === 'en')
  await page.click('[data-a=back]')
  await host.locator('textarea').press('Shift+F10')
  const englishMenu = host.getByRole('menu', { name: 'Terminal text actions' })
  await englishMenu.waitFor()
  assert.equal(await englishMenu.getByRole('menuitemradio', { name: 'Yellow' }).count(), 1)
  assert.equal(await englishMenu.getByRole('menuitem', { name: 'Clear highlights' }).count(), 1)
  await page.screenshot({ path: path.join(shots, 'english-menu.png') })
  await englishMenu.press('Escape')
  await page.waitForFunction(() => !!document.activeElement?.closest('.xterm'))
  console.log('PASS separate tab layout menu, split-pane search, retained xterm, six themes 1024/1440 UI 12/16, alternate-buffer colors and IME guard')
} finally {
  await app.close()
  fs.rmSync(menuDir, { recursive: true, force: true })
}
