import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const shell = process.platform === 'win32' ? 'pwsh' : 'bash'
const count = Number(process.env.AWB_SHUTDOWN_TERMINALS || 6)
const runs = Number(process.env.AWB_SHUTDOWN_RUNS || 2)
const quote = (value) => `'${value.replaceAll("'", process.platform === 'win32' ? "''" : "'\\''")}'`
const until = async (condition, message) => {
  const end = Date.now() + 15000
  while (Date.now() < end) { if (await condition()) return; await new Promise((resolve) => setTimeout(resolve, 80)) }
  throw new Error(message)
}
for (let run = 0; run < runs; run++) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-shutdown-'))
  const pidFile = path.join(data, 'pids.txt')
  const fixture = path.join(root, 'scripts/fixtures/session-tree.cjs')
  fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify({
    settings: { restore: false, confirmKill: false },
    projects: [{ id: 'p', name: 'Shutdown regression', host: 'local', path: data, agent: 'shell' }],
    custom: [{ id: 'tree', name: 'Process tree', cmd: `${process.platform === 'win32' ? '& ' : ''}${quote(process.execPath)}`, args: `${quote(fixture)} ${quote(pidFile)}`, shell, env: [] }]
  }))
  const live = () => {
    if (!fs.existsSync(pidFile)) return []
    if (process.platform === 'win32') {
      const output = execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress'], { encoding: 'utf8', windowsHide: true })
      const rows = JSON.parse(output || '[]')
      return (Array.isArray(rows) ? rows : [rows]).filter((row) => row?.CommandLine?.includes(pidFile)).map((row) => row.ProcessId)
    }
    return fs.readFileSync(pidFile, 'utf8').trim().split(/\s+/).map(Number).filter((pid) => { try { process.kill(pid, 0); return true } catch { return false } })
  }
  const env = { ...process.env, AWB_USER_DATA: data }; delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ args: [root], cwd: root, env })
  const applicationProcess = app.process()
  const lifecycle = path.join(data, 'pty-lifecycle.jsonl')
  let closed = false
  try {
    const page = await app.firstWindow()
    await app.evaluate(({ app }, lifecycle) => {
      const require = process.getBuiltinModule('module').createRequire(`${app.getAppPath()}/package.json`)
      const pty = require('node-pty'), fs = require('node:fs'), original = pty.spawn
      const record = (type, pid) => fs.appendFileSync(lifecycle, JSON.stringify({ type, pid }) + '\n')
      pty.spawn = (...args) => { const process = original(...args); record('spawn', process.pid); process.onExit(() => record('exit', process.pid)); return process }
      app.on('before-quit', () => record('quit'))
    }, lifecycle)
    await page.evaluate(() => { window.__shutdownReady = {}; window.awb.onPty((event) => { if (event.type === 'state' && event.inputReady) window.__shutdownReady[event.id] = true }) })
    const detected = await page.evaluate(() => window.awb.localShells())
    for (let index = 0; index < count; index++) await page.evaluate(({ shell, index }) => window.awb.ptyCreate({ id: `idle-${index}`, projectId: 'p', kind: 'shell', shell }), { shell: detected[index % detected.length].id, index })
    await page.waitForFunction((count) => Object.keys(window.__shutdownReady).length === count, count)
    await page.evaluate((shell) => window.awb.ptyCreate({ id: 'agent', projectId: 'p', kind: 'tree', shell }), shell)
    await until(() => live().length === 3, 'Fixture process tree did not start')
    const exited = app.waitForEvent('close', { timeout: Math.max(30000, (count + 1) * 4000) })
    const closeStarted = Date.now()
    await page.getByRole('button', { name: '关闭窗口', exact: true }).click()
    const lateCreation = await page.evaluate(async (shell) => {
      try {
        await window.awb.ptyCreate({ id: 'late-create', projectId: 'p', kind: 'shell', shell })
        await window.awb.ptyClose('late-create')
        return false
      } catch (error) { return String(error).includes('工作台正在关闭') }
    }, shell)
    assert.equal(lateCreation, true, 'Shutdown must reject new terminals outside its cleanup snapshot')
    await exited; closed = true
    const closeMs = Date.now() - closeStarted
    await until(() => applicationProcess.exitCode !== null || applicationProcess.signalCode !== null, 'Electron did not finish exiting')
    assert.equal(applicationProcess.exitCode, 0, `Electron crashed while closing ${count + 1} terminals (run ${run + 1})`)
    const events = fs.readFileSync(lifecycle, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    const quit = events.findIndex((event) => event.type === 'quit')
    assert.equal(events.slice(0, quit).filter((event) => event.type === 'exit').length, count + 1, 'Application quit before all native PTY exit callbacks completed')
    await until(() => live().length === 0, 'Agent descendants survived shutdown')
    assert.ok(closeMs < Math.max(8000, (count + 1) * 1000), `Shutdown took ${closeMs}ms for ${count + 1} terminals`)
    console.log(`PASS shutdown run ${run + 1}: ${count} idle terminals, detached Agent descendants, ${closeMs}ms close, normal process exit`)
  } catch (error) { console.error(`Shutdown fixture ${data}, exit=${applicationProcess.exitCode}: ${error.message}`); throw error } finally {
    if (!closed) await app.close().catch(() => {})
    for (const pid of live()) {
      try {
        if (process.platform === 'win32') execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore' })
        else process.kill(pid, 'SIGKILL')
      } catch { /* A previously terminated ancestor may already have stopped this child. */ }
    }
  }
}
