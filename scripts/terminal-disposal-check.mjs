import assert from 'node:assert/strict'
import fs from 'node:fs'
import { loadTypeScript } from './fixtures/load-ts.mjs'

// Execute the production close entry points; replace only native processes and
// disk writes so overlapping Windows teardown can be measured deterministically.
const source = fs.readFileSync('src/main/pty.ts', 'utf8')
const start = source.includes('let terminalCloseQueue') ? source.indexOf('let terminalCloseQueue') : source.indexOf('export async function closeSession')
const fixture = { platform: 'win32', sessions: new Map(), active: 0, maximum: 0, flushed: [] }
globalThis.__terminalDisposal = fixture
const { closeSession, closeAllSessions } = await loadTypeScript(new URL('../src/main/pty.ts', import.meta.url), () => `
const fixture = globalThis.__terminalDisposal
const sessions = fixture.sessions
const process = { get platform() { return fixture.platform }, kill() {} }
const windowsDescendants = async () => []
const flushTerminalRecording = async (id?: string) => { fixture.flushed.push(id) }
${source.slice(start, source.indexOf('export async function testExecutor'))}
`)
const add = (id, fail = false) => {
  const dispose = async () => {
    fixture.active++; fixture.maximum = Math.max(fixture.maximum, fixture.active)
    try { await new Promise((resolve) => setImmediate(resolve)); if (fail) throw new Error('synthetic disposal failure') }
    finally { fixture.active-- }
  }
  fixture.sessions.set(id, { dispose, disposeRoot: dispose, prepareShutdown() {}, rootPid: () => null })
}
add('one'); add('two'); add('three')
await Promise.all([closeSession('one'), closeSession('two'), closeAllSessions()])
assert.equal(fixture.maximum, 1, 'Windows per-tab, session/project and application close must never overlap native PTY disposal')
assert.equal(fixture.sessions.size, 0)
assert.ok(fixture.flushed.includes('one') && fixture.flushed.includes('two') && fixture.flushed.includes(undefined))
add('failure', true); add('after-failure')
const failures = await Promise.allSettled([closeSession('failure'), closeSession('after-failure')])
assert.equal(failures[0].status, 'rejected'); assert.equal(failures[1].status, 'fulfilled')
assert.equal(fixture.sessions.has('failure'), true, 'A failed close retains its session for retry')
fixture.sessions.clear(); fixture.platform = 'linux'; fixture.maximum = 0
add('linux-one'); add('linux-two')
await Promise.all([closeSession('linux-one'), closeSession('linux-two')])
assert.equal(fixture.maximum, 2, 'Non-Windows process disposal keeps independent concurrency')
assert.equal(fixture.sessions.size, 0)
console.log('PASS serialized Windows terminal/session/project/app teardown, journal fences, failure recovery and independent non-Windows closes')
