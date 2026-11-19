import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright'
import { loadTypeScript } from './fixtures/load-ts.mjs'

const { THEMES } = await loadTypeScript(new URL('../src/shared/themes.ts', import.meta.url))
const repro = process.argv.includes('--repro')
const shots = path.resolve('output/playwright/input-regression')
fs.mkdirSync(shots, { recursive: true })
const failures = []
const check = (ok, message) => { if (!ok) failures.push(message) }
for (const dpi of repro ? [1] : [1, 1.25, 1.5, 2]) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pello-input-regression-'))
  const log = path.join(data, 'input.log')
  const shell = process.platform === 'win32' ? 'pwsh' : 'bash'
  const quote = (text) => `'${text.replaceAll("'", process.platform === 'win32' ? "''" : "'\\''")}'`
  const original = '# Selection\n\nInline `code sample` and ordinary text.\n\n```js\nconst selected = "中文 selection"\n// second line\nconsole.log(selected, 42)\n```\n'
  fs.writeFileSync(path.join(data, 'selection.md'), original)
  fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify({
    settings: { restore: true, confirmKill: false, autoCheckUpdates: false, layout: 'balanced', theme: 'dark' },
    custom: [{ id: 'probe', name: 'Input probe', cmd: `${process.platform === 'win32' ? '& ' : ''}${quote(process.execPath)}`, args: `${quote(path.resolve('scripts/fixtures/terminal-search.cjs'))} ${quote(log)}`, shell, env: [], letter: 'I', color: '#a9c3df' }],
    projects: [{ id: 'p', name: 'Input regression', path: data, host: 'local', agent: 'probe' }],
    sessions: { p: Array.from({ length: 5 }, (_, i) => ({ id: `t${i}`, kind: 'probe', shell, name: 'iiiii' })) }, activeTab: { p: 't0' }
  }))
  const env = { ...process.env, AWB_USER_DATA: data }; delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ args: ['.', `--force-device-scale-factor=${dpi}`], env })
  try {
    const page = await app.firstWindow(); page.setDefaultTimeout(15000)
    await page.waitForFunction(() => window.__awbBuffer?.('t0')?.includes('READY_SEARCH'))
    await page.evaluate(() => { window.__inputTerm = document.querySelector('[data-term=t0] .xterm') })
    const clipboardBefore = await app.evaluate(({ clipboard }) => clipboard.readText())
    try {
      for (const shortcut of ['Control+v', 'Control+Shift+v']) {
        const text = `PASTE_${shortcut}_中文\nsecond line`
        const before = fs.existsSync(log) ? fs.readFileSync(log).length : 0
        await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), text)
        await page.locator('[data-term=t0] textarea').press(shortcut)
        await page.waitForTimeout(350)
        const actual = fs.readFileSync(log).subarray(before).toString()
        console.log(`PASTE ${shortcut}: ${JSON.stringify(actual)}`)
        check(actual === `\x1b[200~${text.replaceAll('\n', '\r')}\x1b[201~`, `${dpi}: ${shortcut} must paste exactly once with brackets`)
      }
    } finally { await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), clipboardBefore) }

    // Scan the threshold in actual tab containers; measure every animation frame,
    // since a single boundingBox can happen to observe either half of a loop.
    const group = page.locator('[data-a=editor-group]').first()
    const geometry = await group.evaluate((node) => {
      const tabs = node.querySelector('.tabs')
      const content = [...tabs.children].reduce((sum, kid) => sum + kid.getBoundingClientRect().width, 0) + (tabs.children.length - 1) * 2
      const bar = getComputedStyle(node), tools = node.querySelector('[data-a=newterm]').getBoundingClientRect().width
      return { content, fixed: parseFloat(bar.paddingLeft) + parseFloat(bar.paddingRight) + tools + parseFloat(bar.columnGap) * (node.children.length - 1) }
    })
    for (const offset of [-48, -24, -4, 0, 4, 12, 24, 48]) {
      await group.evaluate((node, width) => { node.style.width = `${width}px` }, geometry.content + geometry.fixed + offset)
      const samples = await group.evaluate((node) => new Promise((resolve) => {
        const values = []
        const sample = () => {
          const plus = node.querySelector('[data-a=newterm]'), arrow = node.querySelector('[data-a=tabs-menu]')
          values.push([plus.getBoundingClientRect().x, arrow?.getBoundingClientRect().x ?? null])
          if (values.length < 36) requestAnimationFrame(sample); else resolve(values.slice(6))
        }
        requestAnimationFrame(sample)
      }))
      const positions = new Set(samples.map((sample) => JSON.stringify(sample)))
      console.log(`TABS dpi=${dpi} offset=${offset} positions=${positions.size}`)
      check(positions.size === 1, `${dpi}: tab plus/arrow must settle at offset ${offset} (${positions.size} positions)`)
    }
    await group.evaluate((node) => { node.style.width = '' })
    await page.locator('[data-a=rmode][data-id=files]').click()
    await page.locator('[data-a=preview][data-id="selection.md"]').click()
    const content = page.locator('.milkdown .cm-content')
    await content.waitFor()
    await page.evaluate(() => { window.__inputCode = document.querySelector('.milkdown .cm-editor') })
    const cases = THEMES.map((theme) => ({ theme, width: 1440, height: 900, size: 12 }))
    if (!repro && dpi === 1) for (const theme of THEMES.filter((theme) => theme.id === 'dark' || theme.id === 'light')) {
      for (const [width, height, size] of [[1440, 900, 16], [1024, 680, 12], [1024, 680, 16]]) cases.push({ theme, width, height, size })
    }
    for (const { theme, width, height, size } of cases) {
      await page.evaluate(([width, height]) => window.awb.winResize(width, height), [width, height])
      await page.click('[data-a=settings]'); await page.click('[data-a=sec][data-id=look]')
      await page.click(`[data-a=theme][data-id=${theme.id}]`)
      await page.getByLabel('界面字号', { exact: true }).selectOption(String(size)); await page.click('[data-a=back]')
      await content.locator('.cm-line').first().click()
      await page.keyboard.press('Home')
      // Real pointer selection spanning syntax tokens and multiple lines.
      const lines = content.locator('.cm-line'), first = await lines.first().boundingBox(), last = await lines.last().boundingBox()
      await page.mouse.move(first.x + 2, first.y + first.height / 2); await page.mouse.down()
      await page.mouse.move(last.x + 100, last.y + last.height / 2, { steps: 12 }); await page.mouse.up()
      await page.waitForTimeout(80)
      const colors = await content.evaluate((node) => {
        const editor = node.closest('.cm-editor'), mark = editor.querySelector('.cm-selectionBackground')
        const style = getComputedStyle(node), selection = getComputedStyle(node, '::selection')
        return { selected: window.getSelection()?.toString(), overlay: mark && getComputedStyle(mark).backgroundColor, native: selection.backgroundColor, foreground: style.color, surface: getComputedStyle(editor).backgroundColor }
      })
      console.log(`SELECTION ${theme.id}: ${JSON.stringify(colors)}`)
      check(!!colors.selected && !!colors.overlay, `${theme.id}: pointer selects code with a drawn highlight`)
      check(colors.native === 'rgba(0, 0, 0, 0)', `${theme.id}: native selection must not cover CodeMirror text`)
      const expected = theme.colors.accent.match(/[a-f\d]{2}/gi).map((part) => parseInt(part, 16))
      check(colors.overlay === `rgba(${expected.join(', ')}, 0.14)`, `${theme.id}: drawn selection must follow the current theme`)
      const tokens = await content.locator('.cm-line span').evaluateAll((nodes) => nodes.map((node) => ({ selected: getComputedStyle(node, '::selection').color, background: getComputedStyle(node, '::selection').backgroundColor })))
      check(tokens.every((token) => token.selected === colors.foreground && token.background === 'rgba(0, 0, 0, 0)'), `${theme.id}: selected syntax tokens must use readable theme foregrounds`)
      const rgb = (color) => color.match(/[\d.]+/g).map(Number)
      const surface = rgb(colors.surface), overlay = rgb(colors.overlay)
      const background = surface.map((channel, index) => channel * (1 - overlay[3]) + overlay[index] * overlay[3])
      const luminance = (color) => color.map((channel) => { channel /= 255; return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4 }).reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0)
      const foregroundLuminance = luminance(rgb(colors.foreground)), backgroundLuminance = luminance(background)
      const contrast = (Math.max(foregroundLuminance, backgroundLuminance) + .05) / (Math.min(foregroundLuminance, backgroundLuminance) + .05)
      check(contrast >= 4.5, `${theme.id}: selected code contrast ${contrast.toFixed(2)} must be at least 4.5:1`)
      await page.screenshot({ path: path.join(shots, `${repro ? 'before' : 'after'}-${dpi}-${theme.id}-${width}-ui${size}.png`) })
      await page.locator('.title .brand').click()
      const blurred = await page.locator('.milkdown .cm-selectionBackground').first().evaluate((node) => getComputedStyle(node).backgroundColor)
      check(blurred === colors.overlay, `${theme.id}: unfocused code selection must retain theme color`)
      await content.press('ArrowRight')
    }
    check(fs.readFileSync(path.join(data, 'selection.md'), 'utf8') === original, 'Selection/theme switch must not rewrite Markdown')
    check(await page.evaluate(() => window.__inputTerm === document.querySelector('[data-term=t0] .xterm') && window.__inputCode === document.querySelector('.milkdown .cm-editor')), 'Theme switch must preserve terminal and code editor instances')
  } finally { await app.close() }
}
assert.deepEqual(failures, [])
console.log('PASS exact native clipboard paste, stable multi-Agent tab threshold, and pointer code selection in all six themes')
