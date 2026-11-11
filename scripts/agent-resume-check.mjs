import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ts from 'typescript'

const load = async (file, replace = (value) => value) => {
  const source = replace(fs.readFileSync(new URL(file, import.meta.url), 'utf8'))
  const js = ts.transpile(source, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext })
  return import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)
}
const { agentResumeCommand, terminalSessionKey } = await load('../src/main/agent-resume.ts')
const { matchLegacyConversation, openCodeConversations } = await load('../src/main/legacy-agent-session.ts')
const candidates = [
  { id: 'a', file: 'a.jsonl', messages: ['独属于第一段对话的用户提问', '第一段对话的独立回答'] },
  { id: 'b', file: 'b.jsonl', messages: ['独属于第二段对话的用户提问', '第二段对话的独立回答'] }
]
assert.equal(matchLegacyConversation('上次会话记录\n独属于第二段对话的用户提问\n第二段对话的独立回答', candidates)?.id, 'b')
assert.equal(matchLegacyConversation('没有能够定位的消息', candidates), null)
assert.equal(matchLegacyConversation('同一段无法区分归属的对话消息', candidates.map((item) => ({ ...item, messages: ['同一段无法区分归属的对话消息'] }))), null)
const exported = await openCodeConversations(process.cwd(), {}, async (args) => JSON.stringify(args[0] === 'list'
  ? [{ id: 'ses_fixture', directory: process.cwd() }]
  : { messages: [{ info: { role: 'user' }, parts: [{ type: 'text', text: '旧版OpenCode的独有对话消息' }] }] }))
assert.equal(matchLegacyConversation('旧版OpenCode的独有对话消息', exported)?.id, 'ses_fixture')
const quote = (text) => `'${text.replaceAll("'", "''")}'`
for (const kind of ['claude', 'codex', 'opencode', 'pi', 'omp']) {
  const a = agentResumeCommand(kind, kind, 'session-a', quote('D:/a'), quote)
  const b = agentResumeCommand(kind, kind, 'session-b', quote('D:/b'), quote)
  assert.ok(a.command.includes("'session-a'") && !a.command.includes('session-b'), `${kind} must resume its exact native session`)
  assert.ok(b.command.includes("'session-b'") && !b.command.includes('session-a'))
}
for (const kind of ['pi', 'omp']) {
  const a = agentResumeCommand(kind, kind, undefined, quote('D:/own-a'), quote)
  const b = agentResumeCommand(kind, kind, undefined, quote('D:/own-b'), quote)
  assert.match(a.command, /--session-dir 'D:\/own-a' --continue$/)
  assert.notEqual(a.command, b.command)
  assert.equal(agentResumeCommand(kind, kind, a.session, quote('D:/own-a'), quote).command, a.command)
}
const newClaude = agentResumeCommand('claude', 'claude', undefined, '', quote)
assert.match(newClaude.command, /--session-id '[\w-]+'/)
assert.notEqual(agentResumeCommand('claude', 'claude', undefined, '', quote).session, newClaude.session)
assert.notEqual(terminalSessionKey('a'), terminalSessionKey('b'))
assert.equal(terminalSessionKey('../../outside').includes('/'), false)

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pello-history-unit-'))
const history = await load('../src/main/terminal-history.ts', (source) => source.replace("import { app } from 'electron'", `const app = { getPath: () => ${JSON.stringify(data)} }`))
const text = 'BEGIN_历史记录\n' + '中文 conversation\n'.repeat(60000) + 'END_历史记录'
history.saveTerminalHistory('large', text)
assert.equal(history.loadTerminalHistory('large'), text, 'history must not silently discard older messages at 512 KB')
for (let i = 0; i < 105; i++) history.saveTerminalHistory(`terminal-${i}`, `terminal-${i} conversation`)
history.pruneTerminalHistory(['large', ...Array.from({ length: 105 }, (_, i) => `terminal-${i}`)])
assert.equal(history.loadTerminalHistory('terminal-0'), 'terminal-0 conversation', '100 other terminals must not evict a still-open session')
history.recordTerminalOutput('large', text)
history.recordTerminalOutput('large', '\x1b[3J\x1b[2J\x1b[Hnew screen')
assert.equal(fs.readFileSync(history.terminalRecording('large'), 'utf8'), text + '\x1b[3J\x1b[2J\x1b[Hnew screen', 'TUI clearing and UTF-8 must not erase the full output journal')
history.deleteTerminalHistory('large')
assert.equal(history.loadTerminalHistory('large'), '')
assert.equal(fs.existsSync(history.terminalRecording('large')), false)
console.log('PASS exact Agent resume, per-terminal native storage, untruncated history, 105-terminal retention and explicit deletion')
