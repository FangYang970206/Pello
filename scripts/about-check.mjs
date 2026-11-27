// The About page of the built app, as the Electron build's `git-about-check`
// reads it: it is the last settings section, drawn with its own heading; the
// version is the package's, the author follows the application language, and
// the one homepage is opened by the kernel (written to a log here, so no
// browser is started). The eyes blink, stop under reduced motion and start
// again when the page is reopened. Light and dark, Chinese and English, two
// window sizes and interface font sizes 12 and 16, all on fresh screenshots.
// Drives the running app over the WebView2 debugging port.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launch, sleep } from './tauri-app.mjs'

if (process.platform !== 'win32') {
  console.log('SKIP About page: drives the Windows WebView2, Windows only')
  process.exit(0)
}

const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version
const openLog = fs.mkdtempSync(path.join(os.tmpdir(), 'pello-about-open-'))
const openLogPath = path.join(openLog, 'opened.log')
const shots = path.resolve('output/playwright/about')
fs.mkdirSync(shots, { recursive: true })

const app = await launch({ env: { AWB_OPEN_BIN: 'true', AWB_OPEN_LOG: openLogPath } })
try {
  const { page } = app
  page.setDefaultTimeout(15000)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))

  const resize = async (width, height) => {
    await page.evaluate(([w, h]) => window.awb.winResize(w, h), [width, height])
    await sleep(900)
    assert.deepEqual(await page.evaluate(() => [window.innerWidth, window.innerHeight]), [width, height], `the window is not ${width}x${height}`)
  }
  const openAbout = async () => {
    if (await page.locator('.settings').count() === 0) await page.click('[data-a=settings]')
    await page.click('[data-a=sec][data-id=about]')
    await page.waitForFunction((version) => document.querySelector('[data-about=version]')?.textContent === 'v' + version, version)
  }
  const setLook = async (theme, language, font) => {
    if (await page.locator('.settings').count() === 0) await page.click('[data-a=settings]')
    await page.click('[data-a=sec][data-id=general]')
    await page.locator('[data-set=language]').selectOption(language)
    await page.click('[data-a=sec][data-id=look]')
    await page.click(`[data-a=theme][data-id=${theme}]`)
    await page.getByRole('combobox', { name: /^(界面字号|Interface font size)$/ }).selectOption(String(font))
  }

  for (const theme of ['light', 'dark']) for (const [width, height] of [[1440, 900], [1024, 680]]) for (const font of [12, 16]) {
    await resize(width, height)
    await setLook(theme, theme === 'dark' ? 'en' : 'zh-CN', font)
    await openAbout()
    const language = theme === 'dark' ? 'en' : 'zh-CN'
    assert.equal(await page.locator('.snav .navb').last().getAttribute('data-id'), 'about', 'About is the last navigation item')
    assert.equal(await page.locator('.snav').evaluate((node) => node.querySelector('.navb[data-id=keys]')?.nextElementSibling?.getAttribute('data-id')), 'about', 'About follows Shortcuts')
    // It follows Shortcuts with the same spacing as every other item.
    const navigation = await page.locator('.snav').evaluate((node) => {
      const keys = node.querySelector('.navb[data-id=keys]').getBoundingClientRect(), about = node.querySelector('.navb[data-id=about]').getBoundingClientRect()
      const skills = node.querySelector('.navb[data-id=skills]').getBoundingClientRect()
      return { gap: about.top - keys.bottom, normalGap: keys.top - skills.bottom }
    })
    assert.ok(Math.abs(navigation.gap - navigation.normalGap) < 1, `About is spaced ${navigation.gap}px from Shortcuts, other items ${navigation.normalGap}px`)
    assert.equal(await page.locator('.scol > h1').count(), 0, 'About draws no section title above its own heading')
    assert.equal(await page.locator('.scol > .lead').count(), 0, 'About draws no lead line')
    assert.equal(await page.locator('.about-view h1').textContent(), 'Pello', 'the product name is the page heading')
    assert.equal(await page.locator('[data-about=version]').textContent(), `v${version}`, 'the version is the package version')
    assert.equal(await page.locator('.about-details dt').filter({ hasText: /^(作品作者|Created by)$/ }).locator('..').locator('dd').textContent(), language === 'zh-CN' ? '方阳' : 'FangYang', 'the author follows the application language')
    const meta = await page.evaluate(() => window.awb.meta())
    assert.deepEqual({ version: meta.version, author: meta.author, homepage: meta.homepage }, { version, author: language === 'zh-CN' ? '方阳' : 'FangYang', homepage: 'https://github.com/FangYang970206/Pello' })
    const logo = await page.locator('.about-logo').boundingBox()
    const column = await page.locator('.scol').boundingBox()
    assert.equal(Math.round(logo.width), 128)
    assert.ok(Math.abs(logo.x + logo.width / 2 - column.x - column.width / 2) < 2, 'the logo is centered in the settings column')
    // Every row, the link and the logo are inside what the settings show.
    const view = await page.locator('.scontent').boundingBox()
    for (const selector of ['.about-logo', '.about-view h1', '.about-details > div']) {
      for (const box of await page.locator(selector).evaluateAll((nodes) => nodes.map((node) => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom } }))) {
        assert.ok(box.left >= view.x - 1 && box.right <= view.x + view.width + 1, `${selector} is inside the settings column`)
        assert.ok(box.top >= view.y, `${selector} starts inside the visible settings area`)
      }
    }
    const address = await page.locator('.about-details a').boundingBox()
    assert.ok(address.x >= view.x && address.x + address.width <= view.x + view.width && address.y >= view.y && address.y + address.height <= view.y + view.height, 'the website action stays visible and clickable')
    assert.equal(await page.locator('.about-details a').getAttribute('href'), 'https://github.com/FangYang970206/Pello', 'the link names the homepage')
    assert.ok(address.height >= font && address.width >= 48, `the website action is ${address.width}x${address.height}, smaller than a line of its text`)
    const fontSize = await page.locator('.about-details dd').first().evaluate((node) => getComputedStyle(node).fontSize)
    assert.equal(fontSize, `${font}px`, 'the About details follow the interface font size')
    if (theme === 'light' && width === 1440 && font === 12) {
      // The eye shape itself changes: the animation is read off the element.
      // This is read before any screenshot: a screenshot with animations
      // disabled ends them, and the element has none afterwards.
      const eyeScale = (time) => page.locator('.about-eye').evaluateAll((nodes, time) => {
        for (const node of nodes) { const animation = node.getAnimations()[0]; animation.pause(); animation.currentTime = time }
        return getComputedStyle(nodes[0]).transform
      }, time)
      const opened = await eyeScale(0), blinked = await eyeScale(496)
      assert.notEqual(opened, blinked, 'the eye does not blink')
      await page.locator('.about-eye').first().evaluate((node) => { for (const animation of node.getAnimations()) animation.play() })
      await page.emulateMedia({ reducedMotion: 'reduce' })
      assert.equal(await page.locator('.about-eye').first().evaluate((node) => getComputedStyle(node).animationName), 'none', 'the eye still animates under reduced motion')
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      assert.ok(await page.locator('.about-eye').first().evaluate((node) => node.getAnimations().length > 0), 'the eye does not animate again when reduced motion is lifted')
      // The kernel opens the homepage: the page asks it and nothing else.
      await page.locator('.about-details a').click()
      await sleep(800)
      assert.deepEqual(fs.readFileSync(openLogPath, 'utf8').split(/\r?\n/).filter(Boolean), ['https://github.com/FangYang970206/Pello'], 'clicking the link did not open the homepage')
      await page.click('[data-a=sec][data-id=keys]')
      assert.equal(await page.locator('.about-view').count(), 0)
      await page.click('[data-a=sec][data-id=about]')
      await page.waitForFunction((version) => document.querySelector('[data-about=version]')?.textContent === 'v' + version, version)
      assert.ok(await page.locator('.about-eye').first().evaluate((node) => node.getAnimations().length > 0), 'reopening About does not start the greeting again')
    }
    await page.screenshot({ path: path.join(shots, `about-${theme}-${width}-${font}.png`), animations: 'disabled' })
    // Back leaves settings; About is reachable by keyboard like every section.
    await page.locator('.snav .navb[data-id=about]').focus()
    await page.keyboard.press('Enter')
    assert.equal(await page.locator('.about-view').count(), 1)
    await page.click('[data-a=back]')
    assert.equal(await page.locator('.settings').count(), 0)
  }
  assert.deepEqual(errors, [])
} finally {
  await app.close()
  fs.rmSync(openLog, { recursive: true, force: true })
}
console.log(`PASS About page: last section, own heading, version v${version}, author by language, kernel-opened homepage, blinking, reduced motion; light/dark, zh/en, 1440x900/1024x680, font 12/16`)
