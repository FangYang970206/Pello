import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { _electron as electron } from 'playwright'

if (!process.env.AWB_TEST_PASSWORD) throw new Error('Set AWB_TEST_PASSWORD for the requested live SSH check')
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-live-ssh-'))
const env = { ...process.env, AWB_USER_DATA: data }
delete env.ELECTRON_RUN_AS_NODE
delete env.AWB_TEST_PASSWORD
const app = await electron.launch({ args: ['.'], env })
const password = process.env.AWB_TEST_PASSWORD
const marker = randomUUID().replaceAll('-', '')
const remote = `/tmp/awb-qa-${marker}`
try {
  const page = await app.firstWindow()
  await page.locator('[data-a=newproj]').first().waitFor()
  const host = { id: 'live-linux', name: 'Linux QA', addr: '192.168.64.128', port: 22, user: 'fy', auth: 'password', password, on: false, os: 'Linux', platform: 'linux' }
  for (const addr of ['172.23.202.183', host.addr]) {
    const result = await page.evaluate((host) => window.awb.testHost(host), { ...host, addr })
    console.log(JSON.stringify({ address: addr, ...result }))
    if (addr === host.addr) assert.equal(result.ok, true, result.error)
  }
  await page.evaluate(async (host) => {
    const { db } = await window.awb.getState()
    await window.awb.saveHosts([...db.hosts, { ...host, on: true }])
    await window.awb.saveProjects([{ id: 'live', name: 'Live SSH QA', host: host.id, path: '/tmp', branch: '', agent: 'shell' }])
    window.__liveOutput = ''
    window.awb.onPty((event) => { if (event.type === 'data' && event.id === 'live-terminal') window.__liveOutput += event.data })
    await window.awb.ptyCreate({ id: 'live-terminal', projectId: 'live', kind: 'shell', shell: 'bash' })
  }, host)
  await page.evaluate(({ remote, marker }) => window.awb.ptyWrite('live-terminal', `mkdir -p '${remote}' && printf 'remote fixture\\n' > '${remote}/README.md' && printf 'READY_${marker}\\n'\r`), { remote, marker })
  await page.waitForFunction((marker) => window.__liveOutput.includes(`READY_${marker}\r\n`), marker)
  await page.evaluate((remote) => window.awb.saveProjects([{ id: 'live', name: 'Live SSH QA', host: 'live-linux', path: remote, branch: '', agent: 'shell' }]), remote)
  const read = await page.evaluate(() => window.awb.gitRead('live', 'README.md'))
  assert.equal(read.text, 'remote fixture\n')
  const written = await page.evaluate((version) => window.awb.gitWrite('live', 'README.md', '远程保存验证\n', version), read.version)
  assert.equal(written.text, '远程保存验证\n')
  const tree = await page.evaluate(() => window.awb.gitTree('live'))
  assert.ok(tree.some((item) => item.name === 'README.md'))
  await page.evaluate(({ remote, marker }) => window.awb.ptyWrite('live-terminal', `test -f '${remote}/README.md' && rm -- '${remote}/README.md' && rmdir -- '${remote}' && printf 'CLEAN_${marker}\\n'\r`), { remote, marker })
  await page.waitForFunction((marker) => window.__liveOutput.includes(`CLEAN_${marker}\r\n`), marker)
  await page.evaluate(() => window.awb.ptyClose('live-terminal'))
  const state = await page.evaluate(() => window.awb.getState())
  assert.equal(state.db.hosts.find((item) => item.id === host.id).password, undefined)
  assert.ok(JSON.parse(fs.readFileSync(path.join(data, 'workbench.json'), 'utf8')).hosts.every((item) => !Object.hasOwn(item, 'password')))
  console.log('PASS live Linux password authentication, remote terminal input/output, file listing, versioned UTF-8 save, cleanup and terminal close')
} finally { await app.close() }
