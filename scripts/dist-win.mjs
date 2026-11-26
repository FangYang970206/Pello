import { spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'
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
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${path.basename(cmd)} failed (${result.status ?? result.signal})`)
  }
}

const options = process.argv.slice(2)
try {
  if (options.length && (options.length !== 1 || options[0] !== '--skip-build')) {
    throw new Error('Usage: npm run dist:win -- [--skip-build]')
  }
  if (options.includes('--skip-build')) {
    for (const entry of ['out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html']) {
      if (!statSync(path.join(root, entry), { throwIfNoEntry: false })?.isFile()) {
        throw new Error(`Missing ${entry}. Run npm run build before reusing its output.`)
      }
    }
  } else {
    run(bin('electron-vite'), ['build'])
  }

  // beforePack validates the selected x64 addons. Rebuilding unused optional
  // SSH dependencies can fail on cpu-features.
  try {
    run(bin('electron-builder'), ['--win', '--x64', '--publish', 'never', '-c.npmRebuild=false'])
  } finally {
    // beforePack may have moved a host-platform node-pty build out of the tree.
    restore()
  }
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
