import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { buildSync } from 'esbuild'
import { finishPerformance, performanceReport } from './fixtures/performance-metrics.mjs'

const require = createRequire(import.meta.url), baseline = process.argv.includes('--baseline')
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pello-hotspots-'))
const report = performanceReport('hotspots')
const load = (file, mocks = {}) => {
  const code = buildSync({ entryPoints: [file], bundle: true, platform: 'node', packages: 'external', format: 'cjs', write: false }).outputFiles[0].text
  const module = { exports: {} }
  new Function('require', 'module', 'exports', code)((name) => Object.hasOwn(mocks, name) ? mocks[name] : require(name), module, module.exports)
  return module.exports
}
async function measure(name, operation) {
  const samples = []
  for (let run = 0; run < 3; run++) { global.gc?.(); const start = performance.now(); await operation(run); samples.push(performance.now() - start) }
  report.samples[name] = samples; report.metrics[name] = [...samples].sort((a, b) => a - b)[1]
}
function reference(before, after) {
  const table = Array.from({ length: before.length + 1 }, () => new Uint32Array(after.length + 1))
  for (let i = before.length - 1; i >= 0; i--) for (let j = after.length - 1; j >= 0; j--) table[i][j] = before[i] === after[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
  const rows = []; let i = 0, j = 0
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) { rows.push(['', before[i], i, j]); i++; j++ }
    else if (i < before.length && (j === after.length || table[i + 1][j] >= table[i][j + 1])) { rows.push(['del', before[i], i, null]); i++ }
    else { rows.push(['add', after[j], null, j]); j++ }
  }
  return rows
}
const { lcs } = load('src/shared/diff.ts')
const words = [[]]
for (let length = 1; length <= 4; length++) for (const prefix of words.filter((item) => item.length === length - 1)) for (const value of ['a', 'b', '中']) words.push([...prefix, value])
for (const before of words) for (const after of words) assert.deepEqual(lcs(before, after), reference(before, after), 'Keep every index and deletion-first tie, including repeated lines')
let seed = 1
const random = () => { seed = Math.imul(seed, 1664525) + 1013904223 | 0; return seed >>> 0 }
for (let run = 0; run < 300; run++) {
  const lines = () => Array.from({ length: random() % 60 }, () => String(random() % (run % 2 ? 5 : 200)))
  const a = lines(), b = lines(); assert.deepEqual(lcs(a, b), reference(a, b))
}
report.checks.exactDiff = true
const before = Array.from({ length: 4000 }, (_, index) => `line ${index}`), after = [...before]; after[1] = 'changed'; after[3998] = 'changed again'
await measure('diffMs', () => { const rows = lcs(before, after); assert.equal(rows.filter((row) => row[0] === '').length, 3998); assert.equal(rows.at(-1)[3], 3999) })
await measure('unrelatedDiffMs', () => assert.equal(lcs(before, before.map((line) => `other ${line}`)).length, 8000))

const { ResourceManager } = load('src/main/resources.ts')
const manager = new ResourceManager(path.join(data, 'settings'), path.join(data, 'home')), targets = manager.targets()
const target = targets.find((item) => item.id === 'codex')
fs.mkdirSync(path.dirname(target.mcpPath), { recursive: true })
const config = Array.from({ length: 600 }, (_, index) => `[[skills.config]]\nname = "skill-${index}"\nenabled = ${index % 2 === 0}\n`).join('')
fs.writeFileSync(target.mcpPath, config)
for (let index = 0; index < 600; index++) { const folder = path.join(target.skillPath, `skill-${index}`); fs.mkdirSync(folder, { recursive: true }); fs.writeFileSync(path.join(folder, 'SKILL.md'), `---\nname: skill-${index}\ndescription: Synthetic performance fixture\n---\nBody\n`) }
let configReads = 0
const readFile = fs.readFileSync
fs.readFileSync = function (file, ...args) { if (String(file) === target.mcpPath) configReads++; return readFile.call(this, file, ...args) }
try {
  const gaps = []
  await measure('skillsMs', async () => {
    let previous = performance.now(), gap = 0
    const timer = setInterval(() => { const now = performance.now(); gap = Math.max(gap, now - previous); previous = now }, 5)
    try {
      const list = await (manager.listAsync ? manager.listAsync(targets, 'skills', 'codex', 1, '', true) : manager.list(targets, 'skills', 'codex', 1, '', true))
      await new Promise((resolve) => setImmediate(resolve))
      assert.equal(list.total, 600); assert.deepEqual(list.errors, []); assert.ok(list.items.every((item) => item.enabled === (Number(item.name.slice(6)) % 2 === 0)))
      gaps.push(Math.max(gap, performance.now() - previous))
    } finally { clearInterval(timer) }
  })
  report.samples.skillsGapMs = gaps; report.metrics.skillsGapMs = Math.max(...gaps)
} finally { fs.readFileSync = readFile }
report.metrics.configReadsPerList = configReads / 3
fs.writeFileSync(target.mcpPath, config.replace('enabled = true', 'enabled = false'))
assert.equal(manager.list(targets, 'skills', 'codex', 1, 'skill-0', true).items.find((item) => item.name === 'skill-0').enabled, false, 'A fresh list must observe external configuration changes')
report.checks.externalConfigChange = true
if (!baseline) {
  const controller = new AbortController()
  const listing = manager.listAsync(targets, 'skills', 'codex', 1, '', true, controller.signal)
  controller.abort()
  await assert.rejects(listing, /已取消/)
  const cancelled = new AbortController(); cancelled.abort()
  await assert.rejects(manager.listAsync(targets, 'skills', 'codex', 1, '', true, cancelled.signal), /已取消/)
  assert.equal((await manager.listAsync(targets, 'skills', 'codex', 1, 'skill-599', true)).items[0].name, 'skill-599')
}

const history = load('src/main/terminal-history.ts', { electron: { app: { getPath: () => data } } })
const chunk = '中文😀\x1b[2J\r\n'.repeat(30)
let appendCalls = 0
const append = fs.appendFileSync
fs.appendFileSync = function (...args) { appendCalls++; return append.apply(this, args) }
try {
  await measure('journalMs', async (run) => {
    const id = `journal-${run}`
    for (let index = 0; index < 8000; index++) history.recordTerminalOutput(id, chunk)
    await history.flushTerminalRecording?.(id)
    assert.equal(fs.readFileSync(history.terminalRecording(id), 'utf8'), chunk.repeat(8000), 'All UTF-8 output, ANSI clears and ordering must survive batching')
    await history.deleteTerminalHistory(id)
    assert.equal(fs.existsSync(history.terminalRecording(id)), false)
  })
} finally { fs.appendFileSync = append }
report.metrics.syncAppends = appendCalls / 3
report.checks.losslessJournal = true
if (!baseline) {
  // A failed append remains retryable, including packets accepted while that
  // write was in flight. Deletion must await pending output rather than let a
  // scheduled writer recreate the file after close.
  const open = fs.promises.open
  let attempted = 0
  fs.promises.open = async (...args) => {
    const handle = await open.apply(fs.promises, args)
    return { write: async (buffer, offset, length, position) => {
      if (++attempted === 1) return handle.write(buffer, offset, Math.min(6, length), position)
      if (attempted === 2) throw new Error('Synthetic append failure')
      return handle.write(buffer, offset, length, position)
    }, close: () => handle.close() }
  }
  try {
    history.recordTerminalOutput('retry', 'first中😀')
    await assert.rejects(history.flushTerminalRecording('retry'), /Synthetic append failure/)
    history.recordTerminalOutput('retry', 'second\x1b[2J')
    await history.flushTerminalRecording('retry')
    assert.equal(fs.readFileSync(history.terminalRecording('retry'), 'utf8'), 'first中😀second\x1b[2J')
    await history.deleteTerminalHistory('retry')
  } finally { fs.promises.open = open }
  report.checks.journalRetry = true
  history.recordTerminalOutput('delete-pending', chunk)
  await history.deleteTerminalHistory('delete-pending')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(fs.existsSync(history.terminalRecording('delete-pending')), false)
  history.recordTerminalOutput('flush-a', 'A'); history.recordTerminalOutput('flush-b', 'B')
  await history.flushTerminalRecording()
  assert.equal(fs.readFileSync(history.terminalRecording('flush-a'), 'utf8'), 'A')
  assert.equal(fs.readFileSync(history.terminalRecording('flush-b'), 'utf8'), 'B')
  report.checks.pendingDeletion = true
  let release, entered
  const gate = new Promise((resolve) => { release = resolve }), writing = new Promise((resolve) => { entered = resolve })
  fs.promises.open = async (...args) => {
    const handle = await open.apply(fs.promises, args)
    return { write: async (...parts) => { entered(); await gate; return handle.write(...parts) }, close: () => handle.close() }
  }
  try {
    history.recordTerminalOutput('in-flight', 'before')
    const flush = history.flushTerminalRecording('in-flight')
    await writing; history.recordTerminalOutput('in-flight', 'during中😀'); release(); await flush
    assert.equal(fs.readFileSync(history.terminalRecording('in-flight'), 'utf8'), 'beforeduring中😀')
    await history.deleteTerminalHistory('in-flight')
  } finally { release(); fs.promises.open = open }
  const large = Array.from({ length: 20000 }, (_, index) => `large ${index}`), changed = [...large]; changed[1] = 'changed'
  const rows = lcs(large, changed)
  assert.equal(rows.length, 20001); assert.deepEqual(rows.at(-1), ['', 'large 19999', 19999, 19999])
}
const output = path.resolve(`output/performance/hotspots-${baseline ? 'before' : 'after'}.json`)
fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
if (!baseline) finishPerformance(report, { outputPath: output })
console.log(`PASS exact diff, 600 native Skills and lossless 8000-chunk terminal journal; report: ${output}`)
