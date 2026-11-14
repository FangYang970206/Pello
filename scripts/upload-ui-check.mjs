import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launchWorkbench } from './fixtures/launch-workbench.mjs'

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pello-upload-ui-'))
const project = path.join(data, 'project')
const source = path.join(data, 'secret-source.txt')
const hold = path.join(data, 'hold')
fs.mkdirSync(project)
fs.writeFileSync(source, 'payload')
fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify({
  settings: { layout: 'balanced', restore: false, confirmKill: false },
  projects: [{ id: 'p', name: 'Upload UI', host: 'local', path: project, agent: 'shell' }],
}))
const env = { ...process.env, AWB_USER_DATA: data, AWB_UPLOAD_HOLD: hold }
delete env.ELECTRON_RUN_AS_NODE
const app = await launchWorkbench({ args: ['.'], env })
try {
  const page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  await page.click('[data-a=rmode][data-id=files]')
  const row = () => page.locator('.upload-status')
  await page.evaluate((file) => window.awb.transferDrop('p', '', [file]), source)
  await row().getByText('上传中', { exact: true }).waitFor()
  const lines = (await row().innerText()).split('\n').map((line) => line.trim()).filter(Boolean)
  assert.deepEqual(lines, ['上传中'])
  assert.equal(lines.some((line) => line.includes('secret-source')), false)
  await row().getByRole('button', { name: '取消上传', exact: true }).click()
  await row().waitFor({ state: 'detached' })
  console.log('PASS upload status is one line while uploading and cancel removes it')

  fs.writeFileSync(`${hold}.go`, '1')
  const success = path.join(data, 'success-source.txt')
  fs.writeFileSync(success, 'done')
  await page.evaluate((file) => window.awb.transferDrop('p', '', [file]), success)
  await row().getByText('上传成功', { exact: true }).waitFor()
  await page.waitForTimeout(1100)
  assert.equal(await row().getByText('上传成功', { exact: true }).count(), 1)
  await row().waitFor({ state: 'detached', timeout: 2000 })
  console.log('PASS upload success stays visible and clears after 2 seconds')

  fs.rmSync(`${hold}.go`, { force: true })
  await page.evaluate((file) => window.awb.transferDrop('p', '', [file]), path.join(data, 'missing-source.txt'))
  await row().getByText('上传失败', { exact: true }).waitFor()
  await page.waitForTimeout(2200)
  assert.equal(await row().getByText('上传成功', { exact: true }).count(), 0)
  assert.equal(await row().getByRole('button', { name: '重试上传', exact: true }).count(), 1)
  assert.equal(await row().getByRole('button', { name: '关闭上传提示', exact: true }).count(), 1)
  fs.writeFileSync(path.join(data, 'missing-source.txt'), 'recovered')
  fs.writeFileSync(`${hold}.go`, '1')
  await row().getByRole('button', { name: '重试上传', exact: true }).click()
  await row().getByText('上传中', { exact: true }).waitFor()
  await row().getByRole('button', { name: '取消上传', exact: true }).click()
  await row().waitFor({ state: 'detached' })
  await page.evaluate((file) => window.awb.transferDrop('p', '', [file]), path.join(data, 'missing-again.txt'))
  await row().getByText('上传失败', { exact: true }).waitFor()
  await row().getByRole('button', { name: '关闭上传提示', exact: true }).click()
  await row().waitFor({ state: 'detached' })
  console.log('PASS upload failure keeps retry and close, and close removes the notice')
} finally {
  await app.close()
}
