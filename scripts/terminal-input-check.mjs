import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright'

const root = path.resolve(import.meta.dirname, '..')
const shots = path.join(root, 'output/playwright/terminal-input')
fs.mkdirSync(shots, { recursive: true })
const isWin = process.platform === 'win32'
const shell = isWin ? 'pwsh' : 'bash'
const quote = (value) => `'${value.replaceAll("'", isWin ? "''" : "'\\''")}'`
for (const scale of process.argv.includes('--quick') ? [1] : [1, 1.25, 1.5, 2]) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pello-terminal-input-'))
  const log = path.join(data, 'input.txt')
  fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify({
    settings: { theme: 'light', layout: 'focus', restore: true, confirmKill: false },
    projects: [{ id: 'p', name: 'Input fixture', host: 'local', path: data, agent: 'input' }],
    custom: [{ id: 'input', name: 'Input fixture', cmd: `${isWin ? '& ' : ''}${quote(process.execPath)}`,
      args: `${quote(path.join(root, 'scripts/fixtures/terminal-input.cjs'))} ${quote(log)}`, shell, letter: 'I', color: '#c4aedb', env: [] }],
    sessions: { p: [{ id: 'input', kind: 'input', shell }] }, activeTab: { p: 'input' }
  }))
  const env = { ...process.env, AWB_USER_DATA: data }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ args: [root, `--force-device-scale-factor=${scale}`], cwd: root, env })
  try {
    const page = await app.firstWindow()
    const cdp = await page.context().newCDPSession(page)
    await page.waitForFunction(() => window.__awbBuffer?.('input')?.includes('INPUT_FOOTER 最底行'))
    await page.evaluate(() => { window.__inputTerminal = document.querySelector('[data-term=input] .xterm') })
    let expected = ''
    for (const [theme, width, height] of [['light', 1440, 900], ['dark', 1024, 680]]) {
      await page.click('[data-a=settings]')
      await page.click('[data-a=sec][data-id=look]')
      await page.click(`[data-a=theme][data-id=${theme}]`)
      await page.click('[data-a=back]')
      await page.evaluate(([width, height]) => window.awb.winResize(width, height), [width, height])
      await page.waitForFunction((width) => innerWidth === width, width)
      await page.waitForTimeout(150)
      const geometry = () => page.locator('[data-term=input]').evaluate((host) => {
        const screen = host.querySelector('.xterm-screen').getBoundingClientRect()
        const frame = host.querySelector('.termframe').getBoundingClientRect()
        return { x: screen.x, y: screen.y, width: screen.width, height: screen.height,
          frameX: frame.x, frameY: frame.y, scrollLeft: host.scrollLeft, scrollTop: host.scrollTop,
          cols: window.__awbGeometry('input').cols, rows: window.__awbGeometry('input').rows }
      })
      const before = await geometry()
      const stable = async (label) => assert.deepEqual(await geometry(), before, `${label}: IME must not scroll or move the terminal at ${scale}x ${theme}`)
      const anchored = async () => {
        const anchor = await page.locator('[data-term=input]').evaluate((host) => {
          const screen = host.querySelector('.xterm-screen').getBoundingClientRect()
          const area = host.querySelector('.xterm-helper-textarea').getBoundingClientRect()
          const view = host.querySelector('.composition-view').getBoundingClientRect()
          return { x: area.x - screen.x, compositionX: view.x - screen.x }
        })
        const cells = Array.from(expected).reduce((sum, char) => sum + (char.codePointAt(0) > 127 ? 2 : 1), 0)
        const expectedX = cells * before.width / before.cols
        assert.ok(Math.abs(anchor.x - expectedX) <= 1, `IME textarea must follow input, not the right edge: ${JSON.stringify({ anchor, expectedX })}`)
        assert.ok(Math.abs(anchor.compositionX - expectedX) <= 1, 'Visible pinyin must follow the input caret')
      }
      await page.locator('[data-term=input] .xterm-helper-textarea').focus()
      for (const composition of ['zhongwen', 'ceshizhongwenshuru'.repeat(12)]) {
        await cdp.send('Input.imeSetComposition', { text: composition, selectionStart: composition.length, selectionEnd: composition.length })
        await page.waitForTimeout(60)
        await stable('composing')
        await anchored()
        assert.equal(fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '', expected, 'Preedit must not reach the PTY')
        const committed = '测试中文输入'
        await cdp.send('Input.insertText', { text: committed })
        expected += committed
        await page.waitForFunction((expected) => window.__awbBuffer('input').includes(expected), expected)
        await stable('committed')
      }
      await cdp.send('Input.imeSetComposition', { text: 'quxiao', selectionStart: 6, selectionEnd: 6 })
      await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 })
      await page.keyboard.type(' ASCII')
      expected += ' ASCII'
      await page.waitForFunction((expected) => window.__awbBuffer('input').includes(expected), expected)
      assert.equal(fs.readFileSync(log, 'utf8'), expected, 'Each committed character must reach the PTY exactly once')
      await stable('cancelled and continued typing')
      assert.equal(await page.evaluate(() => window.__inputTerminal === document.querySelector('[data-term=input] .xterm')), true)
      const visible = await page.evaluate(() => window.__awbGeometry('input').visibleText)
      assert.ok(visible.startsWith('INPUT_HEADER 原有文字'))
      assert.ok(visible.split('\n').at(-1).startsWith('INPUT_FOOTER 最底行'))
      await page.screenshot({ path: path.join(shots, `${theme}-${scale * 100}.png`) })
      console.log(`PASS ${scale * 100}% ${theme} ${width}x${height}: short/long IME, commit, cancel, ASCII, fixed bounds and intact header/footer`)
    }
  } finally { await app.close() }
}
