import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import ts from 'typescript'
import ssh2 from 'ssh2'
import { _electron as electron } from 'playwright'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = ts.transpileModule(fs.readFileSync(path.join(root, 'src/main/platform.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
}).outputText
const localShellSource = ts.transpileModule(fs.readFileSync(path.join(root, 'src/main/local-shells.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
}).outputText
const localShellUrl = `data:text/javascript;base64,${Buffer.from(localShellSource).toString('base64')}`
const linkedSource = source.replace("from './local-shells'", `from '${localShellUrl}'`)
assert.notEqual(linkedSource, source, 'Link the actual Shell detection dependency before loading platform.ts')
const { remoteBootstrap } = await import(`data:text/javascript;base64,${Buffer.from(linkedSource).toString('base64')}`)
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`
const failures = []
const check = async (name, run) => {
  try { if (await run() !== false) console.log(`PASS ${name}`) }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message}`) }
}

await check('remote Bash loads user-installed commands before the first prompt', async () => {
  const boot = remoteBootstrap('linux', '/').map(quote).join(' ')
  const script = `
fixture=$(mktemp -d)
trap 'rm -rf -- "$fixture"' EXIT
mkdir "$fixture/bin"
printf '#!/bin/sh\\nprintf "AWB_USER_COMMAND_OK\\\\n"\\n' > "$fixture/bin/opencode"
chmod +x "$fixture/bin/opencode"
printf 'export PATH="$HOME/bin:$PATH"\\n' > "$fixture/.bashrc"
export HOME="$fixture" PATH=/usr/bin:/bin
${boot} <<'AWB_INPUT'
opencode
pwd
exit
AWB_INPUT
`
  const file = process.platform === 'win32' ? 'wsl.exe' : 'bash'
  const args = process.platform === 'win32' ? ['--', 'bash', '--noprofile', '--norc'] : ['--noprofile', '--norc']
  // The SSH transport checks below are portable; executing the real Linux shell
  // additionally requires Bash (or a configured default WSL distro on Windows).
  const available = spawnSync(file, process.platform === 'win32' ? ['--', 'bash', '--version'] : ['--version'], {
    encoding: 'utf8', timeout: 15000, windowsHide: true
  })
  if (available.status !== 0) {
    console.log('未能执行 Linux startup check: Bash/WSL is unavailable')
    return false
  }
  const result = spawnSync(file, args, { input: script, encoding: 'utf8', timeout: 15000, windowsHide: true })
  assert.equal(result.status, 0, result.stderr || result.error?.message)
  assert.ok(result.stdout.includes('AWB_USER_COMMAND_OK'), `${result.stdout}\n${result.stderr}`)
  assert.ok(result.stdout.includes('awb;prompt;0'), 'Workbench prompt markers must survive user startup files')
})

const hostKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' })
const clients = new Set()
let terminalStream
let remoteSize = { cols: 80, rows: 24 }
const unicode = '▀▄▌▐│─┌┐└┘ 中文 🐧'
const stderrText = '错误边线 ┃ 🐧'
let commandFailure = false
async function writeBytes(output, text) {
  for (const byte of Buffer.from(text)) {
    if (output.destroyed) return
    output.write(Buffer.from([byte]))
    await new Promise((resolve) => setTimeout(resolve, 4))
  }
}
const server = new ssh2.Server({ hostKeys: [hostKey] }, (client) => {
  clients.add(client)
  client.on('error', () => {})
  client.once('close', () => clients.delete(client))
  client.on('authentication', (context) => context.method === 'password' && context.password === 'fixture' ? context.accept() : context.reject())
  client.on('ready', () => client.on('session', (accept) => {
    const session = accept()
    let tty = false
    session.on('pty', (accept, _reject, size) => { tty = true; remoteSize = size; accept() })
    session.on('window-change', (accept, _reject, size) => { remoteSize = size; accept?.() })
    session.on('exec', async (accept) => {
      const stream = accept()
      if (!tty) {
        const failed = commandFailure
        await writeBytes(failed ? stream.stderr : stream, failed ? stderrText : `Linux ${unicode}\n`)
        if (!stream.destroyed) { stream.exit(failed ? 1 : 0); stream.end() }
        return
      }
      terminalStream = stream
      stream.write('\x1b]777;awb;prompt;0\x07REMOTE_READY $ ')
    })
  }))
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-remote-terminal-'))
const env = { ...process.env, AWB_USER_DATA: data }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: [root], cwd: root, env })
try {
  const page = await app.firstWindow()
  await page.waitForSelector('[data-a=newproj]')
  const host = { id: 'remote', name: 'Remote UTF-8', addr: '127.0.0.1', user: 'tester', port: server.address().port,
    auth: 'password', password: 'fixture', platform: 'linux', os: 'Linux', on: true }
  await check('SSH command stdout and stderr also preserve fragmented UTF-8', async () => {
    const result = await page.evaluate((host) => window.awb.testHost(host), host)
    assert.equal(result.os, `Linux ${unicode}`)
    commandFailure = true
    try {
      const failed = await page.evaluate((host) => window.awb.testHost(host), host)
      assert.equal(failed.ok, false)
      assert.equal(failed.error, stderrText)
    } finally { commandFailure = false }
  })
  await page.evaluate(async (host) => {
    const state = await window.awb.getState()
    await window.awb.saveHosts([...state.db.hosts, host])
    await window.awb.saveProjects([{ id: 'p', name: 'Remote terminal', host: host.id, path: '/', agent: 'shell', branch: '' }])
  }, host)
  await page.reload()
  await page.waitForSelector('[data-a=quick]')
  await page.click('[data-a=quick]')
  const id = await page.locator('.tab.on [data-a=tab]').getAttribute('data-id')
  await page.waitForFunction((id) => window.__awbBuffer?.(id)?.includes('REMOTE_READY'), id)
  await check('SSH stdout and stderr preserve UTF-8 characters split across packets', async () => {
    for (const [output, text] of [[terminalStream, unicode], [terminalStream.stderr, stderrText]]) {
      await writeBytes(output, `\r\n${text}\r\n`)
    }
    terminalStream.write('UTF8_DONE\r\n')
    await page.waitForFunction((id) => window.__awbBuffer(id).includes('UTF8_DONE'), id)
    const buffer = await page.evaluate((id) => window.__awbBuffer(id), id)
    assert.ok(buffer.includes(unicode) && buffer.includes(stderrText), buffer)
    assert.ok(!buffer.includes('\ufffd'), 'Split UTF-8 sequences must not become replacement glyphs')
  })
  await check('remote PTY size matches the visible terminal and its bottom row', async () => {
    for (const [width, height] of [[1024, 680], [1440, 900]]) {
      await page.evaluate(([w, h]) => window.awb.winResize(w, h), [width, height])
      await page.waitForFunction((w) => window.innerWidth === w, width)
      await page.waitForTimeout(200)
      const size = await page.evaluate((id) => window.__awbGeometry(id), id)
      assert.equal(remoteSize.cols, size.cols)
      assert.equal(remoteSize.rows, size.rows)
      terminalStream.write(`\x1b[?1049h\x1b[2J\x1b[HREMOTE_TUI\x1b[${size.rows};1HBOTTOM_ROW_VISIBLE`)
      await page.waitForFunction((id) => window.__awbBuffer(id).includes('BOTTOM_ROW_VISIBLE'), id)
      const lines = (await page.evaluate((id) => window.__awbBuffer(id), id)).split('\n')
      assert.equal(lines.at(-1), 'BOTTOM_ROW_VISIBLE')
      const bounds = await page.evaluate(() => {
        const pane = document.querySelector('.pane:not([hidden]) .termhost').getBoundingClientRect()
        const screen = document.querySelector('.pane:not([hidden]) .xterm-screen').getBoundingClientRect()
        return screen.bottom <= pane.bottom && screen.right <= pane.right
      })
      assert.ok(bounds)
      terminalStream.write('\x1b[?1049l')
    }
  })
  await page.evaluate((id) => window.awb.ptyClose(id), id)
  const closed = app.waitForEvent('close')
  await page.getByRole('button', { name: '关闭窗口', exact: true }).click()
  await closed
} finally {
  await app.close().catch(() => {})
  for (const client of clients) client.destroy()
  await new Promise((resolve) => server.close(resolve))
}
assert.deepEqual(failures, [], 'Remote terminal regressions failed')
