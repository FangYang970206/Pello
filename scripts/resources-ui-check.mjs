import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright'
import { zipSync, strToU8 } from 'fflate'

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-resources-ui-')), home = path.join(data, 'home')
for (let i = 0; i < 14; i++) {
  const folder = path.join(home, '.claude/skills', `fixture-${i}`)
  fs.mkdirSync(folder, { recursive: true })
  fs.writeFileSync(path.join(folder, 'SKILL.md'), `---\nname: fixture-${i}\ndescription: Fixture description ${i}\n---\nBody`)
}
const archive = path.join(data, 'new-skill.zip')
fs.writeFileSync(archive, zipSync({ 'new-skill/SKILL.md': strToU8('---\nname: new-skill\ndescription: Imported skill\n---\nBody') }))
fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify({ plugins: [{ id: 'legacy', name: 'Old fake plugin' }] }))
const env = { ...process.env, AWB_USER_DATA: data, AWB_RESOURCE_HOME: home }; delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: ['.'], env })
try {
  const page = await app.firstWindow()
  await page.click('[data-a=settings]')
  assert.equal(await page.getByRole('button', { name: '插件', exact: true }).count(), 0)
  await page.click('[data-a=sec][data-id=mcp]')
  await page.getByRole('button', { name: '添加 MCP', exact: true }).click()
  await page.getByLabel('MCP 名称', { exact: true }).fill('ui-fixture')
  await page.getByLabel('服务器配置 JSON', { exact: true }).fill('{"url":"https://example.invalid/mcp"}')
  await page.getByRole('checkbox', { name: 'Codex CLI', exact: true }).check()
  await page.getByRole('button', { name: '添加到所选 Agent', exact: true }).click()
  await page.getByRole('status').filter({ hasText: 'Claude Code · 添加成功' }).waitFor()
  assert.equal(await page.getByRole('tabpanel').getByText('ui-fixture', { exact: true }).count(), 1)
  await page.getByRole('tab', { name: 'Codex CLI', exact: true }).click()
  await page.getByRole('tabpanel').getByText('ui-fixture', { exact: true }).waitFor()
  await page.getByRole('tab', { name: 'Pi', exact: true }).click()
  await page.getByRole('tabpanel').getByText('尚未发现 MCP', { exact: true }).waitFor()
  await page.click('[data-a=sec][data-id=skills]')
  await page.getByText('共 14 项 · 第 1 / 2 页', { exact: true }).waitFor()
  await page.getByRole('button', { name: '下一页', exact: true }).click()
  await page.getByText('共 14 项 · 第 2 / 2 页', { exact: true }).waitFor()
  assert.equal(await page.getByRole('tabpanel').locator('.resource-item').count(), 2)
  await page.getByLabel('搜索 Skill', { exact: true }).fill('fixture-13')
  await page.getByText('共 1 项 · 第 1 / 1 页', { exact: true }).waitFor()
  await page.getByLabel('搜索 Skill', { exact: true }).fill('')
  await page.getByRole('button', { name: '添加 Skill', exact: true }).click()
  await app.evaluate(({ dialog }, archive) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [archive] }) }, archive)
  await page.getByRole('button', { name: '选择 ZIP 压缩包', exact: true }).click()
  await page.getByRole('checkbox', { name: 'Pi', exact: true }).check()
  await page.getByRole('button', { name: '添加到所选 Agent', exact: true }).click()
  await page.getByRole('status').filter({ hasText: 'Pi · 添加成功' }).waitFor()
  await page.getByRole('tab', { name: 'Pi', exact: true }).click()
  await page.getByRole('tabpanel').getByText('new-skill', { exact: true }).waitFor()
  assert.ok(fs.existsSync(path.join(home, '.pi/agent/skills/new-skill/SKILL.md')))
  console.log('PASS MCP/Skill sibling menus, per-agent listing, selected multi-agent add, ZIP picker/import, pagination/search, and legacy fake plugin removal')
} finally { await app.close() }
