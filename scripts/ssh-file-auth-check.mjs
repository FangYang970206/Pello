import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import ssh2 from 'ssh2'
import { _electron as electron } from 'playwright'

if (process.platform !== 'win32') throw new Error('This fixture requires Git for Windows OpenSSH')
const git = execFileSync('where.exe', ['git'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0]
const bin = path.resolve(path.dirname(git), '..', 'usr', 'bin')
for (const name of ['ssh', 'ssh-agent', 'ssh-add', 'ssh-keygen']) assert.ok(fs.existsSync(path.join(bin, `${name}.exe`)), `${name} requires Git for Windows`)
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-file-auth-'))
const home = path.join(data, 'home'), project = path.join(data, "remote 中文's")
fs.mkdirSync(path.join(home, '.ssh'), { recursive: true })
fs.mkdirSync(project)
fs.writeFileSync(path.join(project, 'original.txt'), 'authentication fixture')
const key = path.join(home, '.ssh', 'id_ed25519')
const env = { ...process.env, HOME: home, USERPROFILE: home, PATH: `${bin};${process.env.PATH}`, AWB_USER_DATA: path.join(data, 'profile') }
delete env.ELECTRON_RUN_AS_NODE
execFileSync(path.join(bin, 'ssh-keygen.exe'), ['-q', '-t', 'ed25519', '-N', '', '-f', key], { env, windowsHide: true })
fs.writeFileSync(path.join(home, '.ssh', 'config'), 'Host *\n  IdentityFile none\n  LogLevel ERROR\n')
const identity = ssh2.utils.parseKey(fs.readFileSync(key))
assert.ok(!(identity instanceof Error), String(identity))
const agent = execFileSync(path.join(bin, 'ssh-agent.exe'), ['-s'], { env, encoding: 'utf8', windowsHide: true })
env.SSH_AUTH_SOCK = /SSH_AUTH_SOCK=([^;]+)/.exec(agent)?.[1]
env.SSH_AGENT_PID = /SSH_AGENT_PID=(\d+)/.exec(agent)?.[1]
assert.ok(env.SSH_AUTH_SOCK && env.SSH_AGENT_PID)
const clients = new Set()
let signedAuthentications = 0
const hostKey = () => generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' })
function createServer() {
  return new ssh2.Server({ hostKeys: [hostKey()] }, (client) => {
    clients.add(client)
    client.on('error', () => {})
    client.once('close', () => clients.delete(client))
    client.on('authentication', (context) => {
      if (context.method === 'publickey' && context.username === 'tester' && context.key.data.equals(identity.getPublicSSH()) && (!context.signature || identity.verify(context.blob, context.signature, context.hashAlgo) === true)) {
        if (context.signature) signedAuthentications++
        context.accept()
      } else context.reject(['publickey'])
    })
    client.on('ready', () => client.on('session', (accept) => {
      const session = accept()
      session.on('exec', (accept, _reject, info) => {
        const stream = accept()
        const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', info.command], { windowsHide: true })
        child.stdout.on('data', (chunk) => { if (!stream.destroyed) stream.write(chunk) })
        child.stderr.on('data', (chunk) => { if (!stream.destroyed) stream.stderr.write(chunk) })
        child.stdin.on('error', () => {})
        stream.on('data', (chunk) => child.stdin.write(chunk))
        stream.on('end', () => child.stdin.end())
        stream.once('close', () => child.kill())
        child.once('close', (code) => { if (!stream.destroyed) { stream.exit(code ?? 1); stream.end() } })
      })
    }))
  })
}
let app, server = createServer()
try {
  execFileSync(path.join(bin, 'ssh-add.exe'), [key], { env, windowsHide: true, stdio: 'pipe' })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  app = await electron.launch({ args: ['.'], env })
  const page = await app.firstWindow()
  await app.evaluate(() => { delete process.env.SSH_AUTH_SOCK })
  await page.evaluate(() => { window.__authTransfers = []; window.awb.onTransfer((state) => window.__authTransfers.push(state)) })
  const binary = Buffer.alloc(2_800_000)
  for (let index = 0; index < binary.length; index++) binary[index] = index % 251
  const waitTask = async (id) => {
    await page.waitForFunction((id) => window.__authTransfers.some((state) => state.id === id && state.state === 'completed'), id, { timeout: 40000 })
    const outcome = await page.evaluate((id) => window.__authTransfers.filter((state) => state.id === id).at(-1), id)
    assert.ok(outcome.items.length && outcome.items.every((item) => item.status === 'done'), JSON.stringify(outcome))
  }
  for (const auth of ['key', 'agent']) {
    if (auth === 'agent') {
      fs.renameSync(key, `${key}.parked`); fs.renameSync(`${key}.pub`, `${key}.pub.parked`)
      await app.evaluate((_electron, socket) => { process.env.SSH_AUTH_SOCK = socket }, env.SSH_AUTH_SOCK)
    }
    await page.evaluate(async ({ project, port, auth }) => {
      const state = await window.awb.getState()
      await window.awb.saveHosts([...state.db.hosts, { id: `fixture-${auth}`, name: auth, platform: 'windows', os: 'Windows', on: true, addr: '127.0.0.1', port, user: 'tester', auth }])
      await window.awb.saveProjects([...state.db.projects, { id: `project-${auth}`, host: `fixture-${auth}`, path: project, name: auth, agent: 'shell' }])
    }, { project, port, auth })
    const projectId = `project-${auth}`
    const before = signedAuthentications
    assert.equal((await page.evaluate((id) => window.awb.gitRead(id, 'original.txt'), projectId)).text, 'authentication fixture')
    await page.evaluate((id) => window.awb.treeCreate(id, '', 'folder', true), projectId)
    await page.evaluate((id) => window.awb.treeCreate(id, 'folder', 'new 中文.txt', false), projectId)
    await page.evaluate((id) => window.awb.treeRename(id, 'folder/new 中文.txt', "renamed's.txt", false), projectId)
    await page.evaluate((id) => window.awb.treeMove(id, "folder/renamed's.txt", '', false), projectId)
    await page.evaluate((id) => window.awb.treeTrash(id, "renamed's.txt", false), projectId)
    await page.evaluate((id) => window.awb.treeTrash(id, 'folder', true), projectId)
    const source = path.join(data, `source-${auth} 中文.bin`)
    fs.writeFileSync(source, binary)
    const uploadId = await page.evaluate(({ projectId, source }) => window.awb.transferDrop(projectId, '', [source]), { projectId, source })
    await waitTask(uploadId)
    assert.deepEqual(fs.readFileSync(path.join(project, path.basename(source))), binary)
    const changed = Buffer.from(binary)
    changed[0] ^= 255
    fs.writeFileSync(source, changed)
    const overwriteId = await page.evaluate(({ projectId, source }) => window.awb.transferDrop(projectId, '', [source]), { projectId, source })
    await waitTask(overwriteId)
    assert.deepEqual(fs.readFileSync(path.join(project, path.basename(source))), changed)
    const folder = path.join(data, `folder-${auth} 中文`)
    fs.mkdirSync(path.join(folder, 'empty'), { recursive: true })
    fs.writeFileSync(path.join(folder, 'data.bin'), binary)
    await waitTask(await page.evaluate(({ projectId, folder }) => window.awb.transferDrop(projectId, '', [folder]), { projectId, folder }))
    const remoteFolder = path.join(project, path.basename(folder))
    fs.writeFileSync(path.join(remoteFolder, 'old-only.txt'), 'old directory content')
    fs.writeFileSync(path.join(folder, 'data.bin'), changed)
    await waitTask(await page.evaluate(({ projectId, folder }) => window.awb.transferDrop(projectId, '', [folder]), { projectId, folder }))
    assert.deepEqual(fs.readFileSync(path.join(remoteFolder, 'data.bin')), changed)
    assert.deepEqual(fs.readFileSync(path.join(folder, 'data.bin')), changed)
    assert.equal(fs.existsSync(path.join(remoteFolder, 'old-only.txt')), false)
    assert.ok(fs.statSync(path.join(remoteFolder, 'empty')).isDirectory())
    assert.equal(fs.readdirSync(project).some((name) => name.startsWith('.awb-upload-')), false)
    const destination = path.join(data, `download-${auth}.bin`)
    await app.evaluate(({ dialog }, destination) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination }) }, destination)
    const downloadId = await page.evaluate(({ projectId, rel }) => window.awb.transferDownload(projectId, rel), { projectId, rel: path.basename(source) })
    await waitTask(downloadId)
    assert.deepEqual(fs.readFileSync(destination), changed)
    assert.deepEqual(fs.readFileSync(source), changed)
    assert.ok(signedAuthentications > before, 'SSH server must verify a real public-key signature')
    console.log(`PASS real OpenSSH ${auth} authentication: create, rename, move, delete, automatic file/directory replacement and binary upload/download above 2 MB`)
  }
  assert.ok(fs.existsSync(path.join(home, '.ssh', 'known_hosts')), 'Host keys must be pinned in the isolated SSH profile')
  for (const client of clients) client.end()
  await new Promise((resolve) => server.close(resolve))
  server = createServer()
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  const beforeChangedKey = signedAuthentications
  await assert.rejects(page.evaluate(() => window.awb.gitTree('project-agent')))
  const deniedTarget = path.join(data, 'hostkey-denied.bin')
  await app.evaluate(({ dialog }, destination) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination }) }, deniedTarget)
  const deniedId = await page.evaluate(() => window.awb.transferDownload('project-agent', 'source-agent 中文.bin'))
  await page.waitForFunction((id) => window.__authTransfers.some((state) => state.id === id && state.state === 'completed'), deniedId, { timeout: 30000 })
  const denied = await page.evaluate((id) => window.__authTransfers.filter((state) => state.id === id).at(-1), deniedId)
  assert.equal(denied.items[0].status, 'failed')
  assert.match(denied.items[0].error, /host key|host identification/i)
  assert.equal(fs.existsSync(deniedTarget), false)
  assert.equal(signedAuthentications, beforeChangedKey)
  console.log('PASS external OpenSSH rejects changed host keys using isolated known_hosts; Agent mode works without a private-key file')
} finally {
  if (app) await app.close()
  for (const client of clients) client.end()
  if (server.address()) await new Promise((resolve) => server.close(resolve))
  execFileSync(path.join(bin, 'ssh-agent.exe'), ['-k'], { env, windowsHide: true, stdio: 'pipe' })
}
