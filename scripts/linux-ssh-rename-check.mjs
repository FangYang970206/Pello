import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, generateKeyPairSync } from 'node:crypto'
import ssh2 from 'ssh2'
import { _electron as electron } from 'playwright'

if (process.platform !== 'win32') throw new Error('This fixture requires the Ubuntu WSL distribution')
const wsl = (...args) => execFileSync('wsl.exe', ['-d', 'Ubuntu', '--', ...args], { encoding: 'utf8', timeout: 30000 }).trim()
const remoteRoot = wsl('mktemp', '-d', '/tmp/awb-ssh-rename-XXXXXX')
assert.match(remoteRoot, /^\/tmp\/awb-ssh-rename-[A-Za-z0-9]+$/)
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-linux-ssh-rename-'))
const hostKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' })
const clients = new Set()
let interruptDownload = ''
let interruptUpload = ''
let failDownload = ''
let failVersion = false
let uploadPaused
let releaseUpload = () => {}
const server = new ssh2.Server({ hostKeys: [hostKey] }, (client) => {
  clients.add(client)
  client.on('error', () => {})
  client.on('close', () => clients.delete(client))
  client.on('authentication', (context) => context.method === 'password' && context.password === 'fixture-password' ? context.accept() : context.reject())
  client.on('ready', () => client.on('session', (accept) => {
    const session = accept()
    session.on('exec', (accept, _reject, info) => {
      const stream = accept()
      if (failVersion && info.command.includes('def file_version') && !info.command.includes('传输未确认')) {
        failVersion = false; stream.stderr.write('version unavailable'); stream.exit(1); stream.end(); return
      }
      if (failDownload && info.command.includes(failDownload) && info.command.includes('sys.stdout.buffer.write')) {
        failDownload = ''; stream.stderr.write('fixture download failure'); stream.exit(1); stream.end(); return
      }
      const encoded = Buffer.from(info.command, 'utf8').toString('base64')
      const child = spawn('wsl.exe', ['-d', 'Ubuntu', '--', 'bash', '-c', `exec bash <(base64 -d<<<${encoded})`], { windowsHide: true })
      let inputStopped = false
      child.stdout.on('data', (chunk) => {
        if (interruptDownload && info.command.includes('sys.stdout.buffer.write')) {
          const mode = interruptDownload; interruptDownload = ''
          if (mode === 'break') { client.end(); return }
          stream.write(chunk); child.stdout.pause(); return
        }
        stream.write(chunk)
      })
      child.stderr.on('data', (chunk) => stream.stderr.write(chunk))
      stream.on('data', (chunk) => {
        if (inputStopped) return
        child.stdin.write(chunk)
        if (interruptUpload && info.command.includes('传输未确认')) {
          const mode = interruptUpload; interruptUpload = ''; uploadPaused = true
          stream.pause()
          releaseUpload = () => { inputStopped = true; child.stdin.end(); if (mode === 'break') client.end(); stream.resume() }
        }
      })
      stream.on('end', () => child.stdin.end())
      child.on('close', (code) => { if (!stream.destroyed) { stream.exit(code ?? 1); stream.end() } })
      stream.on('close', () => child.kill())
    })
  }))
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const env = { ...process.env, AWB_USER_DATA: data }
delete env.ELECTRON_RUN_AS_NODE
let app
try {
  wsl('python3', '-c', "import pathlib,sys; p=pathlib.Path(sys.argv[1]); (p/'old 中文.txt').write_text('original'); (p/'existing.txt').write_text('preserve'); (p/'folder').mkdir(); (p/'folder'/'child').write_text('child')", remoteRoot)
  app = await electron.launch({ args: ['.'], env })
  const page = await app.firstWindow()
  await page.evaluate(async ({ port, remoteRoot }) => {
    const state = await window.awb.getState()
    const host = { id: 'linux-fixture', name: 'Linux fixture', addr: '127.0.0.1', port, user: 'tester', auth: 'password', password: 'fixture-password', on: true, os: 'Linux', platform: 'linux' }
    await window.awb.saveHosts([...state.db.hosts, host])
    await window.awb.saveProjects([{ id: 'linux-project', name: 'Linux', host: host.id, path: remoteRoot, agent: 'shell', branch: '' }])
  }, { port: server.address().port, remoteRoot })
  await assert.rejects(page.evaluate(() => window.awb.treeRename('linux-project', 'old 中文.txt', 'existing.txt', false)))
  assert.equal(await page.evaluate(() => window.awb.treeRename('linux-project', 'old 中文.txt', "new 中文's.txt", false)), "new 中文's.txt")
  assert.equal(await page.evaluate(() => window.awb.treeRename('linux-project', 'folder', 'renamed-folder', true)), 'renamed-folder')
  assert.equal((await page.evaluate(() => window.awb.gitRead('linux-project', "new 中文's.txt"))).text, 'original')
  assert.equal((await page.evaluate(() => window.awb.gitRead('linux-project', 'existing.txt'))).text, 'preserve')
  assert.equal((await page.evaluate(() => window.awb.gitRead('linux-project', 'renamed-folder/child'))).text, 'child')
  wsl('mkdir', '-p', `${remoteRoot}/destination`)
  assert.equal(await page.evaluate(() => window.awb.treeMove('linux-project', 'renamed-folder', 'destination', true)), 'destination/renamed-folder')
  assert.equal((await page.evaluate(() => window.awb.gitRead('linux-project', 'destination/renamed-folder/child'))).text, 'child')
  const batchRoot = path.join(data, 'batch-input')
  fs.mkdirSync(path.join(batchRoot, 'batch-folder', 'deep'), { recursive: true })
  for (const name of ['batch-a.txt', 'batch-b.txt', 'batch-folder/deep/a.txt', 'batch-folder/deep/b.txt']) fs.writeFileSync(path.join(batchRoot, name), `new ${name}`)
  wsl('python3', '-c', "import pathlib,sys; p=pathlib.Path(sys.argv[1]); (p/'batch-folder'/'deep').mkdir(parents=True); [(p/n).write_text('old '+n) for n in ['batch-a.txt','batch-b.txt','batch-folder/deep/a.txt','batch-folder/deep/b.txt']]", remoteRoot)
  await page.evaluate(() => { window.__batchStates = []; window.awb.onTransfer((state) => window.__batchStates.push(state)) })
  const batchId = await page.evaluate((sources) => window.awb.transferDrop('linux-project', '', sources), ['batch-a.txt', 'batch-b.txt', 'batch-folder'].map((name) => path.join(batchRoot, name)))
  await page.waitForFunction((id) => window.__batchStates.some((state) => state.id === id && state.state === 'conflicts'), batchId, { timeout: 30000 })
  await page.evaluate((id) => window.awb.transferDecide(id, 'overwrite', true), batchId)
  await page.waitForFunction((id) => window.__batchStates.some((state) => state.id === id && state.state === 'conflicts' && state.items.at(-1)?.mergeable), batchId, { timeout: 30000 })
  assert.equal(wsl('python3', '-c', "import pathlib,sys; print((pathlib.Path(sys.argv[1])/'batch-a.txt').read_text())", remoteRoot), 'old batch-a.txt')
  await page.evaluate((id) => window.awb.transferDecide(id, 'merge', true), batchId)
  await page.waitForFunction((id) => window.__batchStates.some((state) => state.id === id && state.state === 'completed'), batchId, { timeout: 30000 })
  const batchStates = await page.evaluate((id) => window.__batchStates.filter((state) => state.id === id), batchId)
  assert.equal(batchStates.filter((state) => state.state === 'conflicts').length, 2)
  assert.ok(batchStates.at(-1).items.every((item) => item.status === 'done'), JSON.stringify(batchStates.at(-1)))
  assert.equal(wsl('python3', '-c', "import pathlib,sys; p=pathlib.Path(sys.argv[1]); names=['batch-a.txt','batch-b.txt','batch-folder/deep/a.txt','batch-folder/deep/b.txt']; assert all((p/n).read_text()=='new '+n for n in names); print('OK')", remoteRoot), 'OK')
  const freshBatchId = await page.evaluate((source) => window.awb.transferDrop('linux-project', '', [source]), path.join(batchRoot, 'batch-a.txt'))
  await page.waitForFunction((id) => window.__batchStates.some((state) => state.id === id && state.state === 'conflicts'), freshBatchId, { timeout: 30000 })
  await assert.rejects(page.evaluate((id) => window.awb.transferDecide(id, 'merge', true), freshBatchId))
  await page.evaluate((id) => window.awb.transferDecide(id, 'keep'), freshBatchId)
  await page.waitForFunction((id) => window.__batchStates.some((state) => state.id === id && state.state === 'completed'), freshBatchId, { timeout: 30000 })
  assert.equal(wsl('python3', '-c', "import pathlib,sys; print((pathlib.Path(sys.argv[1])/'batch-a (1).txt').read_text())", remoteRoot), 'new batch-a.txt')
  console.log('PASS remote batch policies separate files and directories, include nested conflicts and expire between tasks')
  wsl('ln', '-s', `${remoteRoot}/destination`, `${remoteRoot}/create-link`)
  await assert.rejects(page.evaluate(() => window.awb.treeCreate('linux-project', 'create-link', 'must-not-create', false)))
  await assert.rejects(page.evaluate(() => window.awb.treeCreate('linux-project', 'create-link', 'must-not-create-dir', true)))
  assert.equal(wsl('python3', '-c', "import pathlib,sys; p=pathlib.Path(sys.argv[1])/'destination'; print((p/'must-not-create').exists() or (p/'must-not-create-dir').exists())", remoteRoot), 'False')
  await assert.rejects(page.evaluate(() => window.awb.treeMove('linux-project', 'destination', 'destination/renamed-folder', true)))
  wsl('python3', '-c', "import pathlib,sys; pathlib.Path(sys.argv[1], 'large 中文.bin').write_bytes(bytes(range(256))*14000)", remoteRoot)
  const download = path.join(data, 'download 中文.bin')
  await app.evaluate(({ dialog }, destination) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination }) }, download)
  await page.evaluate(() => { window.__downloadStates = []; window.awb.onTransfer((state) => window.__downloadStates.push(state)) })
  const downloadId = await page.evaluate(() => window.awb.transferDownload('linux-project', 'large 中文.bin'))
  await page.waitForFunction((id) => window.__downloadStates.some((item) => item.id === id && item.state === 'completed'), downloadId, { timeout: 30000 })
  const downloadResult = await page.evaluate((id) => window.__downloadStates.filter((item) => item.id === id).at(-1), downloadId)
  assert.equal(downloadResult.items[0].status, 'done', JSON.stringify(downloadResult))
  const expected = Buffer.alloc(256 * 14000)
  for (let i = 0; i < expected.length; i++) expected[i] = i % 256
  assert.deepEqual(fs.readFileSync(download), expected)
  const uploadSource = path.join(data, '上传 大文件.bin')
  fs.writeFileSync(uploadSource, expected)
  const uploadId = await page.evaluate((source) => window.awb.transferDrop('linux-project', '', [source]), uploadSource)
  await page.waitForFunction((id) => window.__downloadStates.some((item) => item.id === id && item.state === 'completed'), uploadId, { timeout: 30000 })
  const uploadResult = await page.evaluate((id) => window.__downloadStates.filter((item) => item.id === id).at(-1), uploadId)
  assert.ok(uploadResult.items.every((item) => item.status === 'done'), JSON.stringify(uploadResult))
  const remoteHash = wsl('python3', '-c', "import hashlib,pathlib,sys; print(hashlib.sha256(pathlib.Path(sys.argv[1], '上传 大文件.bin').read_bytes()).hexdigest())", remoteRoot)
  assert.equal(remoteHash, createHash('sha256').update(expected).digest('hex'))
  assert.deepEqual(fs.readFileSync(uploadSource), expected)
  const uploadConflictId = await page.evaluate((source) => window.awb.transferDrop('linux-project', '', [source]), uploadSource)
  await page.waitForFunction((id) => window.__downloadStates.some((item) => item.id === id && item.state === 'conflicts'), uploadConflictId, { timeout: 30000 })
  await page.evaluate((id) => window.awb.transferDecide(id, 'skip'), uploadConflictId)
  await page.waitForFunction((id) => window.__downloadStates.some((item) => item.id === id && item.state === 'completed'), uploadConflictId, { timeout: 30000 })
  const uploadConflict = await page.evaluate((id) => window.__downloadStates.filter((item) => item.id === id).at(-1), uploadConflictId)
  assert.ok(uploadConflict.items.some((item) => item.status === 'conflict'))
  const keptId = await page.evaluate((id) => window.awb.transferKeepBoth(id), uploadConflictId)
  await page.waitForFunction((id) => window.__downloadStates.some((item) => item.id === id && item.state === 'completed'), keptId, { timeout: 30000 })
  const kept = await page.evaluate((id) => window.__downloadStates.filter((item) => item.id === id).at(-1), keptId)
  assert.ok(kept.items.every((item) => item.status === 'done'), JSON.stringify(kept))
  assert.equal(wsl('python3', '-c', "import hashlib,pathlib,sys; print(hashlib.sha256(pathlib.Path(sys.argv[1], '上传 大文件 (1).bin').read_bytes()).hexdigest())", remoteRoot), remoteHash)
  const racedId = await page.evaluate((source) => window.awb.transferDrop('linux-project', '', [source]), uploadSource)
  await page.waitForFunction((id) => window.__downloadStates.some((item) => item.id === id && item.state === 'conflicts'), racedId, { timeout: 30000 })
  wsl('python3', '-c', "import pathlib,sys; pathlib.Path(sys.argv[1], '上传 大文件 (2).bin').write_text('created after preflight')", remoteRoot)
  await page.evaluate((id) => window.awb.transferDecide(id, 'keep'), racedId)
  await page.waitForFunction((id) => window.__downloadStates.some((item) => item.id === id && item.state === 'completed'), racedId, { timeout: 30000 })
  const raced = await page.evaluate((id) => window.__downloadStates.filter((item) => item.id === id).at(-1), racedId)
  assert.ok(raced.items.some((item) => item.status === 'failed'), JSON.stringify(raced))
  assert.equal(wsl('python3', '-c', "import pathlib,sys; print(pathlib.Path(sys.argv[1], '上传 大文件 (2).bin').read_text())", remoteRoot), 'created after preflight')
  failVersion = true
  const unavailableVersionId = await page.evaluate((source) => window.awb.transferDrop('linux-project', '', [source]), uploadSource)
  await page.waitForFunction((id) => window.__downloadStates.some((item) => item.id === id && item.state === 'conflicts'), unavailableVersionId, { timeout: 30000 })
  const unavailable = await page.evaluate((id) => window.__downloadStates.filter((item) => item.id === id).at(-1), unavailableVersionId)
  assert.equal(unavailable.items.at(-1).replaceable, false)
  await page.evaluate((id) => window.awb.transferDecide(id, 'keep'), unavailableVersionId)
  await page.waitForFunction((id) => window.__downloadStates.some((item) => item.id === id && item.state === 'completed'), unavailableVersionId, { timeout: 30000 })
  assert.equal(wsl('python3', '-c', "import hashlib,pathlib,sys; print(hashlib.sha256(pathlib.Path(sys.argv[1], '上传 大文件 (3).bin').read_bytes()).hexdigest())", remoteRoot), remoteHash)
  wsl('chmod', '640', `${remoteRoot}/上传 大文件.bin`)
  const changedOverwriteId = await page.evaluate((source) => window.awb.transferDrop('linux-project', '', [source]), uploadSource)
  await page.waitForFunction((id) => window.__downloadStates.some((item) => item.id === id && item.state === 'conflicts'), changedOverwriteId, { timeout: 30000 })
  wsl('python3', '-c', "import pathlib,sys; pathlib.Path(sys.argv[1], '上传 大文件.bin').write_text('external content must survive')", remoteRoot)
  await page.evaluate((id) => window.awb.transferDecide(id, 'overwrite'), changedOverwriteId)
  await page.waitForFunction((id) => window.__downloadStates.some((item) => item.id === id && item.state === 'completed'), changedOverwriteId, { timeout: 30000 })
  const rejectedOverwrite = await page.evaluate((id) => window.__downloadStates.filter((item) => item.id === id).at(-1), changedOverwriteId)
  assert.ok(rejectedOverwrite.items.some((item) => item.status === 'failed'), JSON.stringify(rejectedOverwrite))
  assert.equal(wsl('python3', '-c', "import pathlib,sys; print(pathlib.Path(sys.argv[1], '上传 大文件.bin').read_text())", remoteRoot), 'external content must survive')
  const overwriteId = await page.evaluate((source) => window.awb.transferDrop('linux-project', '', [source]), uploadSource)
  await page.waitForFunction((id) => window.__downloadStates.some((item) => item.id === id && item.state === 'conflicts'), overwriteId, { timeout: 30000 })
  await page.evaluate((id) => window.awb.transferDecide(id, 'overwrite'), overwriteId)
  await page.waitForFunction((id) => window.__downloadStates.some((item) => item.id === id && item.state === 'completed'), overwriteId, { timeout: 30000 })
  const overwritten = await page.evaluate((id) => window.__downloadStates.filter((item) => item.id === id).at(-1), overwriteId)
  assert.ok(overwritten.items.every((item) => item.status === 'done'), JSON.stringify(overwritten))
  assert.equal(wsl('python3', '-c', "import hashlib,pathlib,sys; print(hashlib.sha256(pathlib.Path(sys.argv[1], '上传 大文件.bin').read_bytes()).hexdigest())", remoteRoot), remoteHash)
  assert.deepEqual(fs.readFileSync(uploadSource), expected)
  assert.equal(wsl('python3', '-c', "import pathlib,sys; print(oct(pathlib.Path(sys.argv[1], '上传 大文件.bin').stat().st_mode & 0o777))", remoteRoot), '0o640')
  console.log('PASS Linux remote binary overwrite checks the preflight version and preserves externally changed targets')
  const cancelSource = path.join(data, 'preflight-new.txt')
  fs.writeFileSync(cancelSource, 'must not be uploaded')
  const cancelBatchId = await page.evaluate((sources) => window.awb.transferDrop('linux-project', '', sources), [cancelSource, uploadSource])
  await page.waitForFunction((id) => window.__downloadStates.some((item) => item.id === id && item.state === 'conflicts'), cancelBatchId, { timeout: 30000 })
  assert.equal(wsl('python3', '-c', "import pathlib,sys; print(pathlib.Path(sys.argv[1], 'preflight-new.txt').exists())", remoteRoot), 'False')
  await page.evaluate((id) => window.awb.transferCancel(id), cancelBatchId)
  await page.waitForFunction((id) => window.__downloadStates.some((item) => item.id === id && item.state === 'cancelled'), cancelBatchId, { timeout: 30000 })
  assert.equal(wsl('python3', '-c', "import pathlib,sys; print(pathlib.Path(sys.argv[1], 'preflight-new.txt').exists())", remoteRoot), 'False')
  assert.equal(wsl('python3', '-c', "import hashlib,pathlib,sys; print(hashlib.sha256(pathlib.Path(sys.argv[1], '上传 大文件.bin').read_bytes()).hexdigest())", remoteRoot), remoteHash)
  const laterSource = path.join(data, '恢复后上传.bin')
  const failedUploadId = await page.evaluate((source) => window.awb.transferDrop('linux-project', '', [source]), laterSource)
  await page.waitForFunction((id) => window.__downloadStates.some((item) => item.id === id && item.state === 'completed'), failedUploadId, { timeout: 30000 })
  const failedUpload = await page.evaluate((id) => window.__downloadStates.filter((item) => item.id === id).at(-1), failedUploadId)
  assert.ok(failedUpload.items.some((item) => item.status === 'failed'))
  fs.writeFileSync(laterSource, expected)
  const retryUploadId = await page.evaluate((id) => window.awb.transferRetry(id), failedUploadId)
  await page.waitForFunction((id) => window.__downloadStates.some((item) => item.id === id && item.state === 'completed'), retryUploadId, { timeout: 30000 })
  const retryUpload = await page.evaluate((id) => window.__downloadStates.filter((item) => item.id === id).at(-1), retryUploadId)
  assert.ok(retryUpload.items.every((item) => item.status === 'done'), JSON.stringify(retryUpload))
  assert.equal(wsl('python3', '-c', "import hashlib,pathlib,sys; print(hashlib.sha256(pathlib.Path(sys.argv[1], '恢复后上传.bin').read_bytes()).hexdigest())", remoteRoot), remoteHash)
  for (const replacement of [false, true]) {
    const cancelName = replacement ? '取消覆盖.bin' : '取消上传.bin'
    const cancelUploadSource = path.join(data, cancelName)
    if (replacement) wsl('python3', '-c', "import pathlib,sys; pathlib.Path(sys.argv[1], sys.argv[2]).write_text('original survives cancellation')", remoteRoot, cancelName)
    fs.writeFileSync(cancelUploadSource, Buffer.alloc(32_000_000, 7))
    interruptUpload = 'pause'; uploadPaused = false
    const cancelUploadId = await page.evaluate((source) => window.awb.transferDrop('linux-project', '', [source]), cancelUploadSource)
    if (replacement) {
      await page.waitForFunction((id) => window.__downloadStates.some((item) => item.id === id && item.state === 'conflicts'), cancelUploadId, { timeout: 30000 })
      await page.evaluate((id) => window.awb.transferDecide(id, 'overwrite'), cancelUploadId)
    }
    const pauseDeadline = Date.now() + 15000
    while (!uploadPaused && Date.now() < pauseDeadline) await new Promise((resolve) => setTimeout(resolve, 25))
    assert.equal(uploadPaused, true, 'Remote upload fixture must receive data before cancellation')
    let remoteTemporary = ''
    while (!remoteTemporary && Date.now() < pauseDeadline) {
      remoteTemporary = wsl('python3', '-c', "import os,sys; print('|'.join(n for n in os.listdir(sys.argv[1]) if n.startswith('.awb-upload-')))", remoteRoot)
      if (!remoteTemporary) await new Promise((resolve) => setTimeout(resolve, 25))
    }
    assert.notEqual(remoteTemporary, '', 'Remote temporary file must exist before cancellation')
    await page.evaluate((id) => window.awb.transferCancel(id), cancelUploadId)
    releaseUpload()
    await page.waitForFunction((id) => window.__downloadStates.some((item) => item.id === id && item.state === 'cancelled'), cancelUploadId, { timeout: 30000 })
    const cleanupDeadline = Date.now() + 10000
    let uploadArtifacts = ''
    do {
      uploadArtifacts = wsl('python3', '-c', "import os,sys; print('|'.join(n for n in os.listdir(sys.argv[1]) if n.startswith('.awb-upload-') or (sys.argv[2]=='new' and n == '取消上传.bin')))", remoteRoot, replacement ? 'overwrite' : 'new')
      if (uploadArtifacts) await new Promise((resolve) => setTimeout(resolve, 100))
    } while (uploadArtifacts && Date.now() < cleanupDeadline)
    assert.equal(uploadArtifacts, '', 'Cancelled uploads must remove temporary data and not publish a partial file')
    if (replacement) assert.equal(wsl('python3', '-c', "import pathlib,sys; print(pathlib.Path(sys.argv[1], sys.argv[2]).read_text())", remoteRoot, cancelName), 'original survives cancellation')
    assert.equal(fs.statSync(cancelUploadSource).size, 32_000_000)
  }
  const brokenUploadSource = path.join(data, '断线上传.bin')
  fs.writeFileSync(brokenUploadSource, Buffer.alloc(32_000_000, 8))
  interruptUpload = 'break'; uploadPaused = false
  const brokenUploadId = await page.evaluate((source) => window.awb.transferDrop('linux-project', '', [source]), brokenUploadSource)
  const brokenPauseDeadline = Date.now() + 15000
  while (!uploadPaused && Date.now() < brokenPauseDeadline) await new Promise((resolve) => setTimeout(resolve, 25))
  assert.equal(uploadPaused, true)
  let brokenTemporary = ''
  while (!brokenTemporary && Date.now() < brokenPauseDeadline) {
    brokenTemporary = wsl('python3', '-c', "import os,sys; print('|'.join(n for n in os.listdir(sys.argv[1]) if n.startswith('.awb-upload-')))", remoteRoot)
    if (!brokenTemporary) await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.notEqual(brokenTemporary, '')
  releaseUpload()
  await page.waitForFunction((id) => window.__downloadStates.some((item) => item.id === id && item.state === 'completed'), brokenUploadId, { timeout: 30000 })
  const brokenUpload = await page.evaluate((id) => window.__downloadStates.filter((item) => item.id === id).at(-1), brokenUploadId)
  assert.ok(brokenUpload.items.some((item) => item.status === 'failed'))
  const brokenCleanupDeadline = Date.now() + 10000
  let brokenArtifacts = ''
  do {
    brokenArtifacts = wsl('python3', '-c', "import os,sys; print('|'.join(n for n in os.listdir(sys.argv[1]) if n.startswith('.awb-upload-') or n == '断线上传.bin'))", remoteRoot)
    if (brokenArtifacts) await new Promise((resolve) => setTimeout(resolve, 100))
  } while (brokenArtifacts && Date.now() < brokenCleanupDeadline)
  assert.equal(brokenArtifacts, '')
  const uploadFolder = path.join(data, 'Linux 上传目录')
  fs.mkdirSync(path.join(uploadFolder, 'deep', 'empty'), { recursive: true })
  fs.writeFileSync(path.join(uploadFolder, 'deep', 'data.bin'), expected)
  const uploadFolderId = await page.evaluate((source) => window.awb.transferDrop('linux-project', '', [source]), uploadFolder)
  await page.waitForFunction((id) => window.__downloadStates.some((item) => item.id === id && item.state === 'completed'), uploadFolderId, { timeout: 30000 })
  const folderResult = await page.evaluate((id) => window.__downloadStates.filter((item) => item.id === id).at(-1), uploadFolderId)
  assert.ok(folderResult.items.every((item) => item.status === 'done'), JSON.stringify(folderResult))
  fs.writeFileSync(path.join(uploadFolder, 'deep', 'data.bin'), 'new binary version')
  fs.writeFileSync(path.join(uploadFolder, 'deep', 'fresh.txt'), 'new child')
  const mergeId = await page.evaluate((source) => window.awb.transferDrop('linux-project', '', [source]), uploadFolder)
  let previousConflict = '', decisions = 0
  for (;;) {
    await page.waitForFunction(({ id, previous }) => {
      const state = window.__downloadStates.filter((item) => item.id === id).at(-1)
      return state && (state.state === 'completed' || (state.state === 'conflicts' && state.items.at(-1)?.destination !== previous))
    }, { id: mergeId, previous: previousConflict }, { timeout: 30000 })
    const state = await page.evaluate((id) => window.__downloadStates.filter((item) => item.id === id).at(-1), mergeId)
    if (state.state === 'completed') { assert.ok(state.items.every((item) => item.status === 'done'), JSON.stringify(state)); break }
    const conflict = state.items.at(-1)
    previousConflict = conflict.destination
    assert.equal(wsl('python3', '-c', "import pathlib,sys; print((pathlib.Path(sys.argv[1])/'Linux 上传目录'/'deep'/'fresh.txt').exists())", remoteRoot), 'False')
    await page.evaluate(({ id, choice }) => window.awb.transferDecide(id, choice), { id: mergeId, choice: conflict.mergeable ? 'merge' : 'keep' })
    assert.ok(++decisions < 10)
  }
  assert.ok(decisions >= 3)
  assert.equal(wsl('python3', '-c', "import pathlib,sys; p=pathlib.Path(sys.argv[1])/'Linux 上传目录'/'deep'; assert (p/'data (1).bin').read_text()=='new binary version'; print((p/'fresh.txt').read_text())", remoteRoot), 'new child')
  console.log('PASS remote upload preflights all writes, cancels pending decisions and merges nested directories with explicit keep-both choices')
  assert.equal(wsl('python3', '-c', "import hashlib,pathlib,sys; p=pathlib.Path(sys.argv[1])/'Linux 上传目录'/'deep'; assert (p/'empty').is_dir(); print(hashlib.sha256((p/'data.bin').read_bytes()).hexdigest())", remoteRoot), remoteHash)
  console.log('PASS Linux SSH streaming upload preserves large binary sources and rejects same-name targets')
  fs.writeFileSync(download, 'do not overwrite')
  const conflictId = await page.evaluate(() => window.awb.transferDownload('linux-project', 'large 中文.bin'))
  await page.waitForFunction((id) => window.__downloadStates.some((item) => item.id === id && item.state === 'completed'), conflictId, { timeout: 30000 })
  const conflict = await page.evaluate((id) => window.__downloadStates.filter((item) => item.id === id).at(-1), conflictId)
  assert.equal(conflict.items[0].status, 'failed')
  assert.equal(fs.readFileSync(download, 'utf8'), 'do not overwrite')
  assert.equal(fs.readdirSync(data).some((name) => name.startsWith('.awb-download-')), false)
  const guardedDownload = path.join(data, 'guarded-download')
  fs.mkdirSync(guardedDownload)
  const brokenTarget = path.join(guardedDownload, 'interrupted.bin')
  await app.evaluate(({ dialog }, destination) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination }) }, brokenTarget)
  interruptDownload = 'break'
  const brokenId = await page.evaluate(() => window.awb.transferDownload('linux-project', 'large 中文.bin'))
  await page.waitForFunction((id) => window.__downloadStates.some((item) => item.id === id && item.state === 'completed'), brokenId, { timeout: 30000 })
  const broken = await page.evaluate((id) => window.__downloadStates.filter((item) => item.id === id).at(-1), brokenId)
  assert.equal(broken.items[0].status, 'failed')
  assert.equal(fs.existsSync(brokenTarget), false)
  const originalProjects = await page.evaluate(async () => (await window.awb.getState()).db.projects)
  await page.evaluate((projects) => window.awb.saveProjects(projects.map((project) => ({ ...project, path: `${project.path}-changed` }))), originalProjects)
  await assert.rejects(page.evaluate((id) => window.awb.transferRetry(id), brokenId))
  await page.evaluate((projects) => window.awb.saveProjects(projects), originalProjects)
  const parkedDownload = path.join(data, 'guarded-download-parked')
  const redirectedDownload = path.join(data, 'redirected-download')
  fs.mkdirSync(redirectedDownload)
  fs.renameSync(guardedDownload, parkedDownload)
  fs.symlinkSync(redirectedDownload, guardedDownload, 'junction')
  try {
    const redirectedId = await page.evaluate((id) => window.awb.transferRetry(id), brokenId)
    await page.waitForFunction((id) => window.__downloadStates.some((item) => item.id === id && item.state === 'completed'), redirectedId, { timeout: 30000 })
    const redirected = await page.evaluate((id) => window.__downloadStates.filter((item) => item.id === id).at(-1), redirectedId)
    assert.equal(redirected.items[0].status, 'failed')
    assert.match(redirected.items[0].error, /链接|更改/)
    assert.deepEqual(fs.readdirSync(redirectedDownload), [])
  } finally {
    fs.unlinkSync(guardedDownload)
    fs.renameSync(parkedDownload, guardedDownload)
  }
  const retryDownloadId = await page.evaluate((id) => window.awb.transferRetry(id), brokenId)
  await page.waitForFunction((id) => window.__downloadStates.some((item) => item.id === id && item.state === 'completed'), retryDownloadId, { timeout: 30000 })
  const retryDownload = await page.evaluate((id) => window.__downloadStates.filter((item) => item.id === id).at(-1), retryDownloadId)
  assert.ok(retryDownload.items.every((item) => item.status === 'done'), JSON.stringify(retryDownload))
  assert.deepEqual(fs.readFileSync(brokenTarget), expected)
  await assert.rejects(page.evaluate((id) => window.awb.transferRetry(id), retryDownloadId))
  console.log('PASS Linux SSH disconnected download retries the failed binary without reopening the picker')
  const cancelledTarget = path.join(data, 'cancelled.bin')
  await app.evaluate(({ dialog }, destination) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination }) }, cancelledTarget)
  interruptDownload = 'pause'
  const cancelledId = await page.evaluate(() => window.awb.transferDownload('linux-project', 'large 中文.bin'))
  await page.waitForFunction((id) => window.__downloadStates.some((item) => item.id === id && item.bytes > 0 && item.state === 'running'), cancelledId, { timeout: 30000 })
  await page.evaluate((id) => window.awb.transferCancel(id), cancelledId)
  await page.waitForFunction((id) => window.__downloadStates.some((item) => item.id === id && item.state === 'cancelled'), cancelledId, { timeout: 30000 })
  assert.equal(fs.existsSync(cancelledTarget), false)
  assert.equal(fs.readdirSync(data).some((name) => name.startsWith('.awb-download-')), false)
  wsl('ln', '-s', '/etc/passwd', `${remoteRoot}/linked.txt`)
  const linkTarget = path.join(data, 'linked.bin')
  await app.evaluate(({ dialog }, destination) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination }) }, linkTarget)
  const linkId = await page.evaluate(() => window.awb.transferDownload('linux-project', 'linked.txt'))
  await page.waitForFunction((id) => window.__downloadStates.some((item) => item.id === id && item.state === 'completed'), linkId, { timeout: 30000 })
  const linkResult = await page.evaluate((id) => window.__downloadStates.filter((item) => item.id === id).at(-1), linkId)
  assert.equal(linkResult.items[0].status, 'failed')
  assert.equal(fs.existsSync(linkTarget), false)
  await assert.rejects(page.evaluate(() => window.awb.transferDownload('linux-project', '../outside')))
  wsl('python3', '-c', "import pathlib,sys; p=pathlib.Path(sys.argv[1])/'dir 下载'; (p/'deep 空间'/'empty').mkdir(parents=True); (p/'.hidden').mkdir(); (p/'.hidden'/'config').write_text('hidden'); (p/'deep 空间'/'data.bin').write_bytes(bytes(range(256))*14000)", remoteRoot)
  const directoryParent = path.join(data, 'download-directory')
  fs.mkdirSync(directoryParent)
  await app.evaluate(({ dialog }, destination) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [destination] }) }, directoryParent)
  const directoryId = await page.evaluate(() => window.awb.transferDownload('linux-project', 'dir 下载', true))
  await page.waitForFunction((id) => window.__downloadStates.some((item) => item.id === id && item.state === 'completed'), directoryId, { timeout: 30000 })
  const directoryResult = await page.evaluate((id) => window.__downloadStates.filter((item) => item.id === id).at(-1), directoryId)
  assert.ok(directoryResult.items.every((item) => item.status === 'done'), JSON.stringify(directoryResult))
  assert.deepEqual(fs.readFileSync(path.join(directoryParent, 'dir 下载', 'deep 空间', 'data.bin')), expected)
  assert.equal(fs.readFileSync(path.join(directoryParent, 'dir 下载', '.hidden', 'config'), 'utf8'), 'hidden')
  assert.equal(fs.statSync(path.join(directoryParent, 'dir 下载', 'deep 空间', 'empty')).isDirectory(), true)
  wsl('python3', '-c', "import pathlib,sys; p=pathlib.Path(sys.argv[1])/'retry-tree'; p.mkdir(); (p/'good.bin').write_bytes(b'good'); (p/'fail.bin').write_bytes(b'recovered')", remoteRoot)
  failDownload = 'retry-tree/fail.bin'
  const partialId = await page.evaluate(() => window.awb.transferDownload('linux-project', 'retry-tree', true))
  await page.waitForFunction((id) => window.__downloadStates.some((item) => item.id === id && item.state === 'completed'), partialId, { timeout: 30000 })
  const partial = await page.evaluate((id) => window.__downloadStates.filter((item) => item.id === id).at(-1), partialId)
  assert.ok(partial.items.some((item) => item.status === 'failed'), JSON.stringify(partial))
  const goodFile = path.join(directoryParent, 'retry-tree', 'good.bin')
  const goodBefore = fs.statSync(goodFile)
  const partialRetryId = await page.evaluate((id) => window.awb.transferRetry(id), partialId)
  await page.waitForFunction((id) => window.__downloadStates.some((item) => item.id === id && item.state === 'completed'), partialRetryId, { timeout: 30000 })
  const partialRetry = await page.evaluate((id) => window.__downloadStates.filter((item) => item.id === id).at(-1), partialRetryId)
  assert.equal(partialRetry.items.length, 1, JSON.stringify(partialRetry))
  assert.equal(partialRetry.items[0].status, 'done')
  assert.equal(fs.readFileSync(path.join(directoryParent, 'retry-tree', 'fail.bin'), 'utf8'), 'recovered')
  assert.equal(fs.statSync(goodFile).mtimeMs, goodBefore.mtimeMs)
  assert.equal(fs.statSync(goodFile).ino, goodBefore.ino)
  console.log('PASS directory download retries only failed descendants and leaves successful files unchanged')
  const duplicateDirectoryId = await page.evaluate(() => window.awb.transferDownload('linux-project', 'dir 下载', true))
  await page.waitForFunction((id) => window.__downloadStates.some((item) => item.id === id && item.state === 'completed'), duplicateDirectoryId, { timeout: 30000 })
  const duplicateDirectory = await page.evaluate((id) => window.__downloadStates.filter((item) => item.id === id).at(-1), duplicateDirectoryId)
  assert.ok(duplicateDirectory.items.some((item) => item.status === 'failed'))
  assert.deepEqual(fs.readFileSync(path.join(directoryParent, 'dir 下载', 'deep 空间', 'data.bin')), expected)
  wsl('python3', '-c', "import pathlib,sys; p=pathlib.Path(sys.argv[1])/'link dir'; p.mkdir(); (p/'link').symlink_to('/etc/passwd')", remoteRoot)
  const linkedDirectoryId = await page.evaluate(() => window.awb.transferDownload('linux-project', 'link dir', true))
  await page.waitForFunction((id) => window.__downloadStates.some((item) => item.id === id && item.state === 'completed'), linkedDirectoryId, { timeout: 30000 })
  const linkedDirectory = await page.evaluate((id) => window.__downloadStates.filter((item) => item.id === id).at(-1), linkedDirectoryId)
  assert.ok(linkedDirectory.items.some((item) => item.status === 'failed'))
  assert.equal(fs.existsSync(path.join(directoryParent, 'link dir')), false)
  console.log('PASS Linux SSH recursive directory download preserves hierarchy and rejects conflicts and symlinks')
  console.log('PASS Linux SSH binary download over 2 MB preserves existing targets and removes temporary files')
  await assert.rejects(page.evaluate(() => window.awb.treeRename('linux-project', '', 'bad', true)))
  console.log('PASS Linux SSH rename: password authentication, Unicode files, directories, no overwrite and root protection')
} finally {
  if (app) await app.close()
  for (const client of clients) client.end()
  await new Promise((resolve) => server.close(resolve))
  wsl('python3', '-c', "import shutil,sys; shutil.rmtree(sys.argv[1])", remoteRoot)
}
