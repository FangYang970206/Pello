import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright'
import { installDocumentHarness } from './fixtures/document-harness.mjs'

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-file-dialog-'))
const project = path.join(data, 'project')
fs.mkdirSync(project)
fs.mkdirSync(path.join(project, 'destination'))
const filename = `${'中文 路径 '.repeat(16)}source.txt`
fs.writeFileSync(path.join(project, filename), 'source')
const conflictSource = path.join(data, 'source', 'conflict-task.txt')
fs.mkdirSync(path.dirname(conflictSource))
fs.writeFileSync(conflictSource, 'new task content')
fs.writeFileSync(path.join(project, 'conflict-task.txt'), 'old task content')
const captures = path.resolve('output/playwright/file-dialogs')
fs.mkdirSync(captures, { recursive: true })
const baseline = process.argv.includes('--baseline')
for (const scale of baseline ? [1] : [1, 1.25, 1.5, 2]) for (const theme of baseline ? ['dark'] : ['dark', 'light']) {
  fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify({ settings: { layout: 'balanced', theme, restore: false }, projects: [{ id: 'p', name: '文件弹窗验证', host: 'local', path: project, agent: 'shell' }] }))
  const env = { ...process.env, AWB_USER_DATA: data }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ args: [`--force-device-scale-factor=${scale}`, '.'], env })
  try {
    const page = await app.firstWindow()
    page.setDefaultTimeout(10000)
    await installDocumentHarness(app, page, false)
    await page.click('[data-a=rmode][data-id=files]')
    for (const [width, height] of baseline ? [[1024, 680]] : [[1024, 680], [1440, 900]]) {
      await page.evaluate(({ width, height }) => window.awb.winResize(width, height), { width, height })
      await page.waitForFunction(({ width, height }) => innerWidth === width && innerHeight === height, { width, height })
      const open = async (action, row, name) => {
        await app.evaluate((_electron, command) => { globalThis.__documentMenuCommand = command }, action)
        await row.focus()
        await row.dispatchEvent('contextmenu')
        const dialog = page.getByRole('dialog', { name, exact: true })
        await dialog.waitFor()
        await page.screenshot({ path: path.join(captures, `${theme}-${width}-${scale}-${action}.png`), animations: 'disabled' })
        const layout = await dialog.evaluate((element) => {
          const rect = element.getBoundingClientRect(), style = getComputedStyle(element)
          const controls = [...element.querySelectorAll('button')].map((button) => { const box = button.getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top, bottom: box.bottom } })
          return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, center: rect.left + rect.width / 2, viewport: innerWidth, color: style.color, expectedColor: getComputedStyle(document.body).color, overflow: element.scrollWidth > element.clientWidth + 1, controls, modal: element.matches(':modal'), focused: element.contains(document.activeElement) }
        })
        assert.ok(layout.modal && layout.focused, JSON.stringify(layout))
        assert.ok(layout.left >= 23 && layout.top >= 23 && layout.right <= width - 23 && layout.bottom <= height - 23, JSON.stringify(layout))
        assert.ok(Math.abs(layout.center - width / 2) < 2, JSON.stringify(layout))
        assert.equal(layout.color, layout.expectedColor, JSON.stringify(layout))
        assert.equal(layout.overflow, false, JSON.stringify(layout))
        assert.ok(layout.controls.every((box) => box.left >= layout.left && box.right <= layout.right + 1 && box.top >= layout.top && box.bottom <= layout.bottom + 1), JSON.stringify(layout))
        for (let i = 0; i < 8; i++) { await page.keyboard.press('Tab'); assert.equal(await dialog.evaluate((element) => element.contains(document.activeElement)), true) }
        await page.keyboard.press('Escape')
        await dialog.waitFor({ state: 'detached' })
        assert.equal(await row.evaluate((element) => document.activeElement === element), true)
      }
      await open('create-file', page.getByRole('group', { name: '文件树', exact: true }), '新建文件')
      await open('move', page.locator('[data-a=preview]').filter({ hasText: filename }), '移动到')
      await open('reference', page.locator('[data-a=preview]').filter({ hasText: filename }), '引用到当前终端')
      await page.evaluate((source) => window.awb.transferDrop('p', '', [source]), conflictSource)
      const task = page.locator('.transfer-task').last()
      const batch = task.getByLabel('应用到本批次同类冲突')
      await batch.waitFor()
      assert.equal(await batch.isChecked(), false)
      await batch.scrollIntoViewIfNeeded()
      await page.screenshot({ path: path.join(captures, `${theme}-${width}-${scale}-conflict.png`), animations: 'disabled' })
      const bounds = await batch.evaluate((element) => {
        const label = element.parentElement.getBoundingClientRect()
        return { left: label.left, right: label.right, top: label.top, bottom: label.bottom, width: innerWidth, height: innerHeight }
      })
      assert.ok(bounds.left >= 0 && bounds.right <= width && bounds.top >= 0 && bounds.bottom <= height, JSON.stringify(bounds))
      await batch.focus(); await batch.press('Space')
      assert.equal(await batch.isChecked(), true)
      await page.keyboard.press('Tab')
      assert.equal(await task.getByRole('button', { name: '跳过冲突项', exact: true }).evaluate((element) => document.activeElement === element), true)
      await page.keyboard.press('Enter')
      await task.getByText('导入结束', { exact: true }).waitFor()
      assert.equal(fs.readFileSync(path.join(project, 'conflict-task.txt'), 'utf8'), 'old task content')
      await task.getByRole('button', { name: '关闭', exact: true }).click()
      const uploadId = `upload-layout-${theme}-${width}-${scale}`
      const upload = { id: uploadId, projectId: 'p', direction: 'upload', state: 'running', phase: 'transferring', current: filename, destination: `${project}/${'中文长目录/'.repeat(12)}`, bytes: 1048576, total: 4194304, overallBytes: 5242880, overallTotal: 10485760, items: [] }
      await app.evaluate(({ BrowserWindow }, upload) => BrowserWindow.getAllWindows()[0].webContents.send('transfer:update', upload), upload)
      const uploading = page.locator('.upload-status').last()
      await uploading.getByText('上传中', { exact: true }).waitFor()
      assert.equal(await uploading.getByRole('progressbar').count(), 0)
      assert.equal(await uploading.innerText(), '上传中')
      await uploading.getByRole('button', { name: '取消上传', exact: true }).focus()
      assert.equal(await uploading.getByRole('button', { name: '取消上传', exact: true }).evaluate((element) => document.activeElement === element), true)
      const uploadBounds = await uploading.evaluate((element) => {
        const box = element.getBoundingClientRect()
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, overflow: element.scrollWidth > element.clientWidth + 1, viewport: innerWidth, height: innerHeight }
      })
      assert.ok(!uploadBounds.overflow && uploadBounds.left >= 0 && uploadBounds.right <= width && uploadBounds.top >= 0 && uploadBounds.bottom <= height, JSON.stringify(uploadBounds))
      assert.ok(uploadBounds.bottom - uploadBounds.top <= 36, JSON.stringify(uploadBounds))
      await page.screenshot({ path: path.join(captures, `${theme}-${width}-${scale}-upload-status.png`), animations: 'disabled' })
      await app.evaluate(({ BrowserWindow }, upload) => BrowserWindow.getAllWindows()[0].webContents.send('transfer:update', { ...upload, state: 'completed' }), upload)
      await uploading.getByText('上传成功', { exact: true }).waitFor()
      await uploading.waitFor({ state: 'detached', timeout: 3500 })
      assert.equal(await page.evaluate(() => devicePixelRatio), scale)
      await page.click('[data-a=settings]')
      await page.waitForFunction(() => !document.querySelector('[aria-label="默认 Shell"]').disabled)
      await page.getByText('文件搜索设置', { exact: true }).click()
      const rules = page.getByLabel('忽略的目录名称')
      await rules.scrollIntoViewIfNeeded()
      const settingsBounds = await rules.evaluate((element) => {
        const box = element.getBoundingClientRect(), container = document.querySelector('.scontent')
        return { left: box.left, right: box.right, width: innerWidth, overflow: container.scrollWidth > container.clientWidth + 1, height: box.height }
      })
      assert.ok(!settingsBounds.overflow && settingsBounds.left >= 0 && settingsBounds.right <= width && settingsBounds.height >= 30, JSON.stringify(settingsBounds))
      await page.screenshot({ path: path.join(captures, `${theme}-${width}-${scale}-file-settings.png`), animations: 'disabled' })
      await page.click('[data-a=back]')
      await page.locator('[data-a=new-session][data-id=p]').locator('..').hover()
      await page.click('[data-a=new-session][data-id=p]')
      const termDialog = page.getByRole('dialog', { name: '新建会话', exact: true })
      await termDialog.waitFor()
      await page.waitForFunction(() => !document.querySelector('[data-a=nt-ok]').disabled)
      const shellLayout = await termDialog.evaluate((element) => {
        const box = element.getBoundingClientRect()
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, overflow: element.scrollWidth > element.clientWidth + 1, choices: [...element.querySelectorAll('[data-a=nts]')].map((node) => { const bounds = node.getBoundingClientRect(); return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom } }) }
      })
      assert.ok(!shellLayout.overflow && shellLayout.left >= 23 && shellLayout.right <= width - 23 && shellLayout.top >= 23 && shellLayout.bottom <= height - 23, JSON.stringify(shellLayout))
      assert.ok(shellLayout.choices.every((box) => box.left >= shellLayout.left && box.right <= shellLayout.right && box.top >= shellLayout.top && box.bottom <= shellLayout.bottom), JSON.stringify(shellLayout))
      await page.screenshot({ path: path.join(captures, `${theme}-${width}-${scale}-shell-options.png`), animations: 'disabled' })
      await page.keyboard.press('Escape')
      console.log(`PASS file dialogs ${theme} ${width}×${height} ${scale * 100}% DPI: modal focus, bounds, paths, theme and keyboard return`)
    }
  } finally { await app.close() }
}
