import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright'

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pello-upload-status-'))
const project = path.join(data, 'project'); fs.mkdirSync(project)
fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify({ settings: { layout: 'balanced', restore: false }, projects: [
  { id: 'p', name: 'Upload status', host: 'local', path: project, agent: 'shell' },
  { id: 'other', name: 'Other project', host: 'local', path: project, agent: 'shell' }
] }))
const env = { ...process.env, AWB_USER_DATA: data }; delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: ['.'], env })
try {
  const page = await app.firstWindow(); page.setDefaultTimeout(10000)
  await page.click('[data-a=rmode][data-id=files]')
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    globalThis.__uploadCalls = { cancel: [], dismiss: [], retry: [] }
    for (const method of ['cancel', 'dismiss', 'retry']) {
      ipcMain.removeHandler(`transfer:${method}`)
      ipcMain.handle(`transfer:${method}`, (_event, id) => {
        globalThis.__uploadCalls[method].push(id)
        if (method === 'retry') {
          if (globalThis.__retryError) throw new Error('网络仍不可用')
          BrowserWindow.getAllWindows()[0].webContents.send('transfer:update', { id: 'retried', projectId: 'p', direction: 'upload', state: 'running', current: '', destination: '', bytes: 0, total: 0, items: [] })
          return 'retried'
        }
      })
    }
  })
  const snapshot = (id, changes = {}) => ({ id, projectId: 'p', direction: 'upload', state: 'running', phase: 'transferring', current: 'C:\\private\\source.bin', destination: '/private/target', bytes: 50, total: 100, overallBytes: 50, overallTotal: 100, items: [], ...changes })
  const send = (value) => app.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].webContents.send('transfer:update', value), value)
  const row = (id) => page.locator(`.upload-status[data-transfer-id="${id}"]`)
  const success = (id) => snapshot(id, { state: 'completed', items: [{ source: 'private-source', destination: 'private-target', status: 'done' }] })

  await send(snapshot('first'))
  await row('first').getByText('上传中', { exact: true }).waitFor()
  assert.equal(await row('first').innerText(), '上传中')
  assert.equal(await row('first').getByRole('progressbar').count(), 0)
  assert.equal(await row('first').locator('[title*="private"]').count(), 0)
  for (const phase of ['preparing', 'publishing', 'transferring']) {
    await send(snapshot('first', { phase }))
    await page.waitForFunction(({ id, disabled }) => document.querySelector(`[data-transfer-id="${id}"] button`)?.disabled === disabled, { id: 'first', disabled: phase === 'publishing' })
    assert.equal(await row('first').innerText(), '上传中')
  }
  await row('first').getByRole('button', { name: '取消上传', exact: true }).focus()
  await page.keyboard.press('Enter')
  assert.deepEqual(await app.evaluate(() => globalThis.__uploadCalls.cancel), ['first'])
  await send(snapshot('first', { state: 'cancelled' }))
  await row('first').waitFor({ state: 'detached' })
  console.log('PASS compact upload hides paths and progress, supports keyboard cancellation and protects publication')

  await send(success('success'))
  await row('success').getByText('上传成功', { exact: true }).waitFor()
  assert.equal(await row('success').getByRole('button').count(), 0)
  await page.waitForTimeout(1100)
  assert.equal(await row('success').isVisible(), true)
  // Duplicate completion updates must not restart the success timer; another task must survive it.
  await send(success('success')); await send(snapshot('concurrent'))
  await row('success').waitFor({ state: 'detached', timeout: 1600 })
  assert.equal(await row('concurrent').innerText(), '上传中')
  assert.ok((await app.evaluate(() => globalThis.__uploadCalls.dismiss)).includes('success'))
  await send(snapshot('concurrent', { state: 'cancelled' }))
  console.log('PASS success remains readable then clears after 2 seconds, without resetting on updates or clearing another task')

  await send(success('project-switch'))
  await row('project-switch').getByText('上传成功', { exact: true }).waitFor()
  await page.getByRole('button', { name: '打开项目 Other project', exact: true }).click()
  await page.waitForTimeout(2200)
  await page.getByRole('button', { name: '打开项目 Upload status', exact: true }).click()
  assert.equal(await row('project-switch').count(), 0)
  await page.click('[data-a=settings]')
  await send(success('settings'))
  await page.waitForTimeout(2200)
  await page.click('[data-a=back]')
  assert.equal(await row('settings').count(), 0)
  await page.getByRole('button', { name: '收起文件面板', exact: true }).click()
  await send(success('collapsed'))
  await page.waitForTimeout(2200)
  await page.getByRole('button', { name: '显示文件面板', exact: true }).click()
  assert.equal(await row('collapsed').count(), 0)
  console.log('PASS project switches, settings and a collapsed file panel cannot preserve expired success history')

  const failure = snapshot('failed', { state: 'completed', items: [{ source: 'private-source', destination: 'private-target', status: 'failed', error: '网络连接中断' }] })
  await send(failure)
  const warning = success('warning'); warning.warnings = ['旧对象清理失败，保留于 /remote/.awb-upload-backup']
  await send(warning)
  await row('failed').getByText('上传失败', { exact: true }).waitFor()
  await row('warning').getByRole('alert').waitFor()
  await page.waitForTimeout(2200)
  assert.match(await row('failed').innerText(), /网络连接中断/)
  assert.match(await row('warning').innerText(), /\/remote\/\.awb-upload-backup/)
  assert.equal(await row('failed').getByText('上传成功', { exact: true }).count(), 0)
  assert.equal(await row('warning').getByText('上传成功', { exact: true }).count(), 0)
  await app.evaluate(() => { globalThis.__retryError = true })
  await row('failed').getByRole('button', { name: '重试上传', exact: true }).click()
  await row('failed').getByText(/网络仍不可用/).waitFor()
  await app.evaluate(() => { globalThis.__retryError = false })
  await row('failed').getByRole('button', { name: '重试上传', exact: true }).click()
  await row('failed').waitFor({ state: 'detached' })
  await row('retried').getByText('上传中', { exact: true }).waitFor()
  await row('warning').getByRole('button', { name: '关闭上传提示', exact: true }).click()
  await row('warning').waitFor({ state: 'detached' })
  await send(snapshot('retried', { state: 'cancelled' }))
  await row('retried').waitFor({ state: 'detached' })
  assert.equal(await page.getByRole('region', { name: '传输任务', exact: true }).count(), 0)
  console.log('PASS failures and backup warnings persist without false success, retry errors retain context and retry replaces the old notice')
} finally { await app.close() }
