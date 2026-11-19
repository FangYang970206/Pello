import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { unzipSync } from 'fflate'
import { _electron as electron } from 'playwright'

if (process.platform !== 'win32') { console.log('SKIP Windows packaged upgrade check'); process.exit(0) }
const run = promisify(execFile)
const from = '0.1.13'
const guided = process.argv.includes('--guided')
const target = process.argv.find((arg) => arg.startsWith('--target='))?.slice(9) || JSON.parse(fs.readFileSync('package.json', 'utf8')).version
const root = path.resolve('.cache/update-upgrade-check')
fs.mkdirSync(root, { recursive: true })
const folder = fs.mkdtempSync(path.join(root, `${from}-to-${target}-`))
const identity = randomUUID()
const executableName = `PelloUG-${identity.slice(0, 8)}.exe`
// Keep the temporary extraction paths below NSIS's legacy MAX_PATH limit.
const installation = path.join(folder, guided ? path.basename(executableName, '.exe') : 'Pello installed')
const shots = path.resolve('output/playwright/update-upgrade', path.basename(folder))
fs.mkdirSync(shots, { recursive: true })
const env = { ...process.env }
delete env.PSModulePath; delete env.AWB_USER_DATA; delete env.ELECTRON_RUN_AS_NODE
const options = { windowsHide: true, timeout: 180000, maxBuffer: 4 * 1024 * 1024, env }
async function build(version, legacy) {
  const runtime = path.join(folder, `runtime-${version}`)
  const archive = path.resolve(`dist/Pello-${version}-win-x64.zip`)
  assert.ok(fs.existsSync(archive), `This deep check requires the original release archive: ${archive}`)
  const files = unzipSync(fs.readFileSync(archive))
  for (const [relative, bytes] of Object.entries(files)) {
    const file = path.resolve(runtime, relative)
    assert.ok(file.startsWith(runtime + path.sep), 'release archive entry must stay inside its fixture')
    if (relative.endsWith('/')) fs.mkdirSync(file, { recursive: true })
    else { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes) }
  }
  fs.renameSync(path.join(runtime, 'Pello.exe'), path.join(runtime, executableName))
  const artifacts = path.join(folder, `artifacts-${version}`)
  await run(process.execPath, ['node_modules/electron-builder/out/cli/cli.js', '--win', 'nsis', '--x64', '--prepackaged', runtime, '--publish', 'never',
    `-c.appId=com.pello.upgradecheck.${identity}`, '-c.productName=PelloUpgradeCheck', `-c.directories.output=${artifacts}`,
    `-c.win.executableName=${path.basename(executableName, '.exe')}`, `-c.extraMetadata.version=${version}`,
    '-c.nsis.createDesktopShortcut=false', '-c.nsis.createStartMenuShortcut=false', `-c.nsis.runAfterFinish=${guided && !legacy}`,
    ...(legacy ? ['-c.nsis.include=scripts/fixtures/nsis-legacy-installer.nsh'] : [])], options)
  console.log(`Built isolated ${version} installer (${legacy ? 'legacy' : 'fixed'})`)
  return path.join(artifacts, fs.readdirSync(artifacts).find((name) => name.endsWith('-setup.exe')))
}
const legacyInstaller = await build(from, true)
const installer = await build(target, false)
await run(legacyInstaller, ['/S', `/D=${installation}`], options)
const data = path.join(installation, 'data')
const executable = path.join(installation, executableName)
fs.mkdirSync(data, { recursive: true })
fs.writeFileSync(path.join(data, 'keep.txt'), 'PRESERVE_UPGRADE_DATA_中文')
fs.writeFileSync(path.join(installation, 'pello.config.json'), JSON.stringify({ temporarySessionsDirectory: 'D:\\TempSessions' }))
fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify({ settings: { restore: true, defAgent: 'shell', defShell: 'pwsh', confirmKill: false, autoCheckUpdates: false },
  projects: [{ id: 'upgrade', name: 'Upgrade fixture', host: 'local', path: data, agent: 'shell' }],
  sessions: { upgrade: [{ id: 'upgrade-shell', kind: 'shell', shell: 'pwsh' }] } }))
const payload = fs.readFileSync(installer)
const hash = createHash('sha512').update(payload).digest('base64')
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/latest.yml')) res.end(`version: ${target}\nfiles:\n  - url: update.exe\n    sha512: ${hash}\n    size: ${payload.length}\npath: update.exe\nsha512: ${hash}\n`)
  else if (req.url.startsWith('/update.exe')) { res.writeHead(200, { 'Content-Length': payload.length }); res.end(payload) }
  else { res.writeHead(404); res.end() }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
fs.writeFileSync(path.join(installation, 'resources', 'app-update.yml'), `provider: generic\nurl: http://127.0.0.1:${server.address().port}\nupdaterCacheDirName: upgrade-fixture\n`)
const launch = () => electron.launch({ executablePath: executable, args: ['--force-device-scale-factor=1'], env })
let app = await launch()
let closed = false
try {
  const page = await app.firstWindow()
  await page.locator('[data-a=settings]').waitFor()
  assert.equal(await app.evaluate(({ app }) => app.getVersion()), from)
  await page.waitForFunction(() => !!window.__awbBuffer?.('upgrade-shell'))
  await page.evaluate(() => window.awb.ptyWrite('upgrade-shell', "Write-Output 'UPGRADE_HISTORY_BEFORE'\r"))
  await page.waitForFunction(() => window.__awbBuffer?.('upgrade-shell')?.includes('UPGRADE_HISTORY_BEFORE'))
  if (!guided) await app.evaluate(({ app }) => {
    const require = process.getBuiltinModule('module').createRequire(`${app.getAppPath()}/package.json`)
    const { NsisUpdater } = require('electron-updater')
    const install = NsisUpdater.prototype.quitAndInstall
    // Only skip the native wizard for unattended verification. This still
    // executes the downloaded NSIS package, its real uninstall and restart.
    NsisUpdater.prototype.quitAndInstall = function () { return install.call(this, true, true) }
  })
  assert.equal((await page.evaluate(() => window.awb.checkAppUpdate())).version, target)
  assert.equal((await page.evaluate(() => window.awb.downloadAppUpdate())).phase, 'downloaded')
  console.log(`PASS actual ${from} discovers and downloads ${target}`)
  await page.click('[data-a=settings]')
  await page.screenshot({ path: path.join(shots, 'before-install.png') })
  const oldPid = app.process().pid
  const close = app.waitForEvent('close', { timeout: guided ? 240000 : 45000 })
  await page.evaluate(() => window.awb.installAppUpdate()).catch((error) => { if (!/closed|destroyed/i.test(error.message)) throw error })
  await close; closed = true
  if (guided) console.log('Waiting for the native installation wizard to finish (guided verification)')
  const query = async () => {
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:PELLO_UPGRADE_EXE -and $_.CommandLine -notmatch "--type=" } | Select-Object ProcessId,ExecutablePath)'],
    { ...options, env: { ...env, PELLO_UPGRADE_EXE: executable } })
    return JSON.parse(stdout || '[]')
  }
  let restarted = []
  const deadline = Date.now() + (guided ? 180000 : 90000)
  while (Date.now() < deadline) {
    restarted = (await query()).filter((process) => process.ProcessId !== oldPid)
    if (restarted.length) break
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  assert.equal(restarted.length, 1, 'NSIS must finish and restart the installed application')
  console.log('PASS native installer completed and automatically restarted the application')
  const restartedPid = restarted[0].ProcessId
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$p = Get-Process -Id $env:PELLO_UPGRADE_PID; if ($p.Path -ne $env:PELLO_UPGRADE_EXE) { throw "process identity changed" }; $limit = (Get-Date).AddSeconds(20); while (!$p.MainWindowHandle -and (Get-Date) -lt $limit) { Start-Sleep -Milliseconds 100; $p.Refresh() }; if (!$p.CloseMainWindow()) { throw "restarted application has no window" }; $p.WaitForExit()'],
  { ...options, timeout: 45000, env: { ...env, PELLO_UPGRADE_PID: String(restartedPid), PELLO_UPGRADE_EXE: executable } })
  assert.equal(fs.readFileSync(path.join(data, 'keep.txt'), 'utf8'), 'PRESERVE_UPGRADE_DATA_中文')
  assert.equal(JSON.parse(fs.readFileSync(path.join(installation, 'pello.config.json'), 'utf8')).temporarySessionsDirectory, 'D:\\TempSessions')
  app = await launch(); closed = false
  const restored = await app.firstWindow()
  await restored.locator('[data-a=settings]').waitFor()
  assert.equal(await app.evaluate(({ app }) => app.getVersion()), target, 'verify the installed application version, not just the installer exit')
  await restored.waitForFunction(() => window.__awbBuffer?.('upgrade-shell')?.includes('UPGRADE_HISTORY_BEFORE'))
  await restored.evaluate(() => window.awb.ptyWrite('upgrade-shell', "Write-Output 'UPGRADE_HISTORY_AFTER'\r"))
  await restored.waitForFunction(() => window.__awbBuffer?.('upgrade-shell')?.includes('UPGRADE_HISTORY_AFTER'))
  await restored.click('[data-a=settings]')
  const about = restored.locator('[data-a=sec][data-id=about]')
  if (await about.count()) {
    await about.click()
    await restored.waitForFunction((version) => document.querySelector('[data-about=version]')?.textContent === `v${version}`, target)
  }
  await restored.screenshot({ path: path.join(shots, 'after-upgrade.png') })
  console.log(`PASS actual packaged ${from} → ${target}: real download/cache, NSIS handoff, legacy uninstall, automatic restart, installed version, profile/config and terminal content`)
} finally {
  if (!closed) await app.close()
  await new Promise((resolve) => server.close(resolve))
}
const uninstaller = path.join(installation, fs.readdirSync(installation).find((file) => /^Uninstall .*\.exe$/.test(file)))
await run(uninstaller, ['/S', `_?=${installation}`], options)
console.log(`Evidence: ${folder}; screenshots: ${shots}`)
