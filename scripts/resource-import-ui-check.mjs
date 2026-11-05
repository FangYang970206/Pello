import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import { _electron as electron } from 'playwright'

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-import-ui-')), home = path.join(data, 'home')
const source = path.join(data, 'bundle'), archive = path.join(data, 'skills.zip'), config = path.join(data, 'mcp.jsonc')
const skill = (name) => `---\nname: ${name}\ndescription: ${name} fixture\n---\nBody\n`
fs.mkdirSync(path.join(source, 'group/deep/inner/references'), { recursive: true })
fs.writeFileSync(path.join(source, 'SKILL.md'), skill('folder-outer'))
fs.writeFileSync(path.join(source, 'group/deep/inner/SKILL.md'), skill('folder-inner'))
fs.writeFileSync(path.join(source, 'group/deep/inner/references/guide.md'), 'Support file')
fs.writeFileSync(archive, zipSync({ 'root/SKILL.md': strToU8(skill('zip-outer')), 'root/deep/child/SKILL.md': strToU8(skill('zip-inner')) }))
fs.writeFileSync(config, '{// imported configuration\n"mcpServers":{"file-server":{"command":"node","args":["not-executed.js"],"env":{"TOKEN":"never-display-secret"}},"disabled-http":{"url":"https://example.invalid/mcp?token=never-display-secret","disabled":true},"needs-review":{"command":"node","cwd":"advanced-field-needs-review"}},"projects":{"fixture":{"mcpServers":{"project-server":{"command":"node"}}}}}')
const env = { ...process.env, AWB_USER_DATA: data, AWB_RESOURCE_HOME: home }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: ['.'], env })
try {
  const page = await app.firstWindow()
  const choose = (file) => app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, file)
  await page.click('[data-a=settings]'); await page.click('[data-a=sec][data-id=skills]')
  await page.getByRole('button', { name: '添加 Skill', exact: true }).click()
  await choose(source); await page.getByRole('button', { name: '选择文件夹', exact: true }).click()
  await page.getByText('发现 2 项 · 已选择 2 项', { exact: true }).waitFor()
  await page.getByLabel('搜索待导入资源', { exact: true }).fill('inner')
  assert.equal(await page.locator('.resource-import-item').count(), 1)
  await page.getByLabel('搜索待导入资源', { exact: true }).fill('')
  await page.getByRole('checkbox', { name: 'Codex CLI', exact: true }).check()
  await page.getByRole('checkbox', { name: 'Oh My Pi', exact: true }).check()
  await page.getByRole('button', { name: '添加到所选 Agent', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'detached' })
  for (const root of ['.claude/skills', '.agents/skills', '.omp/agent/skills']) for (const name of ['folder-outer', 'folder-inner']) assert.ok(fs.existsSync(path.join(home, root, name, 'SKILL.md')))
  assert.equal(fs.readFileSync(path.join(home, '.omp/agent/skills/folder-inner/references/guide.md'), 'utf8'), 'Support file')
  await page.getByRole('button', { name: '添加 Skill', exact: true }).click()
  await choose(archive); await page.getByRole('button', { name: '选择 ZIP 压缩包', exact: true }).click()
  await page.getByText('发现 2 项 · 已选择 2 项', { exact: true }).waitFor()
  await page.getByRole('button', { name: '取消全选', exact: true }).click()
  assert.equal(await page.getByRole('button', { name: '添加到所选 Agent', exact: true }).isDisabled(), true)
  await page.getByRole('button', { name: '全选', exact: true }).click()
  await page.getByRole('checkbox', { name: 'Pi', exact: true }).check()
  await page.getByRole('button', { name: '添加到所选 Agent', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'detached' })
  assert.ok(fs.existsSync(path.join(home, '.pi/agent/skills/zip-inner/SKILL.md')))
  await page.click('[data-a=sec][data-id=mcp]')
  await page.getByRole('button', { name: '添加 MCP', exact: true }).click()
  await choose(config); await page.getByRole('button', { name: '从配置文件导入', exact: true }).click()
  await page.getByText('发现 4 项 · 已选择 3 项', { exact: true }).waitFor()
  assert.ok(!(await page.getByRole('dialog').textContent()).includes('never-display-secret'))
  assert.equal(await page.locator('.resource-import-item').filter({ hasText: 'needs-review' }).getByRole('checkbox').isDisabled(), true)
  await page.getByRole('checkbox', { name: 'Pi', exact: true }).check()
  await page.getByRole('checkbox', { name: 'Oh My Pi', exact: true }).check()
  const shots = path.resolve('.cache/goal-upgrade/resource-imports')
  fs.mkdirSync(shots, { recursive: true })
  for (const [theme, width, height] of [['dark', 1440, 900], ['light', 1024, 680]]) {
    if (theme === 'light') {
      await page.getByRole('button', { name: '取消', exact: true }).click()
      await page.click('[data-a=sec][data-id=look]'); await page.click('[data-a=theme][data-id=light]')
      await page.click('[data-a=sec][data-id=mcp]'); await page.getByRole('button', { name: '添加 MCP', exact: true }).click()
      await choose(config); await page.getByRole('button', { name: '从配置文件导入', exact: true }).click()
      await page.getByText('发现 4 项 · 已选择 3 项', { exact: true }).waitFor()
      await page.getByRole('checkbox', { name: 'Pi', exact: true }).check()
      await page.getByRole('checkbox', { name: 'Oh My Pi', exact: true }).check()
    }
    await page.waitForFunction((theme) => document.documentElement.dataset.palette === theme, theme)
    await page.setViewportSize({ width, height })
    await page.screenshot({ path: path.join(shots, `${theme}-${width}.png`) })
    assert.equal(await page.getByRole('dialog').evaluate((el) => el.scrollWidth <= el.clientWidth), true)
  }
  await page.getByRole('button', { name: '添加到所选 Agent', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'detached' })
  for (const root of ['.pi/agent', '.omp/agent']) {
    const imported = JSON.parse(fs.readFileSync(path.join(home, root, 'mcp.json'), 'utf8')).mcpServers
    assert.ok(imported['file-server']); assert.ok(imported['project-server']); assert.equal(imported['disabled-http'].enabled, false)
    assert.equal(imported['needs-review'], undefined)
  }
  console.log('PASS recursive folder/ZIP preview, source search, selected multi-agent Skill distribution and redacted MCP file extraction with disabled/unsupported states')
} finally { await app.close() }
