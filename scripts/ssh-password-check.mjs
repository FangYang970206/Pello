import { installDocumentHarness, documentCommand } from './fixtures/document-harness.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateKeyPairSync } from 'node:crypto'
import { createServer as createTcpServer, createConnection } from 'node:net'
import { spawn } from 'node:child_process'
import ssh2 from 'ssh2'
import { _electron as electron } from 'playwright'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { Server } = ssh2
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-ssh-'))
const projectDir = path.join(data, "space 中文's")
fs.mkdirSync(projectDir)
fs.writeFileSync(path.join(projectDir, 'README.md'), 'remote fixture\n')
const password = 'test pa ss"$中!'
const isWin = process.platform === 'win32'
const platform = isWin ? 'windows' : 'linux'
const privateKey = () => generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' })
let authCount = 0
let remoteTerminals = 0
let windowChanges = 0
let delayUiWrite = false
let uiWriteStarted = false
const clients = new Set()
function createServer(hostKey) {
  return new Server({ hostKeys: [hostKey] }, (connection) => {
    clients.add(connection)
    connection.on('error', () => {})
    connection.once('close', () => clients.delete(connection))
    connection.on('authentication', (context) => {
      if (context.method === 'password' && context.username === 'tester' && context.password === password) {
        authCount++
        context.accept()
      } else context.reject(['password'])
    })
    connection.on('ready', () => connection.on('session', (accept) => {
      const session = accept()
      let tty = false
      let proc
      session.on('pty', (accept) => { tty = true; accept() })
      session.on('window-change', (accept, _reject, info) => {
        if (info.cols > 0 && info.rows > 0) windowChanges++
        accept?.()
      })
      session.on('signal', (accept) => { try { proc?.kill() } catch { /* process already exited */ }; accept?.() })
      session.on('exec', (accept, _reject, info) => {
        const stream = accept()
        const encoded = /-EncodedCommand\s+['"]?([A-Za-z0-9+/=]+)/i.exec(info.command)
        const decoded = encoded ? Buffer.from(encoded[1], 'base64').toString('utf16le') : info.command
        const delayed = delayUiWrite && decoded.includes('AWB_CONFLICT')
        if (delayed) uiWriteStarted = true
        const file = isWin ? (process.env.ComSpec || 'cmd.exe') : 'bash'
        const args = isWin ? ['/d', '/s', '/c', info.command] : ['-lc', info.command]
        if (tty) {
          proc = spawn(file, args, { cwd: projectDir, env: process.env, windowsHide: true })
          remoteTerminals++
          proc.stdout.on('data', (value) => { if (!stream.destroyed) stream.write(value) })
          proc.stderr.on('data', (value) => { if (!stream.destroyed) stream.stderr.write(value) })
          stream.on('data', (value) => proc.stdin.write(value.toString().replace(/\r/g, '\n')))
          proc.on('close', (exitCode) => { if (!stream.destroyed) { stream.exit(exitCode ?? 1); stream.end() } })
          stream.once('close', () => {
            remoteTerminals--
            try { proc.kill() } catch { /* process already exited */ }
          })
        } else {
          const child = spawn(file, args, { cwd: projectDir, windowsHide: true })
          child.stdout.on('data', (value) => stream.write(value))
          child.stderr.on('data', (value) => stream.stderr.write(value))
          stream.on('data', (value) => child.stdin.write(value))
          stream.on('end', () => { if (delayed) setTimeout(() => child.stdin.end(), 700); else child.stdin.end() })
          child.on('close', (code) => { if (!stream.destroyed) { stream.exit(code ?? 1); stream.end() } })
          stream.once('close', () => child.kill())
        }
      })
    }))
  })
}
let server = createServer(privateKey())
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const host = { id: 'remote', name: 'Password fixture', addr: '127.0.0.1', port, user: 'tester',
  auth: 'password', password, platform, os: isWin ? 'Windows' : 'Linux', on: true }
const env = { ...process.env, AWB_USER_DATA: data }
delete env.ELECTRON_RUN_AS_NODE
let app
const start = async () => {
  app = await electron.launch({ args: [root], cwd: root, env })
  const page = await app.firstWindow()
  await installDocumentHarness(app, page)
  await page.waitForSelector('[data-a=newproj]')
  return page
}
const close = async (page) => {
  const done = app.waitForEvent('close')
  await page.getByRole('button', { name: '关闭窗口', exact: true }).click()
  await done
}
try {
  let page = await start()
  const wrong = await page.evaluate((host) => window.awb.testHost({ ...host, password: 'wrong' }), host)
  assert.equal(wrong.ok, false)
  const tested = await page.evaluate((host) => window.awb.testHost(host), host)
  assert.equal(tested.ok, true, tested.error)
  assert.equal(tested.platform, platform)
  console.log('PASS password-only SSH authentication, including special characters and rejection of wrong password')

  const result = await page.evaluate(async (host) => {
    const state = await window.awb.getState()
    const saved = await window.awb.saveHosts([...state.db.hosts, host])
    const projects = [{ id: 'remote-project', name: 'Remote', host: host.id, path: host.projectDir, agent: 'shell', branch: '' }]
    await window.awb.saveProjects(projects)
    return saved
  }, { ...host, projectDir })
  assert.equal(result.hosts.find((item) => item.id === host.id).password, undefined)
  assert.equal(result.hosts.find((item) => item.id === host.id).hasPassword, true)
  for (const file of ['workbench.json', 'credentials.json']) assert.ok(!fs.readFileSync(path.join(data, file), 'utf8').includes('test pa ss'))
  assert.ok(fs.readFileSync(path.join(data, 'credentials.json'), 'utf8').length > 5)
  console.log('PASS password is encrypted at rest and omitted from renderer database responses')

  const checked = await page.evaluate(({ id, projectDir }) => window.awb.checkPath(id, projectDir), { id: host.id, projectDir })
  assert.equal(checked.kind, 'plain', JSON.stringify(checked))
  const listing = await page.evaluate(({ id, projectDir }) => window.awb.listDir(id, projectDir), { id: host.id, projectDir })
  assert.ok(!listing.error, listing.error)
  const tree = await page.evaluate(() => window.awb.gitTree('remote-project'))
  assert.ok(tree.some((node) => node.name === 'README.md'))
  const read = await page.evaluate(() => window.awb.gitRead('remote-project', 'README.md'))
  assert.equal(read.text, 'remote fixture\n')
  const editedText = '远程编辑\r\n' + 'large payload '.repeat(10000)
  const savedFile = await page.evaluate(({ version, text }) => window.awb.gitWrite('remote-project', 'README.md', text, version), { version: read.version, text: editedText })
  assert.equal(savedFile.text, editedText)
  assert.equal(fs.readFileSync(path.join(projectDir, 'README.md'), 'utf8'), editedText)
  const staleWrite = await page.evaluate(({ version }) => window.awb.gitWrite('remote-project', 'README.md', 'stale', version).then(() => false, () => true), { version: read.version })
  assert.equal(staleWrite, true)
  assert.equal(fs.readFileSync(path.join(projectDir, 'README.md'), 'utf8'), editedText)
  const deepDir = path.join(projectDir, 'a/b/c/d/e/f/g/h')
  fs.mkdirSync(deepDir, { recursive: true })
  fs.writeFileSync(path.join(deepDir, 'deep.txt'), 'deep')
  const nested = await page.evaluate(() => window.awb.gitTree('remote-project', 'a/b/c/d/e/f/g/h'))
  assert.ok(nested.some((node) => node.path === 'a/b/c/d/e/f/g/h/deep.txt' && !node.dir))
  fs.mkdirSync(path.join(projectDir, 'preview/assets'), { recursive: true })
  fs.writeFileSync(path.join(projectDir, 'preview/index.html'), '<!doctype html><link rel="stylesheet" href="assets/site.css"><h1>远程预览</h1>')
  fs.writeFileSync(path.join(projectDir, 'preview/assets/site.css'), 'h1{color:blue}')
  const remoteUrl = await page.evaluate(() => window.awb.previewUrl('remote-project', 'preview/index.html'))
  assert.ok((await (await fetch(remoteUrl)).text()).includes('远程预览'))
  assert.equal(await (await fetch(new URL('assets/site.css', remoteUrl))).text(), 'h1{color:blue}')
  console.log('PASS remote HTML preview and relative resources use password authentication')
  console.log('PASS remote file saving with large stdin payloads, stale-write protection and deep directory listing')
  const git = await page.evaluate(() => window.awb.gitStatus('remote-project'))
  assert.equal(git.isRepo, false)
  console.log('PASS password authentication for path checks, directory listing, file tree, file reads and Git status')

  const pendingSockets = new Set()
  let stall = false
  const stalled = createTcpServer((socket) => {
    pendingSockets.add(socket)
    socket.resume()
    socket.on('error', () => {})
    socket.once('close', () => pendingSockets.delete(socket))
    if (!stall) {
      const upstream = createConnection({ host: '127.0.0.1', port })
      upstream.on('error', () => socket.destroy())
      socket.pipe(upstream); upstream.pipe(socket)
      socket.once('close', () => upstream.destroy())
    }
  })
  await new Promise((resolve) => stalled.listen(0, '127.0.0.1', resolve))
  try {
    const originalState = await page.evaluate(() => window.awb.getState())
    await page.evaluate(async ({ host, port }) => {
      const state = await window.awb.getState()
      const target = { ...host, id: 'stalled-host', port }
      await window.awb.saveHosts([...state.db.hosts, target])
      await window.awb.saveProjects([...state.db.projects, { id: 'stalled-project', name: 'Stalled', host: target.id, path: '/', agent: 'shell', branch: '' }])
    }, { host, port: stalled.address().port })
    stall = true
    const cancelled = await page.evaluate(async () => {
      const pending = window.awb.ptyCreate({ id: 'stalled-term', projectId: 'stalled-project', kind: 'shell', shell: 'bash' }).then(() => 'created', () => 'cancelled')
      await new Promise((resolve) => setTimeout(resolve, 100))
      await window.awb.ptyClose('stalled-term')
      const result = await Promise.race([pending, new Promise((resolve) => setTimeout(() => resolve('timeout'), 3000))])
      return result
    })
    await page.evaluate(async (state) => { await window.awb.saveHosts(state.db.hosts); await window.awb.saveProjects(state.db.projects) }, originalState)
    assert.equal(cancelled, 'cancelled')
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(pendingSockets.size, 0)
    console.log('PASS closing during SSH handshake cancels the pending connection')
  } finally {
    for (const socket of pendingSockets) socket.destroy()
    await new Promise((resolve) => stalled.close(resolve))
  }

  await close(page)
  page = await start()
  const stored = await page.evaluate(() => window.awb.getState())
  const savedHost = stored.db.hosts.find((item) => item.id === host.id)
  assert.equal(savedHost.hasPassword, true)
  const again = await page.evaluate((host) => window.awb.testHost(host), savedHost)
  assert.equal(again.ok, true, again.error)
  console.log('PASS saved password works after application restart')

  await page.getByRole('button', { name: '显示文件面板', exact: true }).click()
  await page.click('[data-a=rmode][data-id=files]')
  await page.click('[data-a=preview][data-id="README.md"]')
  await documentCommand(app, page, 'mode')
  const remoteEditor = page.getByRole('textbox', { name: '文件内容', exact: true })
  delayUiWrite = true
  await remoteEditor.fill('remote first version')
  for (let i = 0; i < 100 && !uiWriteStarted; i++) await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(uiWriteStarted, true)
  await remoteEditor.fill('remote newest version')
  await page.waitForFunction(() => !document.querySelector('.tab.on .unsaved'))
  assert.equal(fs.readFileSync(path.join(projectDir, 'README.md'), 'utf8'), 'remote newest version')
  await remoteEditor.press('Control+z')
  await page.waitForFunction(() => !document.querySelector('.tab.on .unsaved'))
  assert.equal(fs.readFileSync(path.join(projectDir, 'README.md'), 'utf8'), 'remote first version')
  await page.locator('.tab.on [data-a=close]').click()
  console.log('PASS remote autosave serializes writes while typing and preserves undo history')

  await page.click('[data-a=settings]')
  await page.click('[data-a=sec][data-id=agents]')
  const presets = await page.locator('.group').first().locator('.srow b').allTextContents()
  assert.deepEqual(presets, ['Claude Code', 'Codex CLI', 'OpenCode', 'Pi', 'Oh My Pi'])
  console.log('PASS Claude Code, Codex, OpenCode, Pi and Oh My Pi presets are shown')
  await page.click('[data-a=sec][data-id=hosts]')
  await page.click('button[data-a=host][data-id=remote]')
  await page.getByLabel('认证方式').selectOption('password')
  assert.equal(await page.getByLabel('登录密码').getAttribute('type'), 'password')
  assert.equal(await page.getByLabel('登录密码').inputValue(), '')
  await page.keyboard.press('Escape')
  await page.click('[data-a=back]')
  console.log('PASS password authentication controls conceal saved passwords')
  await page.click('[data-a=quick]')
  await page.waitForFunction((isWin) => {
    const id = document.querySelector('.tab.on [data-a=tab]')?.dataset.id
    return id && window.__awbBuffer?.(id).includes(isWin ? '>' : '$')
  }, isWin)
  const id = await page.locator('.tab.on [data-a=tab]').getAttribute('data-id')
  await page.evaluate((id) => window.awb.ptyWrite(id, 'echo AWB_REMOTE_PASSWORD_OK\r'), id)
  await page.waitForFunction((id) => window.__awbBuffer?.(id)?.includes('AWB_REMOTE_PASSWORD_OK'), id)
  assert.equal(remoteTerminals, 1)
  assert.ok(windowChanges > 0)
  await page.locator('.tab.on [data-a=close]').click()
  if (await page.locator('[data-a=confirm]').count()) await page.click('[data-a=confirm]')
  await page.waitForFunction(() => !document.querySelector('.tab'))
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(remoteTerminals, 0)
  console.log('PASS password terminal receives input, resizes, and closes its SSH session')

  for (const client of clients) client.end()
  await new Promise((resolve) => server.close(resolve))
  server = createServer(privateKey())
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  const changed = await page.evaluate((host) => window.awb.testHost(host), savedHost)
  assert.equal(changed.ok, false)
  console.log('PASS changed SSH host keys are rejected')
  assert.ok(authCount >= 8)
  await close(page)
} finally {
  await app?.close().catch(() => {})
  for (const client of clients) client.end()
  server.close()
}
console.log('SSH password checks passed')
