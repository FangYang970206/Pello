const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const STASH_MANIFEST = path.join(os.tmpdir(), 'pello-node-pty-stash.json')

const MODULES = ['conpty.node', 'pty.node', 'conpty_console_list.node']

function isPeAmd64(file) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const header = Buffer.alloc(64)
    if (fs.readSync(fd, header, 0, 64, 0) < 64) return false
    if (header[0] !== 0x4d || header[1] !== 0x5a) return false
    const peOffset = header.readUInt32LE(0x3c)
    const pe = Buffer.alloc(6)
    if (fs.readSync(fd, pe, 0, 6, peOffset) < 6) return false
    if (pe.toString('ascii', 0, 4) !== 'PE\0\0') return false
    return pe.readUInt16LE(4) === 0x8664
  } catch {
    return false
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

function isNodeApiAddon(file) {
  const data = fs.readFileSync(file)
  return data.includes(Buffer.from('napi_register_module_v1'))
}

function isWin32NodeApi(file) {
  return isPeAmd64(file) && isNodeApiAddon(file)
}

function walk(dir, out) {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else out.push(full)
  }
}

function candidates(ptyRoot, name) {
  return [
    path.join(ptyRoot, 'build', 'Release', name),
    path.join(ptyRoot, 'build', 'Debug', name),
    path.join(ptyRoot, 'prebuilds', 'win32-x64', name)
  ]
}

function readMoved() {
  if (!fs.existsSync(STASH_MANIFEST)) return []
  return JSON.parse(fs.readFileSync(STASH_MANIFEST, 'utf8'))
}

function writeMoved(moved) {
  if (!moved.length) {
    fs.rmSync(STASH_MANIFEST, { force: true })
    return
  }
  fs.writeFileSync(STASH_MANIFEST, JSON.stringify(moved))
}

// node-pty loads build/Release before prebuilds/<platform>-<arch>. A Linux
// electron-rebuild output in build/Release would be packed into the Windows
// app and tried first. Move any non-win32 build tree aside for the pack,
// then put it back in afterPack / the dist script's finally.
function stashDirIfNotWin32(dir, label) {
  const nodeFiles = []
  walk(dir, nodeFiles)
  const natives = nodeFiles.filter((file) => file.endsWith('.node'))
  if (!natives.length) return []
  if (natives.every((file) => isWin32NodeApi(file))) return []

  const stashDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-node-pty-'))
  const dest = path.join(stashDir, path.basename(dir))
  fs.renameSync(dir, dest)
  console.log(`[node-pty] stashed non-win32 ${label} so prebuilds/win32-x64 is packed`)
  return [{ dest, file: dir }]
}

function stashNonWin32Outputs(ptyRoot) {
  // build/Release is preferred by node-pty's loader. bin/<platform>-<abi>/ is
  // only an @electron/rebuild copy and is not loaded, but it must not ride
  // along as a linux binary inside a Windows installer.
  return ['build', 'bin'].flatMap((name) => stashDirIfNotWin32(path.join(ptyRoot, name), name + '/'))
}

function ensure(context) {
  if (context.electronPlatformName !== 'win32') return
  const ptyRoot = path.join(context.packager.projectDir, 'node_modules', 'node-pty')
  if (!fs.existsSync(ptyRoot)) {
    throw new Error('node-pty is not installed, so a Windows installer cannot be packed')
  }

  const moved = readMoved().concat(stashNonWin32Outputs(ptyRoot))
  writeMoved(moved)

  for (const name of MODULES) {
    const selected = candidates(ptyRoot, name).find((file) => fs.existsSync(file))
    if (!selected || !isWin32NodeApi(selected)) {
      throw new Error(
        `node-pty ${name} is not a win32-x64 Node-API binary. ` +
          'On Windows, "npx electron-builder install-app-deps" rebuilds it against Electron ' +
          '(Visual Studio 2022 C++ Build Tools and Python 3). ' +
          'Refusing to pack an installer that cannot load node-pty.'
      )
    }
    console.log(`[node-pty] ${name} -> ${path.relative(ptyRoot, selected)}`)
  }
}

function restore() {
  const moved = readMoved()
  for (const { dest, file } of moved.reverse()) {
    if (!fs.existsSync(dest)) continue
    fs.mkdirSync(path.dirname(file), { recursive: true })
    if (fs.existsSync(file)) fs.rmSync(file, { recursive: true, force: true })
    fs.renameSync(dest, file)
  }
  writeMoved([])
}

module.exports = { ensure, restore, isWin32NodeApi }
