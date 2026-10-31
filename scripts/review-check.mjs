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
} finally {
  await app.close()
}

if (process.exitCode) process.exit(process.exitCode)
console.log('review checks passed')
