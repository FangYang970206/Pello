import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import http from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { _electron as electron } from 'playwright'

// Isolate both registry identity and executable name: NSIS checks running apps
// by filename, so a separate app ID alone can still stop a real Pello process.
if (process.platform !== 'win32') { console.log('SKIP Windows NSIS installation check'); process.exit(0) }
const run = promisify(execFile)
const root = path.resolve('.cache/installation-check')
fs.mkdirSync(root, { recursive: true })
const installation = fs.mkdtempSync(path.join(root, 'install '))
assert.ok(installation.startsWith(path.resolve('.cache') + path.sep))
const artifacts = fs.mkdtempSync(path.join(root, 'artifacts-'))
const runtime = fs.mkdtempSync(path.join(root, 'runtime-'))
const identity = randomUUID()
const executableBase = `PelloInstallationCheck-${identity}`
const executableName = executableBase + '.exe'
fs.cpSync(path.resolve('dist/win-unpacked'), runtime, { recursive: true })
fs.renameSync(path.join(runtime, 'Pello.exe'), path.join(runtime, executableName))
await run(process.execPath, ['node_modules/electron-builder/out/cli/cli.js', '--win', 'nsis', '--x64', '--prepackaged', runtime, '--publish', 'never',
  `-c.appId=com.pello.installationcheck.${identity}`, '-c.productName=PelloInstallationCheck', `-c.directories.output=${artifacts}`,
  `-c.win.executableName=${executableBase}`,
  '-c.nsis.createDesktopShortcut=false', '-c.nsis.createStartMenuShortcut=false', '-c.nsis.runAfterFinish=false'], { windowsHide: true, timeout: 180000, maxBuffer: 4 * 1024 * 1024 })
const installers = fs.readdirSync(artifacts).filter((file) => file.endsWith('-setup.exe'))
assert.equal(installers.length, 1, 'Use only the installer produced by this run')
const installer = path.join(artifacts, installers[0])
const data = path.join(installation, 'data')
fs.mkdirSync(data)
fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify({ settings: { restore: true, defAgent: 'shell', defShell: 'pwsh', confirmKill: false },
  projects: [{ id: 'smoke', name: 'Update smoke', host: 'local', path: data, agent: 'shell' }], sessions: { smoke: [{ id: 'update-shell', kind: 'shell', shell: 'pwsh' }] } }))
fs.writeFileSync(path.join(data, 'keep.txt'), 'PERSISTENT_DATA_中文')
fs.writeFileSync(path.join(installation, 'pello.config.json'), '{"temporarySessionsDirectory":"D:\\TempSessions"}')
const install = () => run(installer, ['/S', `/D=${installation}`], { windowsHide: true, timeout: 120000 })
await install()
const uninstaller = path.join(installation, fs.readdirSync(installation).find((file) => /^Uninstall .*\.exe$/.test(file)))
assert.ok(fs.statSync(uninstaller).size > 0)
const executable = path.join(installation, executableName)
assert.ok(fs.existsSync(executable))
const fixture = Buffer.from('LOCAL_UPDATE_FIXTURE_NEVER_EXECUTE'), hash = createHash('sha512').update(fixture).digest('base64')
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/latest.yml')) res.end(`version: 99.0.0\nfiles:\n  - url: fixture.exe\n    sha512: ${hash}\n    size: ${fixture.length}\npath: fixture.exe\nsha512: ${hash}\nreleaseDate: '2026-11-12T00:00:00.000Z'\n`)
  else if (req.url.startsWith('/fixture.exe')) { res.writeHead(200, { 'Content-Length': fixture.length }); res.end(fixture) }
  else { res.writeHead(404); res.end() }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
fs.writeFileSync(path.join(installation, 'resources', 'app-update.yml'), `provider: generic\nurl: http://127.0.0.1:${server.address().port}\nupdaterCacheDirName: fixture\n`)
const env = { ...process.env }
delete env.AWB_USER_DATA; delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ executablePath: executable, args: ['--force-device-scale-factor=1'], env })
try {
  const page = await app.firstWindow()
  await page.locator('[data-a=settings]').waitFor()
  const paths = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, paths: Object.fromEntries(['userData', 'sessionData', 'temp', 'logs', 'crashDumps'].map((name) => [name, app.getPath(name)])) }))
  assert.equal(paths.packaged, true)
  assert.equal(await app.evaluate(({ app }) => app.getVersion()), JSON.parse(fs.readFileSync('package.json', 'utf8')).version, 'Installed runtime must match the release version')
  assert.equal(paths.paths.userData, data)
  for (const directory of Object.values(paths.paths)) assert.ok(directory === data || directory.startsWith(data + path.sep))
  const state = await page.evaluate(() => window.awb.appUpdateState())
  assert.equal(state.phase, 'idle', 'packaged Windows app must enable updates')
  await page.waitForFunction(() => !!window.__awbBuffer?.('update-shell'))
  await page.evaluate(() => window.awb.ptyWrite('update-shell', "Write-Output 'UPDATE_BEFORE_CANCEL'\r"))
  await page.waitForFunction(() => window.__awbBuffer?.('update-shell')?.includes('UPDATE_BEFORE_CANCEL'))
  await app.evaluate(({ app, dialog }) => {
    const require = process.getBuiltinModule('module').createRequire(`${app.getAppPath()}/package.json`)
    require('electron-updater').NsisUpdater.prototype.quitAndInstall = function (...args) { globalThis.__installArgs = args }
    globalThis.__confirmInstall = false
    dialog.showMessageBoxSync = () => globalThis.__confirmInstall ? 1 : 0
  })
  await page.evaluate(() => window.awb.checkAppUpdate())
  assert.equal(await page.locator('.app-update').count(), 0)
  await page.click('[data-a=settings]')
  await page.getByRole('button', { name: '下载新版本 99.0.0', exact: true }).click()
  await page.getByRole('button', { name: '安装更新 99.0.0 并重启', exact: true }).waitFor()
  const cached = path.join(data, 'updates', 'fixture', 'pending', 'fixture.exe')
  assert.deepEqual(fs.readFileSync(cached), fixture)
  await page.evaluate(() => window.awb.setUnsavedChanges(true))
  assert.equal(await page.evaluate(() => window.awb.installAppUpdate()), false)
  assert.equal(await app.evaluate(() => globalThis.__installArgs), undefined)
  await page.evaluate(() => window.awb.ptyWrite('update-shell', "Write-Output 'UPDATE_CANCEL_KEPT_TERMINAL'\r"))
  await page.waitForFunction(() => window.__awbBuffer?.('update-shell')?.includes('UPDATE_CANCEL_KEPT_TERMINAL'))
  await page.evaluate(async () => { const { db } = await window.awb.getState(); await window.awb.saveSettings({ ...db.settings, language: 'en' }) })
  await app.evaluate(() => { globalThis.__confirmInstall = true })
  assert.equal(await page.evaluate(() => window.awb.installAppUpdate()), true)
  assert.deepEqual(await app.evaluate(() => globalThis.__installArgs), [false, true])
  const history = path.join(data, 'terminal-history', `${createHash('sha256').update('update-shell').digest('hex')}.log`)
  assert.ok(fs.readFileSync(history, 'utf8').includes('UPDATE_CANCEL_KEPT_TERMINAL'))
  console.log('PASS packaged update IPC/feed/cache, cancellation preserves the live terminal, installation flushes actual history before invoking installer')
} finally { await app.close(); await new Promise((resolve) => server.close(resolve)) }
assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'workbench.json'), 'utf8')).settings.language, 'en')
await install()
assert.equal(fs.readFileSync(path.join(data, 'keep.txt'), 'utf8'), 'PERSISTENT_DATA_中文')
assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'workbench.json'), 'utf8')).settings.language, 'en')
assert.ok(fs.existsSync(path.join(installation, 'pello.config.json')))
console.log('PASS isolated NSIS install, installation-local uninstaller, packaged runtime paths, settings persistence and upgrade data retention')
// _?= runs the tested uninstaller in place, making completion observable.
assert.ok(uninstaller.startsWith(installation + path.sep))
await run(uninstaller, ['/S', `_?=${installation}`], { windowsHide: true, timeout: 120000 })
// NSIS can hand off to a child process before the original process exits.
const deadline = Date.now() + 20000
while ((fs.existsSync(executable) || fs.existsSync(path.join(installation, 'resources'))) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100))
assert.ok(!fs.existsSync(executable))
assert.ok(!fs.existsSync(path.join(installation, 'resources')))
assert.equal(fs.readFileSync(path.join(data, 'keep.txt'), 'utf8'), 'PERSISTENT_DATA_中文')
assert.ok(fs.existsSync(path.join(installation, 'pello.config.json')))
console.log('PASS real uninstall removes program files and preserves data/config in the installation directory')
