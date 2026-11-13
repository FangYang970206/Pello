import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright'

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-resource-dialog-')), home = path.join(data, 'home')
const root = path.join(home, '.claude/skills'), shots = path.resolve('.cache/resource-layout')
fs.mkdirSync(shots, { recursive: true })
for (const name of ['long-skill', 'delete-me', 'untouched']) {
  fs.mkdirSync(path.join(root, name), { recursive: true })
  fs.writeFileSync(path.join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: Layout fixture\n---\n` + 'Skill instructions and supporting content.\n'.repeat(150))
  fs.writeFileSync(path.join(root, name, 'support.txt'), 'Keep supporting files')
}
fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { 'fixture-mcp': { url: 'https://example.invalid/mcp' } } }))
const env = { ...process.env, AWB_USER_DATA: data, AWB_RESOURCE_HOME: home }; delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: ['.'], env })
try {
  const page = await app.firstWindow()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await app.evaluate(({ shell }) => {
    globalThis.__resourceOps = { opened: [], deleted: [], failOpen: false, failDelete: true }
    shell.openPath = async (folder) => { globalThis.__resourceOps.opened.push(folder); return globalThis.__resourceOps.failOpen ? 'Fixture open failed' : '' }
    shell.trashItem = async (folder) => {
      globalThis.__resourceOps.deleted.push(folder)
      await new Promise((resolve) => setTimeout(resolve, 100))
      if (globalThis.__resourceOps.failDelete) throw new Error('Fixture trash failed')
      await new Promise((resolve) => { globalThis.__completeTrash = resolve })
    }
  })
  await page.click('[data-a=settings]')
  async function section(id) { await page.click(`[data-a=sec][data-id=${id}]`) }
  async function aligned(compact = false) {
    const geometry = await page.evaluate(() => {
      const dialog = document.querySelector('dialog'), box = dialog.getBoundingClientRect(), area = document.querySelector('.scontent').getBoundingClientRect(), col = document.querySelector('.scol').getBoundingClientRect()
      const body = dialog.querySelector('.bdy'), footer = dialog.querySelector('footer').getBoundingClientRect()
      return { offsetX: box.x + box.width / 2 - col.x - col.width / 2, offsetY: box.y + box.height / 2 - area.y - area.height / 2,
        inside: box.left >= area.left && box.right <= area.right && box.top >= area.top && box.bottom <= area.bottom,
        height: box.height, pageHeight: area.height, scrollable: body.scrollHeight > body.clientHeight, footerVisible: footer.bottom <= box.bottom + 1,
        overflow: dialog.scrollWidth > dialog.clientWidth + 1 }
    })
    assert.ok(Math.abs(geometry.offsetX) < 2 && Math.abs(geometry.offsetY) < 2, JSON.stringify(geometry))
    assert.ok(geometry.inside && geometry.footerVisible && !geometry.overflow, JSON.stringify(geometry))
    if (compact) assert.ok(geometry.height <= geometry.pageHeight * .6 + 1 && geometry.scrollable, JSON.stringify(geometry))
  }
  for (const theme of ['dark', 'light', 'nord', 'dracula', 'catppuccin', 'solarized-light']) {
    await section('look'); await page.click(`[data-a=theme][data-id=${theme}]`)
    for (const [width, height] of [[1440, 900], [1024, 680]]) {
      await page.evaluate(([width, height]) => window.awb.winResize(width, height), [width, height])
      await page.waitForFunction((width) => innerWidth === width, width)
      await section('skills')
      const inspect = page.getByRole('button', { name: '查看 long-skill 详情', exact: true })
      await inspect.click(); await aligned(true)
      await page.screenshot({ path: path.join(shots, `skill-detail-${theme}-${width}.png`) })
      for (let i = 0; i < 5; i++) {
        await page.keyboard.press('Tab')
        assert.equal(await page.evaluate(() => document.querySelector('dialog').contains(document.activeElement)), true)
      }
      const point = await page.evaluate(() => { const area = document.querySelector('.scontent').getBoundingClientRect(); return { x: area.left + 8, y: area.top + 8 } })
      const dialogBox = await page.getByRole('dialog').boundingBox()
      await page.mouse.move(dialogBox.x + 60, dialogBox.y + 25); await page.mouse.down(); await page.mouse.move(point.x, point.y); await page.mouse.up()
      assert.equal(await page.getByRole('dialog').count(), 1, 'Dragging from the dialog must not dismiss it')
      await page.mouse.click(point.x, point.y)
      await page.getByRole('dialog').waitFor({ state: 'detached' })
      assert.equal(await inspect.evaluate((element) => element === document.activeElement), true, 'Backdrop dismissal returns focus to the detail button')
      await page.getByRole('button', { name: '添加 Skill', exact: true }).click(); await aligned()
      await page.screenshot({ path: path.join(shots, `skill-add-${theme}-${width}.png`) })
      await page.keyboard.press('Escape')
      await section('mcp')
      await page.getByRole('button', { name: '添加 MCP', exact: true }).click(); await aligned()
      await page.screenshot({ path: path.join(shots, `mcp-add-${theme}-${width}.png`) })
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: '查看 fixture-mcp 详情', exact: true }).click(); await aligned()
      await page.screenshot({ path: path.join(shots, `mcp-detail-${theme}-${width}.png`) })
      await page.keyboard.press('Escape')
    }
  }
  console.log('PASS resource add/detail dialogs align with the current page in six themes and both window sizes; Skill details fit 60% height with scrolling, keyboard focus and backdrop dismissal')
  await section('skills')
  const trigger = page.getByRole('button', { name: 'Skill 菜单 delete-me', exact: true })
  await trigger.focus(); await trigger.press('Enter')
  await page.getByRole('menuitem', { name: '在资源管理器打开', exact: true }).waitFor()
  await page.keyboard.press('ArrowDown')
  assert.equal(await page.evaluate(() => document.activeElement.textContent), '删除')
  await page.keyboard.press('Escape')
  assert.equal(await trigger.evaluate((element) => element === document.activeElement), true)
  await trigger.click()
  const menuStyle = await page.getByRole('menu').evaluate((menu) => ({ font: getComputedStyle(menu).fontFamily, expected: getComputedStyle(document.body).fontFamily, overflow: menu.scrollHeight > menu.clientHeight + 1 }))
  assert.equal(menuStyle.font, menuStyle.expected)
  assert.equal(menuStyle.overflow, false, 'Two menu items should fit without a needless scrollbar')
  await page.screenshot({ path: path.join(shots, 'skill-menu.png') })
  await page.getByRole('menuitem', { name: '在资源管理器打开', exact: true }).click()
  assert.deepEqual(await app.evaluate(() => globalThis.__resourceOps.opened), [path.join(root, 'delete-me')])
  await app.evaluate(() => { globalThis.__resourceOps.failOpen = true })
  await trigger.click(); await page.getByRole('menuitem', { name: '在资源管理器打开', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: 'Fixture open failed' }).waitFor()
  const original = await page.evaluate(() => window.awb.resourceList('skills', 'claude', 1, 'delete-me'))
  await trigger.click(); await page.getByRole('menuitem', { name: '删除', exact: true }).click()
  await page.getByRole('dialog', { name: '删除 Skill', exact: true }).getByRole('button', { name: '取消', exact: true }).click()
  assert.equal(await trigger.evaluate((element) => element === document.activeElement), true)
  assert.deepEqual(await app.evaluate(() => globalThis.__resourceOps.deleted), [])
  await trigger.click(); await page.getByRole('menuitem', { name: '删除', exact: true }).click()
  const confirm = page.getByRole('dialog', { name: '删除 Skill', exact: true })
  await confirm.getByRole('button', { name: '删除', exact: true }).click()
  await confirm.getByRole('alert').filter({ hasText: 'Fixture trash failed' }).waitFor()
  assert.ok(fs.existsSync(path.join(root, 'delete-me/SKILL.md')))
  await app.evaluate(() => { globalThis.__resourceOps.failDelete = false })
  await confirm.getByRole('button', { name: '删除', exact: true }).click()
  assert.equal(await confirm.getByRole('button', { name: '正在删除…', exact: true }).isDisabled(), true)
  await page.waitForTimeout(150)
  assert.deepEqual(await app.evaluate(() => globalThis.__resourceOps.deleted), [path.join(root, 'delete-me'), path.join(root, 'delete-me')])
  fs.mkdirSync(path.join(data, 'trash'))
  fs.renameSync(path.join(root, 'delete-me'), path.join(data, 'trash/delete-me'))
  await app.evaluate(() => globalThis.__completeTrash())
  await confirm.waitFor({ state: 'detached' })
  await trigger.waitFor({ state: 'detached' })
  assert.deepEqual(await app.evaluate(() => globalThis.__resourceOps.deleted), [path.join(root, 'delete-me'), path.join(root, 'delete-me')])
  assert.equal(fs.readFileSync(path.join(data, 'trash/delete-me/support.txt'), 'utf8'), 'Keep supporting files')
  assert.ok(fs.existsSync(path.join(root, 'untouched/SKILL.md')))
  assert.equal(await page.evaluate((item) => window.awb.deleteSkill('claude', item).then(() => false, () => true), original.items[0]), true)
  assert.equal(await page.evaluate((item) => window.awb.openSkillFolder('claude', { ...item, path: 'C:/outside/SKILL.md' }).then(() => false, () => true), original.items[0]), true)
  console.log('PASS keyboard Skill menus, validated folder opening, cancel/failure/retry deletion, recoverable directory removal, fresh listing and rejection of stale/forged resources')
} finally { await app.close() }
