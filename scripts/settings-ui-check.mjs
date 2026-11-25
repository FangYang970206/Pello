import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launchWorkbench } from './fixtures/launch-workbench.mjs'

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pello-settings-ui-'))
const project = path.join(data, 'project')
fs.mkdirSync(project)
fs.writeFileSync(path.join(project, 'note.txt'), 'original\n')
fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify({
  settings: { layout: 'balanced', restore: true, confirmKill: false, language: 'zh-CN', autoCheckUpdates: true, defShell: 'bash', defAgent: 'shell' },
  projects: [{ id: 'p', name: 'Settings UI', host: 'local', path: project, agent: 'shell' }],
  sessions: { p: [{ id: 'shell-1', kind: 'shell', shell: 'bash', name: 'bash' }] },
  activeTab: { p: 'shell-1' },
}))
const env = { ...process.env, AWB_USER_DATA: data }
delete env.ELECTRON_RUN_AS_NODE
const app = await launchWorkbench({ args: ['.'], env })
try {
  const page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  await page.locator('.xterm').waitFor()
  await page.evaluate(() => { document.querySelector('.xterm').dataset.keep = 'settings-ui' })
  await page.click('[data-a=rmode][data-id=files]')
  await page.click('[data-a=preview][data-id="note.txt"]')
  const editor = page.getByRole('textbox', { name: '文件内容', exact: true })
  await editor.fill('draft stays')
  const fileTab = await page.locator('.tab.on [data-a=tab]').getAttribute('data-id')
  await page.click('[data-a=settings]')
  await page.click('[data-a=sec][data-id=general]')
  await page.getByRole('region', { name: '应用更新', exact: true }).waitFor()
  await page.getByRole('switch', { name: '自动检查更新', exact: true }).click()
  await page.click('[data-a=sec][data-id=mcp]')
  await page.getByRole('button', { name: '添加 MCP', exact: true }).click()
  const mcp = page.getByRole('dialog', { name: '添加 MCP', exact: true })
  await mcp.waitFor()
  await mcp.getByLabel('MCP 名称', { exact: true }).fill('not-saved')
  await mcp.getByRole('button', { name: '取消', exact: true }).click()
  await mcp.waitFor({ state: 'detached' })
  await page.click('[data-a=sec][data-id=skills]')
  await page.getByRole('button', { name: '添加 Skill', exact: true }).click()
  const skill = page.getByRole('dialog', { name: '添加 Skill', exact: true })
  await skill.waitFor()
  await skill.getByRole('button', { name: '取消', exact: true }).click()
  await skill.waitFor({ state: 'detached' })
  await page.click('[data-a=sec][data-id=general]')
  await page.getByLabel('应用语言', { exact: true }).selectOption('en')
  await page.getByRole('region', { name: 'App updates', exact: true }).waitFor()
  await page.click('[data-a=back]')
  assert.equal(await page.evaluate(() => document.querySelector('.xterm')?.dataset.keep), 'settings-ui')
  assert.equal(await page.locator('.xterm').count(), 1)
  await page.locator(`[data-a=tab][data-id="${fileTab}"]`).click()
  const draft = page.locator('.source-editor textarea')
  await draft.waitFor()
  assert.equal(await draft.inputValue(), 'draft stays')
  assert.equal(fs.readFileSync(path.join(project, 'note.txt'), 'utf8'), 'original\n')
  const saved = JSON.parse(fs.readFileSync(path.join(data, 'workbench.json'), 'utf8'))
  assert.equal(saved.settings.language, 'en')
  assert.equal(saved.settings.autoCheckUpdates, false)
  console.log('PASS language switch keeps the terminal and the draft, resource dialogs cancel cleanly, and the app-update column saves its switch')

  // The page is in English by now, so the controls are named as it names them.
  // Two changes made one right after the other are drawn with the same
  // settings. The second must not carry the first back to what it was: each
  // change keeps, in the app and in the file on disk.
  await page.click('[data-a=settings]')
  await page.click('[data-a=sec][data-id=look]')
  const appearance = async () => {
    const settings = (await page.evaluate(() => window.awb.getState())).db.settings
    return { fontSize: settings.fontSize, editorFontSize: settings.editorFontSize, density: settings.density }
  }
  await page.getByLabel('Interface density', { exact: true }).selectOption('comfortable')
  await page.waitForFunction(async () => (await window.awb.getState()).db.settings.density === 'comfortable')
  await page.getByLabel('Font size', { exact: true }).selectOption('18')
  await page.getByLabel('Source font size', { exact: true }).selectOption('17')
  await page.getByLabel('Interface density', { exact: true }).selectOption('compact')
  await page.waitForFunction(async () => {
    const settings = (await window.awb.getState()).db.settings
    return settings.fontSize === 18 && settings.editorFontSize === 17 && settings.density === 'compact'
  }, null, { timeout: 8000 }).catch(async () => { throw new Error(`three changes in a row kept ${JSON.stringify(await appearance())}`) })
  await page.waitForTimeout(800)
  const onDisk = JSON.parse(fs.readFileSync(path.join(data, 'workbench.json'), 'utf8')).settings
  assert.deepEqual([onDisk.fontSize, onDisk.editorFontSize, onDisk.density], [18, 17, 'compact'], 'three changes made one right after the other must all reach the file')
  assert.deepEqual(await appearance(), { fontSize: 18, editorFontSize: 17, density: 'compact' })
  console.log('PASS three settings changed one right after the other all keep, in the app and in the file')
} finally {
  await app.close()
}
