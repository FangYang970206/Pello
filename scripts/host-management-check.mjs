import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright'

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-host-management-'))
fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify({ hosts: [{ id: 'offline', name: 'Offline host', addr: '127.0.0.1', port: 1, user: 'tester', auth: 'password', on: false, os: 'Linux', platform: 'linux' }] }))
const env = { ...process.env, AWB_USER_DATA: data }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: ['.'], env })
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
  await page.getByRole('button', { name: '编辑 Fixed display name', exact: true }).click()
  await page.click('[data-a=hdel]')
  await page.click('[data-a=confirm]')
  await page.getByRole('button', { name: '编辑 Fixed display name', exact: true }).waitFor({ state: 'detached' })
  assert.equal((await page.evaluate(() => window.awb.getState())).db.hosts.length, 1)
  const rejected = await page.evaluate(async () => {
    const { db } = await window.awb.getState()
    try { await window.awb.saveHosts([...db.hosts, { id: 'invalid', name: 'Invalid', addr: '127.0.0.1', port: 1, user: 'tester', auth: 'password', password: 'bad', on: true, platform: 'linux', os: 'Linux' }]); return false }
    catch { return true }
  })
  assert.equal(rejected, true, 'Main process must reject unreachable hosts even when renderer claims connected')
  console.log('PASS offline hosts remain editable, failed edits preserve input, deletion confirms/cancels, and main-process validation cannot be bypassed')
} finally { await app.close() }
