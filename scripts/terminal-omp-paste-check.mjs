import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright'

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pello-omp-paste-'))
const project = path.join(data, 'project')
fs.mkdirSync(project)
const shell = process.platform === 'win32' ? 'pwsh' : 'bash'
fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify({
  settings: { restore: false, autoCheckUpdates: false },
  custom: [{ id: 'omp-probe', name: 'OMP probe', cmd: 'omp', args: '--no-session --no-extensions --no-skills --model openai/gpt-5.2', shell, env: [], letter: 'P', color: '#a9c3df' }],
  projects: [{ id: 'p', name: 'OMP probe', path: project, host: 'local', agent: 'omp-probe' }]
}))
const env = { ...process.env, AWB_USER_DATA: data, PI_CODING_AGENT_DIR: path.join(data, 'agent'), OMP_SKIP_SETUP: '1', OPENAI_API_KEY: 'fixture-only', OPENAI_BASE_URL: 'http://127.0.0.1:1/v1' }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: ['.'], env })
const systemConpty = process.argv.includes('--system-conpty')
const page = await app.firstWindow()
let terminal
try {
  if (systemConpty) await app.evaluate(({ app }) => {
    const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json')
    const pty = require('node-pty')
    const spawn = pty.spawn
    pty.spawn = (file, args, options) => spawn(file, args, { ...options, useConptyDll: false })
  })
  await page.click('[data-a=quick]')
  terminal = await page.locator('[data-type=term][data-a=pane]').getAttribute('data-id')
  await page.waitForFunction((id) => /π[^\n]*gpt-5\.2/i.test(window.__awbBuffer?.(id) || ''), terminal, { timeout: 15000 })
  const oldClipboard = await app.evaluate(({ clipboard }) => clipboard.readText())
  try {
    const text = 'BEGIN_OMP_PASTE\n' + '0123456789 ABC 中文 🧪\n'.repeat(5000) + 'END_OMP_PASTE'
    await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), text)
    const input = page.locator(`[data-term="${terminal}"] textarea`)
    const start = performance.now()
    await input.press('Control+v')
    await page.waitForFunction((id) => /Pasted 5,?002 lines/.test(window.__awbBuffer?.(id) || ''), terminal, { timeout: 20000 })
    const elapsed = Math.round(performance.now() - start)
    console.log(`OMP rendered a ${Buffer.byteLength(text)} byte paste in ${elapsed} ms`)
    await input.press('Escape')
    await page.waitForFunction((id) => window.__awbBuffer?.(id)?.includes('📄 #1'), terminal)
    if (!systemConpty) assert.ok(elapsed <= 5000, 'OMP should render a large paste promptly')
  } finally { await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), oldClipboard) }
} catch (error) {
  console.error(await page.evaluate((id) => window.__awbBuffer?.(id)?.slice(-3500), terminal))
  throw error
} finally { await app.close() }
