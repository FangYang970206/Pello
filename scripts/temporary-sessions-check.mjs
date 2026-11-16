import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import ssh2 from 'ssh2'
import { _electron as electron } from 'playwright'
import { loadTypeScript } from './fixtures/load-ts.mjs'

const { themeVariables } = await loadTypeScript(new URL('../src/shared/themes.ts', import.meta.url))
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pello-temp-ssh-'))
const windows = process.platform === 'win32'
const linuxFile = windows ? 'wsl.exe' : 'bash'
const linuxArgs = (command) => windows ? ['--', 'bash', '-lc', command] : ['-lc', command]
const probe = spawnSync(linuxFile, linuxArgs('python3 --version'), { encoding: 'utf8', windowsHide: true, timeout: 15000 })
assert.equal(probe.status, 0, 'Linux/WSL with Python 3 is required for the actual remote-directory check')
const clients = new Set(), children = new Set(), requests = []
let deny = false
const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' })
const server = new ssh2.Server({ hostKeys: [key] }, (client) => {
  clients.add(client)
  let platform = 'linux'
  client.on('error', () => {})
  client.once('close', () => clients.delete(client))
  client.on('authentication', (ctx) => { platform = ctx.username; if (ctx.method === 'password' && ctx.password === 'fixture') ctx.accept(); else ctx.reject() })
  client.on('ready', () => client.on('session', (accept) => {
    const session = accept()
    let tty = false
    session.on('pty', (accept) => { tty = true; accept() })
    session.on('window-change', (accept) => accept?.())
    session.on('exec', (accept, _reject, info) => {
      const stream = accept()
      const request = { command: info.command, platform, input: '', tty }
      requests.push(request)
      if (info.command === 'uname -s 2>/dev/null || ver') { stream.write(platform === 'linux' ? 'Linux\n' : 'Microsoft Windows\n'); stream.exit(0); stream.end(); return }
      if (deny) { stream.stderr.write('FIXTURE_PERMISSION_DENIED'); stream.exit(1); stream.end(); return }
      const encoded = /-EncodedCommand ([A-Za-z0-9+/=]+)/.exec(info.command)?.[1]
      const commandFile = path.join(data, `ssh-command-${requests.length}.sh`)
      if (platform === 'linux') fs.writeFileSync(commandFile, info.command)
      const linuxCommandFile = windows ? '/mnt/' + commandFile[0].toLowerCase() + commandFile.slice(2).replaceAll('\\', '/') : commandFile
      const child = platform === 'windows'
        ? spawn('powershell.exe', ['-NoProfile', '-EncodedCommand', encoded], { windowsHide: true })
        : spawn(linuxFile, windows ? ['--exec', 'bash', linuxCommandFile] : [commandFile], { windowsHide: true })
      children.add(child)
      stream.on('data', (chunk) => { request.input += chunk.toString('utf8') })
      stream.pipe(child.stdin); child.stdout.pipe(stream, { end: false }); child.stderr.pipe(stream.stderr, { end: false })
      child.stdin.on('error', () => {})
      child.once('close', (code) => { children.delete(child); if (!stream.destroyed) { stream.exit(code ?? 1); stream.end() } })
      stream.once('close', () => { child.stdin.end(); child.kill() })
    })
  }))
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const linuxRoot = `/tmp/pello-temp-${path.basename(data)} 中文 ' $;`
const winRoot = path.join(data, "remote Windows 中文 ' $; [root]")
fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify({ settings: { defAgent: 'shell', confirmKill: false, restore: true } }))
const env = { ...process.env, AWB_USER_DATA: data }
delete env.ELECTRON_RUN_AS_NODE
let app = await electron.launch({ args: ['.'], env })
let page
const shots = path.resolve('output/playwright/temporary-sessions')
fs.mkdirSync(shots, { recursive: true })
const readLinux = (file) => {
  const result = spawnSync(linuxFile, windows ? ['--', 'python3', '-c', 'import sys; print(open(sys.argv[1], encoding="utf-8").read())', file] : ['-c', 'cat -- "$1"', '_', file], { encoding: 'utf8', windowsHide: true, timeout: 10000 })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}
try {
  page = await app.firstWindow(); page.setDefaultTimeout(15000)
  const hosts = ['linux', ...(windows ? ['windows'] : [])].map((platform) => ({ id: `remote-${platform}`, name: `Remote ${platform} 中文`, user: platform, addr: '127.0.0.1', port: server.address().port, auth: 'password', password: 'fixture', on: true, os: platform, platform }))
  await page.evaluate(async (hosts) => { const { db } = await window.awb.getState(); await window.awb.saveHosts([...db.hosts, ...hosts]) }, hosts)
  await page.reload()
  const open = async () => { await page.locator('[data-a=temporary-session]').locator('..').hover(); await page.click('[data-a=temporary-session]'); await page.getByLabel('临时会话目录', { exact: true }).waitFor(); await page.waitForFunction(() => !document.querySelector('[aria-label="临时会话目录"]').disabled) }
  const choose = async (hostId) => { await page.getByLabel('运行环境', { exact: true }).selectOption(hostId); await page.waitForFunction(() => !document.querySelector('[aria-label="临时会话目录"]').disabled) }
  const next = async () => { await page.getByRole('button', { name: '保存并新建', exact: true }).click(); await page.getByRole('heading', { name: '新建会话', exact: true }).waitFor() }
  const cancel = async () => { await page.getByRole('button', { name: '取消', exact: true }).click() }
  const state = () => page.evaluate(() => window.awb.getState())
  await open(); await choose('remote-linux')
  await page.getByLabel('临时会话目录', { exact: true }).fill('relative')
  await page.getByRole('button', { name: '保存并新建', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: '绝对目录' }).waitFor()
  assert.equal(await page.getByLabel('临时会话目录', { exact: true }).inputValue(), 'relative')
  await page.getByRole('button', { name: '浏览…', exact: true }).click()
  const browser = page.locator('dialog:has(.directory-browser)')
  await browser.getByRole('alert').waitFor() // The invalid typed path can be corrected in the picker.
  await browser.getByRole('button', { name: '主目录', exact: true }).click()
  await page.waitForFunction(() => !!document.querySelector('[aria-label="浏览路径"]')?.value.startsWith('/'))
  await page.keyboard.press('Escape')
  assert.equal(await page.getByRole('dialog', { name: '配置临时会话目录', exact: true }).count(), 1)
  assert.equal(await page.getByRole('button', { name: '浏览…', exact: true }).evaluate((node) => node === document.activeElement), true)
  await page.getByLabel('临时会话目录', { exact: true }).fill(linuxRoot)
  for (const theme of ['light', 'dark']) for (const [width, height] of [[1024, 680], [1440, 900]]) for (const size of [12, 16]) {
    await page.setViewportSize({ width, height })
    await page.evaluate(({ theme, variables, size }) => { document.documentElement.dataset.theme = theme; for (const [k, v] of Object.entries(variables)) document.documentElement.style.setProperty(k, v); document.documentElement.style.setProperty('--ui-size', `${size}px`) }, { theme, variables: themeVariables(theme), size })
    const geometry = await page.locator('#modal .dlg').evaluate((node) => { const r = node.getBoundingClientRect(), input = node.querySelector('input').getBoundingClientRect(), buttons = [...node.querySelectorAll('footer button')].map((button) => button.getBoundingClientRect()); return { fits: r.top >= 24 && r.bottom <= innerHeight - 24 && node.scrollWidth <= node.clientWidth, input: input.width, buttons: buttons.every((b) => b.bottom <= r.bottom && b.right <= r.right), focused: !!document.activeElement.closest('.dlg') } })
    assert.ok(geometry.fits && geometry.buttons && geometry.input >= 64 && geometry.focused, JSON.stringify(geometry))
    await page.screenshot({ path: path.join(shots, `${theme}-${width}-${size}.png`), animations: 'disabled' })
  }
  await cancel()
  await page.click('[data-a=settings]'); await page.click('[data-a=sec][data-id=general]')
  await page.getByLabel('应用语言', { exact: true }).selectOption('en')
  await page.click('[data-a=back]')
  await page.locator('[data-a=temporary-session]').locator('..').hover(); await page.click('[data-a=temporary-session]')
  await page.getByLabel('Environment', { exact: true }).waitFor()
  await page.getByLabel('Environment', { exact: true }).selectOption('remote-linux')
  await page.waitForFunction(() => !document.querySelector('[aria-label="Temporary session directory"]').disabled)
  await page.locator('#modal .dlg').evaluate((node) => { node.style.width = '380px'; document.documentElement.style.setProperty('--ui-size', '16px') })
  await page.getByLabel('Temporary session directory', { exact: true }).fill(linuxRoot)
  await page.getByRole('button', { name: 'Save and create', exact: true }).focus()
  await page.keyboard.press('Tab')
  assert.equal(await page.evaluate(() => !!document.activeElement.closest('#modal .dlg')), true)
  assert.ok(await page.getByLabel('Temporary session directory', { exact: true }).evaluate((node) => node.getBoundingClientRect().width >= 64))
  await page.screenshot({ path: path.join(shots, 'english-narrow-16.png'), animations: 'disabled' })
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.click('[data-a=settings]'); await page.click('[data-a=sec][data-id=general]')
  await page.getByLabel('Application language', { exact: true }).selectOption('zh-CN')
  await page.click('[data-a=back]')
  await open(); await choose('remote-linux'); await page.getByLabel('临时会话目录', { exact: true }).fill(linuxRoot)
  // A failed SSH command keeps both the machine selection and the path.
  deny = true
  await page.getByRole('button', { name: '保存并新建', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: 'FIXTURE_PERMISSION_DENIED' }).waitFor()
  assert.equal(await page.getByLabel('临时会话目录', { exact: true }).inputValue(), linuxRoot)
  deny = false
  await next(); await cancel()
  assert.equal((await state()).db.projects.length, 0)
  assert.ok(!requests.some((r) => r.input && JSON.parse(r.input).id), 'Cancelling executor selection never creates a UUID directory')
  await open(); await choose('remote-linux')
  assert.equal(await page.getByLabel('临时会话目录', { exact: true }).inputValue(), linuxRoot)
  await next()
  assert.ok((await page.locator('.shellone').textContent()).includes('bash'))
  await page.click('[data-a=ntk][data-id=shell]')
  deny = true
  await page.click('[data-a=nt-ok]')
  await page.getByRole('alert').filter({ hasText: 'FIXTURE_PERMISSION_DENIED' }).waitFor()
  assert.equal((await state()).db.projects.length, 0, 'Failed remote preparation must not publish a project')
  deny = false
  await page.click('[data-a=nt-ok]')
  await page.locator('#modal .dlg').waitFor({ state: 'detached' })
  const first = (await state()).db.projects.find((p) => p.temporary)
  assert.equal(first.host, 'remote-linux'); assert.equal(path.posix.dirname(first.path), linuxRoot)
  assert.match(path.posix.basename(first.path), /^[a-f\d-]{36}$/)
  assert.ok(readLinux(first.path + '/AGENTS.md').includes(first.path))
  assert.equal(readLinux(first.path + '/CLAUDE.md').trim(), '@AGENTS.md')
  const term = await page.locator('.tab.on [data-a=tab]').getAttribute('data-id')
  await page.waitForFunction(({ id, cwd }) => window.__awbBuffer?.(id)?.replace(/\s/g, '').includes(cwd.replace(/\s/g, '')), { id: term, cwd: first.path }).catch(async (error) => { console.error('Remote runtime', await page.evaluate((id) => window.__awbBuffer?.(id), term), requests.filter((r) => r.tty)); throw error })
  await page.evaluate(() => { window.__tempTerminal = document.querySelector('.xterm') })
  await open(); await choose('remote-linux')
  await page.getByLabel('临时会话目录', { exact: true }).fill(linuxRoot + '-draft')
  await choose('local'); await choose('remote-linux')
  assert.equal(await page.getByLabel('临时会话目录', { exact: true }).inputValue(), linuxRoot + '-draft')
  await cancel()
  assert.equal(await page.evaluate(() => window.__tempTerminal === document.querySelector('.xterm')), true)
  await page.locator('[data-a=newterm]').first().locator('..').hover()
  await page.locator('[data-a=newterm]').first().click()
  await page.click('[data-a=ntk][data-id=shell]'); await page.click('[data-a=nt-ok]')
  await page.locator('#modal .dlg').waitFor({ state: 'detached' })
  const added = await page.locator('.tab.on [data-a=tab]').getAttribute('data-id')
  assert.notEqual(added, term)
  await page.waitForFunction(({ id, cwd }) => window.__awbBuffer?.(id)?.replace(/\s/g, '').includes(cwd.replace(/\s/g, '')), { id: added, cwd: first.path })
  assert.equal((await state()).db.projects.length, 1, 'Adding a terminal must reuse the same UUID directory and project')
  const second = await page.evaluate((root) => window.awb.createTemporarySession(root, 'remote-linux'), linuxRoot)
  assert.notEqual(second.database.projects.find((p) => p.id === second.projectId).path, first.path)
  if (windows) {
    await page.evaluate((root) => window.awb.configureTemporaryDirectory(root, 'remote-windows'), winRoot)
    const result = await page.evaluate(() => window.awb.createTemporarySession(undefined, 'remote-windows'))
    const project = result.database.projects.find((p) => p.id === result.projectId)
    assert.equal(path.dirname(project.path), winRoot)
    assert.ok(fs.readFileSync(path.join(project.path, 'AGENTS.md'), 'utf8').includes(project.path))
    assert.equal(fs.readFileSync(path.join(project.path, 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n')
  }
  const localRoot = path.join(data, 'local-temp')
  await page.evaluate((root) => window.awb.configureTemporaryDirectory(root), localRoot)
  const config = JSON.parse(fs.readFileSync(path.join(data, 'pello.config.json'), 'utf8'))
  assert.equal(config.temporarySessionsDirectory, localRoot)
  assert.equal(config.remoteTemporarySessionsDirectories['remote-linux'], linuxRoot)
  if (windows) assert.equal(config.remoteTemporarySessionsDirectories['remote-windows'], winRoot)
  await app.close(); app = await electron.launch({ args: ['.'], env }); page = await app.firstWindow(); page.setDefaultTimeout(15000)
  assert.equal(await page.evaluate(() => window.awb.temporaryDirectory('remote-linux')), linuxRoot)
  assert.ok((await state()).db.projects.some((p) => p.id === first.id && p.host === first.host && p.path === first.path))
  await page.waitForFunction((id) => window.__awbBuffer?.(id)?.includes('$'), added)
  await page.evaluate((id) => window.awb.ptyWrite(id, 'printf "__TEMP_RESTART__%s\\n" "$PWD"\r'), added)
  await page.waitForFunction(({ id, cwd }) => window.__awbBuffer?.(id)?.replace(/\s/g, '').includes(('__TEMP_RESTART__' + cwd).replace(/\s/g, '')), { id: added, cwd: first.path })
  await open(); await choose('remote-linux')
  assert.equal(await page.getByLabel('临时会话目录', { exact: true }).inputValue(), linuxRoot)
  await cancel()
  console.log('PASS actual Linux and Windows SSH UUID creation, stdin escaping, instructions, runtime cwd, per-machine config, cancellation, failure retry, draft switching, terminal preservation and restart persistence; nine fresh theme/size/font/English captures')
} finally {
  await app.close().catch(() => {})
  for (const child of children) child.kill()
  for (const client of clients) client.destroy()
  await new Promise((resolve) => server.close(resolve))
}
