import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import ssh2 from 'ssh2'
import { _electron as electron } from 'playwright'
import { assertPerformanceBuild, budgets } from './fixtures/performance-metrics.mjs'

assertPerformanceBuild()

const baseline = process.argv.includes('--baseline'), linux = process.argv.includes('--linux')
const platform = linux ? 'linux' : 'windows'
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pello-remote-open-'))
const localProject = path.join(data, "project 中文's"); fs.mkdirSync(localProject)
const text = '\ufeff远程打开 BOM\r\n' + 'const value = 123;\r\n'.repeat(400)
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="green"/><!--' + 'x'.repeat(800000) + '--></svg>'
for (const name of ['one.txt', 'two.txt', 'three.txt']) fs.writeFileSync(path.join(localProject, name), text)
fs.writeFileSync(path.join(localProject, 'image.svg'), svg)
const wsl = (...args) => execFileSync('wsl.exe', ['-d', 'Ubuntu', '--', ...args], { encoding: 'utf8', timeout: 30000 }).trim()
const remoteProject = linux ? wsl('wslpath', '-u', localProject) : localProject
let authentications = 0, commands = 0, downloaded = 0
const readConnections = new Set()
const clients = new Set()
const hostKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' })
const server = new ssh2.Server({ hostKeys: [hostKey] }, (client) => {
  clients.add(client); client.on('error', () => {}); client.on('close', () => clients.delete(client))
  client.on('authentication', (context) => {
    if (context.method !== 'password' || context.password !== 'fixture') { context.reject(); return }
    // Fixed synthetic authentication latency, identical before/after. No private server.
    setTimeout(() => { authentications++; context.accept() }, 80)
  })
  client.on('ready', () => client.on('session', (accept) => accept().on('exec', (accept, _reject, info) => {
    const powershell = /-EncodedCommand\s+['"]?([A-Za-z0-9+/=]+)/i.exec(info.command)
    const decoded = powershell ? Buffer.from(powershell[1], 'base64').toString('utf16le') : info.command
    if (/PELLO1|ReadAllBytes|base64 -w 0|base64 "\$file"/.test(decoded)) { commands++; readConnections.add(client) }
    const stream = accept()
    const encoded = Buffer.from(info.command).toString('base64')
    const child = linux
      ? spawn('wsl.exe', ['-d', 'Ubuntu', '--', 'bash', '-c', `exec bash <(base64 -d<<<${encoded})`], { windowsHide: true })
      : spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', info.command], { windowsHide: true })
    child.stdout.on('data', (bytes) => { downloaded += bytes.length; if (!stream.destroyed) stream.write(bytes) })
    child.stderr.on('data', (bytes) => { if (!stream.destroyed) stream.stderr.write(bytes) })
    stream.on('data', (bytes) => child.stdin.write(bytes)); stream.on('end', () => child.stdin.end())
    child.stdin.on('error', () => {})
    child.on('close', (code) => { if (!stream.destroyed) { stream.exit(code ?? 1); stream.end() } })
    stream.on('close', () => child.kill())
  })))
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const env = { ...process.env, AWB_USER_DATA: data }; delete env.ELECTRON_RUN_AS_NODE
const executablePath = process.env.AWB_APP_EXE
const app = await electron.launch({ executablePath, args: executablePath ? [] : ['.'], env })
const metrics = { platform, baseline, authenticationDelayMs: 80, textSamples: [], mediaSamples: [] }
try {
  const page = await app.firstWindow(); page.setDefaultTimeout(20000)
  await page.evaluate(async ({ port, directory, platform }) => {
    const { db } = await window.awb.getState()
    await window.awb.saveHosts([...db.hosts, { id: 'fixture', name: 'Fixture', addr: '127.0.0.1', port, user: 'fixture', auth: 'password', password: 'fixture', on: true, platform, os: platform }])
    await window.awb.saveProjects([{ id: 'p', name: 'Remote opening', host: 'fixture', path: directory, agent: 'shell' }])
  }, { port: server.address().port, directory: remoteProject, platform })
  await page.reload()
  await page.locator('[data-a=proj][data-id=p]').click()
  await app.evaluate(() => {
    globalThis.__remoteOpenGap = { max: 0, last: performance.now() }
    globalThis.__remoteOpenTimer = setInterval(() => { const now = performance.now(); globalThis.__remoteOpenGap.max = Math.max(globalThis.__remoteOpenGap.max, now - globalThis.__remoteOpenGap.last); globalThis.__remoteOpenGap.last = now }, 5)
  })
  for (const name of ['one.txt', 'two.txt', 'three.txt']) {
    const started = performance.now(), auth = readConnections.size
    const file = await page.evaluate((name) => window.awb.gitRead('p', name), name)
    assert.equal(file.text, text); assert.equal(file.missing, false)
    metrics.textSamples.push({ ms: performance.now() - started, authentications: readConnections.size - auth })
  }
  const before = commands, concurrentBytes = downloaded
  const concurrent = await page.evaluate(() => Promise.all(Array.from({ length: 3 }, () => window.awb.gitRead('p', 'one.txt'))))
  assert.ok(concurrent.every((file) => file.text === text))
  metrics.concurrentCommands = commands - before
  metrics.concurrentBytes = downloaded - concurrentBytes
  for (let index = 0; index < 3; index++) {
    const started = performance.now(), bytes = downloaded
    const file = await page.evaluate(() => window.awb.gitRead('p', 'image.svg'))
    const url = await page.evaluate((token) => window.awb.previewUrl('p', 'image.svg', undefined, token), file.assetToken)
    assert.equal(await (await fetch(url)).text(), svg)
    metrics.mediaSamples.push({ ms: performance.now() - started, bytes: downloaded - bytes })
  }
  // Exercise the actual click-to-image path, not only API timings.
  await page.keyboard.press('Control+e')
  await page.click('[data-a=rmode][data-id=files]')
  await page.locator('[data-a=preview][data-id="image.svg"]').waitFor()
  const bytes = downloaded
  await page.locator('[data-a=preview][data-id="image.svg"]').focus()
  await page.evaluate(() => { window.__remoteOpenPaint = new Promise((resolve) => {
    let start
    document.addEventListener('keydown', (event) => { if (event.key === 'Enter') start = performance.now() }, { once: true, capture: true })
    const observer = new MutationObserver(() => {
      const img = document.querySelector('.media-preview img')
      if (!img) return
      const finish = () => { if (img.naturalWidth) { observer.disconnect(); requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - start))) } }
      if (img.complete) finish(); else img.addEventListener('load', finish, { once: true })
    })
    observer.observe(document.body, { childList: true, subtree: true })
  }) })
  await page.keyboard.press('Enter')
  const painted = await page.evaluate(() => window.__remoteOpenPaint)
  metrics.clickToImageMs = painted; metrics.clickBytes = downloaded - bytes
  metrics.mainMaxGapMs = await app.evaluate(() => { clearInterval(globalThis.__remoteOpenTimer); return globalThis.__remoteOpenGap.max })
  metrics.mountedRows = await page.locator('[data-a=preview], [data-a=tog]').count()
  metrics.totalAuthentications = authentications
  const output = path.resolve('output/performance'); fs.mkdirSync(output, { recursive: true })
  await page.screenshot({ path: path.join(output, `remote-open-${platform}-${baseline ? 'before' : 'after'}.png`) })
  const median = (samples, field) => samples.map((sample) => sample[field]).sort((a, b) => a - b)[1]
  metrics.textMedianMs = median(metrics.textSamples, 'ms'); metrics.mediaMedianMs = median(metrics.mediaSamples, 'ms')
  fs.writeFileSync(path.join(output, `remote-open-${platform}-${baseline ? 'before' : 'after'}.json`), JSON.stringify(metrics, null, 2))
  console.log(JSON.stringify(metrics))
  if (!baseline) {
    assert.ok(Number.isFinite(metrics.clickToImageMs) && metrics.clickToImageMs > 0, 'Actual input-to-paint timing is required')
    assert.ok(Number.isFinite(metrics.mainMaxGapMs) && metrics.mainMaxGapMs <= budgets.regression.limits.mainThreadGapMs, 'Remote reads must preserve the main-thread responsiveness budget')
    assert.equal(metrics.mountedRows, 4, 'All fixture file rows remain mounted and accessible')
    assert.ok([...metrics.textSamples, ...metrics.mediaSamples].every((sample) => Number.isFinite(sample.ms) && sample.ms > 0), 'All three complete samples must be measured')
    assert.ok(metrics.textSamples.slice(1).every((sample) => sample.authentications === 0), 'Repeated opens must reuse authenticated transport')
    assert.equal(metrics.concurrentCommands, 0, 'Concurrent reads must reuse the open reader')
    assert.ok(metrics.concurrentBytes < Buffer.byteLength(text) + 1024, 'Concurrent same-file reads must transfer a single copy')
    assert.ok(metrics.mediaSamples.every((sample) => sample.bytes < Buffer.byteLength(svg) + 1024), 'Media opening must transfer one binary copy')
    assert.ok(metrics.clickBytes < Buffer.byteLength(svg) + 1024, 'Actual image click must transfer one copy')
    const previous = await page.evaluate(() => window.awb.gitRead('p', 'one.txt'))
    fs.writeFileSync(path.join(localProject, 'one.txt'), 'external change\r\n')
    const fresh = await page.evaluate(() => window.awb.gitRead('p', 'one.txt'))
    assert.equal(fresh.text, 'external change\r\n'); assert.notEqual(fresh.version, previous.version)
    assert.equal(await page.evaluate((version) => window.awb.gitWrite('p', 'one.txt', 'stale edit', version).then(() => false, () => true), previous.version), true)
    const refreshed = await page.evaluate(() => window.awb.previewUrl('p', 'image.svg'))
    assert.equal(await (await fetch(refreshed)).text(), svg)
    fs.writeFileSync(path.join(localProject, 'image.svg'), svg.replace('fill="green"', 'fill="blue"'))
    const updatedUrl = await page.evaluate(() => window.awb.previewUrl('p', 'image.svg'))
    assert.ok((await (await fetch(updatedUrl)).text()).includes('fill="blue"'), 'Fresh preview requests must notice external edits')
    await page.evaluate(async () => {
      const { db } = await window.awb.getState()
      await window.awb.saveHosts(db.hosts.map((host) => host.id === 'fixture' ? { ...host, user: 'changed-user', password: 'fixture' } : host))
    })
    const reconfigured = await page.evaluate(() => window.awb.previewUrl('p', 'image.svg'))
    const reconfiguredResponse = await fetch(reconfigured)
    assert.equal(reconfiguredResponse.status, 200, 'Reconfiguring the same host ID must create a preview for the new target')
    assert.ok((await reconfiguredResponse.text()).includes('fill="blue"'))
    assert.equal((await fetch(updatedUrl)).status, 404, 'A preview bound to the old host configuration must stop working')
    console.log('PASS real remote external edits invalidate completed reads, stale saves reject conflicts and refreshed previews read current bytes')
  }
} finally {
  await app.close()
  for (const client of clients) client.destroy()
  await new Promise((resolve) => server.close(resolve))
}
