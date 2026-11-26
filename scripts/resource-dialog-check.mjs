import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launchWorkbench } from './fixtures/launch-workbench.mjs'

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-resource-dialog-')), home = path.join(data, 'home')
const root = path.join(home, '.claude/skills'), shots = path.resolve('.cache/resource-layout')
fs.mkdirSync(shots, { recursive: true })
for (const name of ['long-skill', 'delete-me', 'untouched']) {
  fs.mkdirSync(path.join(root, name), { recursive: true })
  fs.writeFileSync(path.join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: Layout fixture\n---\n` + 'Skill instructions and supporting content.\n'.repeat(150))
  fs.writeFileSync(path.join(root, name, 'support.txt'), 'Keep supporting files')
}
fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { 'fixture-mcp': { url: 'https://example.invalid/mcp' } } }))
const tauri = process.env.AWB_SHELL === 'tauri'
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`
const openLog = path.join(data, 'open.log')
const trashLog = path.join(data, 'trash.log')
const openFail = path.join(data, 'open-fail')
const trashFail = path.join(data, 'trash-fail')
const trashGo = path.join(data, 'trash-go')
const readLog = (file) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean) : []
if (tauri) {
  const openBin = path.join(data, 'open-bin.sh')
  const trashBin = path.join(data, 'trash-bin.sh')
  fs.writeFileSync(openBin, `#!/bin/sh\nprintf '%s\\n' "$1" >> ${quote(openLog)}\nif [ -f ${quote(openFail)} ]; then echo 'Fixture open failed' >&2; exit 1; fi\nexit 0\n`)
  fs.writeFileSync(trashBin, `#!/bin/sh\nprintf '%s\\n' "$1" >> ${quote(trashLog)}\nif [ -f ${quote(trashFail)} ]; then echo 'Fixture trash failed' >&2; exit 1; fi\nwhile [ ! -f ${quote(trashGo)} ]; do sleep 0.05; done\nrm -f ${quote(trashGo)}\nexit 0\n`)
  fs.chmodSync(openBin, 0o755); fs.chmodSync(trashBin, 0o755); fs.writeFileSync(trashFail, '')
}
const env = { ...process.env, AWB_USER_DATA: data, AWB_RESOURCE_HOME: home }; delete env.ELECTRON_RUN_AS_NODE
if (tauri) { env.AWB_OPEN_BIN = path.join(data, 'open-bin.sh'); env.AWB_TRASH_BIN = path.join(data, 'trash-bin.sh') }
// One scale per run. Without `--scale=<factor>` the page follows the desktop.
const scale = process.argv.find((arg) => arg.startsWith('--scale='))?.slice(8)
const app = await launchWorkbench({ args: ['.'], env, scale: scale === undefined ? null : Number(scale) })
// This check goes through a 1024 by 680 page, the smallest the window
// takes. A desktop whose scale is above the page's own cannot show it, and
// then nothing runs here: that is said, with exit code 2, rather than
// taken for a pass or a failure.
const shown = await app.resize(1024, 680).then(() => true, (error) => {
  if (!/needs a desktop at/.test(String(error))) throw error
  console.log(`NOT RUN: ${error.message}`)
  return false
})
if (!shown) { await app.close(); process.exit(2) }
await app.resize(1440, 900)
try {
  const page = await app.firstWindow()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  if (app.shell !== 'tauri') await app.evaluate(({ shell }) => {
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
      await app.resize(width, height)
      await page.evaluate((size) => document.documentElement.style.setProperty('--ui-size', `${size}px`), width === 1024 ? 16 : 12)
      await section('skills')
      const inspect = page.getByRole('button', { name: '查看 long-skill 详情', exact: true })
      await inspect.click(); await page.getByRole('dialog').waitFor(); await aligned(true)
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
      await page.getByRole('button', { name: '添加 Skill', exact: true }).click(); await page.getByRole('dialog').waitFor(); await aligned()
      await page.screenshot({ path: path.join(shots, `skill-add-${theme}-${width}.png`) })
      await page.keyboard.press('Escape')
      await section('mcp')
      await page.getByRole('button', { name: '添加 MCP', exact: true }).click(); await page.getByRole('dialog').waitFor(); await aligned()
      await page.screenshot({ path: path.join(shots, `mcp-add-${theme}-${width}.png`) })
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: '查看 fixture-mcp 详情', exact: true }).click(); await page.getByRole('dialog').waitFor(); await aligned()
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
if (process.platform !== 'win32') {
    const opened = async () => app.shell === 'tauri' ? readLog(openLog) : app.evaluate(() => globalThis.__resourceOps.opened)
    const removed = async () => app.shell === 'tauri' ? readLog(trashLog) : app.evaluate(() => globalThis.__resourceOps.deleted)
    const skillDir = fs.realpathSync(path.join(root, 'delete-me'))
    assert.deepEqual((await opened()).map((item) => fs.realpathSync(item)), [skillDir])
    if (app.shell === 'tauri') fs.writeFileSync(openFail, '')
    else await app.evaluate(() => { globalThis.__resourceOps.failOpen = true })
    await trigger.click(); await page.getByRole('menuitem', { name: '在资源管理器打开', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: 'Fixture open failed' }).waitFor()
    const original = await page.evaluate(() => window.awb.resourceList('skills', 'claude', 1, 'delete-me'))
    await trigger.click(); await page.getByRole('menuitem', { name: '删除', exact: true }).click()
    await page.getByRole('dialog', { name: '删除 Skill', exact: true }).getByRole('button', { name: '取消', exact: true }).click()
    assert.equal(await trigger.evaluate((element) => element === document.activeElement), true)
    assert.deepEqual(await removed(), [])
    await trigger.click(); await page.getByRole('menuitem', { name: '删除', exact: true }).click()
    const confirm = page.getByRole('dialog', { name: '删除 Skill', exact: true })
    await confirm.getByRole('button', { name: '删除', exact: true }).click()
    await confirm.getByRole('alert').filter({ hasText: 'Fixture trash failed' }).waitFor()
    assert.ok(fs.existsSync(path.join(root, 'delete-me/SKILL.md')))
    if (app.shell === 'tauri') fs.rmSync(trashFail, { force: true })
    else await app.evaluate(() => { globalThis.__resourceOps.failDelete = false })
    await confirm.getByRole('button', { name: '删除', exact: true }).click()
    assert.equal(await confirm.getByRole('button', { name: '正在删除…', exact: true }).isDisabled(), true)
    await page.waitForTimeout(150)
    const deletedPaths = await removed()
    assert.deepEqual(deletedPaths.map((item) => fs.realpathSync(item)), [skillDir, skillDir])
    fs.mkdirSync(path.join(data, 'trash'))
    fs.renameSync(path.join(root, 'delete-me'), path.join(data, 'trash/delete-me'))
    if (app.shell === 'tauri') fs.writeFileSync(trashGo, '')
    else await app.evaluate(() => globalThis.__completeTrash())
    await confirm.waitFor({ state: 'detached' })
    await trigger.waitFor({ state: 'detached' })
    assert.deepEqual(await removed(), deletedPaths)
    assert.equal(fs.readFileSync(path.join(data, 'trash/delete-me/support.txt'), 'utf8'), 'Keep supporting files')
    assert.ok(fs.existsSync(path.join(root, 'untouched/SKILL.md')))
    assert.equal(await page.evaluate((item) => window.awb.deleteSkill('claude', item).then(() => false, () => true), original.items[0]), true)
    assert.equal(await page.evaluate((item) => window.awb.openSkillFolder('claude', { ...item, path: 'C:/outside/SKILL.md' }).then(() => false, () => true), original.items[0]), true)
    console.log('PASS keyboard Skill menus, validated folder opening, cancel/failure/retry deletion, recoverable directory removal, fresh listing and rejection of stale/forged resources')
} else {
  // The folder and trash fixtures are shell scripts, which Windows cannot
  // run. There the product opens the folder and moves the skill to the system
  // Recycle Bin itself; the kernel's behaviour cases cover that path.
  console.log('NOT RUN on Windows: Skill folder opening and deletion through the shell fixtures')
  process.exitCode = 2
}
} finally { await app.close() }
