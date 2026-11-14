import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launchWorkbench } from './fixtures/launch-workbench.mjs'

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pello-search-ui-'))
const project = path.join(data, 'project')
fs.mkdirSync(path.join(project, 'notes'), { recursive: true })
const query = 'PELLORAWQUERY-中文'
fs.writeFileSync(path.join(project, 'notes/unique-needle.txt'), `alpha\n${query} sits here\nomega\n`)
fs.writeFileSync(path.join(project, 'notes/other.txt'), 'nothing to see\n')
fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify({
  settings: { layout: 'balanced', restore: false, confirmKill: false },
  projects: [{ id: 'p', name: 'Search UI', host: 'local', path: project, agent: 'shell' }],
}))
const env = { ...process.env, AWB_USER_DATA: data }
delete env.ELECTRON_RUN_AS_NODE

function commandLines() {
  const lines = []
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    try { lines.push(fs.readFileSync(`/proc/${entry}/cmdline`).toString('utf8').replaceAll('\0', ' ')) } catch { /* The process can exit between the listing and the read. */ }
  }
  return lines
}

const app = await launchWorkbench({ args: ['.'], env })
try {
  const page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  await page.click('[data-a=rmode][data-id=files]')
  const names = page.getByLabel('搜索文件', { exact: true })
  await names.fill('unique-needle')
  const seen = []
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) seen.push(...commandLines())
  assert.equal(seen.some((line) => line.includes('unique-needle')), false, 'The filename query must not be placed on a command line')
  const fileHit = page.locator('[data-a=search-file][data-id="notes/unique-needle.txt"]')
  await fileHit.waitFor()
  await fileHit.click()
  await page.getByRole('textbox', { name: '文件内容', exact: true }).waitFor()
  assert.equal(await names.inputValue(), 'unique-needle')
  assert.equal(await fileHit.count(), 1, 'Opening a filename hit keeps the result list')
  assert.ok((await page.getByRole('textbox', { name: '文件内容', exact: true }).inputValue()).includes(query))
  console.log('PASS filename search keeps the result after the hit is opened and does not put the query on a command line')

  await page.click('[data-a=file-search]')
  const content = page.getByLabel('搜索内容', { exact: true })
  await content.fill(query)
  const contentLines = []
  const scanning = Date.now() + 3000
  while (Date.now() < scanning) contentLines.push(...commandLines())
  const worker = path.join(os.tmpdir(), 'pello-content-search-worker.js')
  if (fs.existsSync(worker)) assert.equal(fs.readFileSync(worker, 'utf8').includes(query), false, 'The content query must stay out of the worker script')
  assert.equal(contentLines.some((line) => line.includes(query)), false, 'The content query must not be placed on a command line')
  const hit = page.locator(`[data-a=content-hit][data-id="notes/unique-needle.txt"]`)
  await hit.waitFor()
  await hit.click()
  assert.equal(await content.inputValue(), query)
  assert.equal(await hit.count(), 1, 'Opening a content hit keeps the result list')
  await page.getByRole('button', { name: '使用正则表达式', exact: true }).click()
  await content.fill('a++')
  await page.getByRole('alert').filter({ hasText: '正则表达式无效' }).waitFor()
  console.log('PASS content search keeps the opened hit, shows a regex error, and keeps the query off the command line')
} finally {
  await app.close()
}
