import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { restore } = require('./node-pty-pack.cjs')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function bin(name) {
  const ext = process.platform === 'win32' ? '.cmd' : ''
  return path.join(root, 'node_modules', '.bin', name + ext)
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: process.env
  })
  if (result.error) {
    console.error(result.error.message)
    process.exit(1)
  }
  if (result.status !== 0) process.exit(result.status ?? 1)
}

run(bin('electron-vite'), ['build'])

const builder = bin('electron-builder')
if (process.platform === 'win32') {
  // @electron/rebuild against the Electron version installed in this repo.
  // Same entry point as `electron-builder install-app-deps`.
  run(builder, ['install-app-deps'])
}

const packArgs = ['--win', '--x64', '--publish', 'never', '-c.npmRebuild=false']
try {
  run(builder, packArgs)
} finally {
  // beforePack may have moved a host-platform node-pty build out of the tree.
  restore()
}
