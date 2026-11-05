import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright'

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-shell-profile-'))
const shell = process.platform === 'win32' ? 'pwsh' : 'bash'
fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify({
  settings: { restore: false, defShell: shell },
  projects: [{ id: 'p', name: 'Profile reuse', host: 'local', path: data, agent: 'shell' }]
}))
const env = { ...process.env, AWB_USER_DATA: data }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: ['.'], env })
try {
  const page = await app.firstWindow()
  await page.evaluate(() => {
    window.__profileReady = {}
    window.awb.onPty((event) => { if (event.type === 'state' && event.inputReady) window.__profileReady[event.id] = true })
  })
  await page.evaluate((shell) => window.awb.ptyCreate({ id: 'first', projectId: 'p', kind: 'shell', shell }), shell)
  await page.waitForFunction(() => window.__profileReady.first)
  const files = ['bashrc.sh', 'profile.ps1', '.zshrc'].map((name) => path.join(data, 'shell', name))
  const before = files.map((file) => ({ text: fs.readFileSync(file, 'utf8'), modified: fs.statSync(file).mtimeMs }))
  await page.evaluate((shell) => window.awb.ptyCreate({ id: 'second', projectId: 'p', kind: 'shell', shell }), shell)
  await page.waitForFunction(() => window.__profileReady.second)
  for (const [index, file] of files.entries()) {
    assert.equal(fs.readFileSync(file, 'utf8'), before[index].text)
    assert.equal(fs.statSync(file).mtimeMs, before[index].modified, 'New terminals must reuse unchanged profiles instead of rewriting a script another shell may be reading')
  }
  console.log('PASS subsequent terminals start without rewriting shared Bash, PowerShell or zsh initialization files')
} finally { await app.close() }
