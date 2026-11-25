import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assertPerformanceBuild, budgets, median, performanceFailures } from './fixtures/performance-metrics.mjs'

const budget = budgets.regression
const good = { schemaVersion: 1, suite: 'regression', fixture: budget.fixture, environment: 'same-machine',
  metrics: Object.fromEntries(Object.entries(budget.limits).map(([name, value]) => [name, value / 2])),
  samples: Object.fromEntries(Object.keys(budget.requiredSamples).map((name) => [name, [budget.limits[name] / 2, budget.limits[name] / 2, budget.limits[name] / 2]])),
  checks: Object.fromEntries(budget.requiredChecks.map((name) => [name, true])) }
assert.equal(median([300, 10, 20]), 20)
assert.equal(median([1, 3]), 2)
assert.throws(() => median([])); assert.throws(() => median([NaN]))
assert.deepEqual(performanceFailures(good, budget), [])
for (const name of ['hotspots', 'hotspotUi']) {
  const item = budgets[name]
  const complete = { schemaVersion: 1, suite: name, fixture: item.fixture, environment: 'same-machine',
    metrics: Object.fromEntries(Object.entries(item.limits).map(([key, limit]) => [key, limit / 2])),
    samples: Object.fromEntries(Object.keys(item.requiredSamples).map((key) => [key, Array(3).fill(item.limits[key] / 2)])),
    checks: Object.fromEntries(item.requiredChecks.map((key) => [key, true])) }
  assert.deepEqual(performanceFailures(complete, item), [])
  for (const key of Object.keys(item.limits)) {
    const missing = structuredClone(complete); delete missing.metrics[key]
    assert.ok(performanceFailures(missing, item).some((failure) => failure.startsWith(`${key}:`)))
    const slow = structuredClone(complete); slow.metrics[key] = item.limits[key] + 1
    assert.ok(performanceFailures(slow, item).some((failure) => failure.startsWith(`${key}:`)))
  }
  for (const key of item.requiredChecks) {
    const incomplete = structuredClone(complete); incomplete.checks[key] = false
    assert.ok(performanceFailures(incomplete, item).some((failure) => failure.startsWith(`${key}:`)))
  }
}
for (const name of Object.keys(budget.limits)) {
  const slow = structuredClone(good); slow.metrics[name] = budget.limits[name] + 1
  assert.ok(performanceFailures(slow, budget).some((failure) => failure.startsWith(`${name}:`)), `Must reject over-budget ${name}`)
  delete slow.metrics[name]
  assert.ok(performanceFailures(slow, budget).some((failure) => failure.includes('missing or invalid')), `Must reject missing ${name}`)
}
for (const name of budget.requiredChecks) {
  const incomplete = structuredClone(good); incomplete.checks[name] = false
  assert.ok(performanceFailures(incomplete, budget).some((failure) => failure.startsWith(`${name}:`)), `Fast incomplete work must fail: ${name}`)
}
const previous = structuredClone(good); previous.metrics.contentMs = 100
const regressed = structuredClone(good); regressed.metrics.contentMs = 200
previous.samples.contentMs = [100, 100, 100]; regressed.samples.contentMs = [200, 200, 200]
assert.ok(performanceFailures(regressed, budget, previous).some((failure) => failure.includes('regressed from')))
previous.environment = 'another-machine'
assert.ok(performanceFailures(good, budget, previous).some((failure) => failure.includes('same fixture')))
const wrongFixture = { ...good, fixture: 'smaller-fixture' }
assert.ok(performanceFailures(wrongFixture, budget).some((failure) => failure.includes('fixture differs')))
const underSampled = structuredClone(good); underSampled.samples.contentMs = [1]
assert.ok(performanceFailures(underSampled, budget).some((failure) => failure.includes('insufficient')))
const wrongMedian = structuredClone(good); wrongMedian.metrics.contentMs = 1
assert.ok(performanceFailures(wrongMedian, budget).some((failure) => failure.includes('sample median')))
const unfinishedBaseline = structuredClone(good); unfinishedBaseline.checks.contentComplete = false
assert.ok(performanceFailures(good, budget, unfinishedBaseline).some((failure) => failure.includes('baseline correctness')))
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pello-performance-build-'))
for (const folder of ['src/main', 'src/shared', 'src/preload', 'src/renderer']) fs.mkdirSync(path.join(fixture, folder), { recursive: true })
fs.writeFileSync(path.join(fixture, 'src/main/entry.ts'), 'source')
assert.throws(() => assertPerformanceBuild(fixture), /current build/)
for (const file of ['out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html']) {
  const target = path.join(fixture, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, 'built')
}
assert.doesNotThrow(() => assertPerformanceBuild(fixture))
const changed = path.join(fixture, 'src/main/entry.ts'), later = new Date(Date.now() + 2000)
fs.utimesSync(changed, later, later)
assert.throws(() => assertPerformanceBuild(fixture), /current build/)
console.log('PASS performance gate rejects overruns, missing metrics, incomplete work, relative regression and incompatible baselines')
