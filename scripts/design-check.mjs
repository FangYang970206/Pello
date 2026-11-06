import { installDocumentHarness, documentCommand } from './fixtures/document-harness.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { _electron as electron } from 'playwright'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const baseline = process.argv.includes('--before')
const folder = path.join(root, 'output/playwright', baseline ? 'design-before' : 'design-after')
fs.mkdirSync(folder, { recursive: true })
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-design-'))
const project = path.join(data, 'workspace')
fs.mkdirSync(path.join(project, 'src'), { recursive: true })
fs.writeFileSync(path.join(project, 'README.md'), '# 工作台使用指南\n\n在同一个工作区管理终端、项目文件与远程机器。\n\n## 保持专注\n\n- **终端**保留当前任务和会话。\n- 编辑文件后自动保存，支持撤销和重做。\n\n| 状态 | 含义 |\n| --- | --- |\n| 黄色 | 正在运行 |\n| 绿色 | 可以继续输入 |\n\n```ts\nconst workspace = "Pello"\n```\n')
fs.writeFileSync(path.join(project, 'src/app.ts'), 'export const ready = false\n')
execFileSync('git', ['init', '-b', 'main'], { cwd: project })
execFileSync('git', ['add', '.'], { cwd: project })
execFileSync('git', ['-c', 'user.name=Design check', '-c', 'user.email=design@example.invalid', 'commit', '-m', 'fixture'], { cwd: project })
fs.writeFileSync(path.join(project, 'src/app.ts'), 'export const ready = true\n')
fs.writeFileSync(path.join(project, 'page.html'), '<!doctype html><h1>项目预览</h1>')
const env = { ...process.env, AWB_USER_DATA: data, AWB_RESOURCE_HOME: path.join(data, 'agent-home') }
fs.mkdirSync(env.AWB_RESOURCE_HOME, { recursive: true })
fs.writeFileSync(path.join(env.AWB_RESOURCE_HOME, '.claude.json'), '{"mcpServers":{"project-tools":{"command":"node","args":["server.mjs"]}}}')
const skillFolder = path.join(env.AWB_RESOURCE_HOME, '.claude', 'skills', 'project-conventions')
fs.mkdirSync(skillFolder, { recursive: true })
fs.writeFileSync(path.join(skillFolder, 'SKILL.md'), '---\nname: project-conventions\ndescription: 项目开发约定与检查流程\n---\n# 项目约定\n')
delete env.ELECTRON_RUN_AS_NODE
fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify({
  settings: { layout: 'balanced', theme: 'dark', fontSize: 13, defShell: process.platform === 'win32' ? 'pwsh' : 'bash', defAgent: 'shell', restore: false, confirmKill: false },
  projects: [{ id: 'p', name: 'Pello', host: 'local', path: project, agent: 'shell' },
    { id: 'long', name: '跨团队协作与远程项目名称很长时的显示检查', host: 'local', path: project, agent: 'shell' }],
  custom: [{ id: 'custom', name: '项目专用 Agent', cmd: 'custom-agent', args: '--interactive --workspace current-project', shell: 'pwsh', color: '#7fb2ff', letter: 'A', env: [] }]
}))
const app = await electron.launch({ args: [root], cwd: root, env })
const errors = [], captures = []
function contrast(first, second) {
  const luminance = (hex) => {
    const value = hex.replace('#', '')
    const full = value.length === 3 ? [...value].map((digit) => digit + digit).join('') : value
    const linear = [0, 2, 4].map((offset) => {
      const channel = parseInt(full.slice(offset, offset + 2), 16) / 255
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    })
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722
  }
  const a = luminance(first), b = luminance(second)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}
try {
  const page = await app.firstWindow()
  await installDocumentHarness(app, page)
  page.setDefaultTimeout(20000)
  page.on('pageerror', (error) => errors.push(error.message))
  await page.locator('[data-a=quick]').waitFor()
  await page.click('[data-a=quick]')
  await page.locator('.xterm').waitFor()
  const shot = async (name, theme, size, surface = page) => {
    await surface.evaluate(() => document.fonts.ready)
    await surface.screenshot({ path: path.join(folder, `${theme}-${size}-${name}.png`), animations: 'disabled' })
    const issues = await surface.evaluate(() => [...document.querySelectorAll('.dlg,.scol,.filebar,.diffbar,.rh,.selmenu')].filter((node) => node.getClientRects().length).flatMap((node) => {
      const box = node.getBoundingClientRect()
      const issues = box.left < -1 || box.right > innerWidth + 1 ? [`${node.className} exceeds viewport`] : []
      if (node.matches('.dlg,.selmenu') && (box.top < 0 || box.bottom > innerHeight)) issues.push(`${node.className} exceeds viewport vertically`)
      return issues
    }))
    captures.push({ name, theme, size, issues })
    if (!baseline) assert.deepEqual(issues, [], `${theme}/${size}/${name}`)
  }
  const closeDialog = () => page.locator('.dlg header [data-a=mclose]').click()
  for (const theme of ['dark', 'light']) {
    for (const [width, height] of [[1440, 900], [1024, 680]]) {
      const size = String(width)
      await app.evaluate(({ BrowserWindow }, dimensions) => BrowserWindow.getAllWindows()[0].setContentSize(...dimensions), [width, height])
      await page.click('[data-a=settings]')
      await page.click('[data-a=sec][data-id=look]')
      await page.click(`[data-a=theme][data-id=${theme}]`)
      if (!baseline) {
        const palette = await page.evaluate(() => {
          const style = getComputedStyle(document.documentElement)
          return Object.fromEntries(['text', 'muted', 'faint', 'green', 'red', 'amber', 'blue', 'cyan', 'magenta', 'bg', 'side', 'panel', 'elev', 'elev2', 'accent', 'accent-ink', 'danger-fill'].map((name) => [name, style.getPropertyValue(`--${name}`).trim()]))
        })
        for (const foreground of ['text', 'muted', 'faint', 'green', 'red', 'amber', 'blue', 'cyan', 'magenta']) {
          for (const background of ['bg', 'side', 'panel', 'elev', 'elev2']) {
            assert.ok(contrast(palette[foreground], palette[background]) >= 4.5, `${theme} ${foreground}/${background} must meet 4.5:1`)
          }
        }
        assert.ok(contrast(palette['accent-ink'], palette.accent) >= 4.5)
        assert.ok(contrast('#ffffff', palette['danger-fill']) >= 4.5)
      }
      for (const section of ['general', 'look', 'agents', 'hosts', 'mcp', 'skills', 'keys']) {
        await page.click(`[data-a=sec][data-id=${section}]`)
        await shot(`settings-${section}`, theme, size)
        if (section === 'mcp' || section === 'skills') {
          const label = section === 'mcp' ? '添加 MCP' : '添加 Skill'
          await page.getByRole('button', { name: label, exact: true }).click()
          await shot(`settings-${section}-add`, theme, size)
          await page.locator('.resource-dialog header [data-a=mclose]').click()
          const name = section === 'mcp' ? 'project-tools' : 'project-conventions'
          await page.getByRole('button', { name: `查看 ${name} 详情`, exact: true }).click()
          await shot(`settings-${section}-detail`, theme, size)
          await page.keyboard.press('Escape')
          await page.getByRole('dialog').waitFor({ state: 'detached' })
        }
      }
      await page.click('[data-a=sec][data-id=hosts]')
      await page.click('[data-a=host]:not([data-id])')
      await page.getByRole('combobox', { name: '认证方式', exact: true }).selectOption('password')
      await shot('host-password', theme, size)
      await closeDialog()
      await page.click('[data-a=sec][data-id=agents]')
      await page.click('[data-a=custom]:not([data-id])')
      await page.click('[data-a=ce-more]')
      await page.click('[data-a=env-add]')
      await shot('executor', theme, size)
      await closeDialog()
      await page.click('[data-a=back]')
      await page.click('[data-a=newproj]')
      await shot('new-project', theme, size)
      await page.click('[data-np=agent]')
      await shot('agent-menu', theme, size)
      if (!baseline) {
        await page.keyboard.press('End')
        assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), '仅 Shell')
        await page.keyboard.press('ArrowUp')
        assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), '项目专用 Agent')
        await page.keyboard.press('Escape')
        assert.equal(await page.locator('.dlg').count(), 1, 'Esc closes the menu before the dialog')
        assert.equal(await page.locator('.selmenu').count(), 0)
      } else await page.click('[data-np=agent]')
      await page.click('[data-a=np-addhost]')
      await page.getByRole('combobox', { name: '认证方式', exact: true }).selectOption('password')
      await shot('inline-host-password', theme, size)
      await closeDialog()
      await page.click('[data-a=newterm]')
      await shot('new-terminal', theme, size)
      await closeDialog()
      await page.click('[data-a=rmode][data-id=files]')
      await page.click('[data-a=preview][data-id="README.md"]')
      await page.getByRole('textbox', { name: 'Markdown 内容', exact: true }).waitFor()
      await shot('markdown', theme, size)
      await documentCommand(app, page, 'mode')
      await shot('source', theme, size)
      await page.click('[data-a=preview][data-id="page.html"]')
      await shot('html', theme, size)
      await page.click('[data-a=rmode][data-id=changes]')
      await page.click('[data-a=diff][data-id="src/app.ts"]')
      await shot('diff', theme, size)
      await page.click('[data-a=dmode][data-id=split]')
      await shot('diff-split', theme, size)
      await page.click('[data-a=dmode][data-id=unified]')
      await page.locator('[data-a=discard]').click()
      await shot('confirm', theme, size)
      await closeDialog()
      if (!await page.locator('.xterm').count()) await page.click('[data-a=quick]')
      else await page.locator('.tab [data-a=tab]').filter({ hasText: /PowerShell|bash/ }).click()
      await page.locator('.xterm').waitFor()
      await shot('terminal', theme, size)
      if (!baseline) {
        const secondProject = page.getByRole('button', { name: '打开项目 跨团队协作与远程项目名称很长时的显示检查', exact: true })
        await secondProject.focus()
        await secondProject.press('Enter')
        assert.equal(await secondProject.getAttribute('aria-current'), 'true')
        assert.ok(await secondProject.evaluate((node) => node.matches(':focus-visible')), 'Project selection must keep visible keyboard focus')
        await page.getByRole('heading', { name: '还没有终端', exact: true }).waitFor()
        await shot('empty-project', theme, size)
        await page.getByRole('button', { name: '打开项目 Pello', exact: true }).press('Enter')
        await page.locator('.xterm:visible').waitFor()
      }
      console.log(`PASS visual surfaces ${theme} ${width}x${height}`)
    }
  }
  assert.deepEqual(errors, [], 'Renderer errors')
  if (!baseline) {
    const emptyData = path.join(data, 'first-launch')
    fs.mkdirSync(emptyData)
    const emptyApp = await electron.launch({ args: [root], cwd: root, env: { ...env, AWB_USER_DATA: emptyData } })
    try {
      const emptyPage = await emptyApp.firstWindow()
      await emptyPage.getByRole('heading', { name: '创建第一个项目', exact: true }).waitFor()
      for (const theme of ['dark', 'light']) {
        for (const [width, height] of [[1440, 900], [1024, 680]]) {
          await emptyApp.evaluate(({ BrowserWindow }, dimensions) => BrowserWindow.getAllWindows()[0].setContentSize(...dimensions), [width, height])
          await emptyPage.click('[data-a=settings]')
          await emptyPage.click('[data-a=sec][data-id=look]')
          await emptyPage.click(`[data-a=theme][data-id=${theme}]`)
          await emptyPage.click('[data-a=back]')
          await shot('first-launch', theme, String(width), emptyPage)
        }
      }
    } finally {
      const closed = emptyApp.waitForEvent('close')
      await emptyApp.windows()[0].getByRole('button', { name: '关闭窗口', exact: true }).click()
      await closed
    }
  }
  fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify(captures, null, 2))
  console.log(`Captured ${captures.length} interface states`)
} finally {
  await app.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 1 }).catch(() => {})
  const closed = app.waitForEvent('close')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
  await closed
}
