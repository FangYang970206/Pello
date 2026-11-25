import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { buildSync } from 'esbuild'

const require = createRequire(import.meta.url)
const code = buildSync({ entryPoints: ['src/main/content-search.ts'], bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false }).outputFiles[0].text
const module = { exports: {} }; new Function('require', 'module', 'exports', code)(require, module, module.exports)
const { ContentSearch } = module.exports
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pello-search-worker-'))
fs.writeFileSync(path.join(root, '000-early.txt'), 'early MODE_TOKEN\n')
for (let index = 0; index < 4100; index++) fs.writeFileSync(path.join(root, `filler-${String(index).padStart(5, '0')}.txt`), 'filler\n')
const late = '\ufeff中文 😀 MODE_TOKEN tail\r\n模式123\r\n'
fs.writeFileSync(path.join(root, 'z-late.txt'), late)
fs.writeFileSync(path.join(root, 'z-invalid.txt'), Buffer.from([0xff, 0xfe, 65]))
fs.writeFileSync(path.join(root, 'z-binary.bin'), Buffer.from('binary\0MODE_TOKEN'))
fs.writeFileSync(path.join(root, 'z-large.txt'), 'MODE_TOKEN' + 'x'.repeat(2_000_001))
fs.writeFileSync(path.join(root, 'z-timeout.txt'), 'a'.repeat(30000) + '!')
for (let index = 0; index < 3; index++) fs.writeFileSync(path.join(root, `z-limit-${index}.txt`), 'LATE_LIMIT\n'.repeat(900))
assert.ok(fs.readdirSync(root).indexOf('z-late.txt') > 4096, 'Fixture must reach the direct-read path')
const target = { cwd: root, platform: process.platform === 'win32' ? 'windows' : 'linux', host: null }
async function run(query, regex = false) {
  const search = new ContentSearch(target, query, false, new Set(), regex)
  const items = []; let batch
  try { do { batch = await search.next(); items.push(...batch.items) } while (!batch.done); return { ...batch, items } }
  finally { search.cancel() }
}
const literal = await run('MODE_TOKEN')
assert.deepEqual(literal.items.map((item) => item.path), ['000-early.txt', 'z-late.txt'])
assert.equal(literal.items[1].matches[0].column, 8)
assert.equal(literal.skipped, 3); assert.equal(literal.errors, 0)
const regex = await run('^模式[0-9]+$', true)
assert.equal(regex.items.length, 1); assert.equal(regex.items[0].path, 'z-late.txt'); assert.equal(regex.items[0].matches[0].line, 2)
const limited = await run('LATE_LIMIT')
assert.equal(limited.items.flatMap((item) => item.matches).length, 2000)
assert.equal(limited.limited, true); assert.equal(new Set(limited.items.map((item) => item.path)).size, limited.items.length)
await assert.rejects(run('(a+)+$', true), /执行超时/)
const cancelled = new ContentSearch(target, 'MODE_TOKEN', false, new Set())
const pending = cancelled.next(); cancelled.cancel()
assert.equal((await pending).done, true)
assert.equal(fs.readFileSync(path.join(root, 'z-late.txt'), 'utf8'), late)
console.log('PASS async/direct worker transition: complete early/late matches, UTF-16 columns, BOM/CRLF, binary/encoding/size skips, shared limit, regex timeout and cancellation')
