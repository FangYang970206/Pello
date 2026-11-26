// Testing an executor shows what its command came to where a terminal would:
// the dialog's own button reports the exit code, a command written for Bash
// runs in Git Bash rather than in the shell of another, a command that is not
// there fails the test, and one that keeps running is said to be running.
// Drives the running app.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launchWorkbench } from './fixtures/launch-workbench.mjs'

const root = path.resolve('.')
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pello-executor-test-'))
const project = path.join(data, 'project')
fs.mkdirSync(project)
fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify({
  settings: { autoCheckUpdates: false, restore: false, confirmKill: false },
  custom: [{ id: 'public-test', name: 'Public custom CLI', cmd: 'node', args: '--version', shell: 'pwsh', env: [], letter: 'Q', color: '#a9c3df' }],
  projects: [{ id: 'p', name: 'Executor test', host: 'local', path: project, agent: 'shell' }],
}))
const env = { ...process.env, AWB_USER_DATA: data }
delete env.ELECTRON_RUN_AS_NODE
const app = await launchWorkbench({ args: ['.'], env, cwd: root })
const failures = []
const check = async (name, run) => { try { await run(); console.log('PASS ' + name) } catch (error) { failures.push(name); console.error('FAIL ' + name + ': ' + error.message) } }
try {
  const page = await app.firstWindow()
  page.setDefaultTimeout(60000)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.click('[data-a=settings]')
  await page.click('[data-a=sec][data-id=agents]')
  await page.click('[data-a=custom][data-id=public-test]')
  await check('the dialog\'s own test reports the exit code of the command', async () => {
    await page.click('[data-a=ce-test]')
    await page.waitForFunction(() => document.querySelector('#ceout')?.textContent?.includes('退出码 0'))
  })
  await check('a command written for Bash runs in Bash', async () => {
    const bash = await page.evaluate(() => window.awb.testExec({ cmd: 'printf', args: "'NATIVE_BASH_TEST\\n'", shell: 'bash', env: [] }))
    assert.equal(bash.code, 0, JSON.stringify(bash)); assert.ok(bash.text.includes('NATIVE_BASH_TEST'), JSON.stringify(bash))
    assert.equal(bash.running, undefined, JSON.stringify(bash))
  })
  await check('a command that is not there fails the test', async () => {
    const missing = await page.evaluate(() => window.awb.testExec({ cmd: 'pello_nonexistent_custom_agent_42', args: '', shell: 'pwsh', env: [] }))
    assert.notEqual(missing.code, 0, 'an unavailable command must fail the startup test: ' + JSON.stringify(missing))
    assert.equal(missing.running, undefined, JSON.stringify(missing))
  })
  await check('an environment variable of the executor reaches its command', async () => {
    const pwsh = await page.evaluate(() => window.awb.testExec({ cmd: 'Write-Output', args: '"pello $env:PELLO_TEST_VAR"', shell: 'pwsh', env: [{ k: 'PELLO_TEST_VAR', v: 'from-env', secret: false }] }))
    assert.equal(pwsh.code, 0, JSON.stringify(pwsh)); assert.ok(pwsh.text.includes('pello from-env'), JSON.stringify(pwsh))
  })
  await check('a command still running is said to be running and is ended', async () => {
    const running = await page.evaluate(() => window.awb.testExec({ cmd: 'Start-Sleep', args: '60', shell: 'pwsh', env: [] }))
    assert.equal(running.code, null, JSON.stringify(running)); assert.equal(running.running, true, JSON.stringify(running))
  })
  await check('the dialog says a command still running was stopped', async () => {
    await page.fill('[data-ce=cmd]', 'Start-Sleep')
    await page.fill('[data-ce=args]', '60')
    await page.click('[data-a=ce-test]')
    await page.waitForFunction(() => document.querySelector('#ceout')?.textContent?.includes('启动观察结束'))
    assert.ok((await page.locator('#ceout').innerText()).includes('未验证服务连接'), 'the dialog says the service connection was not verified')
    await page.fill('[data-ce=cmd]', 'node')
    await page.fill('[data-ce=args]', '--version')
  })
  await check('a host that is not there is said so', async () => {
    const message = await page.evaluate(async () => { try { await window.awb.testExec({ cmd: 'node', args: '--version', shell: 'pwsh', env: [], hostId: 'ghost' }); return '' } catch (error) { return String(error) } })
    assert.ok(message.includes('这台机器未连接'), message)
  })
  await check('the test leaves no terminal and no history behind', async () => {
    const db = (await page.evaluate(() => window.awb.getState())).db
    const sessions = Object.values(db.sessions || {}).flat()
    assert.equal(sessions.length, 0, JSON.stringify(sessions))
    const history = path.join(data, 'terminal-history')
    assert.equal(fs.existsSync(history) ? fs.readdirSync(history).length : 0, 0, 'history left: ' + (fs.existsSync(history) ? fs.readdirSync(history).join(', ') : ''))
    assert.equal(await page.locator('[data-a=tab]').count(), 0)
  })
  assert.deepEqual(errors, [])
  if (failures.length) throw new Error(failures.length + ' check(s) failed')
} finally {
  await app.close()
}
