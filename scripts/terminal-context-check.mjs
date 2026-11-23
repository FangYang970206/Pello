import assert from 'node:assert/strict'
import { loadTypeScript } from './fixtures/load-ts.mjs'

const { TerminalContextTracker, terminalTarget } = await loadTypeScript(new URL('../src/main/terminal-context.ts', import.meta.url))
const tracker = new TerminalContextTracker('session-token', 'term', 'project', { id: 'A' })
const hop = { socket: '/tmp/pello-ssh.abcdefgh/master', destination: 'user@B' }
const report = (route, cwd = '/project', token = 'session-token') => `\x1b]777;pello;context;${token};${Buffer.from(JSON.stringify({ route, cwd, user: '用户 B', hostname: 'B' })).toString('base64')}\x07`
const message = report([hop], '/project/中文')
let context, output = ''
for (const char of 'before' + message + 'after') {
  const parsed = tracker.push(char)
  output += parsed.text
  if (parsed.context !== undefined) context = parsed.context
}
assert.equal(output, 'beforeafter')
assert.equal(context.cwd, '/project/中文')
assert.equal(terminalTarget(context.id).projectId, 'project')
assert.equal(tracker.push(report([hop], '/project/中文')).context, undefined, 'Repeated prompts reuse the target')
assert.equal(tracker.push(report([hop], '/project/中文', 'wrong-token')).context, undefined)
assert.equal(tracker.push(report([{ ...hop, socket: '/tmp/foreign/master' }])).context, undefined)
assert.equal(tracker.push(report([hop], '../escape')).context, undefined)
const parent = context.id
const nested = tracker.push(report([hop, { ...hop, socket: '/tmp/pello-ssh.ijklmnop/master', destination: 'user@C' }])).context
assert.ok(terminalTarget(parent) && terminalTarget(nested.id))
tracker.push(report([hop], '/project/中文'))
assert.equal(terminalTarget(nested.id), undefined, 'Exiting a nested ssh invalidates only the closed route')
assert.ok(terminalTarget(parent))
assert.equal(tracker.push(report([])).context, null)
assert.equal(terminalTarget(parent), undefined)
assert.equal(tracker.push('\x1b[?2004h').text, '\x1b[?2004h')
const current = tracker.push(report([hop])).context
tracker.dispose()
assert.equal(terminalTarget(current.id), undefined)
console.log('PASS fragmented context reports, Unicode CWD, per-session tokens, socket/path validation, prompt deduplication, nested exit and cleanup')
