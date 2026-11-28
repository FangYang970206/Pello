import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launchWorkbench } from './fixtures/launch-workbench.mjs'
import { assertSettingsDialogPosition } from './fixtures/settings-dialog-position.mjs'

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-host-management-'))
fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify({ settings: { autoCheckUpdates: false }, hosts: [{ id: 'offline', name: 'Offline host', addr: '127.0.0.1', port: 1, user: 'tester', auth: 'password', on: false, os: 'Linux', platform: 'linux' }] }))
const env = { ...process.env, AWB_USER_DATA: data }
delete env.ELECTRON_RUN_AS_NODE
// Without an explicit DPI the page takes the desktop's own scale: a forced
// factor below the desktop's leaves the window too few physical pixels for
// the page sizes below, as `app.resize` refuses with the reason.
const dpiArg = process.argv.find((arg) => arg.startsWith('--dpi='))?.slice(6)
const dpi = Number(dpiArg || 1)
const app = await launchWorkbench({ args: ['.'], env, scale: dpiArg ? dpi : null })
try {
  const page = await app.firstWindow()
  await page.locator('[data-a=newproj]').locator('..').hover()
  await page.click('[data-a=newproj]')
  await page.click('[data-a=np-addhost]')
  await page.fill('[data-nh=name]', 'unreachable fixture')
  await page.fill('[data-nh=addr]', 'tester@127.0.0.1')
  await page.selectOption('[aria-label="认证方式"]', 'password')
  await page.fill('[aria-label="登录密码"]', 'invalid')
  await page.click('[data-a=np-savehost]')
  await page.locator('.toast.bad').waitFor()
  const state = await page.evaluate(() => window.awb.getState())
  assert.equal(state.db.hosts.length, 2, 'Unreachable SSH host must not be added')
  assert.equal(await page.locator('[data-nh=addr]').count(), 1, 'Failed connection must keep the form editable')
  console.log('PASS failed SSH connection does not create a host and preserves editable input')
  await page.getByRole('button', { name: '编辑 Offline host', exact: true }).click()
  await page.getByLabel('名称', { exact: true }).fill('Fixed display name')
  await page.getByLabel('地址', { exact: true }).fill('127.0.0.2')
  await page.click('[data-a=hsave]')
  await page.locator('.dlg [role=alert]').waitFor()
  assert.equal(await page.getByLabel('名称', { exact: true }).inputValue(), 'Fixed display name')
  await page.getByLabel('地址', { exact: true }).fill('127.0.0.1')
  await page.click('[data-a=hsave]')
  await page.getByRole('button', { name: '编辑 Fixed display name', exact: true }).waitFor()
  assert.equal((await page.evaluate(() => window.awb.getState())).db.hosts.find((item) => item.id === 'offline').name, 'Fixed display name', 'An existing offline host must allow display-name edits')
  await page.getByRole('button', { name: '编辑 Fixed display name', exact: true }).click()
  await page.click('[data-a=hdel]')
  await page.getByRole('dialog', { name: '移除机器？', exact: true }).waitFor()
  await page.getByRole('button', { name: '取消', exact: true }).click()
  assert.equal((await page.evaluate(() => window.awb.getState())).db.hosts.length, 2)
  await page.keyboard.press('Escape')
  await page.locator('[data-a=settings]').click()
  await page.locator('[data-a=sec][data-id=hosts]').click()
  const offline = page.locator('.srow').filter({ hasText: 'Fixed display name' })
  await offline.getByRole('button', { name: '移除', exact: true }).click()
  await page.getByRole('dialog', { name: '移除机器？', exact: true }).waitFor()
  await page.click('[data-a=confirm]')
  await offline.waitFor({ state: 'detached' })
  assert.equal((await page.evaluate(() => window.awb.getState())).db.hosts.length, 1)
  const rejected = await page.evaluate(async () => {
    const { db } = await window.awb.getState()
    try { await window.awb.saveHosts([...db.hosts, { id: 'invalid', name: 'Invalid', addr: '127.0.0.1', port: 1, user: 'tester', auth: 'password', password: 'bad', on: true, platform: 'linux', os: 'Linux' }]); return false }
    catch { return true }
  })
  assert.equal(rejected, true, 'Main process must reject unreachable hosts even when renderer claims connected')
  console.log('PASS offline hosts remain editable, failed edits preserve input, deletion confirms/cancels, and main-process validation cannot be bypassed')
  for (const [theme, language, width, height, size, narrow] of [['light', 'zh-CN', 1440, 900, 12, false], ['dark', 'en', 1024, 680, 16, true]]) {
    await page.evaluate(async ({ theme, language, size }) => {
      const { db } = await window.awb.getState()
      await window.awb.saveSettings({ ...db.settings, theme, language, uiFontSize: size })
    }, { theme, language, size })
    await page.reload()
    await page.click('[data-a=settings]')
    await page.click('[data-a=sec][data-id=hosts]')
    const title = language === 'en' ? 'Add machine' : '添加机器'
    const addMachine = page.getByRole('button', { name: title, exact: true })
    const addDialog = page.getByRole('dialog', { name: title, exact: true })
    const name = addDialog.getByLabel(language === 'en' ? 'Name' : '名称', { exact: true })
    await app.resize(1440, 900)
    await addMachine.click()
    await name.fill('Fixture machine')
    await app.resize(width, height)
    if (narrow) await page.locator('.scol').evaluate((column) => { column.style.maxWidth = '420px' })
    await assertSettingsDialogPosition(addDialog)
    assert.equal(await name.inputValue(), 'Fixture machine')
    await page.screenshot({ path: path.resolve('output/playwright/host-management', `add-${dpi}-${theme}-${width}.png`) })
    await page.keyboard.press('Escape')
    await addDialog.waitFor({ state: 'detached' })
    assert.equal(await addMachine.evaluate((element) => element === document.activeElement), true)
  }
  console.log(`PASS add-machine dialog follows settings content while resizing and restores focus at ${dpi * 100}% DPI`)
} finally { await app.close() }
