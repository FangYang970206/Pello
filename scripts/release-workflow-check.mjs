import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parse } from 'yaml'
import { checkSuites } from './check-cases.mjs'
import { runChecks } from './check-runner.mjs'

const list = (...args) => execFileSync(process.execPath, ['scripts/check-suite.mjs', ...args, '--list'], { encoding: 'utf8' }).trim().split(/\r?\n/)
const workflow = parse(readFileSync('.github/workflows/windows-release.yml', 'utf8'))
const workflowSuites = workflow.jobs.validate.strategy.matrix.include.map(({ suite }) => suite)
assert.equal(workflowSuites.filter((suite) => suite === 'installation').length, 1)
const workflowCases = workflowSuites.filter((suite) => suite !== 'installation').flatMap((suite) => list(...suite.split(' ')))
assert.equal(new Set(workflowCases).size, workflowCases.length, 'Each case belongs to exactly one runner')
assert.deepEqual(workflowCases.sort(), [...checkSuites.all].sort(), 'CI runs the full behavior suite')
assert.ok(list('performanceIsolated').includes('document-performance-check'))
assert.deepEqual(list('installation'), checkSuites.installation)
assert.equal(workflow.on.workflow_dispatch.inputs.draft.default, false)
const validationSteps = workflow.jobs.validate.steps
const installElectron = validationSteps.findIndex((step) => step.name === 'Install Electron for behavioral checks')
const installDependencies = validationSteps.findIndex((step) => step.run === 'npm ci')
const runChecksStep = validationSteps.findIndex((step) => step.name === 'Run checks')
assert.ok(installDependencies >= 0 && installElectron > installDependencies && installElectron < runChecksStep,
  'The Electron runtime must be available on every behavior runner')
assert.match(validationSteps[installElectron].run, /Expand-Archive.*node_modules\/electron\/dist/)

const logsRoot = mkdtempSync(path.join(os.tmpdir(), 'pello-check-runner-'))
try {
  const summaryPath = path.join(logsRoot, 'summary.md')
  const cases = [
    { name: 'broken', args: ['-e', 'console.error("fixture error"); process.exitCode = 3'], rerun: 're-run broken' },
    { name: 'working', args: ['-e', 'console.log("fixture success")'], rerun: 're-run working' },
  ]
  const { results, failed, pending } = runChecks(cases, { logsRoot, summaryPath })
  assert.deepEqual(results.map(({ status }) => status), [3, 0])
  assert.deepEqual(failed.map(({ name }) => name), ['broken'])
  assert.equal(pending, 0)
  assert.match(readFileSync(failed[0].log, 'utf8'), /fixture error/)
  assert.match(readFileSync(results[1].log, 'utf8'), /fixture success/)
  const report = readFileSync(summaryPath, 'utf8')
  assert.match(report, /1 passed, 1 failed, 0 pending/)
  assert.match(report, /re-run broken/)
  assert.doesNotMatch(report, /re-run working|fixture success/)
  const saved = JSON.parse(readFileSync(path.join(path.dirname(failed[0].log), 'results.json'), 'utf8'))
  assert.deepEqual(saved, { pending, results })
  const stopped = runChecks(cases, { stopOnFailure: true, logsRoot, summaryPath })
  assert.equal(stopped.pending, 1)
  assert.deepEqual(stopped.results.map(({ name }) => name), ['broken'])
} finally {
  rmSync(logsRoot, { recursive: true, force: true })
}
console.log('PASS release check coverage, failure-only summaries, full logs, and fail-fast prerequisites')
