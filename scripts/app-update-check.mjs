import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import http from 'node:http'
import { _electron as electron } from 'playwright'
import { loadTypeScript } from './fixtures/load-ts.mjs'

const { UpdateController } = await loadTypeScript(new URL('../src/main/update-controller.ts', import.meta.url))
class Driver extends EventEmitter {
  checks = 0; downloads = 0; installs = 0; broken = false
  async checkForUpdates() { this.checks++; await new Promise((resolve) => setImmediate(resolve)); this.emit('update-available', { version: '99.0.0' }) }
  async downloadUpdate() {
    this.downloads++
    if (this.broken) { this.emit('error', new Error('offline')); throw new Error('offline') }
    this.emit('download-progress', { percent: 54.5 }); this.emit('update-downloaded', { version: '99.0.0' })
  }
  quitAndInstall() { this.installs++ }
}
const driver = new Driver(), events = [], updater = new UpdateController(driver, (state) => events.push(state))
assert.equal(await updater.install(async () => true), false)
await Promise.all([updater.check(), updater.check()])
assert.equal(driver.checks, 1); assert.equal(driver.downloads, 0)
driver.broken = true
await updater.download()
assert.equal(updater.state.failed, 'download', 'an error event followed by a rejected Promise must retain the retry action')
driver.broken = false
await Promise.all([updater.download(), updater.download()])
assert.equal(driver.downloads, 2); assert.equal(updater.state.phase, 'downloaded')
assert.ok(events.some((state) => state.percent === 55))
assert.equal(await updater.install(async () => false), false)
assert.equal(driver.installs, 0); assert.equal(updater.state.phase, 'downloaded')
await updater.install(async () => { throw new Error('cleanup failed') })
assert.equal(updater.state.failed, 'install'); assert.equal(driver.installs, 0)
let release
const preparing = updater.install(() => new Promise((resolve) => { release = resolve }))
assert.equal(await updater.install(async () => true), false)
release(true); await preparing; assert.equal(driver.installs, 1)
const offlineDriver = new Driver()
offlineDriver.checkForUpdates = async () => { throw new Error('offline') }
const offline = new UpdateController(offlineDriver, () => {})
await offline.check(); assert.equal(offline.state.failed, 'check')
const currentDriver = new Driver()
currentDriver.checkForUpdates = async () => currentDriver.emit('update-not-available')
const current = new UpdateController(currentDriver, () => {})
await current.check(); assert.equal(current.state.phase, 'current')
console.log('PASS update state machine: no auto-download, duplicate actions, progress, offline/retry, cancel, cleanup failure and install ordering')

const { UpdateScheduler } = await loadTypeScript(new URL('../src/main/update-scheduler.ts', import.meta.url))
const scheduled = new Map(), durations = [], cancelledCallbacks = []
let automaticChecks = 0, timerId = 0
const timers = {
  setTimeout: (callback, delay) => { durations.push(delay); scheduled.set(++timerId, callback); return timerId },
  setInterval: (callback, delay) => { durations.push(delay); scheduled.set(++timerId, callback); return timerId },
  clearTimeout: (id) => { if (scheduled.has(id)) cancelledCallbacks.push(scheduled.get(id)); scheduled.delete(id) },
  clearInterval: (id) => { if (scheduled.has(id)) cancelledCallbacks.push(scheduled.get(id)); scheduled.delete(id) }
}
const scheduler = new UpdateScheduler(async () => { automaticChecks++ }, timers)
scheduler.setEnabled(false); assert.equal(scheduled.size, 0)
scheduler.setEnabled(true); assert.deepEqual(durations, [15000, 21600000])
scheduler.setEnabled(true); assert.equal(scheduled.size, 2)
for (const callback of scheduled.values()) callback()
assert.equal(automaticChecks, 2)
scheduler.setEnabled(false); assert.equal(scheduled.size, 0)
for (const callback of cancelledCallbacks) callback()
assert.equal(automaticChecks, 2, 'disabled automatic checks cannot run even if a timer callback was already queued')
scheduler.setEnabled(true); assert.equal(scheduled.size, 2)
scheduler.dispose(); assert.equal(scheduled.size, 0)
console.log('PASS automatic checks: startup/periodic schedule, no duplicate timers, immediate disable, queued callback guard and re-enable')

const { prepareDataDirectory } = await loadTypeScript(new URL('../src/main/data-directory.ts', import.meta.url))
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pello-update-'))
const legacy = path.join(root, 'legacy'), data = path.join(root, 'install', 'data')
fs.mkdirSync(path.join(legacy, 'terminal-history'), { recursive: true })
for (const [name, value] of Object.entries({ 'workbench.json': '{"projects":[{"name":"旧项目"}]}', 'credentials.json': 'encrypted-password', 'Local State': 'chromium-key', 'terminal-history/term.ansi': 'FULL_HISTORY_中文' })) fs.writeFileSync(path.join(legacy, name), value)
prepareDataDirectory(data, legacy)
for (const file of ['workbench.json', 'credentials.json', 'Local State', 'terminal-history/term.ansi']) assert.deepEqual(fs.readFileSync(path.join(data, file)), fs.readFileSync(path.join(legacy, file)))
fs.writeFileSync(path.join(data, 'workbench.json'), 'new-state')
prepareDataDirectory(data, legacy)
assert.equal(fs.readFileSync(path.join(data, 'workbench.json'), 'utf8'), 'new-state')
assert.ok(fs.existsSync(path.join(legacy, 'credentials.json')))
const broken = path.join(root, 'blocked')
fs.writeFileSync(broken, 'file')
assert.throws(() => prepareDataDirectory(broken, legacy))
const copy = fs.cpSync, interrupted = path.join(root, 'interrupted', 'data')
try {
  fs.cpSync = (_source, destination) => { fs.mkdirSync(destination); fs.writeFileSync(path.join(destination, 'partial'), 'incomplete'); throw new Error('interrupted copy') }
  assert.throws(() => prepareDataDirectory(interrupted, legacy), /interrupted copy/)
} finally { fs.cpSync = copy }
assert.equal(fs.existsSync(interrupted), false)
assert.deepEqual(fs.readdirSync(path.dirname(interrupted)), [])
const linked = path.join(legacy, 'linked'), outside = path.join(root, 'outside')
fs.mkdirSync(outside)
fs.symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir')
assert.throws(() => prepareDataDirectory(path.join(root, 'linked-profile'), legacy))
fs.unlinkSync(linked)
assert.ok(fs.existsSync(outside))
console.log('PASS complete migration preserves credentials/history/Chromium state, retains originals and never overwrites the new profile')

const profile = path.join(root, 'ui')
fs.mkdirSync(profile)
fs.writeFileSync(path.join(profile, 'workbench.json'), JSON.stringify({ settings: { restore: false }, projects: [] }))
const env = { ...process.env, AWB_USER_DATA: profile }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: ['.', '--force-device-scale-factor=1'], env })
const payload = Buffer.from('LOCAL_INSTALLER_FIXTURE_DO_NOT_EXECUTE'), digest = createHash('sha512').update(payload).digest('base64')
let corrupt = false
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/latest.yml')) {
    res.end(`version: 99.0.0\nfiles:\n  - url: Pello-99.0.0-setup.exe\n    sha512: ${digest}\n    size: ${payload.length}\npath: Pello-99.0.0-setup.exe\nsha512: ${digest}\nreleaseDate: '2026-11-12T00:00:00.000Z'\n`)
  } else if (req.url.startsWith('/Pello-99.0.0-setup.exe')) { const bytes = corrupt ? Buffer.from('CORRUPTED_INSTALLER') : payload; res.writeHead(200, { 'Content-Length': bytes.length }); res.end(bytes) }
  else { res.writeHead(404); res.end() }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
try {
  const page = await app.firstWindow()
  await page.locator('[data-a=settings]').waitFor()
  const paths = await app.evaluate(({ app }) => Object.fromEntries(['userData', 'sessionData', 'temp', 'logs', 'crashDumps'].map((name) => [name, app.getPath(name)])))
  for (const directory of Object.values(paths)) assert.ok(directory === profile || directory.startsWith(profile + path.sep), directory)
  assert.equal(await page.locator('.app-update').count(), 0)
  assert.equal((await page.evaluate(() => window.awb.getState())).db.settings.autoCheckUpdates, true, 'old profiles default to automatic checks enabled')
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    globalThis.__updateCalls = []
    globalThis.__updateState = { phase: 'idle' }
    ipcMain.removeHandler('app:update-state')
    ipcMain.handle('app:update-state', () => globalThis.__updateState)
    for (const [channel, phase] of [['app:update-check', 'available'], ['app:update-download', 'downloaded'], ['app:update-install', 'installing']]) {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, () => {
        globalThis.__updateCalls.push(channel)
        const next = globalThis.__updateState = { phase, version: '99.0.0' }
        BrowserWindow.getAllWindows()[0].webContents.send('app:update', next)
        return next
      })
    }
  })
  await page.click('[data-a=settings]')
  const section = () => page.getByRole('region', { name: '应用更新', exact: true })
  const toggle = () => section().getByRole('switch', { name: '自动检查更新', exact: true })
  assert.equal(await toggle().getAttribute('aria-checked'), 'true')
  await toggle().click()
  await page.waitForFunction(() => document.querySelector('.app-update-settings [role=switch]')?.getAttribute('aria-checked') === 'false')
  assert.equal(JSON.parse(fs.readFileSync(path.join(profile, 'workbench.json'), 'utf8')).settings.autoCheckUpdates, false)
  // A failed settings write must retain the old switch value and show an inline error.
  fs.mkdirSync(path.join(profile, 'workbench.json.tmp'))
  try {
    await toggle().click()
    await section().getByRole('alert').waitFor()
    assert.equal(await toggle().getAttribute('aria-checked'), 'false')
    assert.equal(await page.locator('#toasts .toast').count(), 0, 'update errors stay inside the General section')
  } finally { fs.rmdirSync(path.join(profile, 'workbench.json.tmp')) }
  await section().getByRole('button', { name: '检查更新', exact: true }).click()
  await section().getByText('发现新版本 99.0.0', { exact: true }).waitFor()
  const publish = (state) => app.evaluate(({ BrowserWindow }, state) => {
    globalThis.__updateState = state
    BrowserWindow.getAllWindows()[0].webContents.send('app:update', state)
  }, state)
  for (const [state, text] of [
    [{ phase: 'current' }, '已是最新版本'],
    [{ phase: 'error', failed: 'check' }, '检查更新失败，请重试'],
    [{ phase: 'error', failed: 'download', version: '99.0.0' }, '更新下载失败，请重试'],
    [{ phase: 'downloading', version: '99.0.0', percent: 55 }, '正在下载更新 55%']
  ]) {
    await publish(state)
    await section().getByText(text, { exact: true }).waitFor()
    if (state.phase === 'downloading') assert.equal(await section().getByRole('button', { name: '检查更新', exact: true }).isDisabled(), true)
  }
  await publish({ phase: 'available', version: '99.0.0' })
  const shots = path.resolve('output/playwright/app-update')
  fs.mkdirSync(shots, { recursive: true })
  for (const theme of ['dark', 'light']) for (const [width, height] of [[1024, 680], [1440, 900]]) {
    await app.evaluate(({ BrowserWindow }, { width, height }) => BrowserWindow.getAllWindows()[0].setSize(width, height), { width, height })
    await page.click('[data-a=sec][data-id=look]')
    await page.click(`[data-a=theme][data-id=${theme}]`)
    await page.click('[data-a=sec][data-id=general]')
    assert.equal(await page.locator('html').getAttribute('data-theme'), theme)
    await section().scrollIntoViewIfNeeded()
    const box = await section().boundingBox(), button = await section().getByRole('button', { name: '下载新版本 99.0.0', exact: true }).boundingBox()
    assert.ok(box && button && button.x >= box.x && button.x + button.width <= box.x + box.width + 1)
    assert.equal(await page.locator('.app-update,.app-update-button').count(), 0, 'no floating update control')
    await page.screenshot({ path: path.join(shots, `${theme}-${width}.png`) })
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1024, 680))
  await page.locator('[data-set=language]').selectOption('en')
  await page.getByText('New version available: 99.0.0', { exact: true }).waitFor()
  const englishSection = page.getByRole('region', { name: 'App updates', exact: true })
  const englishBox = await englishSection.boundingBox(), englishButton = await englishSection.getByRole('button', { name: 'Download version 99.0.0', exact: true }).boundingBox()
  assert.ok(englishButton.x + englishButton.width <= englishBox.x + englishBox.width + 1)
  await page.screenshot({ path: path.join(shots, 'english-1024.png') })
  await page.locator('[data-set=language]').selectOption('zh-CN')
  await page.getByRole('button', { name: '下载新版本 99.0.0', exact: true }).focus()
  await page.keyboard.press('Enter')
  await page.getByRole('button', { name: '安装更新 99.0.0 并重启', exact: true }).waitFor()
  await page.click('[data-a=back]')
  assert.equal(await page.locator('[data-update-phase]').count(), 0, 'updates must only appear inside General')
  await page.click('[data-a=settings]')
  await page.locator('.settings').waitFor()
  await page.getByRole('button', { name: '安装更新 99.0.0 并重启', exact: true }).first().click()
  assert.deepEqual(await app.evaluate(() => globalThis.__updateCalls), ['app:update-check', 'app:update-download', 'app:update-install'])
  console.log('PASS default-on/persistent switch and failed-save rollback, manual check while disabled, version/status/download/install in one General section, two themes/two sizes, keyboard actions and no floating control')

  // Exercise the real Electron updater against a local feed. Never execute the fixture.
  const network = async (folder) => app.evaluate(async ({ app }, { url, folder }) => {
    const require = process.getBuiltinModule('module').createRequire(`${app.getAppPath()}/package.json`)
    const { NsisUpdater } = require('electron-updater')
    const fs = require('node:fs'), path = require('node:path')
    class LocalUpdater extends NsisUpdater {
      constructor() { super(); Object.defineProperty(this.app, 'baseCachePath', { get: () => folder }) }
    }
    const driver = new LocalUpdater()
    driver.autoDownload = false; driver.autoInstallOnAppQuit = false; driver.forceDevUpdateConfig = true
    driver.disableDifferentialDownload = true
    const config = path.join(folder, 'feed.yml')
    fs.mkdirSync(folder, { recursive: true })
    fs.writeFileSync(config, `provider: generic\nurl: ${url}\nupdaterCacheDirName: cache\n`)
    driver.updateConfigPath = config
    driver.on('error', () => {})
    const result = await driver.checkForUpdates()
    const before = fs.existsSync(path.join(folder, 'cache', 'pending', 'Pello-99.0.0-setup.exe'))
    try { const files = await driver.downloadUpdate(); return { available: result.isUpdateAvailable, before, files } }
    catch (error) { return { error: error.message } }
  }, { url: `http://127.0.0.1:${server.address().port}`, folder })
  const good = await network(path.join(profile, 'updates-good'))
  assert.equal(good.available, true); assert.equal(good.before, false)
  assert.ok(good.files.every((file) => file.startsWith(profile + path.sep)))
  assert.deepEqual(fs.readFileSync(good.files[0]), payload)
  corrupt = true
  const bad = await network(path.join(profile, 'updates-bad'))
  assert.match(bad.error, /sha512|checksum|size mismatch/i)
  console.log('PASS real updater: local version feed, explicit download, installation-local cache and SHA-512 rejection of corrupt downloads')
} finally {
  await app.close()
  await new Promise((resolve) => server.close(resolve))
}

const restarted = await electron.launch({ args: ['.', '--force-device-scale-factor=1'], env })
try {
  const page = await restarted.firstWindow()
  await page.click('[data-a=settings]')
  const toggle = page.getByRole('switch', { name: '自动检查更新', exact: true })
  assert.equal(await toggle.getAttribute('aria-checked'), 'false')
  assert.equal((await page.evaluate(() => window.awb.getState())).db.settings.autoCheckUpdates, false)
  await toggle.click()
  await page.waitForFunction(() => document.querySelector('.app-update-settings [role=switch]')?.getAttribute('aria-checked') === 'true')
  assert.equal(JSON.parse(fs.readFileSync(path.join(profile, 'workbench.json'), 'utf8')).settings.autoCheckUpdates, true)
  console.log('PASS disabled automatic checks survive restart and can be enabled again')
} finally { await restarted.close() }
