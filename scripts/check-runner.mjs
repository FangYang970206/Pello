import { spawnSync } from 'node:child_process'
import { appendFileSync, closeSync, mkdirSync, mkdtempSync, openSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export function runChecks(cases, { stopOnFailure = false, logsRoot = 'output/verification', summaryPath = process.env.GITHUB_STEP_SUMMARY } = {}) {
  mkdirSync(logsRoot, { recursive: true })
  const folder = mkdtempSync(path.join(logsRoot, 'run-'))
  const results = []

  for (const { name, args, rerun } of cases) {
    const log = path.join(folder, `${name}.log`)
    const fd = openSync(log, 'w')
    const start = performance.now()
    let child
    try {
      child = spawnSync(process.execPath, args, { stdio: ['ignore', fd, fd] })
    } finally {
      closeSync(fd)
    }
    const status = child.error?.message ?? child.signal ?? child.status
    const passed = child.status === 0
    results.push({ name, passed, status, seconds: (performance.now() - start) / 1000, log, rerun })
    if (!passed && stopOnFailure) break
  }

  const failed = results.filter(({ passed }) => !passed)
  const pending = cases.length - results.length
  const seconds = results.reduce((sum, result) => sum + result.seconds, 0)
  const headline = `${results.length - failed.length} passed, ${failed.length} failed, ${pending} pending (${seconds.toFixed(1)}s)`
  const failures = failed.map(({ name, status, log, rerun }) => `- ${name} (${status}) · \`${rerun}\` · \`${log}\``)
  const report = [headline, ...failures, `Logs and timings: ${folder}`].join('\n')
  writeFileSync(path.join(folder, 'results.json'), JSON.stringify({ pending, results }, null, 2) + '\n')
  console.log(report)
  if (summaryPath) appendFileSync(summaryPath, report + '\n\n')
  return { results, failed, pending }
}
