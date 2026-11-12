import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadTypeScript } from './fixtures/load-ts.mjs'

const { TransferManager } = await loadTypeScript(new URL('../src/main/transfer.ts', import.meta.url))

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-transfer-'))
const source = path.join(root, '来源 目录')
const target = path.join(root, '目标')
fs.mkdirSync(source)
fs.mkdirSync(target)
fs.mkdirSync(path.join(source, '深层'))
const bytes = Buffer.alloc(4_000_000)
for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251
fs.writeFileSync(path.join(source, '深层', '二进制.bin'), bytes)

async function run(sources, destination, cancel = false) {
  return await new Promise((resolve) => {
    const manager = new TransferManager((state) => {
      if (state.state === 'conflicts') manager.decide(state.id, 'skip')
      if (cancel && state.bytes > 0 && state.state === 'running') manager.cancel(state.id)
      if (state.state === 'completed' || state.state === 'cancelled') resolve(state)
    })
    manager.start(sources, destination)
  })
}

try {
  const batchSource = path.join(root, 'batch-source'), batchTarget = path.join(root, 'batch-target')
  fs.mkdirSync(path.join(batchSource, 'folder', 'nested'), { recursive: true })
  fs.mkdirSync(path.join(batchTarget, 'folder', 'nested'), { recursive: true })
  for (const name of ['first.txt', 'second.txt', 'folder/nested/a.txt', 'folder/nested/b.txt']) {
    fs.writeFileSync(path.join(batchSource, name), `new ${name}`)
    fs.writeFileSync(path.join(batchTarget, name), `old ${name}`)
  }
  fs.writeFileSync(path.join(batchSource, 'fresh.txt'), 'fresh')
  let questions = 0
  const batch = await new Promise((resolve) => {
    const manager = new TransferManager((state) => {
      if (state.state === 'conflicts') {
        questions++
        assert.equal(state.items.length, 1)
        assert.equal(fs.existsSync(path.join(batchTarget, 'fresh.txt')), false)
        const item = state.items[0]
        if (item.destination === path.join(batchTarget, 'first.txt')) manager.decide(state.id, 'skip')
        else if (item.destination === path.join(batchTarget, 'second.txt')) manager.decide(state.id, 'keep')
        else if (item.mergeable) manager.decide(state.id, 'merge')
        else manager.decide(state.id, 'overwrite', true)
      }
      if (state.state === 'completed') resolve(state)
    }, async (_project, _destination, operation) => operation())
    manager.start(['fresh.txt', 'first.txt', 'second.txt', 'folder'].map((name) => path.join(batchSource, name)), batchTarget)
  })
  assert.equal(questions, 5, JSON.stringify(batch))
  assert.equal(fs.readFileSync(path.join(batchTarget, 'first.txt'), 'utf8'), 'old first.txt')
  assert.equal(fs.readFileSync(path.join(batchTarget, 'second.txt'), 'utf8'), 'old second.txt')
  assert.equal(fs.readFileSync(path.join(batchTarget, 'second (1).txt'), 'utf8'), 'new second.txt')
  for (const name of ['a.txt', 'b.txt']) assert.equal(fs.readFileSync(path.join(batchTarget, 'folder', 'nested', name), 'utf8'), `new folder/nested/${name}`)
  let mergeApproved = false, directoryMoved = false
  const raceTarget = path.join(root, 'batch-directory-race')
  fs.mkdirSync(path.join(raceTarget, 'folder'), { recursive: true })
  const mergeRace = await new Promise((resolve) => {
    const manager = new TransferManager((state) => {
      if (state.state === 'conflicts') { mergeApproved = true; manager.decide(state.id, 'merge', true) }
      if (state.state === 'running' && mergeApproved && !directoryMoved) { directoryMoved = true; fs.renameSync(path.join(raceTarget, 'folder'), path.join(raceTarget, 'parked-folder')) }
      if (state.state === 'completed') resolve(state)
    })
    manager.start([path.join(batchSource, 'folder')], raceTarget)
  })
  assert.ok(mergeRace.items.some((item) => item.status === 'failed'), JSON.stringify(mergeRace))
  assert.equal(fs.existsSync(path.join(raceTarget, 'folder')), false)
  assert.ok(fs.statSync(path.join(raceTarget, 'parked-folder')).isDirectory())
  console.log('PASS per-item choices, compatible batch overwrite, complete preflight and changed-directory merge protection')
  const overwriteRoot = path.join(root, 'overwrite')
  fs.mkdirSync(overwriteRoot)
  const overwriteSource = path.join(source, 'overwrite.bin'), overwriteTarget = path.join(overwriteRoot, 'overwrite.bin')
  fs.writeFileSync(overwriteSource, bytes)
  for (const race of [false, true]) {
    fs.writeFileSync(overwriteTarget, 'original')
    const outcome = await new Promise((resolve) => {
      const replacing = new TransferManager((state) => {
        if (state.state === 'conflicts') { assert.equal(state.items[0].replaceable, true); replacing.decide(state.id, 'overwrite') }
        if (state.state === 'completed') resolve(state)
      }, async (_project, destination, operation) => { if (race) fs.writeFileSync(destination, 'external change'); await operation() })
      replacing.start([overwriteSource], overwriteRoot)
    })
    assert.equal(outcome.items[0].status, race ? 'failed' : 'done', JSON.stringify(outcome))
    if (race) assert.equal(fs.readFileSync(overwriteTarget, 'utf8'), 'external change')
    else assert.deepEqual(fs.readFileSync(overwriteTarget), bytes)
    assert.deepEqual(fs.readFileSync(overwriteSource), bytes)
    assert.equal(fs.readdirSync(overwriteRoot).some((name) => name.startsWith('.awb-transfer-')), false)
  }
  console.log('PASS explicit overwrite publishes complete binary files and rejects targets changed after preflight')
  const closingTarget = path.join(root, 'closing-target')
  fs.mkdirSync(closingTarget)
  let closingState
  let shutdown
  const closing = new TransferManager((state) => { closingState = state; if (state.bytes > 0 && state.state === 'running' && !shutdown) shutdown = closing.shutdown() })
  closing.start([path.join(source, '深层', '二进制.bin')], closingTarget)
  const closeDeadline = Date.now() + 10000
  while (!shutdown && Date.now() < closeDeadline) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.ok(shutdown)
  await shutdown
  assert.equal(closingState.state, 'cancelled')
  assert.deepEqual(fs.readdirSync(closingTarget), [])
  let waitingState
  const waitingManager = new TransferManager((state) => { waitingState = state })
  fs.writeFileSync(path.join(closingTarget, '二进制.bin'), 'preserve')
  waitingManager.start([path.join(source, '深层', '二进制.bin')], closingTarget)
  while (waitingState?.state !== 'conflicts' && Date.now() < closeDeadline) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(waitingState?.state, 'conflicts')
  await waitingManager.shutdown()
  assert.equal(waitingState.state, 'cancelled')
  assert.equal(fs.readFileSync(path.join(closingTarget, '二进制.bin'), 'utf8'), 'preserve')
  console.log('PASS shutdown waits for active copy cleanup and cancels pending conflict decisions')
  const copied = await run([source], target)
  assert.equal(copied.state, 'completed')
  assert.deepEqual(fs.readFileSync(path.join(target, '来源 目录', '深层', '二进制.bin')), bytes)
  assert.ok(copied.items.some((item) => item.status === 'done' && item.source.endsWith('二进制.bin')))
  const conflict = await run([source], target)
  assert.equal(conflict.items[0].status, 'conflict')
  assert.deepEqual(fs.readFileSync(path.join(target, '来源 目录', '深层', '二进制.bin')), bytes)
  const inside = await run([source], path.join(source, '深层'))
  assert.equal(inside.items[0].status, 'failed')
  const cancelTarget = path.join(root, '取消目标')
  fs.mkdirSync(cancelTarget)
  const cancelled = await run([path.join(source, '深层', '二进制.bin')], cancelTarget, true)
  assert.equal(cancelled.state, 'cancelled')
  assert.deepEqual(fs.readdirSync(cancelTarget), [])
  const missing = path.join(root, '稍后出现.bin')
  const retryTarget = path.join(root, '重试目标')
  fs.mkdirSync(retryTarget)
  let settle
  const manager = new TransferManager((state) => { if (state.state === 'conflicts') manager.decide(state.id, 'skip'); if (state.state === 'completed' || state.state === 'cancelled') settle(state) })
  let finished = new Promise((resolve) => { settle = resolve })
  const firstId = manager.start([missing], retryTarget)
  const failed = await finished
  assert.equal(failed.items[0].status, 'failed')
  fs.writeFileSync(missing, bytes)
  finished = new Promise((resolve) => { settle = resolve })
  manager.retry(firstId)
  const retried = await finished
  assert.equal(retried.items[0].status, 'done')
  assert.deepEqual(fs.readFileSync(path.join(retryTarget, '稍后出现.bin')), bytes)
  manager.dismiss(firstId)
  assert.throws(() => manager.retry(firstId))
  finished = new Promise((resolve) => { settle = resolve })
  const directoryConflictId = manager.start([source], target)
  assert.equal((await finished).items[0].status, 'conflict')
  finished = new Promise((resolve) => { settle = resolve })
  manager.keepBoth(directoryConflictId)
  const keptDirectory = await finished
  assert.ok(keptDirectory.items.some((item) => item.destination.endsWith('来源 目录 (1)') && item.status === 'done'))
  assert.deepEqual(fs.readFileSync(path.join(target, '来源 目录 (1)', '深层', '二进制.bin')), bytes)
  const fileTarget = path.join(root, '文件冲突')
  fs.mkdirSync(fileTarget)
  fs.writeFileSync(path.join(fileTarget, '二进制.bin'), 'preserve')
  fs.writeFileSync(path.join(fileTarget, '二进制 (1).bin'), 'also preserve')
  finished = new Promise((resolve) => { settle = resolve })
  const fileConflictId = manager.start([path.join(source, '深层', '二进制.bin')], fileTarget)
  assert.equal((await finished).items[0].status, 'conflict')
  finished = new Promise((resolve) => { settle = resolve })
  manager.keepBoth(fileConflictId)
  assert.equal((await finished).items[0].status, 'done')
  assert.equal(fs.readFileSync(path.join(fileTarget, '二进制.bin'), 'utf8'), 'preserve')
  assert.equal(fs.readFileSync(path.join(fileTarget, '二进制 (1).bin'), 'utf8'), 'also preserve')
  assert.deepEqual(fs.readFileSync(path.join(fileTarget, '二进制 (2).bin')), bytes)
  const other = path.join(root, '预检新文件.txt')
  fs.writeFileSync(other, 'new')
  let pendingResolve
  const pending = new Promise((resolve) => { pendingResolve = resolve })
  const preflightManager = new TransferManager((state) => { if (state.state === 'conflicts') pendingResolve(state) })
  preflightManager.start([other, path.join(source, '深层', '二进制.bin')], fileTarget)
  const waiting = await pending
  assert.equal(fs.existsSync(path.join(fileTarget, '预检新文件.txt')), false, 'No file may be copied before conflict selection')
  assert.equal(waiting.items[0].destination, path.join(fileTarget, '二进制.bin'))
  preflightManager.cancel(waiting.id)
  const mergeTarget = path.join(root, '合并目标')
  fs.mkdirSync(path.join(mergeTarget, '来源 目录', '深层'), { recursive: true })
  fs.writeFileSync(path.join(mergeTarget, '来源 目录', '深层', '二进制.bin'), 'keep original')
  fs.writeFileSync(path.join(source, '深层', '新文件.txt'), 'new file')
  let choices = 0
  const mergeFinished = new Promise((resolve) => {
    const merging = new TransferManager((state) => {
      if (state.state === 'conflicts') {
        choices++
        assert.equal(fs.existsSync(path.join(mergeTarget, '来源 目录', '深层', '新文件.txt')), false)
        if (choices === 1) { assert.equal(state.items[0].mergeable, true); merging.decide(state.id, 'merge', true) }
        else { assert.ok(state.items.some((item) => item.destination.endsWith('二进制.bin'))); merging.decide(state.id, 'skip') }
      }
      if (state.state === 'completed') resolve(state)
    })
    merging.start([source], mergeTarget)
  })
  const merged = await mergeFinished
  assert.equal(choices, 2)
  assert.ok(merged.items.some((item) => item.status === 'conflict' && item.destination.endsWith('二进制.bin')))
  assert.equal(fs.readFileSync(path.join(mergeTarget, '来源 目录', '深层', '二进制.bin'), 'utf8'), 'keep original')
  assert.equal(fs.readFileSync(path.join(mergeTarget, '来源 目录', '深层', '新文件.txt'), 'utf8'), 'new file')
  console.log('PASS local transfer: recursive binary copy, directory conflict, self-copy rejection, cancellation and temporary file cleanup')
} finally { fs.rmSync(root, { recursive: true, force: true }) }
