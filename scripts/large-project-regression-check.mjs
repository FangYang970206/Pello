import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { buildSync } from 'esbuild'
import { _electron as electron } from 'playwright'
import { assertPerformanceBuild, budgets, finishPerformance, median, performanceReport, savePaintSample } from './fixtures/performance-metrics.mjs'

assertPerformanceBuild()
const metrics = performanceReport('regression')
const outputPath = process.argv.find((arg) => arg.startsWith('--output='))?.slice(9)
const baselinePath = process.argv.find((arg) => arg.startsWith('--compare='))?.slice(10)
async function measured(name, operation, runs = 1) {
  const samples = []; let result
  for (let run = 0; run < runs; run++) { const start = performance.now(); result = await operation(); samples.push(performance.now() - start) }
  metrics.samples[name] = samples; metrics.metrics[name] = median(samples)
  return result
}
process.on('exit', (code) => {
  if (!code || metrics.failures?.length) return
  metrics.failures = ['Behavior check failed before performance gate; see the command output']
  const destination = path.resolve(outputPath || 'output/performance/regression-metrics.json')
  fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, JSON.stringify(metrics, null, 2))
})

const require = createRequire(import.meta.url)
const load = (file) => {
  const code = buildSync({ entryPoints: [file], bundle: true, platform: 'node', packages: 'external', format: 'cjs', write: false }).outputFiles[0].text
  const module = { exports: {} }
  new Function('require', 'module', 'exports', code)(require, module, module.exports)
  return module.exports
}
const { gitStatus, targetFor, readFile, writeFile, localFileNameCandidates } = load('src/main/git.ts')
const { ContentSearch } = load('src/main/content-search.ts')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pello-scan-performance-'))
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true })
git('init', '-q'); git('config', 'core.autocrlf', 'false')
const ignored = new Set(['.git', 'node_modules']), target = targetFor(root, null)
for (let i = 0; i < 1800; i++) fs.writeFileSync(path.join(root, `file-${i}.txt`), `value ${i}\nsecond line`.padEnd(8192, 'x'))
const generated = fs.readdirSync(root).filter((name) => /^file-\d+\.txt$/.test(name)).map((name) => fs.statSync(path.join(root, name)).size)
metrics.fixture = `generated-${generated.length}-files-${new Set(generated).size === 1 ? generated[0] / 1024 : 'mixed'}kb-v1`
metrics.workload = { files: generated.length, bytes: generated.reduce((sum, value) => sum + value, 0) }
fs.mkdirSync(path.join(root, '.hidden')); fs.writeFileSync(path.join(root, '.hidden/skip.txt'), 'not searchable')
fs.mkdirSync(path.join(root, 'node_modules')); fs.writeFileSync(path.join(root, 'node_modules/skip.txt'), 'not searchable')
fs.writeFileSync(path.join(root, '.gitignore'), 'ignored-by-git.txt\n')
fs.writeFileSync(path.join(root, 'ignored-by-git.txt'), 'Pello must still find this\n')
let gap = 0, last = performance.now()
const timer = setInterval(() => { const now = performance.now(); gap = Math.max(gap, now - last); last = now }, 5)
try {
  let rootResolutions = 0
  const realpath = fs.promises.realpath
  fs.promises.realpath = async (file, ...args) => { if (file === root) rootResolutions++; return realpath.call(fs.promises, file, ...args) }
  let panel
  try { panel = await measured('gitColdMs', () => gitStatus(target)) }
  finally { fs.promises.realpath = realpath }
  assert.equal(rootResolutions, 1, 'Resolve the repository root once per status; revalidate every file boundary independently')
  assert.equal(panel.files.find((file) => file.path === 'file-0.txt').add, 2)
  fs.writeFileSync(path.join(root, 'file-0.txt'), 'updated\n')
  const updated = await measured('gitWarmMs', () => gitStatus(target), 3)
  assert.equal(updated.files.find((file) => file.path === 'file-0.txt').add, 1, 'Line-count cache must notice external edits')
  const controller = new AbortController()
  assert.deepEqual(await localFileNameCandidates(target, 'skip.txt', ignored, controller.signal), [])
  assert.deepEqual(await localFileNameCandidates(target, 'ignored-by-git', ignored, controller.signal), ['ignored-by-git.txt'])
  assert.equal((await measured('filenameMs', () => localFileNameCandidates(target, 'file-', ignored, controller.signal), 3)).length, 1800, 'No filename truncation')
  metrics.checks.filenameComplete = true
  await measured('contentMs', async () => {
    const scan = new ContentSearch(target, 'absent-937afe', false, ignored)
    let batch, expired = false
    const deadline = setTimeout(() => { expired = true; scan.cancel() }, budgets.regression.limits.contentMs * 2)
    try {
      do { batch = await scan.next(); assert.equal(batch.items.length, 0) } while (!batch.done)
      assert.equal(batch.errors, 0)
      assert.equal(expired, false, 'Cancelled or timed-out work is not a completed scan')
      metrics.checks.contentComplete = true
    } finally { clearTimeout(deadline); scan.cancel() }
  }, 3)
  const stopped = new ContentSearch(target, 'value', false, ignored)
  const pending = stopped.next(); stopped.cancel()
  assert.equal((await pending).done, true)
  const file = 'save.txt', original = '\ufeff' + '中文 content\r\n'.repeat(50000)
  fs.writeFileSync(path.join(root, file), original)
  const before = await readFile(target, file)
  let latest = before
  const saved = await measured('saveMs', async () => { latest = await writeFile(target, file, original + 'more\r\n', latest.version); return latest }, 3)
  assert.equal(saved.text, original + 'more\r\n')
  assert.equal(saved.version, (await readFile(target, file)).version)
  await assert.rejects(writeFile(target, file, 'stale', before.version), /其他程序修改/)
  // Pause at the real staging seam and mutate the destination before publish.
  const actualWrite = fs.promises.writeFile
  fs.promises.writeFile = async (...args) => {
    await actualWrite(...args)
    if (String(args[0]).includes('.awb-')) await actualWrite(path.join(root, file), 'external edit\n')
  }
  try { await assert.rejects(writeFile(target, file, 'must not publish', saved.version), /其他程序修改/) }
  finally { fs.promises.writeFile = actualWrite }
  assert.equal(fs.readFileSync(path.join(root, file), 'utf8'), 'external edit\n')
  assert.equal(fs.readdirSync(root).filter((name) => name.includes('.awb-')).length, 0)
  metrics.checks.saveConflictSafe = true
  console.log('PASS 1800-file scanning responsiveness, exact line-count invalidation, filename completeness/ignores, search cancellation, large BOM/CRLF saves and concurrent-write rejection')
} finally { metrics.metrics.mainThreadGapMs = Math.max(gap, performance.now() - last); clearInterval(timer) }

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pello-filename-index-'))
fs.mkdirSync(path.join(root, 'indexed'))
fs.writeFileSync(path.join(root, 'indexed/secret.txt'), 'internal fixture')
fs.writeFileSync(path.join(root, 'deleted-index.txt'), 'removed after indexing')
git('add', 'indexed', 'deleted-index.txt')
fs.unlinkSync(path.join(root, 'deleted-index.txt'))
fs.renameSync(path.join(root, 'indexed'), path.join(root, 'real-indexed'))
fs.symlinkSync(path.join(root, 'real-indexed'), path.join(root, 'indexed'), process.platform === 'win32' ? 'junction' : 'dir')
fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify({ settings: { layout: 'balanced', restore: false, autoCheckUpdates: false }, treeIgnores: { p: [...ignored] },
  projects: [{ id: 'p', name: 'Filename index regression', host: 'local', path: root, agent: 'shell' }] }))
const env = { ...process.env, AWB_USER_DATA: data }; delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: ['.', '--force-device-scale-factor=1'], env })
try {
  await app.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 1 })
  const page = await app.firstWindow(); await page.locator('[data-a=proj]').waitFor()
  await page.evaluate(() => window.awb.winResize(1440, 900)); await page.waitForFunction(() => innerWidth === 1440)
  await page.locator('[data-a=rmode][data-id=files]').click()
  const field = page.getByLabel('搜索文件', { exact: true })
  await page.evaluate(() => {
    window.__filenamePaint = { start: 0, ms: null }
    const start = (event) => { if (event.target.getAttribute('aria-label') === '搜索文件') { window.__filenamePaint.start = performance.now(); document.removeEventListener('input', start, true) } }
    document.addEventListener('input', start, true)
    const observer = new MutationObserver(() => {
      if (!document.querySelector('[data-virtual-count="1800"] button')) return
      observer.disconnect(); requestAnimationFrame(() => requestAnimationFrame(() => { window.__filenamePaint.ms = performance.now() - window.__filenamePaint.start }))
    })
    observer.observe(document.querySelector('.right'), { childList: true, subtree: true, attributes: true })
  })
  await field.fill('file-')
  const virtual = page.locator('[data-virtual-count="1800"]')
  await virtual.waitFor()
  await page.waitForFunction(() => window.__filenamePaint.ms !== null)
  metrics.metrics.filenamePaintMs = await page.evaluate(() => window.__filenamePaint.ms)
  metrics.metrics.renderedFilenameRows = await virtual.locator('[data-a=search-file]').count()
  assert.ok(await virtual.locator('[data-a=search-file]').count() < 100, 'Only visible results should mount')
  await virtual.locator('button').first().focus(); await page.keyboard.press('End')
  await page.waitForFunction(() => document.activeElement?.closest('[data-virtual-index]')?.dataset.virtualIndex === '1799')
  const geometry = await page.evaluate(() => {
    const row = document.activeElement.getBoundingClientRect(), list = document.activeElement.closest('.rlist').getBoundingClientRect()
    return { row: row.toJSON(), list: list.toJSON(), visible: row.top >= list.top - 1 && row.bottom <= list.bottom + 1 }
  })
  assert.ok(geometry.visible, `The last result must be visible, not merely focused offscreen: ${JSON.stringify(geometry)}`)
  metrics.checks.lastResultVisible = true
  await page.keyboard.press('Shift+Tab')
  await page.waitForFunction(() => document.activeElement?.closest('[data-virtual-index]')?.dataset.virtualIndex === '1798')
  await page.keyboard.press('Home')
  await page.waitForFunction(() => document.activeElement?.closest('[data-virtual-index]')?.dataset.virtualIndex === '0')
  const first = virtual.locator('[data-virtual-index="0"] button'), selectedPath = await first.getAttribute('data-id')
  await first.click()
  assert.equal(await page.getByLabel('文件内容', { exact: true }).inputValue(), fs.readFileSync(path.join(root, selectedPath), 'utf8'))
  const shots = path.resolve('output/playwright/large-project'); fs.mkdirSync(shots, { recursive: true })
  for (const theme of ['light', 'dark']) for (const [width, height] of [[1024, 680], [1440, 900]]) for (const font of [12, 16]) {
    await page.evaluate(async ({ theme, font }) => { const { db } = await window.awb.getState(); return window.awb.saveSettings({ ...db.settings, theme, uiFontSize: font }) }, { theme, font })
    await page.reload(); await page.locator('[data-a=rmode][data-id=files]').click(); await field.waitFor()
    await page.evaluate(([width, height]) => window.awb.winResize(width, height), [width, height])
    await page.waitForFunction((width) => innerWidth === width, width)
    const handle = page.getByRole('separator', { name: '调整文件面板宽度' })
    const current = await page.locator('.right').evaluate((node) => node.getBoundingClientRect().width)
    const targetWidth = font === 16 ? 220 : 420, steps = Math.round((targetWidth - current) / 20)
    for (let step = 0; step < Math.abs(steps); step++) await handle.press(steps > 0 ? 'ArrowLeft' : 'ArrowRight')
    await field.fill('file-'); await virtual.waitFor()
    assert.ok(await virtual.locator('button').count() < 100)
    await virtual.locator('button').first().focus(); await page.keyboard.press('End')
    await page.waitForFunction(() => {
      const node = document.activeElement, row = node?.getBoundingClientRect(), list = node?.closest('.rlist')?.getBoundingClientRect()
      return node?.closest('[data-virtual-index]')?.dataset.virtualIndex === '1799' && row.top >= list.top - 1 && row.bottom <= list.bottom + 1
    })
    await page.screenshot({ path: path.join(shots, `${theme}-${width}-${font}.png`) })
  }
  await field.fill('')
  console.log('PASS 1800-result UI stays bounded; End/Home/Shift+Tab and clicks work in light/dark, two window sizes, 220/420px containers and 12/16px UI fonts')
  fs.writeFileSync(path.join(root, 'ui-large.txt'), '\ufeff' + '中文 content\r\n'.repeat(50000))
  await field.fill('ui-large.txt')
  await page.locator('[data-a=search-file][data-id="ui-large.txt"]').click()
  const largeEditor = page.getByLabel('文件内容', { exact: true }); await largeEditor.waitFor()
  const paints = []
  for (let run = 0; run < 3; run++) {
    await largeEditor.press('Control+End'); await largeEditor.press('p')
    paints.push(await savePaintSample(page, largeEditor))
  }
  metrics.samples.savePaintMs = paints; metrics.metrics.savePaintMs = median(paints)
  await field.fill('')
  const query = (term) => page.evaluate(async (term) => {
    const id = crypto.randomUUID(), results = []
    await window.awb.treeSearchStart('p', id, term)
    let batch
    do { batch = await window.awb.treeSearchNext(id); results.push(...batch.items.map((item) => item.path)) } while (!batch.done)
    return results
  }, term)
  assert.equal((await query('file-')).length, 1800)
  assert.deepEqual(await query('skip.txt'), [])
  assert.deepEqual(await query('ignored-by-git'), ['ignored-by-git.txt'])
  assert.deepEqual(await query('deleted-index'), [], 'Stale Git index entries must not appear')
  assert.deepEqual(await query('secret'), ['real-indexed/secret.txt'], 'Indexed children behind a junction must not be followed')
  await page.evaluate(() => window.awb.treeIgnoreSet('p', ['.git']))
  assert.deepEqual(await query('skip.txt'), ['node_modules/skip.txt'], 'Editable Pello rules override Git ignore behavior; dot directories stay excluded')
  const embedded = path.join(root, 'embedded')
  fs.mkdirSync(embedded); execFileSync('git', ['-C', embedded, 'init', '-q'], { windowsHide: true })
  fs.writeFileSync(path.join(embedded, 'embedded-child.txt'), 'nested repository')
  assert.deepEqual(await query('embedded-child'), ['embedded/embedded-child.txt'], 'Embedded repositories must not disappear behind the parent index')
  execFileSync('git', ['-C', embedded, 'add', '.'], { windowsHide: true })
  execFileSync('git', ['-C', embedded, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'], { windowsHide: true })
  git('add', 'embedded')
  assert.deepEqual(await query('embedded-child'), ['embedded/embedded-child.txt'], 'Indexed gitlinks must fall back to full traversal')
  console.log('PASS real filename IPC: all results, deleted index entries, indexed junctions and edited ignore rules')
  await page.locator('[data-a=rmode][data-id=changes]').click()
  await page.locator('[data-virtual-count]').waitFor()
  assert.ok(await page.locator('[data-a=diff]').count() < 100, 'Large Git panels mount visible changes only')
  metrics.metrics.renderedGitRows = await page.locator('[data-a=diff]').count()
  const { changeTree } = load('src/renderer/git-change-tree.ts')
  const fullGit = await page.evaluate(() => window.awb.gitStatus('p'))
  const expectedTree = changeTree(fullGit.files, '', new Set())
  const treeSamples = [], treeGaps = [], treeMounted = []
  for (let run = 0; run < 3; run++) {
    await page.evaluate(() => {
      window.__treePaint = { ms: null, gap: 0 }
      const button = document.querySelector('[data-a=git-view]')
      button.addEventListener('keydown', function start(event) {
        if (event.key !== 'Enter') return
        button.removeEventListener('keydown', start)
        const began = performance.now(); let previous = began
        const timer = setInterval(() => { const now = performance.now(); window.__treePaint.gap = Math.max(window.__treePaint.gap, now - previous); previous = now }, 16)
        const observer = new MutationObserver(() => {
          if (!document.querySelector('.git-change-rows.tree [data-virtual-count]')) return
          observer.disconnect()
          requestAnimationFrame(() => requestAnimationFrame(() => { clearInterval(timer); window.__treePaint.ms = performance.now() - began }))
        })
        observer.observe(document.querySelector('.rlist'), { childList: true, attributes: true, subtree: true })
      })
    })
    await page.locator('[data-a=git-view]').press('Enter')
    await page.waitForFunction(() => window.__treePaint.ms !== null)
    const timing = await page.evaluate(() => window.__treePaint)
    treeSamples.push(timing.ms); treeGaps.push(timing.gap)
    const treeRows = page.locator('.git-change-rows.tree [data-virtual-count]')
    assert.equal(Number(await treeRows.getAttribute('data-virtual-count')), expectedTree.length, 'Tree exposes every change and directory')
    treeMounted.push(await treeRows.locator('.git-change-item').count())
    await treeRows.locator('button').first().focus(); await page.keyboard.press('End')
    await page.waitForFunction((last) => document.activeElement?.getAttribute('data-id') === last, expectedTree.at(-1).path)
    await page.keyboard.press('Home')
    await page.waitForFunction((first) => document.activeElement?.getAttribute('data-id') === first, expectedTree[0].path)
    await page.locator('[data-a=git-view]').click()
  }
  const treeMetrics = { samples: treeSamples, medianKeyToPaintMs: median(treeSamples), rendererMaxGapMs: Math.max(...treeGaps), mountedRows: treeMounted, completeRows: expectedTree.length, environment: metrics.environment }
  fs.mkdirSync(path.resolve('output/performance'), { recursive: true })
  fs.writeFileSync(path.resolve('output/performance/git-tree-metrics.json'), JSON.stringify(treeMetrics, null, 2))
  assert.ok(treeSamples.every((ms) => ms <= budgets.regression.limits.filenamePaintMs), 'Tree keyboard-to-paint respects the existing list paint budget')
  assert.ok(treeMetrics.rendererMaxGapMs <= budgets.regression.limits.mainThreadGapMs)
  assert.ok(treeMounted.every((count) => count <= budgets.regression.limits.renderedGitRows))
  console.log(`PASS complete virtual Git tree: three keyboard-to-paint samples, median ${treeMetrics.medianKeyToPaintMs.toFixed(1)}ms, at most ${Math.max(...treeMounted)} mounted rows`)
  await app.evaluate(() => { globalThis.__testPath = process.env.PATH; process.env.PATH = '' })
  await page.getByRole('alert').filter({ hasText: '无法读取 Git 状态' }).waitFor()
  await app.evaluate(() => { process.env.PATH = globalThis.__testPath })
  await page.getByRole('button', { name: '重新扫描仓库', exact: true }).click()
  await page.locator('[data-a=diff]').first().waitFor()
  assert.equal(await page.getByText('正在扫描…', { exact: true }).count(), 0)
  metrics.checks.gitRetryRecovered = true
  console.log('PASS Git failures leave the loading state, show an error and recover through rescan')
} finally {
  await app.evaluate(() => { if (globalThis.__testPath) process.env.PATH = globalThis.__testPath }).catch(() => {})
  await app.close()
}
finishPerformance(metrics, { baselinePath, outputPath })
