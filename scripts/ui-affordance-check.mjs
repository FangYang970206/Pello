import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright'

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pello-affordance-'))
const home = path.join(data, 'home'), shots = path.resolve('output/playwright/ui-affordance')
fs.mkdirSync(shots, { recursive: true })
const skill = path.join(home, '.claude/skills/visible-menu')
fs.mkdirSync(skill, { recursive: true })
fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: visible-menu\ndescription: Menu visibility fixture\n---\nFixture')
const env = { ...process.env, AWB_USER_DATA: data, AWB_RESOURCE_HOME: home }
delete env.ELECTRON_RUN_AS_NODE
const failures = []
const check = (condition, message) => { if (!condition) failures.push(message) }
const launch = () => electron.launch({ args: ['.'], env })
let app = await launch()
try {
  let page = await app.firstWindow()
  await page.locator('[data-a=projects-toggle]').waitFor()
  let database = (await page.evaluate(() => window.awb.getState())).db
  check(database.settings.theme === 'light', 'Fresh installation must default to light')
  check(await page.locator('.newp,.empty [data-a=newproj]').count() === 0, 'Project creation belongs only in the Projects heading')
  await app.close()
  fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify({ ...database,
    settings: { ...database.settings, theme: undefined, restore: false, confirmKill: false },
    projects: [{ id: 'p', name: 'Hover fixture', path: data, host: 'local', agent: 'shell' }]
  }))
  app = await launch(); page = await app.firstWindow()
  await page.locator('[data-a=proj]').waitFor()
  check((await page.evaluate(() => window.awb.getState())).db.settings.theme === 'light', 'Missing theme in an existing configuration must default to light')
  const reveal = async (row, button, label) => {
    await page.mouse.move(800, 500)
    await page.evaluate(() => document.activeElement?.blur())
    const opacity = () => button.evaluate((node) => Number(getComputedStyle(node).opacity))
    check(await opacity() === 0, `${label}: hidden at rest`)
    await row.hover()
    check(await opacity() === 1, `${label}: revealed on row hover`)
    await button.hover()
    const backgrounds = await button.evaluate((node) => ({ own: getComputedStyle(node).backgroundColor }))
    check(backgrounds.own === 'rgba(0, 0, 0, 0)', `${label}: add control shares the row surface`)
    await page.mouse.move(800, 500)
    await page.keyboard.press('Tab')
    await button.focus()
    check(await opacity() === 1, `${label}: revealed for keyboard focus`)
    check(await button.evaluate((node) => node.matches(':focus-visible')), `${label}: visible keyboard focus`)
    await page.evaluate(() => document.activeElement?.blur())
  }
  for (const theme of ['light', 'dark', 'nord', 'dracula', 'catppuccin', 'solarized-light']) {
    await page.click('[data-a=settings]'); await page.click('[data-a=sec][data-id=look]')
    await page.click(`[data-a=theme][data-id=${theme}]`)
    await page.click('[data-a=back]')
    for (const [width, height] of [[1024, 680], [1440, 900]]) {
      await page.evaluate(([width, height]) => window.awb.winResize(width, height), [width, height])
      await page.waitForFunction((width) => innerWidth === width, width)
      const alignment = await page.evaluate(() => {
        const heading = document.querySelector('[data-a=projects-toggle]'), folder = document.querySelector('.project-folder').getBoundingClientRect(), bar = document.querySelector('.tabbar').getBoundingClientRect()
        const text = [...heading.childNodes].find((node) => node.textContent.trim() === '项目')
        const range = document.createRange(); range.selectNodeContents(text)
        const label = range.getBoundingClientRect(), box = heading.getBoundingClientRect()
        return { y: (box.top + box.bottom - bar.top - bar.bottom) / 2, x: label.left - folder.left }
      })
      check(Math.abs(alignment.y) < 2 && Math.abs(alignment.x) < 2, `${theme}: section title aligns with the terminal bar and folder icons: ${JSON.stringify(alignment)}`)
      check((await page.locator('[data-a=agents-toggle]').textContent()).trim() === '最近', 'Agents heading is renamed to 最近')
      for (const action of ['projects-toggle', 'temporary-toggle', 'agents-toggle']) {
        const toggle = page.locator(`[data-a=${action}]`), row = toggle.locator('..'), arrow = toggle.locator('svg')
        const original = await toggle.getAttribute('aria-expanded')
        for (const expanded of [true, false]) {
          if (await toggle.getAttribute('aria-expanded') !== String(expanded)) await toggle.click()
          await page.mouse.move(800, 500); await page.evaluate(() => document.activeElement?.blur())
          check(await arrow.evaluate((node) => Number(getComputedStyle(node).opacity)) === Number(!expanded), `${theme} ${action}: expanded arrow hides at rest; collapsed arrow stays visible`)
          const geometry = await arrow.evaluate((node) => ({ arrow: node.getBoundingClientRect().right, row: node.closest('.sidebar-section-heading').getBoundingClientRect().right }))
          check(geometry.row - geometry.arrow <= 10, `${theme} ${action}: disclosure is at the far right`)
          await row.hover()
          check(await arrow.evaluate((node) => Number(getComputedStyle(node).opacity)) === 1, `${theme} ${action}: hover reveals disclosure`)
          await page.mouse.move(800, 500); await page.keyboard.press('Tab'); await toggle.focus()
          check(await arrow.evaluate((node) => Number(getComputedStyle(node).opacity)) === 1, `${theme} ${action}: keyboard focus reveals disclosure`)
        }
        if (await toggle.getAttribute('aria-expanded') !== original) await toggle.click()
      }
      const projectToggle = page.locator('[data-a=proj]'), folderPath = () => projectToggle.locator('.project-folder path').getAttribute('d')
      const expandedFolder = await folderPath()
      await projectToggle.press('ArrowLeft')
      check(await folderPath() !== expandedFolder, `${theme}: open and closed folders have different shapes`)
      await projectToggle.press('ArrowRight')
      check(await folderPath() === expandedFolder, `${theme}: expanded folder shape is restored`)
      const heading = page.locator('[data-a=projects-toggle]').locator('..')
      await reveal(heading, page.locator('.side [data-a=newproj]'), `${theme} projects`)
      await reveal(page.locator('.proj'), page.locator('[data-a=new-session]'), `${theme} project`)
      await page.locator('[data-a=new-session]').focus(); await page.keyboard.press('Enter')
      await page.getByRole('dialog').waitFor(); await page.keyboard.press('Escape')
      await reveal(page.locator('.temporary-group .sidebar-section-heading'), page.locator('[data-a=temporary-session]'), `${theme} temporary`)
      await reveal(page.locator('.tabbar'), page.locator('.tabtools [data-a=newterm]'), `${theme} terminal`)
      await page.locator('.proj').hover()
      await page.screenshot({ path: path.join(shots, `hover-${theme}-${width}.png`) })
      const add = page.locator('.side [data-a=newproj]')
      await add.focus(); await page.keyboard.press('Enter')
      await page.getByRole('dialog', { name: '新建项目', exact: true }).waitFor()
      await page.keyboard.press('Escape')
      check(await add.evaluate((node) => node === document.activeElement), 'Project dialog restores focus to the heading add control')
      await page.click('[data-a=settings]'); await page.click('[data-a=sec][data-id=skills]')
      const more = page.getByRole('button', { name: 'Skill 菜单 visible-menu', exact: true })
      await more.waitFor()
      const dot = await more.evaluate((node) => {
        const svg = node.querySelector('svg'), box = svg.getBBox(), style = getComputedStyle(node)
        const surface = getComputedStyle(node.closest('.card')).backgroundColor
        const luminance = (color) => color.match(/[\d.]+/g).slice(0, 3).map(Number).map((n) => n / 255).map((n) => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4).reduce((a, n, i) => a + n * [.2126, .7152, .0722][i], 0)
        const a = luminance(style.color), b = luminance(surface)
        return { height: box.height, contrast: (Math.max(a, b) + .05) / (Math.min(a, b) + .05), opacity: style.opacity }
      })
      check(dot.height >= 3 && dot.contrast >= 4.5 && dot.opacity === '1', `${theme}: ellipsis has substantial visible dots and accessible contrast: ${JSON.stringify(dot)}`)
      await more.focus(); await page.keyboard.press('Enter')
      await page.getByRole('menuitem', { name: '在资源管理器打开', exact: true }).waitFor()
      await page.screenshot({ path: path.join(shots, `skill-menu-${theme}-${width}.png`) })
      await page.keyboard.press('Escape')
      check(await more.evaluate((node) => node === document.activeElement), 'Skill menu restores focus')
      await page.click('[data-a=back]')
    }
  }
  await app.close(); app = await launch(); page = await app.firstWindow()
  await page.locator('[data-a=projects-toggle]').waitFor()
  database = (await page.evaluate(() => window.awb.getState())).db
  check(database.settings.theme === 'solarized-light', 'Saved theme must survive restart')
  assert.deepEqual(failures, [])
  console.log('PASS title/bar/folder alignment, right-side disclosure states, open/closed folder icons, Recent heading, fresh light default, saved theme, mouse/keyboard add controls and Skill menus in six themes at two sizes')
} finally { await app.close() }
