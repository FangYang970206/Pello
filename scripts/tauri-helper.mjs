// Builds the helper that answers a native CLI's capability query and puts it
// where Tauri's `externalBin` picks it up: `binaries/<name>-<target-triple>.exe`.
// Tauri ships it beside the main program as `<name>.exe`, which is the name the
// terminal looks for (`<main program>-console-reply.exe`), so the reply works
// in an installed build and not only under `cargo test`.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tauri = path.join(root, 'src-tauri')
const name = 'pello-console-reply'
const extension = process.platform === 'win32' ? '.exe' : ''
const cargo = (...args) => execFileSync('cargo', args, { cwd: tauri, stdio: 'inherit' })

const triple = process.env.AWB_TARGET_TRIPLE || execFileSync('rustc', ['-vV'], { cwd: tauri, encoding: 'utf8' }).match(/^host: (\S+)$/m)?.[1]
if (!triple) throw new Error('rustc did not report its host target')
const debug = process.env.AWB_HELPER_DEBUG === '1'
cargo('build', '-p', 'pello-core', '--bin', 'awb-console-reply', ...(debug ? [] : ['--release']))

const built = path.join(tauri, 'target', debug ? 'debug' : 'release', `awb-console-reply${extension}`)
if (!fs.existsSync(built)) throw new Error(`cargo did not build ${built}`)
fs.mkdirSync(path.join(tauri, 'binaries'), { recursive: true })
fs.copyFileSync(built, path.join(tauri, 'binaries', `${name}-${triple}${extension}`))
// `tauri dev` and `cargo run` start `target/debug/pello`, where no bundler
// has placed anything, so the same helper is put beside it under the name the
// terminal looks for.
const beside = path.join(tauri, 'target', 'debug', `${name}${extension}`)
fs.mkdirSync(path.dirname(beside), { recursive: true })
fs.copyFileSync(built, beside)
console.log(`helper ready: binaries/${name}-${triple}${extension}`)
