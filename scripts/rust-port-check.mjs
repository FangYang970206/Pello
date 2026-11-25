import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

const manifest = 'src-tauri/Cargo.toml'
const test = execFileSync('cargo', ['test', '-p', 'pello-core', '--manifest-path', manifest, '--', '--test-threads=8'], { encoding: 'utf8' })
// Every test program reports its own result line; one passing program must not
// stand in for another that failed.
const results = test.split(/\r?\n/).filter((line) => line.startsWith('test result: '))
assert.ok(results.length > 0, 'cargo test printed no result line')
assert.deepEqual(results.filter((line) => !/^test result: ok\./.test(line)), [], 'a test program failed')
console.log(results.join('\n'))
const cases = test.split(/\r?\n/).filter((line) => line.startsWith('test ') && !line.endsWith(' ... ok'))
assert.deepEqual(cases, [], 'a test did not pass')
execFileSync('cargo', ['check', '-p', 'pello', '--manifest-path', manifest], { stdio: 'inherit' })
console.log('PASS tauri shell type-checks against the same command dispatcher')
