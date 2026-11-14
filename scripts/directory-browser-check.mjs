import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright'
import { loadTypeScript } from './fixtures/load-ts.mjs'
const { themeVariables } = await loadTypeScript(new URL('../src/shared/themes.ts', import.meta.url))

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-directory-browser-'))
fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify({ hosts: [
  { id: 'wsl-fixture', name: 'WSL fixture', addr: 'localhost', port: 22, user: 'tester', auth: 'key', on: true, os: 'Linux', platform: 'linux' }
] }))
const env = { ...process.env, AWB_USER_DATA: data }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: ['.'], env })
try {
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('path:list')
    ipcMain.handle('path:list', async (_event, _host, input) => {
      if (input === '/slow') await new Promise((resolve) => setTimeout(resolve, 500))
      const current = input || '/home/tester'
      if (current === '/denied') return { path: current, parent: '/', dirs: [], error: 'Permission denied' }
      if (current === '/throws') throw new Error('Connection lost')
      return { path: current, parent: current === '/' ? null : '/', dirs: current === '/empty' ? [] : [
        { name: 'projects', path: '/home/tester/projects' }, { name: '下载', path: '/home/tester/下载' }
      ] }
    })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(8000)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.locator('[data-a=newproj]').locator('..').hover()
  await page.click('[data-a=newproj]')
  await page.click('[data-a=nph][data-id=wsl-fixture]')
  await page.click('[data-a=browse]')
  const browser = page.locator('dialog:has(.directory-browser)')
  await page.getByLabel('浏览路径', { exact: true }).waitFor({ timeout: 3000 })
  await page.waitForFunction(() => document.querySelector('[aria-label="浏览路径"]')?.value === '/home/tester')
  fs.mkdirSync(path.resolve('.cache/directory-browser-shots'), { recursive: true })
  await page.screenshot({ path: path.resolve('.cache/directory-browser-shots/current.png') })
  assert.equal(await page.locator('dialog[open]').count(), 1, 'Remote browsing must open a separate modal directory picker')
  await page.getByLabel('筛选子目录').fill('下载')
  assert.equal(await browser.locator('.directory-entry').count(), 1)
  await browser.getByRole('button', { name: '下载', exact: true }).dblclick()
  await page.waitForFunction(() => document.querySelector('[aria-label="浏览路径"]')?.value === '/home/tester/下载')
  await browser.getByRole('button', { name: '返回', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('[aria-label="浏览路径"]')?.value === '/home/tester')
  await browser.getByRole('button', { name: '前进', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('[aria-label="浏览路径"]')?.value === '/home/tester/下载')
  async function go(input) {
    await page.getByLabel('浏览路径', { exact: true }).fill(input)
    await page.getByLabel('浏览路径', { exact: true }).press('Enter')
    await page.waitForFunction(() => !document.querySelector('.directory-browser')?.textContent.includes('正在读取目录'))
  }
  await go('/denied')
  await browser.getByRole('alert').filter({ hasText: 'Permission denied' }).waitFor()
  assert.equal(await browser.getByRole('button', { name: /^使用此目录/ }).isDisabled(), true)
  await go('/throws')
  await browser.getByRole('alert').filter({ hasText: 'Connection lost' }).waitFor()
  await browser.getByRole('button', { name: '主目录', exact: true }).click()
  await browser.getByRole('button', { name: 'projects', exact: true }).waitFor()
  await browser.getByRole('button', { name: '上一级', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('[aria-label="浏览路径"]')?.value === '/')
  assert.equal(await browser.getByRole('button', { name: '上一级', exact: true }).isDisabled(), true)
  await go('/empty')
  await browser.getByText('此目录没有子文件夹', { exact: true }).waitFor()
  await page.getByLabel('浏览路径', { exact: true }).fill('/slow')
  await browser.getByRole('button', { name: '前往', exact: true }).click()
  await browser.getByRole('status').filter({ hasText: '正在读取目录' }).waitFor()
  await browser.getByRole('button', { name: '主目录', exact: true }).click()
  await browser.getByRole('button', { name: 'projects', exact: true }).waitFor()
  await page.waitForTimeout(650)
  assert.equal(await page.getByLabel('浏览路径', { exact: true }).inputValue(), '/home/tester', 'Stale requests must not overwrite a later navigation')
  const shots = path.resolve('.cache/directory-browser-shots')
  fs.mkdirSync(shots, { recursive: true })
  for (const theme of ['dark', 'light']) for (const [width, height] of [[1024, 680], [1440, 900]]) {
    await page.setViewportSize({ width, height })
    await page.evaluate(({ theme, variables }) => { document.documentElement.dataset.theme = theme; for (const [key, value] of Object.entries(variables)) document.documentElement.style.setProperty(key, value) }, { theme, variables: themeVariables(theme) })
    await browser.scrollIntoViewIfNeeded()
    await page.screenshot({ path: path.join(shots, `${theme}-${width}.png`) })
    assert.equal(await browser.evaluate((el) => el.scrollWidth <= el.clientWidth), true)
    assert.equal(await browser.evaluate((el) => { const r = el.getBoundingClientRect(); return r.top >= 23 && r.bottom <= innerHeight - 23 }), true)
  }
  await browser.getByRole('button', { name: 'projects', exact: true }).click()
  assert.equal(await page.getByLabel('浏览路径', { exact: true }).inputValue(), '/home/tester', 'Single click selects without navigating')
  await browser.getByRole('button', { name: /^使用此目录/ }).click()
  assert.equal(await page.locator('[data-np=path]').inputValue(), '/home/tester/projects')
  assert.equal(await browser.count(), 0)
  assert.equal(await page.locator('[data-a=browse]').evaluate((el) => el === document.activeElement), true)
  await page.click('[data-a=browse]')
  await browser.waitFor()
  await page.keyboard.press('Tab')
  assert.equal(await page.evaluate(() => !!document.activeElement.closest('dialog[open]')), true, 'Outer form must not steal Tab focus')
  await page.keyboard.press('Escape')
  assert.equal(await browser.count(), 0)
  assert.equal(await page.locator('[data-np=path]').inputValue(), '/home/tester/projects', 'Cancel preserves the form path')
  assert.equal(await page.locator('#modal .dlg').count(), 1, 'Escape closes only the directory picker')
  await page.click('[data-a=nph][data-id=local]')
  assert.equal(await browser.count(), 0, 'Switching hosts closes the previous environment browser')
  await page.click('[data-a=nph][data-id=wsl-fixture]'); await page.click('[data-a=browse]')
  await browser.waitFor()
  // Resource dialogs can be constrained by the settings content column, independently of window width.
  await browser.evaluate((node) => { node.style.maxWidth = '440px'; document.documentElement.style.setProperty('--ui-size', '16px') })
  await page.getByLabel('浏览路径', { exact: true }).waitFor()
  const compact = await browser.locator('.directory-location').evaluate((node) => {
    const crumbs = node.querySelector('.directory-crumbs').getBoundingClientRect()
    return { width: crumbs.width, overflow: node.scrollWidth > node.clientWidth }
  })
  assert.ok(!compact.overflow && compact.width >= 120, `Narrow directory dialogs must retain usable breadcrumbs alongside filtering: ${JSON.stringify(compact)}`)
  await page.getByLabel('筛选子目录').fill('下载')
  assert.equal(await browser.locator('.directory-entry').count(), 1)
  await page.screenshot({ path: path.join(shots, 'compact-large-font.png') })
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await page.click('[data-a=settings]'); await page.click('[data-a=sec][data-id=general]')
  await page.getByLabel('应用语言', { exact: true }).selectOption('en')
  await page.click('[data-a=back]')
  await page.click('[data-a=newproj]'); await page.click('[data-a=nph][data-id=wsl-fixture]'); await page.click('[data-a=browse]')
  await browser.waitFor()
  await browser.evaluate((node) => { node.style.maxWidth = '440px'; document.documentElement.style.setProperty('--ui-size', '16px') })
  await page.getByLabel('Filter subdirectories').fill('下载')
  assert.equal(await browser.locator('.directory-entry').count(), 1)
  assert.ok(await browser.evaluate((node) => {
    const panel = node.getBoundingClientRect()
    return node.scrollWidth <= node.clientWidth && [...node.querySelectorAll('footer button')].every((button) => { const r = button.getBoundingClientRect(); return r.left >= panel.left && r.right <= panel.right && r.bottom <= panel.bottom })
  }), 'Narrow English dialogs must retain visible footer actions')
  await page.screenshot({ path: path.join(shots, 'compact-english-large-font.png') })
  await page.keyboard.press('Escape')
  console.log('PASS remote directory picker: modal focus/Escape, single selection/double-click navigation, history, path entry, Unicode filter, home/parent, errors, empty/loading, stale navigation, selection/cancel, host switch, four layouts and compact Chinese/English large-font dialogs')
} finally { await app.close() }
