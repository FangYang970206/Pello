import assert from 'node:assert/strict'
import fs from 'node:fs'
import ts from 'typescript'

const source = fs.readFileSync(new URL('../src/main/program-status.ts', import.meta.url), 'utf8')
const { ProgramStatus } = await import(`data:text/javascript;base64,${Buffer.from(ts.transpile(source, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext })).toString('base64')}`)
const sequences = ['\x1b]7501;state=working:app=codex\x1b\\', '\x1b]7501;state=blocked:app=claude-code\x07', '\x1b]7501;state=done:app=pi\x1b\\', '\x1b]9;4;3\x07', '\x1b]9;4;0\x07']
for (const [index, sequence] of sequences.entries()) {
  for (let at = 0; at <= sequence.length; at++) {
    const parser = new ProgramStatus(), first = parser.push(`before${sequence.slice(0, at)}`), second = parser.push(`${sequence.slice(at)}after`)
    assert.equal(first.text + second.text, 'beforeafter')
    assert.deepEqual([...first.states, ...second.states], [index === 0 || index === 3 ? 'working' : 'waiting'])
  }
}
const parser = new ProgramStatus()
assert.equal(parser.push('\x1b]7501;?\x1b\\').queries, 1)
assert.equal(parser.push('\x1b]7501;state=working:id=child:app=claude-code\x07').states.length, 0)
assert.deepEqual(parser.push('\x1b]7501;state=clear\x07').states, ['clear'])
assert.equal(parser.push('\x1b]777;awb;prompt;0\x07\x1b[?2004h').text, '\x1b]777;awb;prompt;0\x07\x1b[?2004h')
const oversized = '\x1b]7501;' + 'x'.repeat(17000)
assert.equal(parser.push(oversized).text, oversized)
assert.deepEqual(parser.push('no output means nothing about state').states, [])
console.log('PASS native CLI status protocols, all packet splits, capability query, child-report isolation, unrelated escapes and bounded buffering')

const lifecycleSource = fs.readFileSync(new URL('../src/main/agent-lifecycle.ts', import.meta.url), 'utf8')
const { claudeLifecycle, submittedAgent, nativeAgent } = await import(`data:text/javascript;base64,${Buffer.from(ts.transpile(lifecycleSource, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext })).toString('base64')}`)
assert.equal(submittedAgent('& "D:\\工具\\claude.exe" --continue'), 'claude')
assert.equal(submittedAgent('opencode'), 'opencode')
assert.equal(submittedAgent('echo claude'), undefined)
assert.equal(submittedAgent('node agent.js | claude'), undefined)
assert.equal(nativeAgent('pi'), 'pi')
const states = []
const lifecycle = await claudeLifecycle((state) => states.push(state))
try {
  for (const event of ['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'PreToolUse', 'Stop', 'SessionEnd']) {
    const response = await fetch(lifecycle.settings.hooks[event][0].hooks[0].url, { method: 'POST', body: '{}' })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {})
  }
  assert.deepEqual(states, ['waiting', 'working', 'waiting', 'working', 'waiting', 'clear'])
  const url = lifecycle.settings.hooks.Stop[0].hooks[0].url
  assert.equal((await fetch(url)).status, 404)
  lifecycle.dispose()
  assert.equal((await fetch(url, { method: 'POST' })).status, 404)
} finally { lifecycle.dispose() }
console.log('PASS native Claude lifecycle hooks, scoped loopback tokens, disposal, and manually launched Agent identities')
