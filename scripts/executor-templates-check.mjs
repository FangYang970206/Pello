import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright'

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pello-templates-'))
const home = path.join(data, 'home')
const local = (executorId) => ({ hostId: 'local', executorId })
const custom = {
  id: 'legacy', name: 'Legacy executor', cmd: 'node', args: '--version', shell: process.platform === 'win32' ? 'pwsh' : 'bash',
  env: [{ k: 'PELLO_VALUE', v: 'legacy-value', secret: false }], session: { startArgs: '--start {sessionId}', resumeArgs: '--resume {sessionId}' },
  letter: 'L', color: '#7fb2ff', resources: { format: 'standard', skillPath: path.join(data, 'legacy-skills'), mcpPath: path.join(data, 'current.json') },
  hosts: { fixture: { cmd: 'printf', args: "'.'", shell: 'bash' } }
}
const host = { id: 'fixture', name: 'Offline SSH fixture', addr: '127.0.0.1', user: 'fixture', port: 1, auth: 'key', platform: 'linux', os: 'Linux', on: false }
fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify({ custom: [custom], hosts: [host], settings: { autoCheckUpdates: false } }))
fs.writeFileSync(path.join(data, 'resource-targets.json'), JSON.stringify({ legacy: { mcpPath: path.join(data, 'old.json'), skillPath: path.join(data, 'old-skills'), format: 'codex' } }))
const env = { ...process.env, AWB_USER_DATA: data, AWB_RESOURCE_HOME: home }; delete env.ELECTRON_RUN_AS_NODE
const dpi = process.argv.find((arg) => arg.startsWith('--dpi='))?.slice(6) || '1'
const output = path.resolve('output/playwright/executor-templates', dpi)
fs.mkdirSync(output, { recursive: true })
const launch = () => electron.launch({ args: ['.', `--force-device-scale-factor=${dpi}`], env })
let app
try {
  app = await launch()
  let page = await app.firstWindow()
  const state = () => page.evaluate(async () => (await window.awb.getState()).db)
  const [migrated] = (await state()).templates
  assert.ok(migrated.id)
  assert.equal(migrated.mcpPath, custom.resources.mcpPath)
  assert.deepEqual(migrated.env, custom.env)
  assert.deepEqual(migrated.session, custom.session)
  assert.deepEqual((await state()).templateBindings, [{ ...local(custom.id), templateId: migrated.id }])
  assert.deepEqual((await state()).custom[0].hosts.fixture, custom.hosts.fixture)
  assert.deepEqual((await state()).custom[0].env, custom.env)
  console.log('PASS old mappings migrate once with executor precedence and retain legacy launch settings')

  await page.click('[data-a=settings]')
  await page.click('[data-a=sec][data-id=agents]')
  await page.getByRole('button', { name: '模板管理', exact: true }).click()
  await page.getByRole('button', { name: '新建模板', exact: true }).click()
  let dialog = page.getByRole('dialog')
  await dialog.getByLabel('模板名称').fill('Team profile')
  const mcpPath = path.join(home, 'shared.jsonc'), skillPath = path.join(home, 'shared-skills')
  await app.evaluate(({ dialog }, source) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] }) }, skillPath)
  await dialog.getByRole('button', { name: '浏览 Skill 目录', exact: true }).click()
  assert.equal(await dialog.getByLabel('Skill 目录', { exact: true }).inputValue(), skillPath)
  await dialog.getByLabel('MCP 配置文件', { exact: true }).fill(mcpPath)
  await dialog.getByLabel('Skill 管理方式').selectOption('claude')
  await dialog.getByRole('button', { name: '添加变量' }).click()
  await dialog.getByLabel('变量名').fill('PELLO_TEMPLATE_PROBE')
  await dialog.getByLabel('变量值').fill('secret-fixture-value')
  await dialog.getByLabel('保密').check()
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await dialog.waitFor({ state: 'detached' })
  const template = (await state()).templates.find((item) => item.name === 'Team profile')
  assert.equal(template.mcpPath, mcpPath)
  await page.getByRole('button', { name: '执行器列表' }).click()
  await page.getByLabel('Claude Code 的高级属性模板').selectOption(template.id)
  await page.waitForFunction(async (id) => (await window.awb.getState()).db.templateBindings.some((row) => row.executorId === 'claude' && row.templateId === id), template.id)
  await page.getByLabel('Legacy executor 的高级属性模板').selectOption(template.id)
  await page.waitForFunction(async (id) => (await window.awb.getState()).db.templateBindings.some((row) => row.executorId === 'legacy' && row.templateId === id), template.id)
  assert.equal(await page.getByLabel('Codex CLI 的高级属性模板').locator(`option[value="${template.id}"]`).count(), 0)
  assert.equal(await page.getByLabel('Codex CLI 的高级属性模板').evaluate((node) => getComputedStyle(node).backgroundPositionX), 'calc(100% - 12px)')
  const rejectBind = (scope, id) => page.evaluate(({ scope, id }) => window.awb.bindTemplate(scope, id), { scope, id })
  await assert.rejects(rejectBind(local('codex'), template.id), /不兼容/)
  await assert.rejects(rejectBind({ hostId: 'fixture', executorId: 'claude' }, template.id), /所属|属于/)
  await assert.rejects(page.evaluate((template) => window.awb.saveTemplate({ ...template, skillAdapter: 'portable' }), template), /不兼容/)
  await assert.rejects(page.evaluate((template) => window.awb.saveTemplate({ ...template, id: '', name: 'Invalid', session: { startArgs: '--start', resumeArgs: '--resume' } }), template), /sessionId/)
  const test = await page.evaluate(({ shell }) => window.awb.testExec({
    executorId: 'legacy', hostId: 'local', cmd: shell === 'pwsh' ? 'Write-Output' : 'printf',
    args: shell === 'pwsh' ? '$env:PELLO_TEMPLATE_PROBE' : '"%s\\n" "$PELLO_TEMPLATE_PROBE"', shell, env: []
  }), custom)
  assert.equal(test.code, 0)
  assert.match(test.text, /••••/)
  assert.doesNotMatch(test.text, /secret-fixture-value/)
  const renamed = await page.evaluate((template) => window.awb.saveTemplate({ ...template, name: 'Renamed profile' }), template)
  assert.equal(renamed.templates.find((entry) => entry.name === 'Renamed profile').id, template.id)
  assert.equal(renamed.templateBindings.filter((entry) => entry.templateId === template.id).length, 2)
  await page.evaluate((template) => window.awb.saveTemplate(template), template)
  console.log('PASS compatibility, path picker, scoped launch and test output redaction')

  for (const [language, theme, width, height, font] of [['en', 'dark', 1024, 680, 16], ['zh-CN', 'light', 1440, 900, 12]]) {
    await page.evaluate(async ({ language, theme, width, height, font }) => {
      const db = (await window.awb.getState()).db
      await window.awb.saveSettings({ ...db.settings, language, theme, uiFontSize: font })
      await window.awb.winResize(width, height)
    }, { language, theme, width, height, font })
    await page.reload()
    await page.click('[data-a=settings]'); await page.click('[data-a=sec][data-id=agents]')
    await page.getByRole('button', { name: /^(Templates|模板管理)$/ }).click()
    const edit = page.getByRole('button', { name: /^(Edit template|编辑模板) Team profile$/ })
    await edit.click()
    dialog = page.getByRole('dialog')
    await page.screenshot({ path: path.join(output, `${theme}-${width}.png`), animations: 'disabled' })
    assert.ok(await dialog.evaluate((node) => {
      const body = node.querySelector('.bdy'), footer = node.querySelector('footer')
      return body.clientWidth >= 300 && body.scrollWidth <= body.clientWidth + 1 && footer.getBoundingClientRect().bottom <= innerHeight
    }))
    await page.keyboard.press('Escape')
    assert.equal(await edit.evaluate((node) => node === document.activeElement), true)
  }
  await page.click('[data-a=sec][data-id=mcp]')
  await page.getByText(mcpPath, { exact: true }).waitFor()
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(mcpPath, '{\n  // keep this comment\n  "other": true\n}\n')
  const results = await page.evaluate((targets) => window.awb.addMcp('common', { command: 'node' }, targets), [local('claude'), local('legacy'), { hostId: 'fixture', executorId: 'claude' }])
  assert.deepEqual(results.map((row) => [row.hostId, row.agent, row.ok]), [['local', 'claude', true], ['local', 'legacy', true], ['fixture', 'claude', false]])
  assert.doesNotMatch(fs.readFileSync(mcpPath + '.awb-backup', 'utf8'), /common/)
  assert.match(fs.readFileSync(mcpPath, 'utf8'), /keep this comment/)
  assert.equal(JSON.parse(fs.readFileSync(mcpPath, 'utf8').replace('// keep this comment', '')).mcpServers.common.command, 'node')

  const piPath = path.join(home, '.pi/agent/mcp.json')
  fs.mkdirSync(piPath, { recursive: true })
  await page.getByRole('button', { name: '添加 MCP', exact: true }).click()
  dialog = page.getByRole('dialog')
  await dialog.getByLabel('MCP 名称').fill('retry-fixture')
  await dialog.getByLabel('服务器配置 JSON').fill('{"command":"node"}')
  await dialog.getByRole('button', { name: '下一步', exact: true }).click()
  await dialog.getByRole('checkbox', { name: 'Pi', exact: true }).check()
  await dialog.getByRole('button', { name: '添加到所选 Agent', exact: true }).click()
  const failure = dialog.locator('.resource-result-row').filter({ hasText: '本机 · Pi' })
  await failure.getByRole('button', { name: '重试', exact: true }).waitFor()
  const successful = fs.readFileSync(mcpPath, 'utf8')
  const successfulBackup = fs.readFileSync(mcpPath + '.awb-backup', 'utf8')
  fs.rmdirSync(piPath)
  await failure.getByRole('button', { name: '重试', exact: true }).click()
  await failure.getByText(/添加成功/).waitFor()
  assert.equal(JSON.parse(fs.readFileSync(piPath, 'utf8')).mcpServers['retry-fixture'].command, 'node')
  assert.equal(fs.readFileSync(mcpPath, 'utf8'), successful)
  assert.equal(fs.readFileSync(mcpPath + '.awb-backup', 'utf8'), successfulBackup)
  await page.screenshot({ path: path.join(output, 'distribution-result.png'), animations: 'disabled' })
  await dialog.getByRole('button', { name: '完成', exact: true }).click()
  console.log('PASS single-item retry retains source input and leaves prior successful targets untouched')

  const staged = path.join(data, 'workbench.json.tmp')
  fs.mkdirSync(staged)
  try { await assert.rejects(page.evaluate((id) => window.awb.deleteTemplate(id), template.id)) }
  finally { fs.rmdirSync(staged) }
  assert.ok((await state()).templates.some((item) => item.id === template.id))
  assert.ok((await state()).templateBindings.some((item) => item.templateId === template.id))
  await page.click('[data-a=sec][data-id=agents]')
  await page.getByRole('button', { name: '模板管理', exact: true }).click()
  await page.getByRole('button', { name: '删除模板 Team profile', exact: true }).click()
  dialog = page.getByRole('dialog')
  assert.match(await dialog.innerText(), /Claude Code.*原生默认位置/s)
  assert.match(await dialog.innerText(), /Legacy executor.*重新选择模板/s)
  await dialog.getByRole('button', { name: '删除', exact: true }).click()
  await dialog.waitFor({ state: 'detached' })
  await page.evaluate((id) => window.awb.deleteTemplate(id), migrated.id)
  await page.evaluate(async (hostId) => {
    const next = await window.awb.saveTemplate({ id: '', hostId, name: 'Team profile', mcpPath: '/tmp/mcp.json', skillPath: '/tmp/skills', format: 'standard', env: [] })
    await window.awb.bindTemplate({ hostId, executorId: 'legacy' }, next.templates.find((item) => item.hostId === hostId).id)
    await window.awb.saveHosts(next.hosts.filter((host) => host.id !== hostId))
  }, host.id)
  await app.close(); app = await launch(); page = await app.firstWindow()
  const db = await state()
  assert.deepEqual(db.templates, [])
  assert.deepEqual(db.templateBindings, [])
  assert.deepEqual(db.custom[0].hosts, {})
  assert.ok(fs.existsSync(mcpPath))
  console.log('PASS shared writes and backup, failed config transaction, delete confirmation, host cleanup and idempotent migration after restart')
} finally { await app?.close() }
