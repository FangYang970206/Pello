import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ts from 'typescript'
import { _electron as electron } from 'playwright'
import { createServer } from 'node:http'

const root = path.resolve('.')
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pello-codex-native-'))
const home = path.join(data, 'codex-home'), project = path.join(data, 'project')
fs.mkdirSync(home); fs.mkdirSync(project)
// The actual CLI writes native history against a local deterministic Responses
// fixture. No real credentials, external requests, or model charges.
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (part) => { body += part })
  req.on('end', () => {
    const index = body.includes('NATIVE_USER_MESSAGE_1') ? 1 : 0
    const text = body.includes('NATIVE_USER_CONTINUED') ? `NATIVE_CONTINUED_REPLY_${index}` : `NATIVE_ASSISTANT_REPLY_${index}`
    const message = { id: 'message_fixture', type: 'message', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' })
    for (const event of [
      { type: 'response.created', response: { id: 'response_fixture', status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { ...message, content: [] } },
      { type: 'response.output_text.delta', item_id: message.id, output_index: 0, content_index: 0, delta: text },
      { type: 'response.output_item.done', output_index: 0, item: message },
      { type: 'response.completed', response: { id: 'response_fixture', status: 'completed', output: [message], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } } }
    ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    res.end()
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
server.unref()
fs.writeFileSync(path.join(home, 'config.toml'), `model = "fixture"\nmodel_provider = "fixture"\n[model_providers.fixture]\nname = "Fixture"\nbase_url = "http://127.0.0.1:${server.address().port}/v1"\nwire_api = "responses"\n[projects.${JSON.stringify(project)}]\ntrust_level = "trusted"\n`)
process.env.CODEX_HOME = home
let source = fs.readFileSync(path.join(root, 'src/main/codex-session.ts'), 'utf8')
source = source.replace(/import \{ bashQuote, psQuote, sshBatchArgs \} from '.\/platform'/, 'const bashQuote = JSON.stringify, psQuote = JSON.stringify, sshBatchArgs = () => []')
source = source.replace(/import \{ connectPasswordHost, remoteCommand \} from '.\/ssh'/, 'const connectPasswordHost = () => { throw new Error("unexpected remote") }, remoteCommand = () => ""')
const { createCodexThread } = await import(`data:text/javascript;base64,${Buffer.from(ts.transpile(source, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext })).toString('base64')}`)
const ids = [await createCodexThread(project), await createCodexThread(project)]
assert.notEqual(ids[0], ids[1], 'same-directory terminals must own different native threads')
const allFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((item) => item.isDirectory() ? allFiles(path.join(dir, item.name)) : [path.join(dir, item.name)])
for (const id of ids) {
  const file = allFiles(home).find((file) => file.endsWith(`${id}.jsonl`))
  assert.ok(file, 'thread/start must persist a native transcript before CLI attaches')
}
const shell = process.platform === 'win32' ? 'pwsh' : 'bash'
fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify({
  settings: { restore: true, theme: 'dark', confirmKill: false },
  projects: [{ id: 'p', name: 'Codex native restore', path: project, host: 'local', agent: 'codex' }],
  workSessions: { p: [{ id: 'a', name: '会话一' }, { id: 'b', name: '会话二' }] },
  activeSession: { p: 'a' }, activeTab: { p: 'a-term' },
  sessions: { p: [...ids.map((id, i) => ({ id: i ? 'b-term' : 'a-term', kind: 'codex', shell, sessionId: i ? 'b' : 'a', agentSessionId: id })), { id: 'new-term', kind: 'codex', shell, sessionId: 'a' }] }
}))
const env = { ...process.env, AWB_USER_DATA: data, CODEX_HOME: home }
delete env.ELECTRON_RUN_AS_NODE
let allocated
for (let launch = 0; launch < 2; launch++) {
  if (launch === 1) {
    const state = JSON.parse(fs.readFileSync(path.join(data, 'workbench.json'), 'utf8'))
    delete state.sessions.p.find((term) => term.id === 'b-term').agentSessionId
    fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify(state))
  }
  const app = await electron.launch({ args: [root], cwd: root, env })
  try {
    const page = await app.firstWindow()
    page.setDefaultTimeout(30000)
    if (launch === 0) {
      await page.waitForFunction(() => ['a-term', 'b-term'].every((id) => window.__awbBuffer?.(id)?.includes('Ask Codex')))
      await page.evaluate(() => {
        window.awb.ptyWrite('a-term', 'NATIVE_USER_MESSAGE_0')
        window.awb.ptyWrite('b-term', 'NATIVE_USER_MESSAGE_1')
      })
      await page.waitForTimeout(300)
      await page.evaluate(() => { window.awb.ptyWrite('a-term', '\r'); window.awb.ptyWrite('b-term', '\r') })
    }
    await page.waitForFunction(() => ['a-term', 'b-term'].every((id, index) => {
      const text = window.__awbBuffer?.(id) || ''
      return text.includes(`NATIVE_USER_MESSAGE_${index}`) && text.includes(`NATIVE_ASSISTANT_REPLY_${index}`)
    }))
    const db = (await page.evaluate(() => window.awb.getState())).db
    assert.deepEqual(db.sessions.p.slice(0, 2).map((term) => term.agentSessionId), ids)
    await page.waitForFunction(() => window.__awbBuffer?.('new-term')?.includes('Ask Codex'))
    const newId = (await page.evaluate(() => window.awb.getState())).db.sessions.p.find((term) => term.id === 'new-term').agentSessionId
    assert.ok(newId && !ids.includes(newId))
    if (launch === 0) allocated = newId
    else assert.equal(newId, allocated, 'an empty newly allocated native thread must also survive restart')
    if (launch === 1) {
      await page.waitForTimeout(1600)
      await page.evaluate(() => { window.awb.ptyWrite('a-term', 'NATIVE_USER_CONTINUED_0'); window.awb.ptyWrite('b-term', 'NATIVE_USER_CONTINUED_1') })
      await page.waitForTimeout(300)
      await page.evaluate(() => { window.awb.ptyWrite('a-term', '\r'); window.awb.ptyWrite('b-term', '\r') })
      await page.waitForFunction(() => ['a-term', 'b-term'].every((id, index) => window.__awbBuffer?.(id)?.includes(`NATIVE_CONTINUED_REPLY_${index}`)))
    }
    console.log(`PASS native Codex two-session conversation content, automatic exact resume, launch ${launch + 1}`)
  } catch (error) {
    const page = await app.firstWindow()
    console.error(await page.evaluate(() => ['a-term', 'b-term'].map((id) => window.__awbBuffer?.(id))))
    throw error
  } finally { await app.close() }
}
server.close()
console.log(`PASS native persisted Codex conversation restore using local model fixture (${data})`)
