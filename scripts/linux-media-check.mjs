import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import ssh2 from 'ssh2'
import { _electron as electron } from 'playwright'

const wsl = (...args) => execFileSync('wsl.exe', ['-d', 'Ubuntu', '--', ...args], { encoding: 'utf8', timeout: 30000 }).trim()
const remoteRoot = wsl('mktemp', '-d', '/tmp/pello-media-XXXXXX')
assert.match(remoteRoot, /^\/tmp\/pello-media-[A-Za-z0-9]+$/)
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pello-linux-media-'))
const clients = new Set()
const hostKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' })
const server = new ssh2.Server({ hostKeys: [hostKey] }, (client) => {
  clients.add(client); client.on('error', () => {}); client.on('close', () => clients.delete(client))
  client.on('authentication', (context) => context.method === 'password' && context.password === 'fixture' ? context.accept() : context.reject())
  client.on('ready', () => client.on('session', (accept) => accept().on('exec', (accept, _reject, info) => {
    const stream = accept(), encoded = Buffer.from(info.command).toString('base64')
    const child = spawn('wsl.exe', ['-d', 'Ubuntu', '--', 'bash', '-c', `exec bash <(base64 -d<<<${encoded})`], { windowsHide: true })
    child.stdout.on('data', (bytes) => { if (!stream.destroyed) stream.write(bytes) })
    child.stderr.on('data', (bytes) => { if (!stream.destroyed) stream.stderr.write(bytes) })
    stream.on('data', (bytes) => child.stdin.write(bytes)); stream.on('end', () => child.stdin.end())
    child.stdin.on('error', () => {})
    child.on('close', (code) => { if (!stream.destroyed) { stream.exit(code ?? 1); stream.end() } })
    stream.on('close', () => child.kill())
  })))
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
wsl('python3', '-c', `import pathlib,sys
p=pathlib.Path(sys.argv[1])
for name in ["目录 [draft]'s", 'line'+chr(10)+'break', 'slash'+chr(92)+'name']: (p/name).mkdir()
(p/'large.pdf').write_bytes(b'%PDF-1.4'+bytes([10])+b' '*9100000)
(p/'too-large.pdf').write_bytes(b' '*12000001)
(p/'outside.pdf').symlink_to('/etc/passwd')
(p/'image.svg').write_text('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"/>')`, remoteRoot)
const env = { ...process.env, AWB_USER_DATA: data }; delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: ['.'], env })
try {
  const page = await app.firstWindow()
  await page.evaluate(async ({ root, port }) => {
    const { db } = await window.awb.getState()
    await window.awb.saveHosts([...db.hosts, { id: 'linux', name: 'Linux fixture', addr: '127.0.0.1', port, user: 'fixture', auth: 'password', password: 'fixture', on: true, platform: 'linux', os: 'Linux' }])
    await window.awb.saveProjects([{ id: 'p', name: 'Media', host: 'linux', path: root, agent: 'shell' }])
  }, { root: remoteRoot, port: server.address().port })
  const listing = await page.evaluate((root) => window.awb.listDir('linux', root), remoteRoot)
  assert.equal(listing.error, undefined)
  for (const name of ["目录 [draft]'s", 'line' + String.fromCharCode(10) + 'break', 'slash' + String.fromCharCode(92) + 'name']) assert.ok(listing.dirs.some((dir) => dir.name === name), JSON.stringify({ expected: [...name].map(c=>c.charCodeAt(0)), actual: listing.dirs.map(d=>[...d.name].map(c=>c.charCodeAt(0))) }))
  const childPath = listing.dirs.find((dir) => dir.name.includes('draft')).path
  const child = await page.evaluate((input) => window.awb.listDir('linux', input), childPath)
  assert.equal(child.path, childPath); assert.equal(child.parent, remoteRoot); assert.deepEqual(child.dirs, [])
  const denied = await page.evaluate((root) => window.awb.listDir('linux', root + '/missing'), remoteRoot)
  assert.ok(denied.error)
  const media = await page.evaluate(() => window.awb.gitRead('p', 'large.pdf'))
  assert.equal(media.missing, false); assert.equal(media.binary, true); assert.equal(media.text, '')
  const url = await page.evaluate(() => window.awb.previewUrl('p', 'large.pdf'))
  const response = await fetch(url)
  assert.equal(response.headers.get('content-type'), 'application/pdf')
  const bytes = Buffer.from(await response.arrayBuffer())
  assert.equal(bytes.length, 9_100_009); assert.equal(bytes.subarray(0, 9).toString(), '%PDF-1.4\n')
  for (const file of ['too-large.pdf', 'outside.pdf', '../etc/passwd']) assert.equal(await page.evaluate((file) => window.awb.previewUrl('p', file).then(() => false, () => true), file), true)
  console.log('PASS real Linux SSH media/directory operations: Unicode/quotes/newline/backslash names, navigation/errors, >9 MB PDF, metadata, MIME/bytes, size and symlink boundaries')
} finally {
  await app.close(); for (const client of clients) client.destroy(); await new Promise((resolve) => server.close(resolve))
  wsl('rm', '-rf', '--', remoteRoot)
}
