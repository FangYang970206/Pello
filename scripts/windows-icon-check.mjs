import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { _electron as electron } from 'playwright'

if (process.platform !== 'win32') {
  console.log('SKIP Windows taskbar properties: Windows only')
} else {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const executablePath = process.argv[2] && path.resolve(process.argv[2])
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-taskbar-'))
  const env = { ...process.env, AWB_USER_DATA: data, AWB_RESOURCE_HOME: path.join(data, 'agent-home') }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ executablePath, args: executablePath ? [] : [root], cwd: root, env, timeout: 30000 })
  try {
    await app.firstWindow({ timeout: 20000 })
    const info = await app.evaluate(({ app, BrowserWindow }) => ({
      packaged: app.isPackaged, name: app.getName(), title: BrowserWindow.getAllWindows()[0].getTitle(), executable: process.execPath, appPath: app.getAppPath(), resources: process.resourcesPath,
      handle: BrowserWindow.getAllWindows()[0].getNativeWindowHandle().readBigUInt64LE().toString()
    }))
    const state = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-File', path.join(root, 'scripts/fixtures/windows-taskbar.ps1'), '-WindowHandle', info.handle], { encoding: 'utf8', windowsHide: true, timeout: 15000 }))
    console.log('Windows Shell taskbar properties', JSON.stringify(state))
    assert.equal(info.name, 'Pello')
    assert.equal(info.title, 'Pello', 'Window title must use the new product name')
    assert.equal(state.appId, info.packaged ? 'com.pello.app' : 'com.pello.app.dev', 'Development and installed windows must have separate Shell identities')
    const icon = path.join(info.packaged ? info.resources : path.join(root, 'assets'), 'icon.ico')
    assert.equal(state.relaunchIcon, `${icon},0`, 'Shell taskbar must use the supplied ICO rather than the Electron executable or old shortcut')
    assert.ok(fs.readFileSync(icon).equals(fs.readFileSync(path.join(root, 'assets/icon.ico'))))
    assert.equal(state.relaunchDisplayName, 'Pello')
    assert.equal(state.relaunchCommand, info.packaged ? `"${info.executable}"` : `"${info.executable}" "${info.appPath}"`)
    assert.notEqual(state.windowIcon, '0', 'Native window icon is missing')
    console.log(`PASS ${info.packaged ? 'packaged' : 'development'} Windows taskbar icon, grouping and relaunch target`)
  } finally { await app.close() }
}
