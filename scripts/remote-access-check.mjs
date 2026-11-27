import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import ssh2 from 'ssh2'
import { _electron as electron } from 'playwright'

const wsl = (...args) => execFileSync('wsl.exe', ['-d', 'Ubuntu', '-u', 'root', '--', ...args], { encoding: 'utf8', timeout: 30000 }).trim()
const root = wsl('mktemp', '-d', '/tmp/pello-native-ssh-XXXXXXXX')
assert.match(root, /^\/tmp\/pello-native-ssh-[A-Za-z0-9]+$/)
const user = execFileSync('wsl.exe', ['-d', 'Ubuntu', '--', 'id', '-un'], { encoding: 'utf8' }).trim()
assert.notEqual(user, 'root', 'Fixture requires a non-root default WSL user')
const port = Number(wsl('python3', '-c', 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])'))
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pello-native-ssh-'))
const clients = new Set(), children = new Set()
const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' })
const server = new ssh2.Server({ hostKeys: [key] }, (client) => {
  clients.add(client); client.on('error', () => {}); client.on('close', () => clients.delete(client))
  client.on('authentication', (context) => context.method === 'password' && context.password === 'fixture-only' ? context.accept() : context.reject())
  client.on('ready', () => client.on('session', (accept) => {
    const session = accept(); let tty = false
    session.on('pty', (accept) => { tty = true; accept() })
    session.on('window-change', (accept) => accept?.())
    session.on('exec', (accept, _reject, info) => {
      const stream = accept(), encoded = Buffer.from(info.command).toString('base64')
      const command = `exec bash <(base64 -d<<<${encoded})`
      const child = spawn('wsl.exe', ['-d', 'Ubuntu', '-u', 'root', '--', ...(tty ? ['script', '-qefc', `bash -c '${command}'`, '/dev/null'] : ['bash', '-c', command])], { windowsHide: true })
      children.add(child); child.stdin.on('error', () => {})
      child.stdout.pipe(stream, { end: false }); child.stderr.pipe(stream.stderr, { end: false }); stream.pipe(child.stdin)
      child.on('close', (code) => { children.delete(child); if (!stream.destroyed) { stream.exit(code ?? 1); stream.end() } })
      stream.on('close', () => child.kill())
    })
  }))
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
let app, daemon
try {
  wsl('python3', '-c', `import os,pathlib,subprocess,sys,pwd
p=pathlib.Path(sys.argv[1]); u=pwd.getpwnam(sys.argv[2]); os.chmod(p,0o755)
for name in ['A','B','C']:
 folder=p/name; folder.mkdir(); (folder/'shared.txt').write_text(name+' original\\n')
 subprocess.run(['git','init','-q',str(folder)],check=True)
 subprocess.run(['git','-C',str(folder),'add','.'],check=True)
 subprocess.run(['git','-C',str(folder),'-c','user.name=Fixture','-c','user.email=f@example.invalid','commit','-qm','initial'],check=True)
(p/'C'/'changed-in-C.txt').write_text('C change\\n')
(p/'C'/'codex').write_text('#!/bin/bash\\nprintf cwd-check-running\\nsleep 3\\n')
os.chmod(p/'C'/'codex',0o755)
for folder,dirs,files in os.walk(p/'B'):
 os.chown(folder,u.pw_uid,u.pw_gid)
 for name in files: os.chown(os.path.join(folder,name),u.pw_uid,u.pw_gid)
subprocess.run(['ssh-keygen','-q','-t','ed25519','-N','','-f',str(p/'client-key')],check=True)
subprocess.run(['ssh-keygen','-q','-t','ed25519','-N','','-f',str(p/'host-key')],check=True)
(p/'sshd_config').write_text('Port '+sys.argv[3]+'\\nListenAddress 127.0.0.1\\nHostKey '+str(p/'host-key')+'\\nPidFile '+str(p/'sshd.pid')+'\\nAuthorizedKeysFile '+str(p/'client-key.pub')+'\\nStrictModes no\\nPasswordAuthentication no\\nKbdInteractiveAuthentication no\\nUsePAM no\\nLogLevel VERBOSE\\nPrintMotd no\\nPrintLastLog no\\n')
`, root, user, String(port))
  daemon = spawn('wsl.exe', ['-d', 'Ubuntu', '-u', 'root', '--', '/usr/sbin/sshd', '-D', '-f', `${root}/sshd_config`, '-E', `${root}/sshd.log`], { windowsHide: true })
  await new Promise((resolve) => setTimeout(resolve, 300))
  const env = { ...process.env, AWB_USER_DATA: data }; delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: ['.'], env })
  const page = await app.firstWindow()
  await page.evaluate(async ({ port, root }) => {
    const { db } = await window.awb.getState()
    await window.awb.saveHosts([...db.hosts, { id: 'A', name: 'Machine A', addr: '127.0.0.1', port, user: 'root', auth: 'password', password: 'fixture-only', on: true, platform: 'linux', os: 'Linux' }])
    await window.awb.saveProjects([{ id: 'p', name: 'Native SSH', host: 'A', path: root + '/A', agent: 'shell', branch: '' }, { id: 'owner-probe', name: 'Owner probe', host: 'A', path: root + '/B', agent: 'shell', branch: '' }])
    await window.awb.saveSettings({ ...db.settings, layout: 'balanced', restore: false })
  }, { port: server.address().port, root })
  const indexMetadata = () => wsl('stat', '-c', '%u:%g:%a:%Y:%i', `${root}/B/.git/index`)
  const before = indexMetadata()
  await page.evaluate(() => window.awb.gitStatus('owner-probe', true))
  assert.equal(indexMetadata(), before, 'Privileged background refresh cannot rewrite another owner’s Git index')
  await page.reload()
  await page.evaluate(() => { window.__contexts = []; window.__terminal = ''; window.awb.onPty((event) => { if (event.type === 'data') window.__terminal += event.data; else window.__contexts.push(event) }) })
  await page.click('[data-a=quick]')
  await page.waitForFunction(() => window.__contexts.some((event) => event.inputReady))
  const terminal = await page.locator('[data-type=term][data-a=pane]').getAttribute('data-id')
  await page.keyboard.press('Control+e')
  await page.getByLabel('搜索文件', { exact: true }).fill('shared.txt')
  await page.locator('[data-a=search-file][data-id="shared.txt"]').click()
  const initialEditor = page.getByLabel('文件内容', { exact: true })
  await initialEditor.waitFor()
  await initialEditor.press('Control+End'); await initialEditor.press('A')
  const originalFileTab = await page.locator('[data-type=file][data-a=pane]:not([hidden])').getAttribute('data-id')
  await page.locator(`[data-a=tab][data-id="${terminal}"]`).click()
  await page.evaluate(({ terminal, root }) => window.awb.ptyWrite(terminal, `cd -- '${root}/C'\r`), { terminal, root })
  await page.waitForFunction((root) => window.__contexts.at(-1)?.context?.cwd === root + '/C', root)
  await page.evaluate((terminal) => window.awb.ptyWrite(terminal, './codex\r'), terminal)
  await page.waitForFunction(() => window.__contexts.at(-1)?.agentKind === 'codex')
  await page.getByLabel('搜索文件', { exact: true }).fill('changed-in-C')
  await page.locator('[data-a=search-file][data-id="changed-in-C.txt"]').waitFor()
  await page.click('[data-a=rmode][data-id=changes]')
  await page.locator('[data-a=diff][data-id="changed-in-C.txt"]').waitFor()
  await page.waitForFunction(() => window.__contexts.at(-1)?.inputReady)
  await page.evaluate(({ terminal, root }) => window.awb.ptyWrite(terminal, `cd -- '${root}/A'\r`), { terminal, root })
  await page.waitForFunction(() => window.__contexts.at(-1)?.context === null)
  await page.locator('[data-a=diff][data-id="changed-in-C.txt"]').waitFor({ state: 'detached' })
  const native = `ssh -i ${root}/client-key -p ${port} -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${root}/known_hosts ${user}@127.0.0.1`
  await page.evaluate(({ terminal, native }) => window.awb.ptyWrite(terminal, native + '\r'), { terminal, native })
  try { await page.waitForFunction((user) => window.__contexts.some((event) => event.context?.user === user), user, { timeout: 20000 }) }
  catch (error) { console.error(await page.evaluate(() => window.__terminal)); throw error }
  await page.evaluate(({ terminal, root }) => window.awb.ptyWrite(terminal, `cd -- '${root}/B'\r`), { terminal, root })
  await page.waitForFunction((root) => window.__contexts.at(-1)?.context?.cwd === root + '/B', root)
  const context = await page.evaluate(() => window.__contexts.at(-1).context)
  assert.equal(context.user, user)
  assert.equal((await page.evaluate((id) => window.awb.gitRead(id, 'shared.txt'), context.id)).text, 'B original\n')
  await page.keyboard.press('Control+e')
  await page.getByLabel('搜索文件', { exact: true }).fill('shared.txt')
  await page.locator('[data-a=search-file][data-id="shared.txt"]').click()
  const editor = page.getByLabel('文件内容', { exact: true })
  await editor.waitFor()
  const remoteFileTab = await page.locator('[data-type=file][data-a=pane]:not([hidden])').getAttribute('data-id')
  assert.notEqual(remoteFileTab, originalFileTab, 'Identical paths on different machines own separate views and drafts')
  assert.equal(await editor.inputValue(), 'B original\n', 'Visible file panel follows native SSH without any host configuration for B')
  await editor.press('Control+End'); await editor.press('x'); await editor.press('Control+s')
  await page.waitForFunction((id) => window.awb.gitRead(id, 'shared.txt').then((file) => file.text.includes('x')), context.id)
  assert.equal(wsl('cat', `${root}/A/shared.txt`), 'A original')
  assert.equal(wsl('stat', '-c', '%U', `${root}/B/shared.txt`), user)
  const panel = await page.evaluate((id) => window.awb.gitStatus(id, true), context.id)
  assert.ok(panel.files.some((file) => file.path === 'shared.txt'))
  assert.equal(wsl('stat', '-c', '%U', `${root}/B/.git/index`), user)
  const matches = await page.evaluate(async (target) => {
    const id = crypto.randomUUID(), paths = []
    await window.awb.contentSearchStart(target, id, 'B original', false)
    let done = false
    while (!done) { const batch = await window.awb.contentSearchNext(id); done = batch.done; paths.push(...batch.items.map((item) => item.path)) }
    return paths
  }, context.id)
  assert.deepEqual(matches, ['shared.txt'], 'Streaming content search follows the authenticated native session')
  const authentications = () => Number(wsl('python3', '-c', "import pathlib,sys; print(pathlib.Path(sys.argv[1]).read_text().count('Accepted publickey'))", `${root}/sshd.log`))
  assert.equal(authentications(), 1, 'File and Git commands must reuse the terminal authentication')
  await page.locator(`[data-a=tab][data-id="${originalFileTab}"]`).click()
  assert.equal(await editor.inputValue(), 'A original\nA', 'Opening B preserves A’s unsaved draft')
  await editor.press('Control+z')
  assert.equal(await editor.inputValue(), 'A original\n', 'Undo history is also isolated')
  await page.locator(`[data-a=tab][data-id="${remoteFileTab}"]`).click()
  assert.ok((await editor.inputValue()).includes('x'))
  await page.evaluate((terminal) => window.awb.ptyWrite(terminal, 'exit\r'), terminal)
  await page.waitForFunction(() => window.__contexts.at(-1)?.context === null)
  await assert.rejects(page.evaluate((id) => window.awb.gitRead(id, 'shared.txt'), context.id), 'A closed native SSH route must never fall back to machine A')
  assert.equal((await page.evaluate(() => window.awb.gitRead('p', 'shared.txt'))).text, 'A original\n')
  assert.ok((await editor.inputValue()).includes('x'), 'An ended route keeps the visible document content')
  await page.evaluate((terminal) => window.awb.ptyKill(terminal), terminal)
  console.log('PASS real native ssh from A to another user on B, context/CWD following, visible file read/save, Git, original ownership, authentication reuse, exit restoration and stale-route rejection')
} finally {
  if (app) await app.close()
  for (const client of clients) client.destroy()
  for (const child of children) child.kill()
  await new Promise((resolve) => server.close(resolve))
  try { wsl('python3', '-c', "import pathlib,os,signal,sys; p=pathlib.Path(sys.argv[1]); pid=int((p/'sshd.pid').read_text()); cmd=pathlib.Path('/proc',str(pid),'cmdline').read_bytes(); assert str(p/'sshd_config').encode() in cmd; os.kill(pid,signal.SIGTERM)", root) } catch { /* daemon may already have exited */ }
  daemon?.kill()
  wsl('rm', '-rf', '--', root)
}
