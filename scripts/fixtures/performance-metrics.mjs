import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

export const budgets = JSON.parse(fs.readFileSync(new URL('../performance-budgets.json', import.meta.url), 'utf8'))
export function assertPerformanceBuild(root = path.resolve('.')) {
  const newest = (folder) => Math.max(0, ...fs.readdirSync(path.join(root, folder), { withFileTypes: true }).map((entry) => {
    const relative = `${folder}/${entry.name}`
    return entry.isDirectory() ? newest(relative) : fs.statSync(path.join(root, relative)).mtimeMs
  }))
  for (const [output, inputs] of [
    ['out/main/index.js', ['src/main', 'src/shared']],
    ['out/preload/index.js', ['src/preload', 'src/shared']],
    ['out/renderer/index.html', ['src/renderer', 'src/shared']]
  ]) {
    const file = path.join(root, output)
    if (!fs.existsSync(file) || inputs.some((folder) => newest(folder) > fs.statSync(file).mtimeMs)) throw new Error(`Performance checks require a current build: run npm run build (${output})`)
  }
}
export const median = (samples) => {
  if (!samples.length || samples.some((value) => !Number.isFinite(value) || value < 0)) throw new Error('Performance samples must be finite non-negative durations')
  const sorted = [...samples].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

export function performanceReport(suite) {
  const budget = budgets[suite]
  if (!budget) throw new Error(`Unknown performance suite: ${suite}`)
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', windowsHide: true }).trim()
  const electron = JSON.parse(fs.readFileSync(new URL('../../node_modules/electron/package.json', import.meta.url), 'utf8')).version
  return {
    schemaVersion: budgets.schemaVersion, suite, fixture: budget.fixture, at: new Date().toISOString(),
    revision: git('rev-parse', 'HEAD'), dirty: !!git('status', '--porcelain', '--untracked-files=no'),
    environment: `${process.platform}/${os.release()}/${process.arch}/${os.cpus()[0]?.model}/${process.version}/electron-${electron}/dpi-1`,
    metrics: {}, samples: {}, checks: {}
  }
}

/** Missing work and incompatible baselines are failures, even if all times look fast. */
export function performanceFailures(report, budget, baseline) {
  const failures = []
  if (report.schemaVersion !== 1 || report.fixture !== budget.fixture) failures.push('Performance schema or fixture differs from its budget')
  for (const [name, limit] of Object.entries(budget.limits)) {
    const value = report.metrics[name]
    if (!Number.isFinite(value) || value < 0) failures.push(`${name}: missing or invalid measurement`)
    else if (value > limit) failures.push(`${name}: ${value.toFixed(1)} > ${limit} budget`)
  }
  for (const name of budget.requiredChecks) if (report.checks[name] !== true) failures.push(`${name}: work is incomplete or correctness failed`)
  for (const [name, count] of Object.entries(budget.requiredSamples || {})) {
    const samples = report.samples?.[name]
    if (!Array.isArray(samples) || samples.length < count || samples.some((value) => !Number.isFinite(value) || value < 0)) failures.push(`${name}: insufficient or invalid samples`)
    else if (Math.abs(median(samples) - report.metrics[name]) > 0.001) failures.push(`${name}: metric differs from sample median`)
  }
  if (baseline) {
    if (baseline.fixture !== report.fixture || baseline.environment !== report.environment || baseline.suite !== report.suite || baseline.schemaVersion !== report.schemaVersion) failures.push('Baseline must use the same fixture, environment, suite and schema')
    else {
      for (const name of budget.requiredChecks) if (baseline.checks?.[name] !== true) failures.push(`${name}: baseline correctness is incomplete`)
      for (const [name, value] of Object.entries(report.metrics)) {
        if (!name.endsWith('Ms')) continue
        const previous = baseline.metrics[name]
        if (!Number.isFinite(previous) || previous < 0) { failures.push(`${name}: baseline measurement is missing or invalid`); continue }
        // A relative tolerance plus an absolute noise allowance protects fast cases.
        if (value > Math.max(previous * 1.5, previous + 50)) failures.push(`${name}: regressed from ${previous.toFixed(1)} to ${value.toFixed(1)}`)
      }
    }
  }
  return failures
}

/** Measure inside Chromium; Playwright polling time is deliberately excluded. */
export async function savePaintSample(page, editor) {
  await page.evaluate(() => {
    window.__pelloSaveMetricCleanup?.()
    window.__pelloSaveMetric = { start: 0, ms: null }
    const start = (event) => {
      if (event.ctrlKey && event.key.toLowerCase() === 's') { window.__pelloSaveMetric.start = performance.now(); document.removeEventListener('keydown', start, true) }
    }
    const observer = new MutationObserver(() => {
      if (!window.__pelloSaveMetric.start || !document.querySelector('#toasts')?.textContent.includes('文件已保存')) return
      observer.disconnect()
      requestAnimationFrame(() => requestAnimationFrame(() => { window.__pelloSaveMetric.ms = performance.now() - window.__pelloSaveMetric.start }))
    })
    window.__pelloSaveMetricCleanup = () => { observer.disconnect(); document.removeEventListener('keydown', start, true) }
    document.addEventListener('keydown', start, true)
    observer.observe(document.querySelector('#toasts'), { subtree: true, childList: true })
  })
  try {
    await editor.press('Control+s')
    await page.waitForFunction(() => window.__pelloSaveMetric.ms !== null, null, { timeout: 10000 })
    return await page.evaluate(() => window.__pelloSaveMetric.ms)
  } finally { await page.evaluate(() => window.__pelloSaveMetricCleanup?.()) }
}

export function finishPerformance(report, { baselinePath, outputPath } = {}) {
  const baseline = baselinePath ? JSON.parse(fs.readFileSync(baselinePath, 'utf8')) : undefined
  const failures = performanceFailures(report, budgets[report.suite], baseline)
  report.failures = failures
  const destination = path.resolve(outputPath || `output/performance/${report.suite}-metrics.json`)
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.writeFileSync(destination, JSON.stringify(report, null, 2))
  if (failures.length) throw new Error(`Performance gate failed; report: ${destination}\n${failures.join('\n')}`)
  console.log(`PASS performance budgets (${Object.keys(report.metrics).length} metrics): ${destination}`)
}
