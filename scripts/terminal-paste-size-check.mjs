import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright'

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pello-large-paste-'))
const baseline = process.argv.includes('--baseline')
const log = path.join(data, 'input.log')
const shellKind = process.platform === 'win32' ? 'pwsh' : 'bash'
const quote = (value) => `'${value.replaceAll("'", process.platform === 'win32' ? "''" : "'\\''")}'`
fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify({
  settings: { restore: true, autoCheckUpdates: false },
  custom: [{ id: 'probe', name: 'Paste probe', cmd: `${process.platform === 'win32' ? '& ' : ''}${quote(process.execPath)}`, args: `${quote(path.resolve('scripts/fixtures/terminal-search.cjs'))} ${quote(log)}`, shell: shellKind, env: [], letter: 'P', color: '#a9c3df' }],
  projects: [{ id: 'p', name: 'Paste probe', path: data, host: 'local', agent: 'probe' }],
  sessions: { p: [{ id: 't0', kind: 'probe', shell: shellKind }] }, activeTab: { p: 't0' }
}))
const env = { ...process.env, AWB_USER_DATA: data }; delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: ['.'], env })
try {
  const page = await app.firstWindow()
  await page.waitForFunction(() => window.__awbBuffer?.('t0')?.includes('READY_SEARCH'))
  await app.evaluate(({ app }) => {
    const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json')
    const proto = process.platform === 'win32'
      ? require('node-pty/lib/windowsTerminal.js').WindowsTerminal.prototype
      : require('node-pty/lib/unixTerminal.js').UnixTerminal.prototype
    const write = proto._write
    globalThis.__pasteWrites = []
    proto._write = function (data) {
      globalThis.__pasteWrites.push(Buffer.byteLength(data))
      return write.call(this, data)
    }
  })
  const clipboardBefore = await app.evaluate(({ clipboard }) => clipboard.readText())
  try {
    const text = 'a'.repeat(8185) + '🧪中文\r\n' + 'text 中文 🧪\n'.repeat(16_000)
    const expected = Buffer.from(`\x1b[200~${text.replace(/\r?\n/g, '\r')}\x1b[201~Z`)
    await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), text)
    const input = page.locator('[data-term=t0] textarea')
    await page.evaluate(() => {
      window.__pasteKeyPaint = new Promise((resolve) => {
        const measure = (event) => {
          if (event.key.toLowerCase() !== 'z') return
          document.removeEventListener('keydown', measure, true)
          const start = performance.now()
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - start)))
        }
        document.addEventListener('keydown', measure, true)
      })
    })
    const started = performance.now()
    await input.press('Control+v')
    await input.press('Z')
    await assert.doesNotReject(async () => {
      for (let index = 0; index < 500; index++) {
        if (fs.existsSync(log) && fs.statSync(log).size >= expected.length) return
        await new Promise((resolve) => setTimeout(resolve, 40))
      }
      throw new Error(`Expected ${expected.length} PTY bytes, received ${fs.existsSync(log) ? fs.statSync(log).size : 0}`)
    })
    assert.ok(fs.readFileSync(log).equals(expected), 'Paste must preserve Unicode, input order and a single bracketed sequence')
    const writes = await app.evaluate(() => globalThis.__pasteWrites)
    const keyPaint = await page.evaluate(() => window.__pasteKeyPaint)
    console.log(`PTY paste: ${expected.length} bytes, largest write ${Math.max(...writes)} bytes, finished in ${Math.round(performance.now() - started)} ms, next key to paint ${Math.round(keyPaint)} ms`)
    assert.ok(Number.isFinite(keyPaint) && keyPaint <= 250, 'Rendering must yield while a large paste is in transit')
    if (baseline) assert.ok(Math.max(...writes) > 64 * 1024, 'Baseline should demonstrate the unbounded write')
    else assert.ok(writes.length > 2 && Math.max(...writes) <= 64 * 1024, 'Large clipboard input must yield between bounded PTY writes')
  } finally { await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), clipboardBefore) }
} finally { await app.close() }
