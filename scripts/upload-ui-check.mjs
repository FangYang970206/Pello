import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launchWorkbench } from './fixtures/launch-workbench.mjs'

// The project is on this machine, so each transfer here is a local one. As
// on the Electron build, its notice is one line: it says a choice is waited
// for, a success clears by itself, and a failure keeps its details behind
// Details. The transfers are real ones; none is injected.
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pello-upload-ui-'))
const project = path.join(data, 'project')
const source = path.join(data, 'secret-source.txt')
fs.mkdirSync(project)
fs.writeFileSync(source, 'payload')
fs.writeFileSync(path.join(project, 'secret-source.txt'), 'what was there')
fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify({
  settings: { layout: 'balanced', restore: false, confirmKill: false },
  projects: [{ id: 'p', name: 'Upload UI', host: 'local', path: project, agent: 'shell' }],
}))
const env = { ...process.env, AWB_USER_DATA: data }
delete env.ELECTRON_RUN_AS_NODE
const app = await launchWorkbench({ args: ['.'], env })
try {
  const page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  await page.click('[data-a=rmode][data-id=files]')
  const row = () => page.locator('.upload-status')
  const lines = async () => (await row().innerText()).split('\n').map((line) => line.trim()).filter(Boolean)
  const names = () => fs.readdirSync(project)
  // The source has the same name as a file of the project: the transfer
  // waits for a choice, and the notice asks for it in one line over the
  // choices. Nothing says the transfer is over.
  await page.evaluate((file) => window.awb.transferDrop('p', '', [file]), source)
  await row().getByText('请选择同名项目的处理方式', { exact: true }).waitFor()
  const asked = (await lines()).slice(0, 2)
  assert.equal(asked[0], '请选择同名项目的处理方式')
  assert.ok(asked[1].endsWith(`${path.sep}secret-source.txt`), JSON.stringify(asked))
  assert.equal(await row().getByText('详情', { exact: true }).count(), 0)
  assert.equal(fs.readFileSync(path.join(project, 'secret-source.txt'), 'utf8'), 'what was there')
  await row().getByRole('button', { name: '取消传输', exact: true }).click()
  await row().waitFor({ state: 'detached' })
  assert.equal(fs.readFileSync(path.join(project, 'secret-source.txt'), 'utf8'), 'what was there')
  assert.deepEqual(names(), ['secret-source.txt'])
  console.log('PASS a same-name choice is asked in one line over the choices, and cancelling leaves the project as it was')

  const success = path.join(data, 'success-source.txt')
  fs.writeFileSync(success, 'done')
  await page.evaluate((file) => window.awb.transferDrop('p', '', [file]), success)
  await row().getByText('导入成功', { exact: true }).waitFor()
  await page.waitForTimeout(1100)
  assert.equal(await row().getByText('导入成功', { exact: true }).count(), 1)
  await row().waitFor({ state: 'detached', timeout: 2000 })
  assert.equal(fs.readFileSync(path.join(project, 'success-source.txt'), 'utf8'), 'done')
  console.log('PASS a success stays visible and clears after 2 seconds')

  // A source that is not there fails the one entry.
  await page.evaluate((file) => window.awb.transferDrop('p', '', [file]), path.join(data, 'missing-source.txt'))
  await row().getByText('传输失败', { exact: true }).waitFor()
  await page.waitForTimeout(2200)
  assert.equal(await row().getByText('导入成功', { exact: true }).count(), 0)
  // The failure is one line; what failed and the way to retry are behind Details.
  assert.deepEqual(await lines(), ['传输失败', '详情'])
  await row().getByRole('button', { name: '详情', exact: true }).click()
  const details = page.getByRole('dialog', { name: '传输详情', exact: true })
  await details.locator('.transfer-detail-task p > span').filter({ hasText: 'missing-source.txt' }).waitFor()
  await details.getByRole('button', { name: '重试失败项', exact: true }).waitFor()
  // Retrying works once the source is there, and ends as a success that clears by itself.
  fs.writeFileSync(path.join(data, 'missing-source.txt'), 'recovered')
  await details.getByRole('button', { name: '重试失败项', exact: true }).click()
  await details.waitFor({ state: 'detached' })
  await row().getByText('导入成功', { exact: true }).waitFor()
  await row().waitFor({ state: 'detached', timeout: 4000 })
  assert.equal(fs.readFileSync(path.join(project, 'missing-source.txt'), 'utf8'), 'recovered')
  console.log('PASS a failure is one line with details, and retry from the details copies what was missing')

  await page.evaluate((file) => window.awb.transferDrop('p', '', [file]), path.join(data, 'missing-again.txt'))
  await row().getByText('传输失败', { exact: true }).waitFor()
  await row().getByRole('button', { name: '关闭传输提示', exact: true }).click()
  await row().waitFor({ state: 'detached' })
  console.log('PASS closing the notice removes it')
} finally {
  await app.close()
}
