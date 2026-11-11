import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { _electron as electron } from 'playwright'
import { execSync } from 'node:child_process'

const root = path.resolve('.')
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pello-pi-native-'))
const project = path.join(data, 'project'), agentHome = path.join(data, 'pi-home')
fs.mkdirSync(project); fs.mkdirSync(agentHome)
const npmRoot = execSync('npm root -g', { encoding: 'utf8', windowsHide: true }).trim()
const installed = ['@earendil-works', '@mariozechner'].map((scope) => path.join(npmRoot, scope, 'pi-coding-agent/dist/core/session-manager.js')).find((file) => fs.existsSync(file))
assert.ok(installed, 'Deep Pi checks require an installed Pi CLI')
const { SessionManager } = await import(pathToFileURL(installed).href)
const ids = ['pi-a', 'pi-b']
const nativeIds = []
const originals = []
for (const [index, id] of ids.entries()) {
  const directory = path.join(agentHome, 'sessions', `legacy-${index}`)
  const manager = SessionManager.create(project, directory)
  manager.appendMessage({ role: 'user', content: [{ type: 'text', text: `PI_USER_MESSAGE_${index}` }], timestamp: Date.now() })
  manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: `PI_ASSISTANT_REPLY_${index}` }], api: 'openai-responses', provider: 'openai', model: 'fixture', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() })
  nativeIds.push(manager.getSessionId())
  originals.push({ file: manager.getSessionFile(), content: fs.readFileSync(manager.getSessionFile(), 'utf8') })
  fs.mkdirSync(path.join(data, 'terminal-history'), { recursive: true })
  fs.writeFileSync(path.join(data, 'terminal-history', createHash('sha256').update(id).digest('hex') + '.log'), `PI_USER_MESSAGE_${index}\nPI_ASSISTANT_REPLY_${index}`)
}
assert.notEqual(nativeIds[0], nativeIds[1])
const shell = process.platform === 'win32' ? 'pwsh' : 'bash'
fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify({
  settings: { restore: true, theme: 'dark', confirmKill: false },
  projects: [{ id: 'p', name: 'Pi native restore', path: project, host: 'local', agent: 'pi' }],
  workSessions: { p: [{ id: 'a', name: '会话一' }, { id: 'b', name: '会话二' }] },
  activeSession: { p: 'a' }, activeTab: { p: ids[0] },
  sessions: { p: ids.map((id, i) => ({ id, kind: 'pi', shell, sessionId: i ? 'b' : 'a' })) }
}))
const env = { ...process.env, AWB_USER_DATA: data, PI_CODING_AGENT_DIR: agentHome }
delete env.ELECTRON_RUN_AS_NODE
for (let launch = 0; launch < 2; launch++) {
  const app = await electron.launch({ args: [root], cwd: root, env })
  try {
    const page = await app.firstWindow()
    page.setDefaultTimeout(30000)
    await page.waitForFunction((ids) => ids.every((id, index) => {
      const text = window.__awbGeometry?.(id)?.visibleText || ''
      return text.includes(`PI_USER_MESSAGE_${index}`) && text.includes(`PI_ASSISTANT_REPLY_${index}`)
    }), ids)
    const db = (await page.evaluate(() => window.awb.getState())).db
    assert.ok(db.sessions.p.every((term) => term.agentSessionId === 'pello:directory'), 'legacy terminals must acquire an unambiguous durable native mapping')
    for (const original of originals) assert.equal(fs.readFileSync(original.file, 'utf8'), original.content, 'legacy migration must preserve the original native file')
    console.log(`PASS Pi exact two-terminal native conversations restored without selecting sessions, launch ${launch + 1}`)
  } catch (error) {
    const page = await app.firstWindow()
    console.error(await page.evaluate((ids) => ids.map((id) => window.__awbBuffer?.(id)), ids))
    throw error
  } finally { await app.close() }
}
console.log(`PASS native Pi session storage, no model calls (${data})`)
