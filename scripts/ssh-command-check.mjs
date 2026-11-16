import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { loadTypeScript } from './fixtures/load-ts.mjs'

let visitedBytes = 0
globalThis.__sshCommandBuffer = { byteLength(value) { const size = Buffer.byteLength(value); visitedBytes += size; return size } }

// Exercise the production command collector with a fragmented SSH channel.
// Bound bytes visited by UTF-8 accounting rather than using a machine-speed deadline.
const { runPasswordCommand } = await loadTypeScript(new URL('../src/main/ssh.ts', import.meta.url), (source) => {
  const start = source.indexOf('export async function runPasswordCommand(')
  const end = source.indexOf('export interface TerminalProcess', start)
  return `const t = (key: string) => key
const connectPasswordHost = async () => globalThis.__sshCommandClient
const Buffer = globalThis.__sshCommandBuffer
${source.slice(start, end)}`
})

async function collect(parts, maxOutput, code = 0, stderr = '') {
  visitedBytes = 0
  const client = new EventEmitter(), stream = new EventEmitter()
  stream.stderr = new EventEmitter()
  stream.setEncoding = stream.stderr.setEncoding = () => {}
  stream.end = (value) => { stream.input = value }
  client.end = client.destroy = () => { client.closed = true }
  client.exec = (_command, callback) => {
    callback(null, stream)
    queueMicrotask(() => {
      for (const part of parts) { if (client.closed) break; stream.emit('data', part) }
      if (stderr) stream.stderr.emit('data', stderr)
      stream.emit('close', code)
    })
  }
  globalThis.__sshCommandClient = client
  const result = await runPasswordCommand({}, 'fixture command', 'stdin contents', maxOutput)
  assert.equal(stream.input, 'stdin contents')
  assert.ok(client.closed, 'Completed SSH commands close their connection')
  return result
}

try {
  const parts = Array(4096).fill('x'.repeat(64)), expected = parts.join('')
  assert.equal(await collect(parts, Buffer.byteLength(expected)), expected)
  assert.ok(visitedBytes <= Buffer.byteLength(expected) * 2, `Fragmented output must use linear UTF-8 byte accounting; visited ${visitedBytes} bytes for ${expected.length} output bytes`)
  assert.equal(await collect(['中文', '🐧'], 10), '中文🐧')
  await assert.rejects(collect(['中文', '🐧'], 9), /远程输出过大/)
  await assert.rejects(collect(['partial'], 100, 1, 'remote failure'), /remote failure/)
  console.log('PASS fragmented SSH command collection uses linear byte accounting, preserves output/stdin, enforces UTF-8 byte limits and propagates failures')
} finally {
  delete globalThis.__sshCommandClient
  delete globalThis.__sshCommandBuffer
}
