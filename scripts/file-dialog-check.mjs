import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launchWorkbench } from './fixtures/launch-workbench.mjs'
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
// `--baseline` runs one scale only, 100% unless `--scale=<factor>` names the
// desktop's own, which is the only one that gives a 1024 by 680 page here.
const baselineScale = Number(process.argv.find((arg) => arg.startsWith('--scale='))?.slice(8) || 1)
const notRun = []
for (const scale of baseline ? [baselineScale] : [1, 1.25, 1.5, 2]) for (const theme of baseline ? ['dark'] : ['dark', 'light']) {
  fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify({ settings: { layout: 'balanced', theme, restore: false }, projects: [{ id: 'p', name: '文件弹窗验证', host: 'local', path: project, agent: 'shell' }] }))
  const env = { ...process.env, AWB_USER_DATA: data }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await launchWorkbench({ args: ['.'], env, scale })
  try {
    const page = await app.firstWindow()
    page.setDefaultTimeout(10000)
    await installDocumentHarness(app, page, false)
    await page.click('[data-a=rmode][data-id=files]')
    for (const [width, height] of baseline ? [[1024, 680]] : [[1024, 680], [1440, 900]]) {
      await app.resize(width, height)
      const open = async (action, row, name) => {
        if (app.menuFile) fs.writeFileSync(app.menuFile, action)
        else await app.evaluate((_electron, command) => { globalThis.__documentMenuCommand = command }, action)
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
        // The keyboard stays in the dialog: past its last control Tab comes
        // back to the first, and before its first Shift+Tab to the last.
        // The page must keep the focus on the way, not hand it to the window
        // around it and take it back on the next key.
        const focus = () => page.evaluate(() => ({ inDialog: !!document.activeElement?.closest('dialog[open]'), onPage: document.hasFocus(), at: document.activeElement?.getAttribute('aria-label') || document.activeElement?.tagName }))
        const walk = async (key, times) => {
          for (let i = 0; i < times; i++) {
            await page.keyboard.press(key)
            const seen = await focus()
            assert.ok(seen.inDialog && seen.onPage, `${key} ${i + 1} of ${times} left the dialog: ${JSON.stringify(seen)}`)
          }
        }
        const controls = await dialog.evaluate((element) => element.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])').length)
        await walk('Tab', controls + 2)
        await walk('Shift+Tab', controls + 2)
        await page.keyboard.press('Escape')
        await dialog.waitFor({ state: 'detached' })
        assert.equal(await row.evaluate((element) => document.activeElement === element), true)
      }
      await open('create-file', page.getByRole('group', { name: '文件树', exact: true }), '新建文件')
      await open('move', page.locator('[data-a=preview]').filter({ hasText: filename }), '移动到')
      await open('reference', page.locator('[data-a=preview]').filter({ hasText: filename }), '引用到当前终端')
      if (app.shell === 'tauri') {
        // The page is the only control in the window on Tauri, so it turns Tab
        // round itself at its ends. A control that takes Tab for its own use
        // comes first: the source editor puts two spaces in for Tab, and does
        // so still when the editor is the page's last control, where the key
        // would otherwise be one that leaves the page.
        await page.getByText('conflict-task.txt', { exact: true }).first().click()
        const editor = page.getByLabel('文件内容', { exact: true })
        await editor.waitFor()
        await editor.focus()
        const placed = await page.evaluate(() => {
          const field = document.querySelector('[aria-label="文件内容"]')
          const order = () => [...document.querySelectorAll('button, input:not([disabled]), select, textarea, a[href], [tabindex]')].filter((node) => node.tabIndex >= 0 && !node.closest('[inert]'))
          const moved = order().slice(order().indexOf(field) + 1)
          for (const node of moved) node.tabIndex = -1
          return { moved: moved.length, last: order()[order().length - 1] === field }
        })
        assert.equal(placed.last, true, JSON.stringify(placed))
        // Where opening a file leaves the caret is not what this case is about,
        // and it is not the same for a file opened for the first time in this
        // data directory and for one opened again, so it is set here. The
        // editor puts the caret after the two spaces in the next frame, and a
        // key typed before that lands where the browser left it, so it is
        // waited for: the next key is typed the way a person would, after it.
        await editor.evaluate((element) => element.setSelectionRange(0, 0))
        await page.keyboard.press('Tab')
        await page.waitForFunction(() => document.querySelector('[aria-label="文件内容"]')?.selectionStart === 2)
        await page.keyboard.type('x')
        const typed = await editor.evaluate((element) => ({ value: element.value, focused: document.activeElement === element, onPage: document.hasFocus() }))
        assert.deepEqual(typed, { value: '  xold task content', focused: true, onPage: true }, JSON.stringify(typed))
        await page.keyboard.press('Control+z')
        await page.screenshot({ path: path.join(captures, `${theme}-${width}-${scale}-editor-tab.png`), animations: 'disabled' })
      }
      await page.evaluate((source) => window.awb.transferDrop('p', '', [source]), conflictSource)
      const task = page.locator('.upload-status').last()
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
      await task.getByText('部分项目已跳过', { exact: true }).waitFor()
      assert.equal(fs.readFileSync(path.join(project, 'conflict-task.txt'), 'utf8'), 'old task content')
      await task.getByRole('button', { name: '关闭传输提示', exact: true }).click()
      const uploadId = `upload-layout-${theme}-${width}-${scale}`
      const upload = { id: uploadId, projectId: 'p', direction: 'upload', state: 'running', phase: 'transferring', current: filename, destination: `${project}/${'中文长目录/'.repeat(12)}`, bytes: 1048576, total: 4194304, overallBytes: 5242880, overallTotal: 10485760, items: [] }
      if (app.shell === 'tauri') await page.evaluate((upload) => window.__TAURI_INTERNALS__.invoke('awb', { channel: 'transfer:inject', args: [upload] }), upload)
      else await app.evaluate(({ BrowserWindow }, upload) => BrowserWindow.getAllWindows()[0].webContents.send('transfer:update', upload), upload)
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
      // One line and the close button, as the Electron build lays it out: the
      // same 52 CSS pixels at most, whatever the scale and the theme.
      assert.ok(uploadBounds.bottom - uploadBounds.top <= 52, JSON.stringify(uploadBounds))
      await page.screenshot({ path: path.join(captures, `${theme}-${width}-${scale}-upload-status.png`), animations: 'disabled' })
      if (app.shell === 'tauri') await page.evaluate((upload) => window.__TAURI_INTERNALS__.invoke('awb', { channel: 'transfer:inject', args: [{ ...upload, state: 'completed' }] }), upload)
      else await app.evaluate(({ BrowserWindow }, upload) => BrowserWindow.getAllWindows()[0].webContents.send('transfer:update', { ...upload, state: 'completed' }), upload)
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
  } catch (error) {
    // A scale below the desktop's cannot give a 1024 by 680 page: the window
    // will not go smaller than that in logical pixels. Said, not passed.
    if (!/needs a desktop at/.test(String(error?.message ?? error))) throw error
    notRun.push(`${scale * 100}% DPI ${theme}: ${error.message}`)
  } finally { await app.close() }
}
for (const line of notRun) console.log(`NOT RUN ${line}`)
if (notRun.length) process.exitCode = 2
