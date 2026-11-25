import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { loadTypeScript } from './fixtures/load-ts.mjs'

const transports = []
globalThis.__remoteReadOpen = async (_host, _args, signal) => {
  const stdin = new PassThrough(), stdout = new PassThrough(), requests = []
  stdin.on('data', (bytes) => requests.push(JSON.parse(bytes.toString())))
  let end
  const completion = new Promise((resolve) => { end = resolve })
  const stream = { stdin, stdout, completion, close() { stdout.destroy(); end() }, requests }
  signal.addEventListener('abort', () => stream.close(), { once: true })
  transports.push(stream)
  return stream
}
const { readRemoteBytes, closeRemoteReaders, readTargetKey } = await loadTypeScript(new URL('../src/main/remote-read.ts', import.meta.url), (source) => source
  .replace("import { t } from '../shared/i18n'", 'const t = (key: string) => key')
  .replace("import { openRemoteStream, remoteCommand, type RemoteStream } from './ssh'", 'type RemoteStream = any; const openRemoteStream = globalThis.__remoteReadOpen; const remoteCommand = () => "routed"')
  .replace("import { remoteReadProgram, remoteReadRelay } from './remote-read-program'", 'const remoteReadProgram = () => []; const remoteReadRelay = () => []'))
const target = { cwd: '/project', platform: 'linux', host: { id: 'a', addr: 'fixture', user: 'a', auth: 'key' } }
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const respond = (transport, body, status = 'OK') => {
  const bytes = Buffer.concat([Buffer.from(`PELLO1 ${status} ${body.length}\n`), body])
  for (let index = 0; index < bytes.length; index += 3) transport.stdout.write(bytes.subarray(index, index + 3))
}
try {
  const first = readRemoteBytes(target, 'one'), duplicate = readRemoteBytes(target, 'one'), second = readRemoteBytes(target, 'two')
  assert.equal(first, duplicate, 'Concurrent same-file reads must share one request')
  await tick()
  const transport = transports[0]
  assert.equal(transports.length, 1); assert.equal(transport.requests.length, 1)
  const bytes = Buffer.from([0, 255, 13, 10, 228, 184, 173])
  respond(transport, bytes); assert.deepEqual(await first, bytes)
  assert.equal(transport.requests.length, 2)
  respond(transport, Buffer.from('next')); assert.equal((await second).toString(), 'next')
  const missing = readRemoteBytes(target, 'missing'); await tick()
  respond(transport, Buffer.alloc(0), 'MISSING'); await assert.rejects(missing, { code: 'ENOENT' })
  const newer = readRemoteBytes(target, 'one'); await tick()
  respond(transport, Buffer.from('external edit')); assert.equal((await newer).toString(), 'external edit', 'Completed text reads must not leave stale content caches')
  const other = readRemoteBytes({ ...target, host: { ...target.host, user: 'b' } }, 'one'); await tick()
  assert.equal(transports.length, 2); respond(transports[1], Buffer.from('user b')); assert.equal((await other).toString(), 'user b')
  const interrupted = readRemoteBytes(target, 'cancelled'), queued = readRemoteBytes(target, 'queued')
  const rejected = Promise.all([assert.rejects(interrupted), assert.rejects(queued)])
  closeRemoteReaders('a'); await rejected
  const retry = readRemoteBytes(target, 'retry'); await tick()
  assert.equal(transports.length, 3); respond(transports[2], Buffer.from('retry')); assert.equal((await retry).toString(), 'retry')
  const overflow = readRemoteBytes(target, 'oversize', 2); await tick()
  transports[2].stdout.write('PELLO1 OK 3\nabc'); await assert.rejects(overflow, /远程输出过大/)
  const route = [{ socket: '/tmp/pello-ssh.abcdefgh/master', destination: 'b' }]
  const routed = readRemoteBytes({ ...target, host: { ...target.host, terminalRoute: route } }, 'one')
  await tick(); const routeRejected = assert.rejects(routed)
  closeRemoteReaders('a', route); await routeRejected
  globalThis.__remoteReadKey = readTargetKey
  const { stageAsset, takeAsset, clearAssetSnapshots } = await loadTypeScript(new URL('../src/main/asset-snapshots.ts', import.meta.url), (source) => source.replace("import { readTargetKey, type ReadTarget } from './remote-read'", 'type ReadTarget = object; const readTargetKey = globalThis.__remoteReadKey'))
  const token = stageAsset(target, 'image.svg', bytes)
  assert.equal(takeAsset({ ...target, cwd: '/other' }, 'image.svg', token), undefined)
  assert.equal(takeAsset(target, 'other.svg', token), undefined)
  assert.deepEqual(takeAsset(target, 'image.svg', token, false), bytes)
  assert.deepEqual(takeAsset(target, 'image.svg', token), bytes)
  assert.equal(takeAsset(target, 'image.svg', token), undefined)
  const invalidated = stageAsset(target, 'folder/image.svg', bytes)
  clearAssetSnapshots(target, 'folder'); assert.equal(takeAsset(target, 'folder/image.svg', invalidated), undefined)
  const oldest = stageAsset(target, 'image.svg', bytes)
  for (let index = 0; index < 32; index++) stageAsset(target, 'image.svg', bytes)
  assert.equal(takeAsset(target, 'image.svg', oldest), undefined, 'Snapshot handoff has bounded entries')
  const originalNow = Date.now, expired = stageAsset(target, 'image.svg', bytes)
  try { Date.now = () => originalNow() + 31000; assert.equal(takeAsset(target, 'image.svg', expired), undefined) }
  finally { Date.now = originalNow; clearAssetSnapshots() }
  const { gitDiff } = await loadTypeScript(new URL('../src/main/git.ts', import.meta.url), (source) => {
    const start = source.indexOf('export async function gitDiff('), end = source.indexOf('export async function gitDiscard(', start)
    return `const MAX_DIFF = 250000
const cleanRelative = (path: string) => path
const owningRepository = async (target: object, relative: string) => ({ target, relative })
const showHead = async () => 'base'
const readRemote = async () => ({ text: '', missing: false, binary: false, tooBig: true })
const readLocal = readRemote
${source.slice(start, end)}`
  })
  assert.equal((await gitDiff(target, 'too-large.txt', false)).tooBig, true, 'A metadata-only oversized remote file must never appear as an empty editable diff')
  console.log('PASS binary framing across packet splits, connection reuse, coalescing, identity isolation, external edits, missing files, limits, cancellation, retry and SSH route invalidation')
  console.log('PASS media handoff is bound to target/path, single-use, invalidated on replacement, bounded and expiring')
} finally { closeRemoteReaders(); delete globalThis.__remoteReadOpen; delete globalThis.__remoteReadKey }
