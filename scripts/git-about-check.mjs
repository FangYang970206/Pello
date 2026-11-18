import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { _electron as electron } from 'playwright'
import { loadTypeScript } from './fixtures/load-ts.mjs'

const { changeTree } = await loadTypeScript(new URL('../src/renderer/git-change-tree.ts', import.meta.url))
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pello-git-about-'))
const project = path.join(data, 'project')
const empty = path.join(data, 'empty')
const shots = path.resolve('output/playwright/git-about')
fs.mkdirSync(project); fs.mkdirSync(empty); fs.mkdirSync(shots, { recursive: true })
const git = (...args) => execFileSync('git', ['-C', project, ...args], { windowsHide: true, encoding: 'utf8' })
git('init', '-q'); git('config', 'core.autocrlf', 'false')
for (const name of ['src/deep/中文 空格.txt', 'src/other.txt', 'deleted.txt', 'renamed.txt']) {
  fs.mkdirSync(path.dirname(path.join(project, name)), { recursive: true })
  fs.writeFileSync(path.join(project, name), 'original\n')
}
git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture')
fs.writeFileSync(path.join(project, 'src/deep/中文 空格.txt'), 'changed\n')
fs.writeFileSync(path.join(project, 'src/other.txt'), 'other\n')
fs.unlinkSync(path.join(project, 'deleted.txt'))
git('mv', 'renamed.txt', 'new-name.txt')
fs.mkdirSync(path.join(project, 'large'))
for (let index = 0; index < 600; index++) fs.writeFileSync(path.join(project, 'large', `item-${String(index).padStart(4, '0')}.txt`), 'new\n')
fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify({ settings: { restore: false, layout: 'balanced', autoCheckUpdates: false }, projects: [
  { id: 'p', name: 'Tree fixture', path: project, host: 'local', agent: 'shell' },
  { id: 'empty', name: 'Empty fixture', path: empty, host: 'local', agent: 'shell' }
] }))
const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version
const env = { ...process.env, AWB_USER_DATA: data }; delete env.ELECTRON_RUN_AS_NODE
for (const scale of [1, 1.25, 1.5, 2]) {
  const app = await electron.launch({ args: ['.', `--force-device-scale-factor=${scale}`], env })
  const errors = []
  try {
    const page = await app.firstWindow(); page.setDefaultTimeout(15000)
    page.on('pageerror', (error) => errors.push(error.message))
    await page.locator('[data-a=rmode][data-id=changes]').click()
    await page.locator('[data-a=diff]').first().waitFor()
    if (scale === 1) {
      const panel = await page.evaluate(() => window.awb.gitStatus('p'))
      const all = changeTree(panel.files, '', new Set())
      assert.deepEqual(all.filter((row) => row.file).map((row) => row.path).sort(), panel.files.map((file) => file.path).sort(), 'Tree preserves every Git path and status')
      const scoped = panel.files.slice(0, 3).map((file) => ({ ...file, path: 'repo-a/' + file.path, repository: 'repo-a' }))
      assert.ok(changeTree(scoped, 'repo-a', new Set()).every((row) => !row.name.includes('repo-a')), 'Repository prefix is not repeated inside its tree')
      assert.equal(await page.getByText('git status', { exact: true }).count(), 0)
      assert.equal(await page.getByText('自动发现子仓库', { exact: true }).count(), 0)
      await page.click('[data-a=git-view]')
      await page.locator('[data-a=git-dir][data-id="large/"]').click()
      await page.locator('[data-a=git-dir][data-id="src/"]').waitFor()
      const directory = page.locator('[data-a=git-dir][data-id="src/"]')
      await directory.focus(); await directory.press('ArrowLeft')
      assert.equal(await directory.getAttribute('aria-expanded'), 'false')
      assert.equal(await page.locator('[data-a=diff][data-id^="src/"]').count(), 0)
      await directory.press('ArrowRight')
      const file = page.locator('[data-a=diff][data-id="src/deep/中文 空格.txt"]')
      await file.click(); await page.locator('.diffbar .path').waitFor()
      assert.ok((await page.locator('.diff').textContent()).includes('changed'), 'Tree opens the actual Unicode file diff')
      await page.click('[data-a=git-view]')
      await page.click('[data-a=git-view]')
      assert.ok((await page.locator('.diff').textContent()).includes('changed'), 'Switching views preserves the active diff')
      await page.locator('[data-a=git-dir][data-id="large/"]').click()
      await page.locator('.git-change-rows [data-virtual-index] button').first().focus()
      await page.keyboard.press('End')
      await page.waitForFunction((last) => document.activeElement?.getAttribute('data-id') === last, all.at(-1).path)
      await page.keyboard.press('Home')
      await page.waitForFunction(() => document.activeElement?.getAttribute('data-id') === 'large/')
      assert.ok(await page.locator('.git-change-rows button').count() < 100, 'Tree remains virtualized')
      await page.locator('[data-a=git-dir][data-id="large/"]').click()
      await file.waitFor()
      fs.writeFileSync(path.join(project, 'src/new-after-scan.txt'), 'fresh\n')
      await page.click('[data-a=git-refresh]')
      await page.locator('[data-a=diff][data-id="src/new-after-scan.txt"]').waitFor()
      await page.locator('[data-a=proj][data-id=empty]').click()
      await page.getByText('不是 Git 仓库', { exact: true }).waitFor()
      assert.equal(await page.locator('[data-a=git-refresh]').isEnabled(), true, 'Empty/error states retain the same refresh control')
      await page.locator('[data-a=proj][data-id=p]').click()
      await page.locator('[data-a=diff]').first().waitFor()
    } else {
      if (await page.locator('[data-a=git-view]').getAttribute('aria-pressed') === 'false') await page.click('[data-a=git-view]')
      await page.locator('[data-a=git-dir][data-id="large/"]').click()
    }
    for (const theme of ['light', 'dark']) for (const [width, height] of [[1440, 900], [1024, 680]]) for (const font of [12, 16]) {
      if (scale !== 1 && (width !== 1024 || font !== 16)) continue
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), [width, height])
      await page.click('[data-a=settings]')
      await page.click('[data-a=sec][data-id=general]')
      const language = theme === 'dark' ? 'en' : 'zh-CN'
      await page.locator('[data-set=language]').selectOption(language)
      await page.click('[data-a=sec][data-id=look]')
      await page.click(`[data-a=theme][data-id=${theme}]`)
      await page.getByRole('combobox', { name: /^(界面字号|Interface font size)$/ }).selectOption(String(font))
      await page.click('[data-a=sec][data-id=about]')
      await page.waitForFunction((version) => document.querySelector('[data-about=version]')?.textContent === 'v' + version, version)
      assert.equal(await page.locator('.snav .navb').last().getAttribute('data-id'), 'about')
      const navigation = await page.locator('.snav').evaluate((node) => {
        const keys = node.querySelector('[data-id="keys"]'), about = node.querySelector('[data-id="about"]'), skills = node.querySelector('[data-id="skills"]')
        return { next: keys.nextElementSibling?.getAttribute('data-id'), gap: about.getBoundingClientRect().top - keys.getBoundingClientRect().bottom, normalGap: keys.getBoundingClientRect().top - skills.getBoundingClientRect().bottom }
      })
      assert.equal(navigation.next, 'about')
      assert.ok(Math.abs(navigation.gap - navigation.normalGap) < 1, 'About follows Shortcuts with the same spacing as the other navigation items')
      assert.equal(await page.locator('.scol > h1').count(), 0, 'About omits the redundant section title')
      assert.equal(await page.locator('.about-view h1').textContent(), 'Pello', 'The product name is the page heading')
      assert.equal(await page.locator('.about-details dt').filter({ hasText: /^(作品作者|Created by)$/ }).locator('..').locator('dd').textContent(), language === 'zh-CN' ? '方阳' : 'FangYang', 'Author follows the application language')
      const logo = await page.locator('.about-logo').boundingBox()
      const column = await page.locator('.scol').boundingBox()
      assert.equal(Math.round(logo.width), 128)
      assert.ok(Math.abs(logo.x + logo.width / 2 - column.x - column.width / 2) < 2, 'Brand icon is centered in the settings column')
      if (scale === 1 && theme === 'light' && font === 12 && width === 1440) {
        const animatedEye = page.locator('.about-eye').first()
        const eyeScale = async (time) => page.locator('.about-eye').evaluateAll((nodes, time) => { for (const node of nodes) { const animation = node.getAnimations()[0]; animation.pause(); animation.currentTime = time } return getComputedStyle(nodes[0]).transform }, time)
        const opened = await eyeScale(0), blinked = await eyeScale(496)
        assert.notEqual(opened, blinked, 'The actual eye shape blinks')
        await page.screenshot({ path: path.join(shots, 'about-blink.png') })
        await eyeScale(1600)
        await app.evaluate(({ shell }) => { globalThis.__aboutLinks = []; shell.openExternal = async (url) => { globalThis.__aboutLinks.push(url) } })
        await page.locator('.about-details a').click()
        assert.deepEqual(await app.evaluate(() => globalThis.__aboutLinks), ['https://github.com/FangYang970206/Pello'])
        await page.emulateMedia({ reducedMotion: 'reduce' })
        assert.equal(await animatedEye.evaluate((node) => getComputedStyle(node).animationName), 'none')
        await page.emulateMedia({ reducedMotion: 'no-preference' })
        await page.click('[data-a=sec][data-id=keys]'); await page.click('[data-a=sec][data-id=about]')
        assert.ok(await animatedEye.evaluate((node) => node.getAnimations().length > 0), 'Reopening About restarts the greeting')
      }
      const address = await page.locator('.about-details a').boundingBox()
      const view = await page.locator('.scontent').boundingBox()
      assert.ok(address.x >= view.x && address.x + address.width <= view.x + view.width && address.y + address.height <= view.y + view.height, 'The actual website action stays visible and clickable')
      await page.screenshot({ path: path.join(shots, `about-${scale}-${theme}-${width}-${font}.png`), animations: 'disabled' })
      await page.click('[data-a=back]')
      await page.locator('[data-a=git-refresh]').waitFor()
      await page.locator('[data-a=git-view]').click()
      await page.locator('[data-a=git-dir][data-id="large/"]').click()
      const handle = page.locator('.right-resize')
      await handle.focus()
      for (let step = 0; step < 30; step++) await handle.press('ArrowRight')
      const positions = await page.locator('.git-toolbar').evaluate((node) => {
        const buttons = [...node.querySelectorAll('button')].map((button) => { const box = button.getBoundingClientRect(); return { x: box.x, right: box.right, width: box.width } })
        const box = node.getBoundingClientRect(); return { buttons, x: box.x, right: box.right }
      })
      assert.ok(positions.buttons[0].right <= positions.buttons[1].x && positions.right - positions.buttons[1].right <= 10, 'View toggle sits immediately left of the right-aligned refresh')
      assert.ok(positions.buttons.every((button) => button.width >= 24 && button.x >= positions.x), 'Both actions remain usable in the narrow panel')
      await page.locator('[data-a=diff][data-id="src/deep/中文 空格.txt"]').click()
      assert.ok(await page.locator('[data-a=diff][data-id="src/new-after-scan.txt"] .num').evaluate((node) => { const a = node.getBoundingClientRect(), b = node.closest('.rlist').getBoundingClientRect(); return a.right <= b.right && a.left >= b.left }), 'Narrow tree keeps change counts visible beside the truncated filename')
      await page.screenshot({ path: path.join(shots, `tree-${scale}-${theme}-${width}-${font}.png`), animations: 'disabled' })
    }
    assert.deepEqual(errors, [])
  } finally { await app.close() }
}
console.log('PASS Git flat/tree, folding, exact-path diffs, refresh, large-list keyboard access; About metadata, external link, blinking, reduced motion; light/dark, Chinese/English, two sizes, 12/16px, four DPI scales')
