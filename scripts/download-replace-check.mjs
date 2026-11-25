import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { loadTypeScript } from './fixtures/load-ts.mjs'

// Exercise the production download/publish path, substituting only the SSH transport.
let duringDownload = () => {}, fail = false
const bytes = Buffer.from('new binary\0中文\xff')
globalThis.__downloadOpen = async () => {
  const stdin = new PassThrough(), stdout = new PassThrough()
  let finish
  const completion = new Promise((resolve, reject) => { finish = () => fail ? reject(new Error('connection interrupted')) : resolve() })
  stdin.once('finish', () => { duringDownload(); stdout.end(bytes); finish() })
  return { stdin, stdout, completion, close() { stdout.destroy() } }
}
const { downloadRemoteFile } = await loadTypeScript(new URL('../src/main/remote-file.ts', import.meta.url), (source) => {
  const imports = source.slice(0, source.indexOf("import { createInterface"))
    .replace('Readable, Transform', 'Transform')
  return imports + `
const treePath = (_target: unknown, relative: string) => ({ relative })
const READ_LINUX = () => ''
const psQuote = (value: string) => value
const openRemoteStream = globalThis.__downloadOpen
type Target = any
` + source.slice(source.indexOf('export async function downloadRemoteFile'))
})
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pello-download-replace-'))
const destination = path.join(root, 'same.bin')
const target = { cwd: '/project', platform: 'linux', host: { id: 'remote' } }
const run = (signal = new AbortController().signal) => downloadRemoteFile(target, 'same.bin', destination, signal, () => {}, true)
try {
  fs.writeFileSync(destination, 'old content')
  await run()
  assert.deepEqual(fs.readFileSync(destination), bytes, 'Confirmed replacement must publish downloaded bytes')
  await assert.rejects(downloadRemoteFile(target, 'same.bin', destination, new AbortController().signal, () => {}), { code: 'EEXIST' })
  assert.deepEqual(fs.readFileSync(destination), bytes, 'Callers without overwrite confirmation must retain exclusive creation')
  console.log('PASS confirmed download replaces an existing local file')
  fs.unlinkSync(destination); await run(); assert.deepEqual(fs.readFileSync(destination), bytes)
  fs.writeFileSync(destination, 'keep on failure'); fail = true
  await assert.rejects(run(), /connection interrupted/); assert.equal(fs.readFileSync(destination, 'utf8'), 'keep on failure'); fail = false
  const controller = new AbortController(); duringDownload = () => controller.abort()
  await assert.rejects(run(controller.signal)); assert.equal(fs.readFileSync(destination, 'utf8'), 'keep on failure')
  duringDownload = () => fs.writeFileSync(destination, 'external edit')
  await assert.rejects(run(), /目标文件已更改/); assert.equal(fs.readFileSync(destination, 'utf8'), 'external edit')
  fs.unlinkSync(destination)
  duringDownload = () => fs.writeFileSync(destination, 'concurrent create')
  await assert.rejects(run()); assert.equal(fs.readFileSync(destination, 'utf8'), 'concurrent create')
  duringDownload = () => {}
  fs.unlinkSync(destination); fs.mkdirSync(destination)
  await assert.rejects(run(), /目标不是普通文件/)
  fs.rmdirSync(destination); fs.writeFileSync(destination, 'kept')
  assert.deepEqual(fs.readdirSync(root), ['same.bin'])
  console.log('PASS failed/cancelled downloads, concurrent edits and concurrent creation preserve local content and clean staging')
} finally { fs.rmSync(root, { recursive: true, force: true }); delete globalThis.__downloadOpen }
