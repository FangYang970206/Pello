import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright'

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pello-menu-position-'))
const home = path.join(data, 'home'), shots = path.resolve('output/playwright/menu-position')
fs.mkdirSync(shots, { recursive: true })
const files = Array.from({ length: 8 }, (_, i) => `long-filename-for-tabs-fixture-${i}.txt`)
for (const name of files) fs.writeFileSync(path.join(data, name), 'Menu fixture\n')
for (let i = 0; i < 15; i++) {
  const folder = path.join(home, '.claude/skills', `fixture-${String(i).padStart(2, '0')}`)
  fs.mkdirSync(folder, { recursive: true })
  fs.writeFileSync(path.join(folder, 'SKILL.md'), `---\nname: fixture-${String(i).padStart(2, '0')}\ndescription: Menu placement fixture\n---\nFixture\n`)
}
fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify({
  settings: { theme: 'light', restore: false, confirmKill: false, autoCheckUpdates: false },
  projects: [{ id: 'p', name: 'Menu fixture', path: data, host: 'local', agent: 'shell' }],
  workSessions: { p: [{ id: 's', name: 'Session fixture' }] }
}))
const env = { ...process.env, AWB_USER_DATA: data, AWB_RESOURCE_HOME: home }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: ['.'], env })
const failures = [], baselines = new Map(), measurements = []
try {
  const page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.locator('[data-a=proj]').click()
  if (!await page.locator('[data-a=preview]').count()) await page.locator('[data-a=right]').click()
  await page.locator('[data-a=rmode][data-id=files]').click()
  for (const name of files) await page.locator(`[data-a=preview][data-id="${name}"]`).click()
  async function compareSurface(name, selector, theme, width) {
    const surface = page.locator(selector)
    await surface.waitFor()
    await page.evaluate(() => document.fonts.ready)
    const m = await surface.boundingBox(), viewport = page.viewportSize() || await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
    const key = `${name}/${width}`, previous = baselines.get(key)
    if (m.x < 0 || m.y < 0 || m.x + m.width > viewport.width + 1 || m.y + m.height > viewport.height + 1) failures.push(`${key}: surface exceeds viewport: ${JSON.stringify(m)}`)
    if (previous && Object.keys(m).some((key) => Math.abs(m[key] - previous[key]) > 1)) failures.push(`${name}/${theme}/${width}: theme changes surface geometry: ${JSON.stringify(m)} vs ${JSON.stringify(previous)}`)
    if (!previous) baselines.set(key, m)
    measurements.push({ name, theme, width, menu: m })
    await page.screenshot({ path: path.join(shots, `${name}-${theme}-${width}.png`) })
  }
  async function geometry(anchor, selector) {
    return anchor.evaluate((node, selector) => {
      const a = node.getBoundingClientRect(), menu = document.querySelector(selector), m = menu.getBoundingClientRect()
      return { anchor: { x: a.x, y: a.y, width: a.width, height: a.height }, menu: { x: m.x, y: m.y, width: m.width, height: m.height },
        overflow: menu.scrollHeight > menu.clientHeight + 1, viewport: { width: innerWidth, height: innerHeight } }
    }, selector)
  }
  async function measure(name, anchor, theme, width, alignSidebar = false) {
    await page.locator(':popover-open').waitFor()
    // Wait for layout/focus scroll events, rather than accepting initial inline coordinates.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const g = await geometry(anchor, ':popover-open'), { anchor: a, menu: m, viewport: v } = g
    const expectedX = alignSidebar ? await page.locator('.plist').evaluate((node) => node.getBoundingClientRect().left) : a.x
    const x = Math.max(12, Math.min(expectedX, v.width - m.width - 12))
    const below = v.height - a.y - a.height - 12
    const y = below >= m.height ? a.y + a.height + 4 : Math.max(12, a.y - m.height - 4)
    const label = `${name}/${theme}/${width}`
    if (Math.abs(m.x - x) > 1 || Math.abs(m.y - y) > 1 || g.overflow) failures.push(`${label}: misplaced or overflowing: ${JSON.stringify(g)}, expected ${x},${y}`)
    const key = `${name}/${width}`, baseline = baselines.get(key)
    if (baseline && Object.keys(m).some((key) => Math.abs(m[key] - baseline[key]) > 1)) failures.push(`${label}: theme changes geometry: ${JSON.stringify(m)} vs ${JSON.stringify(baseline)}`)
    if (!baseline) baselines.set(key, m)
    measurements.push({ name, theme, width, ...g })
    await page.screenshot({ path: path.join(shots, `${name}-${theme}-${width}.png`) })
    await page.keyboard.press('Escape')
    assert.equal(await anchor.evaluate((node) => node === document.activeElement), true, `${label}: Escape returns focus`)
  }
  for (const [width, height] of [[1024, 680], [1440, 900]]) {
    await page.evaluate(([w, h]) => window.awb.winResize(w, h), [width, height])
    await page.waitForFunction((w) => innerWidth === w, width)
    for (const theme of ['light', 'dark', 'nord', 'dracula', 'catppuccin', 'solarized-light']) {
      await page.click('[data-a=settings]'); await page.click('[data-a=sec][data-id=look]')
      await page.click(`[data-a=theme][data-id=${theme}]`)
      await page.click('[data-a=sec][data-id=skills]')
      const trigger = page.getByRole('button', { name: 'Skill 菜单 fixture-00', exact: true })
      await trigger.click(); await measure('skill', trigger, theme, width)
      await trigger.click()
      await page.locator('.scontent').evaluate((node) => { node.scrollTop += 40 })
      await measure('skill-after-scroll', trigger, theme, width)
      const last = page.getByRole('button', { name: 'Skill 菜单 fixture-09', exact: true })
      await last.click(); await measure('skill-scrolled', last, theme, width)
      await last.click()
      const resizedWidth = width === 1024 ? 1440 : 1024, resizedHeight = width === 1024 ? 900 : 680
      await page.evaluate(([w, h]) => window.awb.winResize(w, h), [resizedWidth, resizedHeight])
      await page.waitForFunction((w) => innerWidth === w, resizedWidth)
      await measure(`skill-resized-from-${width}`, last, theme, resizedWidth)
      await page.evaluate(([w, h]) => window.awb.winResize(w, h), [width, height])
      await page.waitForFunction((w) => innerWidth === w, width)
      await page.click('[data-a=sec][data-id=general]')
      const agent = page.locator('[data-set=defAgent]')
      await agent.click(); await measure('default-agent', agent, theme, width)
      await page.click('[data-a=sec][data-id=hosts]')
      await page.click('[data-a=host]:not([data-id])')
      await compareSurface('host-dialog', '.dlg', theme, width)
      await page.locator('.dlg header [data-a=mclose]').click()
      await page.click('[data-a=sec][data-id=agents]')
      await page.click('[data-a=custom]:not([data-id])')
      await compareSurface('executor-dialog', '.dlg', theme, width)
      await page.locator('.dlg header [data-a=mclose]').click()
      await page.click('[data-a=back]')
      await page.locator('[data-a=tabs-menu]').click()
      await compareSurface('all-tabs', '.pop', theme, width)
      await page.locator('[data-a=tabs-menu]').click()
      const project = page.locator('[data-a=proj]')
      await project.click({ button: 'right' }); await measure('project', project, theme, width, true)
      const session = page.locator('[data-a=side-session]')
      await session.focus(); await session.press('Shift+F10'); await measure('session', session, theme, width, true)
      const recent = page.locator('[data-a=agents-toggle]')
      await recent.click({ button: 'right' }); await measure('recent', recent, theme, width, true)
      await page.locator('[data-a=projects-toggle]').hover()
      await page.click('[data-a=newproj]')
      await compareSurface('new-project-dialog', '.dlg', theme, width)
      const picker = page.locator('[data-np=agent]')
      await picker.click(); await measure('project-agent', picker, theme, width)
      await page.keyboard.press('Escape')
      console.log(`Checked ${theme} ${width}`)
    }
  }
  fs.writeFileSync(path.join(shots, 'geometry.json'), JSON.stringify(measurements, null, 2))
  assert.deepEqual(failures, [])
  console.log('PASS anchored click/context/keyboard menus: identical geometry across six themes, two sizes, scrolled Skills, viewport edges and focus return')
} finally { await app.close() }
