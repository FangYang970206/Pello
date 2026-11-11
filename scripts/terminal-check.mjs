import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { _electron as electron } from 'playwright'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-terminal-'))
const pidFile = path.join(data, 'pids.txt')
const isWin = process.platform === 'win32'
const shell = isWin ? 'pwsh' : 'bash'
const quote = (value) => `'${value.replaceAll("'", isWin ? "''" : "'\\''")}'`
const node = `${isWin ? '& ' : ''}${quote(process.execPath)}`
const fixture = path.join(root, 'scripts/fixtures/session-tree.cjs')
const shots = path.join(root, 'output/playwright')
fs.mkdirSync(shots, { recursive: true })
fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify({
  settings: { theme: 'dark', fontSize: 13, defShell: shell, defAgent: 'shell', restore: true, confirmKill: true },
  projects: [{ id: 'p1', name: 'Terminal check', host: 'local', path: data, branch: '', agent: 'shell' }],
  custom: [
    { id: 'busy', name: 'Busy agent', cmd: node, args: `${quote(fixture)} ${quote(pidFile)}`, letter: 'B', color: '#dcc07f', shell, env: [] },
    { id: 'ready', name: 'Completed agent', cmd: node, args: '-e "process.exit(0)"', letter: 'R', color: '#95cfaa', shell, env: [] }
  ],
  sessions: { p1: [
    { id: 'shell', kind: 'shell', shell },
    { id: 'ready', kind: 'ready', shell },
    { id: 'busy', kind: 'busy', shell }
  ] },
  activeTab: { p1: 'busy' }
}))

const alive = (pid) => {
  try { process.kill(pid, 0); return true } catch { return false }
}
const liveFixturePids = () => {
  if (!isWin) return pids().filter(alive)
  // Windows quickly reuses PIDs while the overflow test starts more shells.
  // Match the unique fixture command as well, including during cleanup.
  const result = execFileSync('powershell.exe', ['-NoProfile', '-Command',
    'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress'
  ], { encoding: 'utf8', windowsHide: true })
  const parsed = JSON.parse(result || '[]')
  return (Array.isArray(parsed) ? parsed : [parsed]).filter((item) => item?.CommandLine?.includes(pidFile)).map((item) => item.ProcessId)
}
const pids = () => fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8').trim().split(/\s+/).map(Number) : []
const until = async (check, message, timeout = 15000) => {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(message)
}
const failures = []
const check = async (label, run) => {
  try { await run(); console.log(`PASS ${label}`) }
  catch (error) { failures.push(label); console.error(`FAIL ${label}: ${error.message}`) }
}
const env = { ...process.env, AWB_USER_DATA: data }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: [root], cwd: root, env })
const electronProcess = app.process()
let appClosed = false
app.on('console', (message) => {
  if (message.type() === 'error') console.error(`Electron: ${message.text()}`)
})
try {
  const page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  await page.waitForSelector('[data-a=tab][data-id=busy][data-state=running]')
  await until(() => pids().length === 3, 'Agent process tree did not start')
  await page.waitForSelector('[data-a=tab][data-id=ready][data-state=exited]')

  const checkTabbar = async (theme) => {
    for (const [width, height] of [[1440, 900], [1024, 680]]) {
      await page.evaluate(([width, height]) => window.awb.winResize(width, height), [width, height])
      await page.waitForFunction((width) => window.innerWidth === width, width)
      await page.locator('[data-a=newterm]').waitFor({ state: 'visible' })
      await check(`plus follows tabs on the same horizontal line: ${theme} ${width}px`, async () => {
        const layout = await page.evaluate(() => {
          const last = document.querySelector('.tabs .tab:last-child').getBoundingClientRect()
          const plus = document.querySelector('.addtab[data-a=newterm]').getBoundingClientRect()
          const tabs = document.querySelector('.tabs')
          const view = tabs.getBoundingClientRect()
          return { gap: plus.left - last.right, top: plus.top - last.top, bottom: plus.bottom - last.bottom, height: plus.height,
            overflow: tabs.scrollWidth > tabs.clientWidth + 1, accessible: plus.left >= view.right - 1 }
        })
        assert.ok(Math.abs(layout.top) <= 1 && Math.abs(layout.bottom) <= 1 && layout.height === 32, `tab and plus must share the same 32px row: ${JSON.stringify(layout)}`)
        if (layout.overflow) assert.ok(layout.accessible, JSON.stringify(layout))
        else assert.ok(layout.gap >= 0 && layout.gap <= 4, `gap is ${layout.gap}px`)
      })
      await page.locator('.tabbar').screenshot({ path: path.join(shots, `terminal-tabbar-${theme}-${width}.png`) })
    }
  }
  await checkTabbar('dark')
  await check('toolbar and shortcut badges are absent', async () => {
    assert.equal(await page.locator('[data-a=ctrlc], [data-a=kill], [data-a=restart], [data-a=split], .pstate, .side kbd, .empty kbd').count(), 0)
  })
  await check('running agent spins yellow; exited and shell terminals stay gray and still', async () => {
    const colors = await page.evaluate(() => {
      const css = getComputedStyle(document.documentElement)
      return ['busy', 'ready', 'shell'].map((id, i) => {
        const dot = document.querySelector(`[data-a=tab][data-id=${id}] .dot`)
        const probe = document.createElement('span')
        probe.style.color = css.getPropertyValue(['--amber', '--faint', '--faint'][i])
        document.body.append(probe)
        const expected = getComputedStyle(probe).color
        probe.remove()
        const style = getComputedStyle(dot)
        return [i === 0 ? style.borderTopColor : style.backgroundColor, expected, style.animationName]
      })
    })
    colors.forEach(([actual, expected, animation], index) => {
      assert.equal(actual, expected)
      assert.equal(animation === 'terminal-spin', index === 0)
    })
  })
  await page.evaluate(() => window.awb.winResize(1440, 900))
  await page.screenshot({ path: path.join(shots, 'terminal-status.png') })
  await check('settings retain keyboard shortcuts', async () => {
    await page.click('[data-a=settings]')
    await page.click('[data-a=sec][data-id=keys]')
    assert.ok(await page.locator('.settings kbd').count() >= 8)
    await page.click('[data-a=back]')
  })
  await check('completed agent accepts another command', async () => {
    await page.click('[data-a=tab][data-id=ready]')
    await page.evaluate(() => window.awb.ptyWrite('ready', 'echo AWB_STILL_READY\r'))
    await page.waitForFunction(() => window.__awbBuffer('ready').includes('AWB_STILL_READY'))
    await page.waitForSelector('[data-a=tab][data-id=ready][data-state=exited]')
  })
  await page.click('[data-a=tab][data-id=busy]')
  await check('closing agent stops its complete process tree', async () => {
    await page.locator('.tab').filter({ has: page.locator('[data-a=tab][data-id=busy]') }).locator('[data-a=close]').click()
    await page.click('[data-a=confirm]')
    await page.waitForSelector('[data-a=tab][data-id=busy]', { state: 'detached' })
    await until(() => liveFixturePids().length === 0, 'Agent process tree survived closing its tab')
    const state = await page.evaluate(() => window.awb.getState())
    assert.ok(!state.db.sessions.p1.some((term) => term.id === 'busy'))
    assert.ok(await page.locator('[data-a=tab][data-id=shell]').count(), 'Unrelated terminal was closed')
    await page.evaluate(() => window.awb.ptyRestart('busy'))
    assert.equal(pids().length, 3, 'Closed session restarted')
  })
  await check('closing during startup cannot launch an orphan later', async () => {
    await page.evaluate(async (shell) => {
      await window.awb.ptyCreate({ id: 'early-close', projectId: 'p1', kind: 'busy', shell })
      await window.awb.ptyClose('early-close')
    }, shell)
    await new Promise((resolve) => setTimeout(resolve, 1500))
    assert.equal(pids().length, 3)
  })
  await check('dead shell does not show a ready green dot', async () => {
    await page.click('[data-a=tab][data-id=shell]')
    await page.evaluate(() => window.awb.ptyWrite('shell', 'exit\r'))
    await page.waitForSelector('[data-a=tab][data-id=shell][data-state=exited]')
    assert.equal(await page.locator('[data-a=tab][data-id=shell] .terminal-status.inactive').count(), 1)
  })
  await check('overflow keeps active tab and plus accessible', async () => {
    for (let i = 0; i < 9; i++) {
      await page.click('.addtab[data-a=newterm]')
      await page.click('[data-a=ntk][data-id=shell]')
      await page.click('[data-a=nt-ok]')
    }
    await page.waitForSelector('.tabs.over')
    const visible = await page.evaluate(() => {
      const view = document.querySelector('.tabs').getBoundingClientRect()
      const tab = document.querySelector('.tab.on').getBoundingClientRect()
      const plus = document.querySelector('.addtab[data-a=newterm]').getBoundingClientRect()
      const bar = document.querySelector('.tabbar').getBoundingClientRect()
      return tab.left >= view.left - 1 && tab.right <= view.right + 1 && plus.right <= bar.right
    })
    assert.ok(visible)
  })
  await page.evaluate(() => window.awb.winResize(1440, 900))
  await page.click('[data-a=tab][data-id=ready]')
  await page.screenshot({ path: path.join(shots, 'terminal-dark.png') })
  await page.click('[data-a=settings]')
  await page.click('[data-a=sec][data-id=look]')
  await page.click('[data-a=theme][data-id=light]')
  await page.click('[data-a=back]')
  await page.screenshot({ path: path.join(shots, 'terminal-light.png') })
  await checkTabbar('light')
  await check('light theme keeps exited terminals gray', async () => {
    const color = await page.locator('[data-a=tab][data-id=ready] .dot').evaluate((dot) => getComputedStyle(dot).backgroundColor)
    assert.equal(color, 'rgb(96, 102, 114)')
  })
  await page.evaluate((shell) => window.awb.ptyCreate({ id: 'shutdown', projectId: 'p1', kind: 'busy', shell }), shell)
  await until(() => pids().length === 6, 'Shutdown process tree did not start')
  const closed = app.waitForEvent('close')
  await page.getByRole('button', { name: '关闭窗口', exact: true }).click()
  await closed
  appClosed = true
  await until(() => electronProcess.exitCode !== null || electronProcess.signalCode !== null, 'Application process did not finish exiting')
  assert.equal(electronProcess.exitCode, 0, 'Application must exit normally after cleanup')
} finally {
  if (!appClosed) await app.close()
  await check('application shutdown stops all remaining agent processes', async () => {
    await until(() => liveFixturePids().length === 0, 'Agent processes survived application shutdown').catch((error) => {
      console.error('Shutdown fixture identity', JSON.stringify({ pidFile, expected: pids(), remaining: liveFixturePids() }))
      const remaining = liveFixturePids()
      if (isWin && remaining.length) console.error(execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -in @(${remaining.join(',')}) } | Select-Object ProcessId,ParentProcessId,CreationDate,CommandLine | ConvertTo-Json -Compress`], { encoding: 'utf8', windowsHide: true }))
      throw error
    })
  })
  for (const pid of liveFixturePids()) {
    try {
      if (isWin) execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore' })
      else process.kill(pid, 'SIGKILL')
    } catch { /* already exited */ }
  }
}
assert.equal(failures.length, 0, failures.join(', '))
console.log('Terminal checks passed')
