import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright'
import { loadTypeScript } from './fixtures/load-ts.mjs'
import { assertSettingsDialogPosition } from './fixtures/settings-dialog-position.mjs'

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
    for (const repository of repos) {
      const card = panel.getByRole('button', { name: `在浏览器中打开 ${repository}`, exact: true })
      const [owner, name] = repository.split('/')
      assert.equal(await card.locator('.skill-repository-top svg').count(), 1)
      assert.equal(await card.locator('.skill-repository-top > span').textContent(), owner)
      assert.equal(await card.locator('b').textContent(), name)
      assert.ok((await card.locator(':scope > span').last().textContent()).length > 0)
    }
    for (const [theme, width, height, size, narrow] of [['light', 1440, 900, 12, false], ['dark', 1024, 680, 16, false], ['light', 1440, 900, 16, true], ['dark', 1024, 680, 12, true]]) {
      await page.setViewportSize({ width, height })
      await page.evaluate(({ theme, size, variables, narrow }) => {
        document.documentElement.dataset.theme = theme
        document.documentElement.dataset.palette = theme
        for (const [key, value] of Object.entries(variables)) document.documentElement.style.setProperty(key, value)
        document.documentElement.style.setProperty('--ui-size', `${size}px`)
        document.querySelector('.scol').style.maxWidth = narrow ? '420px' : ''
      }, { theme, size, variables: themeVariables(theme), narrow })
      await assertSettingsDialogPosition(panel)
      const geometry = await panel.evaluate((dialog) => {
        const cards = [...dialog.querySelectorAll('.skill-repository')]
        return { columns: new Set(cards.map((card) => Math.round(card.getBoundingClientRect().left))).size,
          cardsFit: cards.every((card) => card.scrollWidth <= card.clientWidth + 1),
          scrollable: dialog.querySelector('.bdy').scrollHeight > dialog.querySelector('.bdy').clientHeight }
      })
      assert.ok(geometry.cardsFit && geometry.columns === (narrow ? 1 : 2), JSON.stringify(geometry))
      if (narrow && height === 680) assert.ok(geometry.scrollable, JSON.stringify(geometry))
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
