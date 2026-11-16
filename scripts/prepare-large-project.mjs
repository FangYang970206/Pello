import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { budgets } from './fixtures/performance-metrics.mjs'

const target = path.resolve('.cache/performance/TypeScript'), fixture = budgets.github
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', windowsHide: true, maxBuffer: 20_000_000 })
if (!fs.existsSync(target)) {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  git('clone', '--depth=1', '--no-checkout', '--filter=blob:none', fixture.repository, target)
  git('-C', target, 'fetch', '--depth=1', 'origin', fixture.commit)
  git('-C', target, 'checkout', '--detach', fixture.commit)
}
assert.equal(git('-C', target, 'remote', 'get-url', 'origin').trim(), fixture.repository, 'Existing benchmark checkout has a different origin; it will not be overwritten')
assert.equal(git('-C', target, 'rev-parse', 'HEAD').trim(), fixture.commit, 'Existing benchmark checkout has a different commit; it will not be reset')
assert.equal(git('-C', target, 'diff', 'HEAD', '--name-only').trim(), '', 'Benchmark source checkout contains edits; preserve them and use a separate checkout')
assert.equal(git('-C', target, 'ls-files', '-z').split('\0').filter(Boolean).length, fixture.trackedFiles)
console.log(`PASS pinned TypeScript fixture (${fixture.trackedFiles} tracked files): ${fixture.commit}`)
