import { _electron as electron } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const userData = `/tmp/awb-pw-${Date.now()}`
fs.mkdirSync(userData, { recursive: true })
fs.mkdirSync('/tmp/awb-pw-demo/src', { recursive: true })
fs.writeFileSync('/tmp/awb-pw-demo/README.md', 'demo\n')
if (!fs.existsSync('/tmp/awb-pw-demo/.git')) {
  const { execFileSync } = await import('node:child_process')
  execFileSync('git', ['init', '-b', 'master'], { cwd: '/tmp/awb-pw-demo' })
  execFileSync('git', ['add', 'README.md'], { cwd: '/tmp/awb-pw-demo' })
  execFileSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=awb', 'commit', '-m', 'init'], { cwd: '/tmp/awb-pw-demo' })
}

const app = await electron.launch({
  args: [root, '--no-sandbox'],
  cwd: root,
  env: { ...process.env, AWB_USER_DATA: userData }
})

const page = await app.firstWindow()
page.setDefaultTimeout(20000)

const fail = (message) => {
  console.error(message)
  process.exitCode = 1
}

try {
  await page.waitForSelector('[data-a=newproj]')
  await page.click('[data-a=newproj]')
  await page.fill('[data-np=name]', 'pw-check')
  await page.fill('[data-np=path]', '/tmp/awb-pw-demo')
  await page.waitForSelector('#pchk small.ok, #pchk small')
  const create = page.locator('[data-a=np-ok]')
  await page.waitForFunction(() => {
    const node = document.querySelector('[data-a=np-ok]')
    return node && !node.disabled
  })
  await create.click()
  await page.waitForSelector('[data-a=quick]')
  await page.click('[data-a=quick]')
  await page.waitForSelector('.xterm')
  await page.waitForFunction(() => {
    const id = document.querySelector('.tab.on [data-a=tab]')?.getAttribute('data-id') || ''
    return (window.__awbBuffer?.(id) || '').includes('$')
  })

  for (let i = 0; i < 8; i++) {
    await page.click('.addtab[data-a=newterm]')
    await page.click('[data-a=ntk][data-id=shell]')
    await page.click('[data-a=nt-ok]')
    await page.waitForFunction(() => (window.__awbBuffer?.(document.querySelector('.tab.on [data-a=tab]')?.getAttribute('data-id') || '') || '').includes('$'))
  }

  const tab = await page.evaluate(() => {
    const scroller = document.querySelector('.tabs')
    const node = document.querySelector('.tab.on')
    const close = node?.querySelector('.x')
    if (!scroller || !node || !close) return { ok: false, reason: 'missing tab' }
    const view = scroller.getBoundingClientRect()
    const box = node.getBoundingClientRect()
    const x = close.getBoundingClientRect()
    const inside = box.left >= view.left - 1 && box.right <= view.right + 1 && x.left >= view.left - 1 && x.right <= view.right + 1 && x.width > 8
    return { ok: inside, box: [box.left, box.right], view: [view.left, view.right], x: [x.left, x.right, x.width] }
  })
  if (!tab.ok) fail(`激活标签不在 .tabs 内 ${JSON.stringify(tab)}`)
  else console.log('tab rect ok', JSON.stringify(tab))

  await page.click('[data-a=settings]')
  await page.click('[data-a=sec][data-id=look]')
  await page.click('[data-a=theme][data-id=light]')
  await page.click('[data-a=back]')
  await page.waitForFunction(() => {
    const pane = [...document.querySelectorAll('.pane')].find((node) => !node.hasAttribute('hidden') && node.offsetWidth > 0 && node.querySelector('.xterm'))
    return !!pane
  })
  await page.waitForTimeout(400)
  const light = await page.evaluate(() => {
    const pane = [...document.querySelectorAll('.pane')].find((node) => !node.hasAttribute('hidden') && node.querySelector('.xterm'))
    const id = pane?.getAttribute('data-id') || ''
    const text = window.__awbBuffer?.(id) || ''
    return { theme: document.documentElement.dataset.theme, empty: !text.trim(), sample: text.trim().slice(0, 80) }
  })
  if (light.theme !== 'light' || light.empty) fail(`浅色主题 buffer 异常 ${JSON.stringify(light)}`)
  else console.log('light buffer ok', light.sample)

  const cycle = async (label, root) => {
    const count = await page.evaluate((selector) => {
      const node = document.querySelector(selector)
      if (!node) return 0
      return node.querySelectorAll('button, input, select, textarea, a[href]').length
    }, root)
    const steps = Math.max(count + 2, 8)
    for (const key of ['Tab', 'Shift+Tab']) {
      for (let i = 0; i < steps; i++) {
        await page.keyboard.press(key)
        const where = await page.evaluate((selector) => {
          const box = document.querySelector(selector)
          const el = document.activeElement
          const inside = !!(box && el && box.contains(el))
          return {
            inside,
            xterm: !!el?.closest?.('.xterm'),
            work: !!el?.closest?.('#center, aside.side, aside.right'),
            name: el?.getAttribute?.('aria-label') || el?.textContent?.trim()?.slice(0, 32) || el?.tagName || ''
          }
        }, root)
        if (!where.inside || where.xterm || where.work) {
          fail(`${label} ${key} 第 ${i + 1} 次焦点跑出弹窗 ${JSON.stringify(where)}`)
          return false
        }
      }
    }
    console.log(`focus cycle ok ${label} (${steps} Tab + ${steps} Shift+Tab)`)
    return true
  }

  const openClose = async (label, opener, open) => {
    await open()
    await page.waitForSelector('#modal .dlg')
    const cycled = await cycle(label, '#modal .dlg')
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('#modal .dlg'))
    const back = await page.evaluate((selector) => {
      const node = document.querySelector(selector)
      const el = document.activeElement
      return {
        ok: !!node && el === node,
        active: el?.getAttribute?.('aria-label') || el?.textContent?.trim()?.slice(0, 40) || el?.tagName || ''
      }
    }, opener)
    if (!back.ok) fail(`${label} Esc 后焦点没有回到打开它的元素 ${JSON.stringify(back)}`)
    else console.log(`focus return ok ${label}`)
    return cycled && back.ok
  }

  await openClose('新建项目', '.side [data-a=newproj]', () => page.click('.side [data-a=newproj]'))
  await openClose('新建终端', '.addtab[data-a=newterm]', () => page.click('.addtab[data-a=newterm]'))

  await page.click('.pane:not([hidden]) .xterm')
  await page.keyboard.type('sleep 30')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => {
    const button = document.querySelector('[data-a=kill]')
    return !!button && !button.hasAttribute('disabled')
  })
  await openClose('结束进程确认', '[data-a=kill]', () => page.click('[data-a=kill]'))

  await page.click('[data-a=settings]')
  await page.waitForSelector('.settings')
  await cycle('设置页', '.settings')
  await openClose('添加执行器', 'button[data-a=custom]', async () => {
    await page.click('[data-a=sec][data-id=agents]')
    await page.click('button[data-a=custom]')
  })
  await openClose('添加机器', 'button[data-a=host]', async () => {
    await page.click('[data-a=sec][data-id=hosts]')
    await page.click('button[data-a=host]')
  })
  await page.locator('.settings .back').focus()
  await page.keyboard.press('Escape')
  await page.waitForSelector('.settings', { state: 'detached' })
  const settingsBack = await page.evaluate(() => {
    const opener = document.querySelector('[data-a=settings]')
    return { ok: document.activeElement === opener, active: document.activeElement?.textContent?.trim()?.slice(0, 24) || '' }
  })
  if (!settingsBack.ok) fail(`设置页 Esc 后焦点没有回到设置按钮 ${JSON.stringify(settingsBack)}`)
  else console.log('focus return ok 设置页')
} finally {
  await app.close()
}

async function assertRestored(label, activeTab, expectId) {
  const data = `/tmp/awb-pw-restore-${label}-${Date.now()}`
  fs.mkdirSync(data, { recursive: true })
  const db = {
    settings: { theme: 'dark', fontSize: 13, defShell: 'bash', defAgent: 'shell', restore: true, confirmKill: true },
    projects: [{ id: 'p1', name: 'pw-restore', host: 'local', path: '/tmp/awb-pw-demo', branch: 'master', agent: 'shell' }],
    sessions: {
      p1: [
        { id: 'term-bash', kind: 'shell', shell: 'bash' },
        { id: 'term-bash-2', kind: 'shell', shell: 'bash' }
      ]
    }
  }
  if (activeTab !== undefined) db.activeTab = activeTab
  fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify(db, null, 2))
  const restoreApp = await electron.launch({
    args: [root, '--no-sandbox'],
    cwd: root,
    env: { ...process.env, AWB_USER_DATA: data }
  })
  try {
    const page = await restoreApp.firstWindow()
    page.setDefaultTimeout(20000)
    await page.waitForFunction((id) => {
      const empty = [...document.querySelectorAll('h2')].some((node) => node.textContent === '还没有终端')
      const tabs = [...document.querySelectorAll('.tabs .tab')]
      const on = document.querySelector('.tabs .tab.on [data-a=tab]')
      const pane = document.querySelector('.pane:not([hidden])')
      const state = document.querySelector('.pstate b')?.textContent || ''
      const onId = on?.getAttribute('data-id') || ''
      const paneId = pane?.getAttribute('data-id') || ''
      const buffer = window.__awbBuffer?.(onId) || ''
      return !empty && tabs.length === 2 && onId === id && paneId === id && (state === '运行中' || state === '空闲') && buffer.includes('$')
    }, expectId)
    fs.mkdirSync('/opt/cursor/artifacts/review', { recursive: true })
    const shot = `/opt/cursor/artifacts/review/v4_restore_${label}.png`
    await page.screenshot({ path: shot })
    console.log(`restore ok ${label} -> ${expectId} ${shot}`)
  } catch (err) {
    fail(`恢复激活失败 ${label}: ${err instanceof Error ? err.message : err}`)
  } finally {
    await restoreApp.close()
  }
}

await assertRestored('missing', undefined, 'term-bash')
await assertRestored('invalid', { p1: 'ghost-tab' }, 'term-bash')
await assertRestored('valid', { p1: 'term-bash-2' }, 'term-bash-2')

if (process.exitCode) process.exit(process.exitCode)
console.log('review checks passed')
