import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

const manifest = 'src-tauri/Cargo.toml'
const test = execFileSync('cargo', ['test', '-p', 'pello-core', '--manifest-path', manifest, '--', '--test-threads=8'], { encoding: 'utf8' })
assert.match(test, /test result: ok/)
console.log(test.trim().split('\n').filter((line) => line.startsWith('test ') || line.startsWith('test result')).join('\n'))
console.log('PASS rust core matches data directory, settings, temporary sessions, local files, git status, shell prompt, local file search, and SSH password sessions')
execFileSync('cargo', ['check', '-p', 'pello', '--manifest-path', manifest], { stdio: 'inherit' })
console.log('PASS tauri shell type-checks against the same command dispatcher')
