import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'

if (process.platform !== 'win32') { console.log('SKIP Windows NSIS update check'); process.exit(0) }
const run = promisify(execFile)
const root = path.resolve('.cache/nsis-update-check')
fs.mkdirSync(root, { recursive: true })
const folder = fs.mkdtempSync(path.join(root, 'upgrade-'))
const runtime = path.join(folder, 'runtime')
const identity = randomUUID()
const executableName = `PelloUpdateCheck-${identity}.exe`
fs.mkdirSync(path.join(runtime, 'resources'), { recursive: true })
// Only the installer runs: a tiny payload makes the real NSIS lifecycle fast.
fs.writeFileSync(path.join(runtime, executableName), 'ISOLATED_INSTALLATION_PAYLOAD')
async function build(name, legacy) {
  const artifacts = path.join(folder, name)
  fs.writeFileSync(path.join(runtime, 'installed.txt'), name)
  await run(process.execPath, ['node_modules/electron-builder/out/cli/cli.js', '--win', 'nsis', '--x64', '--prepackaged', runtime, '--publish', 'never',
    `-c.appId=com.pello.updatecheck.${identity}`, '-c.productName=PelloUpdateCheck', `-c.directories.output=${artifacts}`,
    `-c.win.executableName=${path.basename(executableName, '.exe')}`,
    '-c.nsis.createDesktopShortcut=false', '-c.nsis.createStartMenuShortcut=false', '-c.nsis.runAfterFinish=false',
    ...(legacy ? ['-c.nsis.include=scripts/fixtures/nsis-legacy-installer.nsh'] : [])],
  { windowsHide: true, timeout: 180000, maxBuffer: 4 * 1024 * 1024 })
  return path.join(artifacts, fs.readdirSync(artifacts).find((file) => file.endsWith('-setup.exe')))
}
const legacyInstaller = await build('legacy', true)
const installer = await build('fixed', false)
// PowerShell 7's inherited module path can break Windows PowerShell's security
// module and silently force NSIS onto its filename-based fallback.
const env = { ...process.env }
delete env.PSModulePath
const options = { windowsHide: true, timeout: 45000, env }
async function waitUntil(predicate, message) {
  const deadline = Date.now() + 20000
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100))
  assert.ok(predicate(), message)
}
async function processFixture(executable) {
  fs.mkdirSync(path.dirname(executable), { recursive: true })
  fs.copyFileSync(process.execPath, executable)
  const child = spawn(executable, ['-e', "console.log('READY'); setInterval(() => {}, 1000)"], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('fixture process did not become ready: ' + executable)) }, 10000)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.stdout.once('data', () => { clearTimeout(timer); resolve() })
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error('fixture exited before READY: ' + code)) })
  })
  return child
}
async function checkUpgrade(name, fallback = false) {
  const installation = path.join(folder, name)
  const installOptions = { ...options, env: { ...env, ...(fallback ? { PSExecutionPolicyPreference: 'Restricted' } : {}) } }
  await run(legacyInstaller, ['/S', `/D=${installation}`], installOptions)
  assert.equal(fs.readFileSync(path.join(installation, 'installed.txt'), 'utf8'), 'legacy')
  const data = path.join(installation, 'data')
  const pending = path.join(data, 'updates', 'pello-updater', 'pending')
  const temp = path.join(data, 'tmp')
  fs.mkdirSync(pending, { recursive: true })
  fs.mkdirSync(temp, { recursive: true })
  fs.writeFileSync(path.join(data, 'keep.txt'), 'KEEP_PROFILE_中文')
  fs.writeFileSync(path.join(installation, 'pello.config.json'), '{"keep":true}')
  const cached = path.join(pending, 'update.exe')
  fs.copyFileSync(installer, cached)
  const children = []
  try {
    // Verify that closing Pello cannot stop helpers in data or sibling installs.
    children.push(await processFixture(path.join(installation, executableName)))
    children.push(await processFixture(path.join(data, 'helper', 'helper.exe')))
    children.push(await processFixture(path.join(installation + '-sibling', executableName)))
    let failure
    try {
      // Match the old application's cache location and inherited temporary paths.
      await run(cached, ['--updated', '/S', `/D=${installation}`], { ...installOptions, env: { ...installOptions.env, TEMP: temp, TMP: temp, TMPDIR: temp } })
    } catch (error) { failure = `installer exit=${error.code}, signal=${error.signal}` }
    assert.equal(fs.readFileSync(path.join(installation, 'installed.txt'), 'utf8'), 'fixed',
      `Updater-launched NSIS must finish when both its EXE and TEMP are inside data; ${failure || 'installer exited normally'}`)
    assert.equal(failure, undefined)
    await waitUntil(() => children[0].exitCode !== null, 'the actual application process must close')
    for (const child of children.slice(1)) assert.equal(child.exitCode, null, 'unrelated data/sibling process must survive')
    assert.equal(fs.readFileSync(path.join(data, 'keep.txt'), 'utf8'), 'KEEP_PROFILE_中文')
    assert.equal(fs.readFileSync(path.join(installation, 'pello.config.json'), 'utf8'), '{"keep":true}')
    console.log(`PASS legacy-to-fixed cached NSIS upgrade (${name}, ${fallback ? 'no PowerShell' : 'PowerShell'}), actual payload, process boundaries and data/config retention`)
    const uninstaller = path.join(installation, fs.readdirSync(installation).find((file) => /^Uninstall .*\.exe$/.test(file)))
    assert.ok(uninstaller.startsWith(folder + path.sep))
    await run(uninstaller, ['/S', `_?=${installation}`], installOptions)
    await waitUntil(() => !fs.existsSync(path.join(installation, executableName)), 'uninstaller must remove the program')
    assert.equal(fs.readFileSync(path.join(data, 'keep.txt'), 'utf8'), 'KEEP_PROFILE_中文')
    assert.equal(fs.readFileSync(path.join(installation, 'pello.config.json'), 'utf8'), '{"keep":true}')
    for (const child of children.slice(1)) assert.equal(child.exitCode, null, 'uninstall must preserve unrelated processes')
    console.log('PASS isolated real uninstaller retains profile')
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill()
    for (const child of children) await waitUntil(() => child.exitCode !== null || child.signalCode !== null, 'fixture process must end')
  }
}
await checkUpgrade('Pello install')
await checkUpgrade("Pello 中文 user's install")
await checkUpgrade('Pello fallback', true)
