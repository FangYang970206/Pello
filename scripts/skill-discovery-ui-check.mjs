import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import { _electron as electron } from 'playwright'
import { loadTypeScript } from './fixtures/load-ts.mjs'

const { themeVariables } = await loadTypeScript(new URL('../src/shared/themes.ts', import.meta.url))

const shots = path.resolve('.cache/skill-discovery/screenshots')
fs.mkdirSync(shots, { recursive: true })
const revision = 'a'.repeat(40)
const files = {}
for (let i = 0; i < 22; i++) files[`repo/skills/fixture-${i}/SKILL.md`] = strToU8(`---\nname: fixture-${i}\ndescription: Useful engineering skill with supporting instructions ${i}\n---\nBody`)
files['repo/skills/fixture-0/references/example.md'] = strToU8('reference')
const archive = Buffer.from(zipSync(files)).toString('base64')
const onlyDpi = Number(process.argv.find((arg) => arg.startsWith('--dpi='))?.slice(6))
for (const dpi of [1, 1.25, 1.5, 2].filter((value) => !onlyDpi || value === onlyDpi)) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pello-discovery-ui-')), home = path.join(data, 'home')
  fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify({ hosts: [{ id: 'remote-fixture', name: 'Remote Linux / 开发服务器', addr: 'linux.example.invalid', user: 'admin', port: 22, auth: 'key', on: false, platform: 'linux', os: 'Linux' }] }))
  const env = { ...process.env, AWB_USER_DATA: data, AWB_RESOURCE_HOME: home }; delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ args: ['.', `--force-device-scale-factor=${dpi}`], env })
  try {
    const page = await app.firstWindow()
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await app.evaluate(({ net }, { revision, archive }) => {
      globalThis.__discoveryMode = 'ok'
      globalThis.__discoveryRequests = []
      net.fetch = async (url, init) => {
        globalThis.__discoveryRequests.push(url)
        if (globalThis.__discoveryMode === 'failure') return new Response('unavailable', { status: 503 })
        if (globalThis.__discoveryMode === 'slow') await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 1000)
          init.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('cancelled')) }, { once: true })
        })
        if (url.includes('/git/trees/')) return Response.json({ tree: [{ path: 'skills/fixture-0/SKILL.md' }], truncated: false })
        return url.includes('/commits/') ? Response.json({ sha: revision }) : new Response(Buffer.from(archive, 'base64'))
      }
    }, { revision, archive })
    await page.click('[data-a=settings]')
    await page.click('[data-a=sec][data-id=skills]')
    await page.getByRole('button', { name: '发现', exact: true }).click()
    assert.equal(await page.locator('.skill-repository').count(), 5)
    const header = await page.locator('.resource-header-actions').evaluate((node) => { const [discover, add] = node.querySelectorAll('button'); return { gap: add.getBoundingClientRect().left - discover.getBoundingClientRect().right, icons: add.querySelectorAll('svg').length } })
    assert.ok(header.gap >= 7.9 && header.icons === 0, `Discover and Add are spaced text buttons: ${JSON.stringify(header)}`)
    for (const theme of ['dark', 'light']) {
      for (const [width, height, size] of [[1440, 900, 12], [1024, 680, 16]]) {
        await page.setViewportSize({ width, height })
        await page.evaluate(({ theme, size, variables }) => { document.documentElement.dataset.theme = theme; document.documentElement.dataset.palette = theme; for (const [key, value] of Object.entries(variables)) document.documentElement.style.setProperty(key, value); document.documentElement.style.setProperty('--ui-size', `${size}px`) }, { theme, size, variables: themeVariables(theme) })
        // Exercise the actual settings content container, independently of window width.
        if (width === 1440) await page.locator('.scol').evaluate((node) => { node.style.maxWidth = '460px' })
        else await page.locator('.scol').evaluate((node) => { node.style.maxWidth = '' })
        await page.waitForFunction(() => { const dialog = document.querySelector('dialog'); return dialog && dialog.getBoundingClientRect().width <= document.querySelector('.scol').getBoundingClientRect().width + 1 })
        const geometry = await page.locator('dialog').evaluate((dialog) => {
          const box = dialog.getBoundingClientRect(), footer = dialog.querySelector('footer').getBoundingClientRect(), body = dialog.querySelector('.bdy')
          const buttons = [...dialog.querySelectorAll('button')].filter((node) => !node.disabled)
          return { overflow: dialog.scrollWidth > dialog.clientWidth + 1, footerVisible: footer.bottom <= box.bottom + 1, body: body.clientHeight, buttons: buttons.map((button) => ({ width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height })), width: box.width }
        })
        assert.ok(!geometry.overflow && geometry.footerVisible && geometry.body > 100, JSON.stringify(geometry))
        assert.ok(geometry.buttons.every((button) => button.width >= 24 && button.height >= 24))
        await page.screenshot({ path: path.join(shots, `catalog-${dpi}-${theme}-${width}.png`) })
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.locator('.scol').evaluate((node) => { node.style.maxWidth = '' })
    await page.evaluate(() => document.documentElement.style.setProperty('--ui-size', '13px'))
    await page.waitForFunction(() => document.querySelector('dialog').getBoundingClientRect().width > 700)
    await page.screenshot({ path: path.join(shots, `catalog-wide-${dpi}.png`) })
    await page.getByRole('button', { name: '打开 mattpocock/skills', exact: true }).click()
    await page.getByText('发现 22 项 · 已选择 22 项', { exact: true }).waitFor()
    await page.locator('.scol').evaluate((node) => { node.style.maxWidth = '460px' })
    await page.evaluate(() => document.documentElement.style.setProperty('--ui-size', '16px'))
    await page.waitForFunction(() => { const list = document.querySelector('.skill-browser-list').getBoundingClientRect(), detail = document.querySelector('.skill-preview-content').getBoundingClientRect(); return detail.top >= list.bottom - 1 })
    await page.locator('.skill-preview').filter({ hasText: 'fixture-1' }).first().click()
    await page.waitForFunction(() => { const title = document.querySelector('.skill-preview-content h3').getBoundingClientRect(), body = document.querySelector('dialog .bdy').getBoundingClientRect(); return title.top >= body.top && title.bottom <= body.bottom })
    assert.ok(await page.getByRole('dialog').getByLabel('搜索 Skill').evaluate((node) => node.getBoundingClientRect().width >= 64))
    await page.screenshot({ path: path.join(shots, `preview-narrow-${dpi}.png`) })
    await page.locator('.scol').evaluate((node) => { node.style.maxWidth = '' })
    await page.evaluate(() => document.documentElement.style.setProperty('--ui-size', '13px'))
    await page.getByRole('button', { name: '取消全选', exact: true }).click()
    assert.equal(await page.getByRole('button', { name: '安装所选 Skill', exact: true }).isEnabled(), false)
    await page.getByRole('dialog').getByLabel('搜索 Skill', { exact: true }).fill('fixture-0')
    await page.locator('.skill-option').getByRole('checkbox').check()
    await page.getByRole('checkbox', { name: 'Pi', exact: true }).check()
    await page.screenshot({ path: path.join(shots, `selection-${dpi}.png`) })
    await page.getByRole('button', { name: '安装所选 Skill', exact: true }).click()
    await page.getByRole('dialog').waitFor({ state: 'detached' })
    await page.getByRole('tabpanel').getByText('fixture-0', { exact: true }).waitFor()
    for (const folder of ['.claude/skills', '.pi/agent/skills']) {
      assert.ok(fs.existsSync(path.join(home, folder, 'fixture-0/references/example.md')))
      assert.ok(!fs.existsSync(path.join(home, folder, 'fixture-1')))
    }
    assert.equal(await page.getByRole('button', { name: '发现', exact: true }).evaluate((node) => node === document.activeElement), true)
    await page.getByRole('button', { name: '发现', exact: true }).click()
    await app.evaluate(() => { globalThis.__discoveryMode = 'failure' })
    await page.locator('.skill-repository').first().click()
    await page.getByRole('alert').filter({ hasText: 'HTTP 503' }).waitFor()
    await app.evaluate(() => { globalThis.__discoveryMode = 'ok' })
    await page.getByRole('button', { name: '重试', exact: true }).click()
    await page.getByText('发现 22 项 · 已选择 22 项', { exact: true }).waitFor()
    await page.getByRole('button', { name: '安装所选 Skill', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: '已存在 fixture-0' }).first().waitFor()
    assert.equal(await page.locator('.skill-option input:checked').count(), 22, 'Failed installation preserves selection')
    await page.keyboard.press('Escape')
    await page.getByRole('dialog').waitFor({ state: 'detached' })
    await page.getByRole('button', { name: '发现', exact: true }).click()
    await app.evaluate(() => { globalThis.__discoveryMode = 'slow' })
    await page.locator('.skill-repository').first().click()
    await page.getByText('正在获取仓库中的 Skill…', { exact: true }).waitFor()
    await page.keyboard.press('Escape')
    await page.getByRole('dialog').waitFor({ state: 'detached' })
    await page.waitForTimeout(1200)
    assert.equal(await page.getByRole('alert').count(), 0, 'Cancelled request cannot publish stale errors')
    assert.deepEqual(fs.readdirSync(path.join(data, 'skill-discovery')).filter((name) => name !== 'repositories.json'), [])
    await app.evaluate(() => { globalThis.__discoveryMode = 'ok' })
    await page.getByRole('button', { name: '发现', exact: true }).click()
    await page.getByLabel('从 GitHub 导入仓库', { exact: true }).fill('https://github.com/example/new-skills')
    await page.getByRole('button', { name: '导入', exact: true }).click()
    await page.getByText('发现 22 项 · 已选择 22 项', { exact: true }).waitFor()
    await page.locator('.skill-readme').getByText('Body', { exact: true }).waitFor()
    await page.getByRole('button', { name: '返回仓库', exact: true }).click()
    assert.equal(await page.locator('.skill-repository').count(), 6)
    await page.keyboard.press('Escape')
    const state = await page.evaluate(() => window.awb.getState())
    await page.evaluate(async (settings) => { await window.awb.saveSettings({ ...settings, language: 'en' }) }, state.db.settings)
    await page.click('[data-a=sec][data-id=general]')
    await page.getByLabel('应用语言', { exact: true }).selectOption('en')
    await page.click('[data-a=sec][data-id=skills]')
    await page.getByRole('button', { name: 'Discover', exact: true }).click()
    await page.waitForFunction(() => getComputedStyle(document.querySelector('dialog')).opacity === '1')
    await page.screenshot({ path: path.join(shots, `catalog-${dpi}-english.png`) })
    await page.keyboard.press('Escape')
    await page.click('[data-a=sec][data-id=hosts]')
    await page.click('[data-a=host]')
    assert.equal(await page.getByLabel('Jump host', { exact: true }).count(), 0, 'No jump host configuration is added')
    for (const theme of ['dark', 'light']) {
      await page.evaluate(({ theme, variables }) => { document.documentElement.dataset.theme = theme; for (const [key, value] of Object.entries(variables)) document.documentElement.style.setProperty(key, value) }, { theme, variables: themeVariables(theme) })
      const folders = await page.locator('.host-color-option').evaluateAll((nodes) => nodes.map((node) => ({ color: getComputedStyle(node).color, fill: getComputedStyle(node.querySelector('path')).fill, stroke: getComputedStyle(node.querySelector('path')).stroke })))
      assert.equal(new Set(folders.map((folder) => folder.color)).size, 8)
      assert.ok(folders.every((folder) => folder.fill === folder.color && folder.stroke === 'none'))
      await page.screenshot({ path: path.join(shots, `folders-${dpi}-${theme}.png`) })
    }
    await page.keyboard.press('Escape')
    for (let i = 0; i < 12; i++) await page.keyboard.press('Tab')
    await page.click('[data-a=sec][data-id=skills]')
    await page.getByRole('button', { name: 'Discover', exact: true }).click()
    await app.evaluate(() => { globalThis.__discoveryMode = 'ok' })
    await page.locator('.skill-repository').first().click()
    await page.getByText('Found: 22 · Selected: 22', { exact: true }).waitFor()
    console.log(`PASS ${dpi * 100}% DPI: five repositories, actual narrow container, themes, sizes, partial install, focus, errors/retry, no overwrite, cancellation and English`)
  } finally { await app.close(); if (fs.existsSync(path.join(data, 'skill-discovery'))) assert.deepEqual(fs.readdirSync(path.join(data, 'skill-discovery')).filter((name) => name !== 'repositories.json'), [], 'Application shutdown cleans preview snapshots') }
}
