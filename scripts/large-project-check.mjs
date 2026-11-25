import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { _electron as electron } from 'playwright'
import { assertPerformanceBuild, budgets, finishPerformance, performanceReport, savePaintSample } from './fixtures/performance-metrics.mjs'

// Run after `npm run build`. Reuse the exact checkout for before/after runs.
const phase = process.argv.find((arg) => arg.startsWith('--phase='))?.split('=')[1] || 'after'
const enforce = process.argv.includes('--enforce-budget')
if (enforce) assertPerformanceBuild()
assert.ok(!enforce || (phase === 'after' && !process.argv.includes('--ui-only') && !process.argv.includes('--skip-content')), 'Performance gates require the complete after scenario')
const metrics = performanceReport('github')
const project = path.resolve(process.argv.find((arg) => arg.startsWith('--repo='))?.slice(7) || '.cache/performance/TypeScript')
const output = path.resolve('output/performance'); fs.mkdirSync(output, { recursive: true })
const git = (...args) => execFileSync('git', ['-C', project, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 20_000_000 })
const tracked = git('ls-files', '-z').split('\0').filter(Boolean)
assert.equal(git('diff', '--name-only').trim(), '', 'Benchmark source checkout must be unchanged')
const fixture = path.join(project, 'pello-performance-fixture')
fs.mkdirSync(fixture, { recursive: true })
const source = tracked.filter((name) => name.endsWith('.ts')).slice(0, 6000)
const digest = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
for (let i = 0; i < source.length; i++) {
  const dest = path.join(fixture, `copy-${i}.txt`)
  if (!fs.existsSync(dest)) fs.copyFileSync(path.join(project, source[i]), dest)
  assert.equal(digest(dest), digest(path.join(project, source[i])), `Benchmark copy differs from its source: ${dest}`)
}
const large = tracked.filter((name) => /\.(ts|txt|json)$/.test(name)).map((name) => ({ name, size: fs.statSync(path.join(project, name)).size }))
  .filter(({ size }) => size > 200_000 && size < 1_950_000).sort((a, b) => b.size - a.size)[0]
assert.ok(large, 'The GitHub checkout must contain a real large editable file')
const savePath = 'pello-performance-fixture/save-large.txt'
if (!fs.existsSync(path.join(project, savePath))) fs.copyFileSync(path.join(project, large.name), path.join(project, savePath))
assert.equal(digest(path.join(project, savePath)), digest(path.join(project, large.name)), 'Save fixture differs from its source; preserve the failed fixture and prepare a clean copy')
metrics.workload = { trackedFiles: tracked.length, copies: source.length + 1, saveBytes: fs.statSync(path.join(project, savePath)).size }
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pello-large-project-'))
fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify({ settings: { restore: false, confirmKill: false, autoCheckUpdates: false, layout: 'balanced' },
  projects: [{ id: 'large', name: 'TypeScript 68k files', host: 'local', path: project, agent: 'shell' }] }))
const env = { ...process.env, AWB_USER_DATA: data }; delete env.ELECTRON_RUN_AS_NODE
const report = { phase, repository: git('remote', 'get-url', 'origin').trim(), commit: git('rev-parse', 'HEAD').trim(), trackedFiles: tracked.length,
  untrackedCopies: source.length + 1, largeFileSource: large, measurements: {} }
const runRecord = path.join(output, 'runs', `${metrics.at.replace(/[:.]/g, '-')}-${process.pid}.json`)
if (enforce) {
  assert.equal(report.repository, budgets.github.repository)
  assert.equal(report.commit, budgets.github.commit)
  assert.equal(report.trackedFiles, budgets.github.trackedFiles)
  assert.equal(report.untrackedCopies, budgets.github.untrackedCopies)
}
const app = await electron.launch({ args: [process.argv.includes('--baseline') ? '.cache/performance/baseline-app' : '.', '--force-device-scale-factor=1'], env })
const measure = async (label, operation) => {
  await app.evaluate(() => {
    globalThis.__perf = { gap: 0, last: performance.now() }
    globalThis.__perf.timer = setInterval(() => { const now = performance.now(); globalThis.__perf.gap = Math.max(globalThis.__perf.gap, now - globalThis.__perf.last); globalThis.__perf.last = now }, 10)
  })
  const start = performance.now(), value = await operation()
  const mainThreadGapMs = await app.evaluate(() => { clearInterval(globalThis.__perf.timer); return Math.max(globalThis.__perf.gap, performance.now() - globalThis.__perf.last) })
  report.measurements[label] = { ms: Math.round(performance.now() - start), mainThreadGapMs: Math.round(mainThreadGapMs), ...value }
  console.log(label, JSON.stringify(report.measurements[label]))
  fs.writeFileSync(path.join(output, `${phase}.json`), JSON.stringify(report, null, 2))
}
try {
  await app.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 1 })
  console.log('Electron launched')
  const page = await app.firstWindow(); page.setDefaultTimeout(30_000)
  await page.evaluate(() => window.awb.winResize(1440, 900)); await page.waitForFunction(() => innerWidth === 1440)
  console.log('Window ready')
  await page.locator('[data-a=proj]').first().waitFor()
  console.log('Project ready')
  if (!process.argv.includes('--ui-only')) {
  await measure('gitStatus', async () => {
    console.log('Measuring Git status')
    const result = await page.evaluate(() => window.awb.gitStatus('large', true))
    assert.equal(result.files.length, source.length + 1)
    assert.ok(result.files.every((file) => file.add >= 0))
    return { changedFiles: result.files.length }
  })
  await measure('gitStatusWarm', async () => {
    const result = await page.evaluate(() => window.awb.gitStatus('large'))
    assert.equal(result.files.length, source.length + 1)
    return { changedFiles: result.files.length }
  })
  if (phase.startsWith('after')) {
    await page.locator(`[data-virtual-count="${source.length + 1}"]`).waitFor()
  } else await page.locator('[data-a=diff]').first().waitFor()
  report.renderedGitRows = await page.locator('[data-a=diff]').count()
  if (phase.startsWith('after')) {
    assert.ok(report.renderedGitRows > 0 && report.renderedGitRows < 100)
  }
  await page.screenshot({ path: path.join(output, `${phase}-git.png`) })
  await measure('filenameNoMatch', () => page.evaluate(async () => {
    const id = crypto.randomUUID(); await window.awb.treeSearchStart('large', id, 'PELLO_ABSENT_937afe')
    let batch, count = 0, batches = 0
    do { batch = await window.awb.treeSearchNext(id); count += batch.items.length; batches++ } while (!batch.done)
    return { matches: count, batches }
  }))
  if (!process.argv.includes('--skip-content')) await measure('contentNoMatch', () => page.evaluate(async () => {
    const id = crypto.randomUUID(); await window.awb.contentSearchStart('large', id, 'PELLO_ABSENT_937afe', false)
    let batch, count = 0, batches = 0
    const deadline = performance.now() + 120_000
    do { batch = await window.awb.contentSearchNext(id); count += batch.items.length; batches++ } while (!batch.done && performance.now() < deadline)
    if (!batch.done) await window.awb.contentSearchCancel(id)
    return { matches: count, errors: batch.errors, batches, timedOut: !batch.done }
  }))
  }
  await measure('saveLarge', async () => {
    const result = await page.evaluate(async (rel) => {
      const before = await window.awb.gitRead('large', rel)
      const start = performance.now(), after = await window.awb.gitWrite('large', rel, before.text, before.version)
      return { ipcMs: Math.round(performance.now() - start), bytes: before.text.length, identical: before.version === after.version }
    }, savePath)
    assert.ok(result.identical)
    return result
  })
  await measure('saveDuringScan', () => page.evaluate(async (rel) => {
    let file = await window.awb.gitRead('large', rel), done = false
    const scan = window.awb.gitStatus('large', true).finally(() => { done = true })
    const samples = []
    do {
      const start = performance.now()
      file = await window.awb.gitWrite('large', rel, file.text, file.version)
      samples.push(performance.now() - start)
      await new Promise((resolve) => setTimeout(resolve, 50))
    } while (!done && samples.length < 100)
    await scan
    return { saves: samples.length, maxSaveMs: Math.round(Math.max(...samples)), meanSaveMs: Math.round(samples.reduce((sum, ms) => sum + ms, 0) / samples.length) }
  }, savePath))
  if (!await page.locator('[data-a=rmode][data-id=files]').count()) await page.getByRole('button', { name: '显示文件面板', exact: true }).click()
  console.log('Opening large file in UI')
  await page.locator('[data-a=rmode][data-id=files]').click()
  await page.getByLabel('搜索文件', { exact: true }).fill('save-large.txt')
  await page.locator(`[data-a=search-file][data-id="${savePath}"]`).click()
  const editor = page.getByLabel('文件内容', { exact: true }); await editor.waitFor()
  console.log('Large editor ready')
  await editor.focus()
  await editor.press('Control+End')
  await editor.press('End')
  await editor.press('Enter')
  await editor.press('p')
  console.log('Large draft edited')
  await measure('saveLargeUI', async () => {
    return { keyToPaintMs: await savePaintSample(page, editor) }
  })
  const restore = await page.evaluate(async ({ rel, source }) => {
    const value = await window.awb.gitRead('large', rel)
    const original = await window.awb.gitRead('large', source)
    return window.awb.gitWrite('large', rel, original.text, value.version)
  }, { rel: savePath, source: large.name })
  assert.equal(restore.version, (await page.evaluate((rel) => window.awb.gitRead('large', rel), large.name)).version)
  assert.equal(git('diff', '--name-only').trim(), '', 'Original GitHub files must remain unchanged')
  if (phase.startsWith('after')) {
    await page.getByLabel('搜索文件', { exact: true }).fill('copy-')
    const rows = page.locator(`[data-virtual-count="${source.length}"]`)
    await rows.waitFor()
    report.renderedFilenameRows = await rows.locator('button').count()
    assert.ok(report.renderedFilenameRows < 100)
    await rows.locator('button').first().focus(); await page.keyboard.press('End')
    await page.waitForFunction((last) => document.activeElement?.closest('[data-virtual-index]')?.dataset.virtualIndex === String(last), source.length - 1)
    metrics.checks.lastResultVisible = await page.evaluate(() => {
      const row = document.activeElement.getBoundingClientRect(), list = document.activeElement.closest('.rlist').getBoundingClientRect()
      return row.top >= list.top - 1 && row.bottom <= list.bottom + 1
    })
  }
  await page.screenshot({ path: path.join(output, `${phase}-files.png`) })
  fs.writeFileSync(path.join(output, `${phase}.json`), JSON.stringify(report, null, 2))
  if (phase.startsWith('after') && !process.argv.includes('--ui-only')) {
    assert.ok(report.measurements.gitStatus.mainThreadGapMs < 250, 'Git scanning must keep the main process responsive')
    if (report.measurements.contentNoMatch) {
      assert.equal(report.measurements.contentNoMatch.matches, 0)
      assert.equal(report.measurements.contentNoMatch.errors, 0)
      assert.equal(report.measurements.contentNoMatch.timedOut, false)
    }
    assert.equal(report.measurements.filenameNoMatch.matches, 0)
  }
  if (enforce) {
    const m = report.measurements
    metrics.metrics = { gitColdMs: m.gitStatus.ms, gitWarmMs: m.gitStatusWarm.ms, filenameMs: m.filenameNoMatch.ms, contentMs: m.contentNoMatch.ms,
      saveDuringScanMs: m.saveDuringScan.maxSaveMs, savePaintMs: m.saveLargeUI.keyToPaintMs,
      mainThreadGapMs: Math.max(...Object.values(m).map((entry) => entry.mainThreadGapMs)),
      renderedFilenameRows: report.renderedFilenameRows, renderedGitRows: report.renderedGitRows }
    Object.assign(metrics.checks, { contentComplete: !m.contentNoMatch.timedOut && m.contentNoMatch.errors === 0, filenameComplete: m.filenameNoMatch.matches === 0 && report.untrackedCopies === budgets.github.untrackedCopies,
      sourceUnchanged: git('diff', 'HEAD', '--name-only').trim() === '' })
    finishPerformance(metrics, { baselinePath: process.argv.find((arg) => arg.startsWith('--compare='))?.slice(10), outputPath: process.argv.find((arg) => arg.startsWith('--output='))?.slice(9) })
  }
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error)
  throw error
} finally {
  try {
    fs.mkdirSync(path.dirname(runRecord), { recursive: true })
    fs.writeFileSync(runRecord, JSON.stringify({ report, metrics }, null, 2))
    console.log(`Benchmark run retained: ${runRecord}`)
  } finally { await app.close() }
}
