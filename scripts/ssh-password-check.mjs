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
let beforeBinaryUpload
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
        if (beforeBinaryUpload && decoded.includes('传输未确认')) { const action = beforeBinaryUpload; beforeBinaryUpload = undefined; action() }
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
  const remoteDelete = path.join(projectDir, "待删 中文's.txt")
  fs.writeFileSync(remoteDelete, 'remote original\n')
  const refreshedTree = await page.evaluate(() => window.awb.gitTree('remote-project'))
  assert.ok(refreshedTree.some((item) => item.name === "待删 中文's.txt"), JSON.stringify(refreshedTree))
  const remoteDeleteRow = page.locator('[data-a=preview]').filter({ hasText: "待删 中文's.txt" })
  await remoteDeleteRow.waitFor({ timeout: 10000 })
  await app.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 1 })
  await page.evaluate(() => { window.__autosaveDelay = 60000 })
  await remoteDeleteRow.click()
  await page.getByRole('textbox', { name: '文件内容', exact: true }).fill('remote unsaved')
  await app.evaluate(() => { globalThis.__documentMenuCommand = 'trash' })
  await remoteDeleteRow.dispatchEvent('contextmenu')
  await page.getByRole('dialog', { name: '删除远程对象？' }).getByText(/无法通过工作台恢复/).waitFor()
  await page.getByRole('dialog', { name: '删除远程对象？' }).getByRole('button', { name: '继续' }).click()
  await page.getByRole('dialog', { name: '再次确认永久删除？' }).getByRole('button', { name: '取消' }).click()
  assert.equal(fs.readFileSync(remoteDelete, 'utf8'), 'remote original\n')
  await app.evaluate(() => { globalThis.__documentMenuCommand = 'trash' })
  await remoteDeleteRow.dispatchEvent('contextmenu')
  await page.getByRole('dialog', { name: '删除远程对象？' }).getByRole('button', { name: '继续' }).click()
  const confirmDelete = page.getByRole('dialog', { name: '再次确认永久删除？' })
  await confirmDelete.getByRole('button', { name: '永久删除' }).click()
  await confirmDelete.waitFor({ state: 'detached', timeout: 10000 })
  assert.equal(fs.existsSync(remoteDelete), false)
  await assert.rejects(page.evaluate(() => window.awb.treeTrash('remote-project', '', true)))
  await assert.rejects(page.evaluate(() => window.awb.treeTrash('remote-project', '../outside', false)))
  const external = path.join(data, 'remote-delete-outside')
  fs.mkdirSync(external); fs.writeFileSync(path.join(external, 'safe.txt'), 'safe')
  fs.symlinkSync(external, path.join(projectDir, 'remote-link'), isWin ? 'junction' : 'dir')
  await assert.rejects(page.evaluate(() => window.awb.treeTrash('remote-project', 'remote-link', true)))
  await assert.rejects(page.evaluate(() => window.awb.treeTrash('remote-project', 'remote-link/safe.txt', false)))
  assert.equal(fs.readFileSync(path.join(external, 'safe.txt'), 'utf8'), 'safe')
  fs.mkdirSync(path.join(projectDir, '远程 删除目录', 'sub'), { recursive: true })
  fs.writeFileSync(path.join(projectDir, '远程 删除目录', 'sub', 'file.txt'), 'fixture')
  await page.evaluate(() => window.awb.treeTrash('remote-project', '远程 删除目录', true))
  assert.equal(fs.existsSync(path.join(projectDir, '远程 删除目录')), false)
  if (isWin) {
    fs.writeFileSync(path.join(projectDir, '远程 Name.txt'), 'source')
    fs.writeFileSync(path.join(projectDir, '远程 collision.txt'), 'destination')
    await assert.rejects(page.evaluate(() => window.awb.treeRename('remote-project', '远程 Name.txt', '远程 collision.txt', false)))
    assert.equal(fs.readFileSync(path.join(projectDir, '远程 collision.txt'), 'utf8'), 'destination')
    assert.equal(await page.evaluate(() => window.awb.treeRename('remote-project', '远程 Name.txt', '远程 name.txt', false)), '远程 name.txt')
    assert.ok(fs.readdirSync(projectDir).includes('远程 name.txt'))
    await assert.rejects(page.evaluate(() => window.awb.treeRename('remote-project', 'remote-link/safe.txt', 'bad.txt', false)))
  }
  await page.evaluate(() => { window.__autosaveDelay = 800 })
  console.log('PASS remote permanent deletion requires two confirmations and protects the project root')
  const downloadSource = path.join(projectDir, "下载 数据's.bin")
  const downloadTarget = path.join(data, 'download-result.bin')
  const binaryData = Buffer.alloc(2_700_000)
  for (let index = 0; index < binaryData.length; index++) binaryData[index] = index % 251
  fs.writeFileSync(downloadSource, binaryData)
  await app.evaluate(({ dialog }, destination) => { globalThis.__originalSaveDialog = dialog.showSaveDialog; dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination }) }, downloadTarget)
  try {
    await page.evaluate(() => { window.__downloadStates = []; window.awb.onTransfer((state) => window.__downloadStates.push(state)) })
    const id = await page.evaluate(() => window.awb.transferDownload('remote-project', "下载 数据's.bin"))
    await page.waitForFunction((id) => window.__downloadStates.some((item) => item.id === id && item.state === 'completed'), id, { timeout: 30000 })
    const outcome = await page.evaluate((id) => window.__downloadStates.filter((item) => item.id === id).at(-1), id)
    assert.equal(outcome.items[0].status, 'done', JSON.stringify(outcome))
    assert.deepEqual(fs.readFileSync(downloadTarget), binaryData)
    const retryTarget = path.join(data, 'download-retry.bin')
    await app.evaluate(({ dialog }, destination) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination }) }, retryTarget)
    const missingId = await page.evaluate(() => window.awb.transferDownload('remote-project', 'retry-missing.bin'))
    await page.waitForFunction((id) => window.__downloadStates.some((item) => item.id === id && item.state === 'completed'), missingId, { timeout: 30000 })
    const failed = await page.evaluate((id) => window.__downloadStates.filter((item) => item.id === id).at(-1), missingId)
    assert.equal(failed.items[0].status, 'failed')
    assert.equal(fs.existsSync(retryTarget), false)
    fs.writeFileSync(path.join(projectDir, 'retry-missing.bin'), binaryData)
    const retryId = await page.evaluate((id) => window.awb.transferRetry(id), missingId)
    await page.waitForFunction((id) => window.__downloadStates.some((item) => item.id === id && item.state === 'completed'), retryId, { timeout: 30000 })
    const retry = await page.evaluate((id) => window.__downloadStates.filter((item) => item.id === id).at(-1), retryId)
    assert.equal(retry.items[0].status, 'done', JSON.stringify(retry))
    assert.deepEqual(fs.readFileSync(retryTarget), binaryData)
    await assert.rejects(page.evaluate((id) => window.awb.transferRetry(id), retryId))
    console.log('PASS remote failed binary download retries only the failed target and preserves bytes')
    console.log('PASS remote binary download preserves data above the editor size limit')
  } finally { await app.evaluate(({ dialog }) => { dialog.showSaveDialog = globalThis.__originalSaveDialog }) }
  const uploadSource = path.join(data, "上传 data's.bin")
  fs.writeFileSync(uploadSource, binaryData)
  const uploadId = await page.evaluate((source) => window.awb.transferDrop('remote-project', '', [source]), uploadSource)
  await page.waitForFunction((id) => window.__downloadStates.some((item) => item.id === id && item.state === 'completed'), uploadId, { timeout: 30000 })
  const uploadOutcome = await page.evaluate((id) => window.__downloadStates.filter((item) => item.id === id).at(-1), uploadId)
  assert.ok(uploadOutcome.items.every((item) => item.status === 'done'), JSON.stringify(uploadOutcome))
  assert.deepEqual(fs.readFileSync(path.join(projectDir, "上传 data's.bin")), binaryData)
  assert.deepEqual(fs.readFileSync(uploadSource), binaryData)
  const conflictId = await page.evaluate((source) => window.awb.transferDrop('remote-project', '', [source]), uploadSource)
  await page.waitForFunction((id) => window.__downloadStates.some((item) => item.id === id && item.state === 'completed'), conflictId, { timeout: 30000 })
  const uploadConflict = await page.evaluate((id) => window.__downloadStates.filter((item) => item.id === id).at(-1), conflictId)
  assert.ok(uploadConflict.items.every((item) => item.status === 'done'), JSON.stringify(uploadConflict))
  assert.equal(await page.evaluate((id) => window.__downloadStates.some((item) => item.id === id && item.state === 'conflicts'), conflictId), false)
  assert.deepEqual(fs.readFileSync(path.join(projectDir, "上传 data's.bin")), binaryData)
  for (const race of [true, false]) {
    if (race) beforeBinaryUpload = () => fs.writeFileSync(path.join(projectDir, "上传 data's.bin"), 'external binary change')
    const overwriteId = await page.evaluate((source) => window.awb.transferDrop('remote-project', '', [source]), uploadSource)
    await page.waitForFunction((id) => window.__downloadStates.some((item) => item.id === id && item.state === 'completed'), overwriteId, { timeout: 30000 })
    const outcome = await page.evaluate((id) => window.__downloadStates.filter((item) => item.id === id).at(-1), overwriteId)
    if (race) {
      assert.ok(outcome.items.some((item) => item.status === 'failed'), JSON.stringify(outcome))
      assert.ok(outcome.items.some((item) => item.error?.includes('目标文件已更改')), JSON.stringify(outcome))
      assert.equal(fs.readFileSync(path.join(projectDir, "上传 data's.bin"), 'utf8'), 'external binary change')
    } else {
      assert.ok(outcome.items.every((item) => item.status === 'done'), JSON.stringify(outcome))
      assert.deepEqual(fs.readFileSync(path.join(projectDir, "上传 data's.bin")), binaryData)
    }
  }
  assert.deepEqual(fs.readFileSync(uploadSource), binaryData)
  console.log('PASS Windows SSH binary overwrite validates target versions and preserves racing external changes')
  await app.evaluate(({ dialog }, source) => { globalThis.__conflictOpenDialog = dialog.showOpenDialog; dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] }); globalThis.__documentMenuCommand = 'import-files' }, uploadSource)
  try {
    await page.click('[data-a=rmode][data-id=files]')
    await page.getByRole('group', { name: '文件树', exact: true }).dispatchEvent('contextmenu')
    const task = page.locator('.transfer-task').last()
    await task.getByText('上传结束', { exact: true }).waitFor({ timeout: 30000 })
    assert.equal(await task.getByRole('button', { name: '冲突项保留两者', exact: true }).count(), 0)
    assert.equal(await task.getByRole('progressbar', { name: '上传总进度', exact: true }).getAttribute('value'), String(binaryData.length))
    assert.deepEqual(fs.readFileSync(path.join(projectDir, "上传 data's.bin")), binaryData)
    console.log('PASS remote upload menu automatically overwrites and shows completed aggregate progress')
  } finally { await app.evaluate(({ dialog }) => { dialog.showOpenDialog = globalThis.__conflictOpenDialog }) }
  const uploadFolder = path.join(data, '上传 目录')
  fs.mkdirSync(path.join(uploadFolder, 'deep', 'empty'), { recursive: true })
  fs.writeFileSync(path.join(uploadFolder, 'deep', 'data.bin'), binaryData)
  const folderId = await page.evaluate((source) => window.awb.transferDrop('remote-project', '', [source]), uploadFolder)
  await page.waitForFunction((id) => window.__downloadStates.some((item) => item.id === id && item.state === 'completed'), folderId, { timeout: 30000 })
  const folderOutcome = await page.evaluate((id) => window.__downloadStates.filter((item) => item.id === id).at(-1), folderId)
  assert.ok(folderOutcome.items.every((item) => item.status === 'done'), JSON.stringify(folderOutcome))
  assert.deepEqual(fs.readFileSync(path.join(projectDir, '上传 目录', 'deep', 'data.bin')), binaryData)
  assert.ok(fs.statSync(path.join(projectDir, '上传 目录', 'deep', 'empty')).isDirectory())
  fs.writeFileSync(path.join(uploadFolder, 'deep', 'data.bin'), 'replacement content')
  fs.writeFileSync(path.join(uploadFolder, 'deep', 'fresh.txt'), 'fresh child')
  fs.writeFileSync(path.join(projectDir, '上传 目录', 'old-only.txt'), 'remove with whole-directory replacement')
  const mergeUploadId = await page.evaluate((source) => window.awb.transferDrop('remote-project', '', [source]), uploadFolder)
  await page.waitForFunction((id) => window.__downloadStates.some((item) => item.id === id && item.state === 'completed'), mergeUploadId, { timeout: 60000 })
  const directoryReplacement = await page.evaluate((id) => window.__downloadStates.filter((item) => item.id === id).at(-1), mergeUploadId)
  assert.ok(directoryReplacement.items.every((item) => item.status === 'done'), JSON.stringify(directoryReplacement))
  assert.equal(await page.evaluate((id) => window.__downloadStates.some((item) => item.id === id && item.state === 'conflicts'), mergeUploadId), false)
  assert.equal(fs.readFileSync(path.join(projectDir, '上传 目录', 'deep', 'data.bin'), 'utf8'), 'replacement content')
  assert.equal(fs.existsSync(path.join(projectDir, '上传 目录', 'old-only.txt')), false)
  assert.equal(fs.readFileSync(path.join(projectDir, '上传 目录', 'deep', 'fresh.txt'), 'utf8'), 'fresh child')
  console.log('PASS remote Windows uploads replace entire same-name directories after staging, including removal of old-only files')
  const downloadDirectory = path.join(projectDir, '远程 下载目录')
  fs.mkdirSync(path.join(downloadDirectory, '深层 目录', '空目录'), { recursive: true })
  fs.writeFileSync(path.join(downloadDirectory, '深层 目录', 'data.bin'), binaryData)
  const downloadParent = path.join(data, 'download-folder')
  fs.mkdirSync(downloadParent)
  await app.evaluate(({ dialog }, destination) => { globalThis.__originalOpenDialog = dialog.showOpenDialog; dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [destination] }) }, downloadParent)
  try {
    const id = await page.evaluate(() => window.awb.transferDownload('remote-project', '远程 下载目录', true))
    await page.waitForFunction((id) => window.__downloadStates.some((item) => item.id === id && item.state === 'completed'), id, { timeout: 30000 })
    const outcome = await page.evaluate((id) => window.__downloadStates.filter((item) => item.id === id).at(-1), id)
    assert.ok(outcome.items.every((item) => item.status === 'done'), JSON.stringify(outcome))
    assert.deepEqual(fs.readFileSync(path.join(downloadParent, '远程 下载目录', '深层 目录', 'data.bin')), binaryData)
    assert.equal(fs.statSync(path.join(downloadParent, '远程 下载目录', '深层 目录', '空目录')).isDirectory(), true)
    console.log('PASS remote recursive download preserves binary files and empty directories')
  } finally { await app.evaluate(({ dialog }) => { dialog.showOpenDialog = globalThis.__originalOpenDialog }) }
  await page.click('[data-a=preview][data-id="README.md"]')
  await documentCommand(app, page, 'mode')
  const remoteEditor = page.getByRole('textbox', { name: '文件内容', exact: true })
  const overwriteFolder = path.join(data, 'remote-overwrite-source')
  fs.mkdirSync(overwriteFolder)
  const overwriteSource = path.join(overwriteFolder, 'README.md')
  fs.writeFileSync(overwriteSource, 'remote replacement text')
  const originalBeforeOverwrite = fs.readFileSync(path.join(projectDir, 'README.md'), 'utf8')
  await page.evaluate(() => { window.__autosaveDelay = 5000 })
  await remoteEditor.fill('remote draft must survive cancellation')
  for (const allow of [false, true]) {
    await page.evaluate((source) => window.awb.transferDrop('remote-project', '', [source]), overwriteSource)
    const task = page.locator('.transfer-task').last()
    const confirm = page.getByRole('dialog', { name: '覆盖未保存的文件？', exact: true })
    await confirm.waitFor()
    const version = (await page.evaluate(() => window.awb.gitRead('remote-project', 'README.md'))).version
    await assert.rejects(page.evaluate((version) => window.awb.gitWrite('remote-project', 'README.md', 'blocked during replacement', version), version))
    await confirm.getByRole('button', { name: allow ? '放弃草稿并覆盖' : '取消', exact: true }).click()
    await task.getByText('上传结束', { exact: true }).waitFor({ timeout: 30000 })
    try {
      await page.waitForFunction((expected) => document.querySelector('textarea[aria-label="文件内容"]')?.value === expected, allow ? 'remote replacement text' : 'remote draft must survive cancellation', { timeout: 5000 })
    } catch (error) {
      console.error('Overwrite diagnostic', { allow, task: await task.innerText(), editor: await remoteEditor.inputValue(), disk: fs.readFileSync(path.join(projectDir, 'README.md'), 'utf8').slice(0, 120) })
      throw error
    }
    assert.equal(fs.readFileSync(path.join(projectDir, 'README.md'), 'utf8'), allow ? 'remote replacement text' : originalBeforeOverwrite)
  }
  await remoteEditor.press('Control+z')
  assert.equal(await remoteEditor.inputValue(), 'remote draft must survive cancellation')
  await remoteEditor.press('Control+Shift+z')
  assert.equal(await remoteEditor.inputValue(), 'remote replacement text')
  await page.evaluate(() => { window.__autosaveDelay = 800 })
  console.log('PASS Windows SSH overwrite confirms dirty drafts, rejects concurrent saves and retains undo history')
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
