import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright'
import { loadTypeScript } from './fixtures/load-ts.mjs'

const { themeVariables } = await loadTypeScript(new URL('../src/shared/themes.ts', import.meta.url))
const repos = ['mattpocock/skills', 'anthropics/skills', 'obra/superpowers', 'QingYunA/answer-me-with-html', 'pbakaus/impeccable']
const shots = path.resolve('output/playwright/skill-recommendations')
fs.mkdirSync(shots, { recursive: true })
for (const dpi of [1, 1.25, 1.5, 2]) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pello-skill-recommendations-'))
  const home = path.join(data, 'home'), env = { ...process.env, AWB_USER_DATA: data, AWB_RESOURCE_HOME: home }; delete env.ELECTRON_RUN_AS_NODE
  fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify({ settings: { autoCheckUpdates: false } }))
  const app = await electron.launch({ args: ['.', `--force-device-scale-factor=${dpi}`], env })
  try {
    const page = await app.firstWindow()
    await app.evaluate(({ shell }) => {
      globalThis.__openedRepositories = []
      shell.openExternal = async (url) => { globalThis.__openedRepositories.push(url) }
    })
    await page.click('[data-a=settings]')
    await page.click('[data-a=sec][data-id=skills]')
    const recommend = page.getByRole('button', { name: '推荐', exact: true })
    const add = page.getByRole('button', { name: '添加', exact: true })
    const header = await page.locator('.resource-header-actions').evaluate((node) => {
      const [recommend, add] = node.querySelectorAll('button')
      return { gap: add.getBoundingClientRect().left - recommend.getBoundingClientRect().right, icons: add.querySelectorAll('svg').length }
    })
    assert.ok(header.gap >= 7.9 && header.icons === 0, JSON.stringify(header))
    await recommend.click()
    const panel = page.getByRole('dialog', { name: '推荐 Skill' })
    assert.equal(await panel.locator('.skill-repository').count(), repos.length)
    assert.equal(await panel.locator('input,form').count(), 0)
    for (const [theme, width, height, size, narrow] of [['light', 1440, 900, 12, false], ['dark', 1024, 680, 16, false], ['light', 1440, 900, 16, true], ['dark', 1024, 680, 12, true]]) {
      await page.setViewportSize({ width, height })
      await page.evaluate(({ theme, size, variables, narrow }) => {
        document.documentElement.dataset.theme = theme
        document.documentElement.dataset.palette = theme
        for (const [key, value] of Object.entries(variables)) document.documentElement.style.setProperty(key, value)
        document.documentElement.style.setProperty('--ui-size', `${size}px`)
        document.querySelector('.scol').style.maxWidth = narrow ? '420px' : ''
      }, { theme, size, variables: themeVariables(theme), narrow })
      await page.waitForFunction(() => document.querySelector('dialog').getBoundingClientRect().width <= document.querySelector('.scol').getBoundingClientRect().width + 1)
      const geometry = await panel.evaluate((dialog) => {
        const box = dialog.getBoundingClientRect(), footer = dialog.querySelector('footer').getBoundingClientRect(), body = dialog.querySelector('.bdy')
        return { overflow: dialog.scrollWidth > dialog.clientWidth + 1, footerVisible: footer.bottom <= box.bottom + 1, body: body.clientHeight }
      })
      assert.ok(!geometry.overflow && geometry.footerVisible && geometry.body > 100, JSON.stringify(geometry))
      await page.screenshot({ path: path.join(shots, `${dpi}-${theme}-${width}-${size}.png`) })
    }
    for (const repository of repos) {
      const entry = panel.getByRole('button', { name: `在浏览器中打开 ${repository}`, exact: true })
      await entry.press('Enter')
    }
    await assert.rejects(page.evaluate(() => window.awb.openSkillRecommendation('https://example.invalid')))
    assert.deepEqual(await app.evaluate(() => globalThis.__openedRepositories), repos.map((repo) => `https://github.com/${repo}`))
    assert.equal(fs.existsSync(path.join(data, 'skill-discovery')), false)
    await page.keyboard.press('Escape')
    await panel.waitFor({ state: 'detached' })
    assert.equal(await recommend.evaluate((node) => node === document.activeElement), true)
    await add.click()
    await page.getByRole('dialog', { name: '添加 Skill' }).waitFor()
    console.log(`PASS fixed browser links, keyboard focus, separate import, and narrow dark/light settings at ${dpi * 100}% DPI`)
  } finally { await app.close() }
}
