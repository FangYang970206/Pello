import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, generateKeyPairSync } from 'node:crypto'
import ssh2 from 'ssh2'
import { _electron as electron } from 'playwright'
import { installDocumentHarness } from './fixtures/document-harness.mjs'

const linux = process.argv.includes('--linux') || process.platform !== 'win32'
const wsl = (...args) => execFileSync(process.platform === 'win32' ? 'wsl.exe' : args[0], process.platform === 'win32' ? ['-d', 'Ubuntu', '--', ...args] : args.slice(1), { encoding: 'utf8', timeout: 30000 }).trim()
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-upload-replace-'))
const remoteRoot = linux ? wsl('mktemp', '-d', '/tmp/awb-upload-replace-XXXXXX') : path.join(data, "远端 项目's")
if (linux) assert.match(remoteRoot, /^\/tmp\/awb-upload-replace-[a-zA-Z0-9]+$/)
else fs.mkdirSync(remoteRoot)
const remoteWrite = (rel, text) => {
  if (linux) wsl('python3', '-c', 'import pathlib,sys; p=pathlib.Path(sys.argv[1])/sys.argv[2]; p.parent.mkdir(parents=True,exist_ok=True); p.write_text(sys.argv[3])', remoteRoot, rel, text)
  else { const file = path.join(remoteRoot, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text) }
}
const remoteText = (rel) => linux ? wsl('python3', '-c', 'import pathlib,sys; print((pathlib.Path(sys.argv[1])/sys.argv[2]).read_text(),end="")', remoteRoot, rel) : fs.readFileSync(path.join(remoteRoot, rel), 'utf8')
const remoteExists = (rel) => linux ? wsl('python3', '-c', 'import pathlib,sys; print((pathlib.Path(sys.argv[1])/sys.argv[2]).exists())', remoteRoot, rel) === 'True' : fs.existsSync(path.join(remoteRoot, rel))
const remoteHash = (rel) => linux ? wsl('python3', '-c', 'import pathlib,hashlib,sys; print(hashlib.sha256((pathlib.Path(sys.argv[1])/sys.argv[2]).read_bytes()).hexdigest())', remoteRoot, rel) : createHash('sha256').update(fs.readFileSync(path.join(remoteRoot, rel))).digest('hex')
const stages = () => linux ? wsl('find', remoteRoot, '-maxdepth', '1', '-name', '.awb-upload-*') : fs.readdirSync(remoteRoot).filter((name) => name.startsWith('.awb-upload-')).join('\n')
remoteWrite('same.txt', 'old file')
remoteWrite('same folder/note.txt', 'old note')
remoteWrite('same folder/old-only.txt', 'old-only')
const sources = path.join(data, 'sources'); fs.mkdirSync(sources)
const source = path.join(sources, 'same folder'); fs.mkdirSync(path.join(source, 'empty'), { recursive: true })
fs.writeFileSync(path.join(source, 'note.txt'), 'new note 中文')
const binary = Buffer.alloc(32 * 1024 * 1024, 179)
fs.writeFileSync(path.join(source, 'big.bin'), binary)
const digest = createHash('sha256').update(binary).digest('hex')
const clients = new Set(), children = new Set()
let pauseNext = false, paused = false, failCleanupNext = false, release = () => {}
const server = new ssh2.Server({ hostKeys: [generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' })] }, (client) => {
  clients.add(client); client.on('error', () => {}); client.on('close', () => clients.delete(client))
  client.on('authentication', (context) => context.method === 'password' && context.password === 'fixture' ? context.accept() : context.reject())
  client.on('ready', () => client.on('session', (accept) => accept().on('exec', (accept, _reject, info) => {
    const stream = accept()
    const encoded = /-EncodedCommand\s+['"]?([a-zA-Z0-9+/=]+)/i.exec(info.command)
    const decoded = encoded ? Buffer.from(encoded[1], 'base64').toString('utf16le') : info.command
    let command = info.command
    if (linux && failCleanupNext && command.includes('old_in_stage = True')) { failCleanupNext = false; command = command.replace('remove_entry(parent, stage); old_in_stage = False', 'raise OSError("fixture cleanup failure")') }
    const child = linux ? process.platform === 'win32' ? spawn('wsl.exe', ['-d', 'Ubuntu', '--', 'bash', '-c', `exec bash <(base64 -d<<<${Buffer.from(command).toString('base64')})`], { windowsHide: true }) : spawn('bash', ['-c', command]) : spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command], { windowsHide: true })
    children.add(child); child.stdin.on('error', () => {})
    child.stdout.on('data', (chunk) => { if (!stream.destroyed) stream.write(chunk) })
    child.stderr.on('data', (chunk) => { if (!stream.destroyed) stream.stderr.write(chunk) })
    const scriptChunks = [], scriptInput = !linux && decoded.includes('ScriptBlock')
    stream.on('data', (chunk) => {
      if (scriptInput) { scriptChunks.push(chunk); return }
      child.stdin.write(chunk)
      if (pauseNext && decoded.includes('传输未确认') && decoded.includes('big.bin')) { pauseNext = false; paused = true; stream.pause(); release = () => { paused = false; stream.resume() } }
    })
    stream.on('end', () => {
      if (!scriptInput) { child.stdin.end(); return }
      let body = Buffer.concat(scriptChunks).toString('utf8')
      if (failCleanupNext && body.includes('Remove-AwbStage $backup;')) { failCleanupNext = false; body = body.replace('Remove-AwbStage $backup;', "throw 'fixture cleanup failure';") }
      child.stdin.end(body)
    }); stream.on('close', () => child.stdin.end())
    client.once('close', () => child.stdin.end())
    child.on('close', (code) => { children.delete(child); if (!stream.destroyed) { stream.exit(code ?? 1); stream.end() } })
  })))
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const env = { ...process.env, AWB_USER_DATA: data }; delete env.ELECTRON_RUN_AS_NODE
fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify({ settings: { layout: 'balanced', restore: false, confirmKill: false }, projects: [] }))
const app = await electron.launch({ args: ['.'], env })
try {
  const page = await app.firstWindow(); page.setDefaultTimeout(15000)
  await page.evaluate(async ({ root, port, platform }) => {
    const state = await window.awb.getState()
    await window.awb.saveHosts([...state.db.hosts, { id: 'remote', name: 'Remote', addr: '127.0.0.1', port, user: 'tester', auth: 'password', password: 'fixture', on: true, os: platform, platform }])
    await window.awb.saveProjects([{ id: 'p', name: 'Upload', host: 'remote', path: root, agent: 'shell' }, { id: 'alias', name: 'Remote alias', host: 'remote', path: root, agent: 'shell' }])
  }, { root: remoteRoot, port: server.address().port, platform: linux ? 'linux' : 'windows' })
  await page.reload(); await installDocumentHarness(app, page, false)
  await page.evaluate(() => { window.__uploads = []; window.awb.onTransfer((snapshot) => window.__uploads.push(snapshot)) })
  const start = (paths) => page.evaluate((paths) => window.awb.transferDrop('p', '', paths), paths)
  const done = async (id, success = true) => {
    await page.waitForFunction((id) => window.__uploads.some((item) => item.id === id && ['completed', 'cancelled'].includes(item.state)), id, { timeout: 120000 })
    const events = await page.evaluate((id) => window.__uploads.filter((item) => item.id === id), id)
    assert.ok(events.every((item) => item.state !== 'conflicts'), 'Uploads must not request a naming-conflict decision')
    if (success) assert.ok(events.at(-1).items.length && events.at(-1).items.every((item) => item.status === 'done'), JSON.stringify(events.at(-1)))
    return events.at(-1)
  }
  const file = path.join(sources, 'same.txt'); fs.writeFileSync(file, 'new file')
  await done(await start([file])); assert.equal(remoteText('same.txt'), 'new file')
  assert.equal(fs.readFileSync(file, 'utf8'), 'new file')
  await done(await start([source]))
  assert.equal(remoteExists('same folder/old-only.txt'), false)
  assert.equal(remoteText('same folder/note.txt'), 'new note 中文')
  assert.equal(remoteHash('same folder/big.bin'), digest)
  assert.ok(remoteExists('same folder/empty'))
  assert.equal(stages(), '')
  console.log(`PASS ${linux ? 'Linux' : 'Windows'} uploads automatically replace same-name files and whole directories, preserving source bytes and empty folders`)

  // A dirty file in another project record pointing at the same physical directory is protected too.
  await page.getByRole('button', { name: '打开项目 Remote alias', exact: true }).click()
  await page.click('[data-a=rmode][data-id=files]')
  const folder = page.locator('[data-a=tog][data-id="same folder"]'); await folder.click(); await folder.press('ArrowRight')
  const row = page.locator('[data-a=preview][data-id="same folder/note.txt"]'); await row.dblclick()
  const editor = page.getByRole('textbox', { name: '文件内容', exact: true }); await editor.fill('unsaved alias draft')
  fs.writeFileSync(path.join(source, 'note.txt'), 'newer note')
  let id = await start([source])
  const confirm = page.getByRole('dialog', { name: '覆盖未保存的文件？', exact: true }); await confirm.waitFor()
  await confirm.getByRole('button', { name: '取消', exact: true }).click(); await done(id, false)
  assert.equal(await editor.inputValue(), 'unsaved alias draft'); assert.equal(remoteText('same folder/note.txt'), 'new note 中文')
  pauseNext = true; id = await start([source]); await confirm.waitFor()
  const version = (await page.evaluate(() => window.awb.gitRead('alias', 'same folder/note.txt'))).version
  await assert.rejects(page.evaluate((version) => window.awb.gitWrite('alias', 'same folder/note.txt', 'must not write', version), version))
  await confirm.getByRole('button', { name: '放弃草稿并覆盖', exact: true }).click()
  const end = Date.now() + 30000; while (!paused && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 30))
  assert.ok(paused, 'Expected a paused real binary upload')
  await page.waitForFunction((id) => { const item = window.__uploads.filter((item) => item.id === id).at(-1); return item?.overallBytes > 0 && item.overallBytes < item.overallTotal }, id)
  await page.getByRole('button', { name: '打开项目 Upload', exact: true }).click()
  const status = page.locator(`.upload-status[data-transfer-id="${id}"]`)
  await status.getByText('上传中', { exact: true }).waitFor()
  assert.equal(await status.innerText(), '上传中')
  assert.equal(await status.getByRole('progressbar').count(), 0)
  const visibleStatus = await status.evaluate((element) => {
    const box = element.getBoundingClientRect(), list = element.closest('.transfer-list').getBoundingClientRect()
    return box.top >= list.top && box.bottom <= list.bottom
  })
  assert.equal(visibleStatus, true, 'The compact upload status must stay visible')
  const shots = path.resolve('output/playwright/upload-replace'); fs.mkdirSync(shots, { recursive: true })
  await page.screenshot({ path: path.join(shots, `${linux ? 'linux' : 'windows'}-status.png`) })
  release(); await done(id)
  await status.getByText('上传成功', { exact: true }).waitFor()
  await status.waitFor({ state: 'detached', timeout: 3500 })
  await page.getByRole('button', { name: '打开项目 Remote alias', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('textarea[aria-label="文件内容"]')?.value === 'newer note')
  await editor.press('Control+z'); assert.equal(await editor.inputValue(), 'unsaved alias draft')
  await editor.press('Control+Shift+z')
  assert.equal(stages(), '')
  console.log('PASS directory replacement protects alias-project drafts, blocks descendant saves, preserves undo and clears compact success status')

  remoteWrite('same folder/external.txt', 'must survive cancelled replacement')
  pauseNext = true; paused = false; id = await start([source])
  const cancelEnd = Date.now() + 30000; while (!paused && Date.now() < cancelEnd) await new Promise((resolve) => setTimeout(resolve, 30))
  assert.ok(paused); await page.getByRole('button', { name: '打开项目 Upload', exact: true }).click()
  const cancellingStatus = page.locator(`.upload-status[data-transfer-id="${id}"]`)
  await cancellingStatus.getByRole('button', { name: '取消上传', exact: true }).click()
  const cancelled = await done(id, false); assert.equal(remoteText('same folder/external.txt'), 'must survive cancelled replacement')
  assert.equal(cancelled.state, 'cancelled')
  await cancellingStatus.waitFor({ state: 'detached' })
  assert.equal(stages(), '', JSON.stringify(cancelled))
  pauseNext = true; paused = false; id = await start([source])
  const raceEnd = Date.now() + 30000; while (!paused && Date.now() < raceEnd) await new Promise((resolve) => setTimeout(resolve, 30))
  assert.ok(paused); remoteWrite('same folder/external.txt', 'changed during upload'); release()
  const raced = await done(id, false); assert.ok(raced.items.some((item) => item.status === 'failed'), JSON.stringify(raced))
  assert.equal(remoteText('same folder/external.txt'), 'changed during upload'); assert.equal(stages(), '')
  const retry = await page.evaluate((id) => window.awb.transferRetry(id), id); await done(retry)
  assert.equal(remoteExists('same folder/external.txt'), false); assert.equal(remoteHash('same folder/big.bin'), digest)
  assert.equal(createHash('sha256').update(fs.readFileSync(path.join(source, 'big.bin'))).digest('hex'), digest)
  console.log('PASS cancelled and raced directory replacements preserve old contents, clean stages and retry the complete source tree')

  remoteWrite('file-over-dir/old.txt', 'old'); const collision = path.join(sources, 'file-over-dir'); fs.writeFileSync(collision, 'now file')
  await done(await start([collision])); assert.equal(remoteText('file-over-dir'), 'now file')
  remoteWrite('dir-over-file', 'old file'); const directory = path.join(sources, 'dir-over-file'); fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, 'child.txt'), 'now directory')
  await done(await start([directory])); assert.equal(remoteText('dir-over-file/child.txt'), 'now directory')
  assert.equal(stages(), '')
  console.log('PASS same-name file/directory type collisions replace completely without leftover staging objects')

  remoteWrite('bad-source/old.txt', 'safe old content')
  const badSource = path.join(sources, 'bad-source'); fs.mkdirSync(badSource)
  const outside = path.join(data, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'safe.txt'), 'outside content')
  fs.symlinkSync(outside, path.join(badSource, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
  const rejected = await done(await start([badSource]), false)
  assert.ok(rejected.items.some((item) => item.status === 'failed'))
  assert.equal(remoteText('bad-source/old.txt'), 'safe old content'); assert.equal(fs.readFileSync(path.join(outside, 'safe.txt'), 'utf8'), 'outside content')
  await assert.rejects(page.evaluate((source) => window.awb.transferDrop('p', '../', [source]), source))
  assert.equal(stages(), '')
  console.log('PASS linked source trees and project-boundary escapes cannot replace or delete existing targets')

  remoteWrite('cleanup-warning/old.txt', 'backup data')
  const warningSource = path.join(sources, 'cleanup-warning'); fs.mkdirSync(warningSource); fs.writeFileSync(path.join(warningSource, 'new.txt'), 'published data')
  failCleanupNext = true
  const warned = await done(await start([warningSource]))
  assert.equal(failCleanupNext, false, 'The fixture must exercise post-publication cleanup failure')
  assert.ok(warned.warnings?.some((message) => message.includes('旧对象清理失败')), JSON.stringify(warned))
  assert.equal(remoteText('cleanup-warning/new.txt'), 'published data')
  assert.equal(remoteExists('cleanup-warning/old.txt'), false)
  assert.ok(stages(), 'Retain the old object and tell the user its recovery location')
  console.log('PASS a failed backup cleanup reports its recovery location while committed contents and editor replacement remain successful')
} finally {
  release()
  await app.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 1 }).catch(() => {})
  await app.close().catch(() => {})
  for (const client of clients) client.destroy()
  for (const child of children) child.stdin.end()
  await new Promise((resolve) => server.close(resolve))
}
