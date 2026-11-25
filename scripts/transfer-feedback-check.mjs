import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright'

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pello-transfer-feedback-'))
const project = path.join(data, 'project'); fs.mkdirSync(project)
fs.writeFileSync(path.join(project, 'first.txt'), 'first file')
fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify({ settings: { layout: 'balanced', restore: false }, projects: [{ id: 'p', name: 'Transfer', host: 'local', path: project, agent: 'shell' }] }))
const env = { ...process.env, AWB_USER_DATA: data }; delete env.ELECTRON_RUN_AS_NODE
const dpi = Number(process.argv.find((arg) => arg.startsWith('--dpi='))?.split('=')[1] || 1)
const shots = path.resolve('output/playwright/transfer-feedback'); fs.mkdirSync(shots, { recursive: true })
const app = await electron.launch({ args: ['.', `--force-device-scale-factor=${dpi}`], env })
try {
  const page = await app.firstWindow(); page.setDefaultTimeout(10000)
  assert.equal(await page.evaluate(() => devicePixelRatio), dpi)
  await page.click('[data-a=rmode][data-id=files]')
  const first = page.locator('[data-a=preview][data-id="first.txt"]'); await first.waitFor()
  await page.screenshot({ path: path.join(data, 'before.png') })
  const before = await first.boundingBox()
  const transfer = await page.evaluateHandle(() => { const value = new DataTransfer(); value.items.add(new File(['test'], 'drag.txt')); return value })
  await first.dispatchEvent('dragover', { dataTransfer: transfer })
  await page.locator('.tree-drop-hint').waitFor()
  const after = await first.boundingBox()
  assert.equal(after.y, before.y, 'Showing the drop hint must not push the first file away from the pointer')
  for (let index = 0; index < 30; index++) {
    await page.evaluate(({ x, y }) => {
      const value = new DataTransfer(); value.items.add(new File(['test'], 'drag.txt'))
      document.elementFromPoint(x, y).dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: value }))
    }, { x: before.x + 50, y: before.y + 2 })
    assert.equal((await first.boundingBox()).y, before.y)
    assert.equal(await page.locator('.tree-drop-hint').count(), 1)
  }
  await page.locator('.right .rlist').last().dispatchEvent('dragleave', { dataTransfer: transfer })
  await transfer.dispose()
  console.log('PASS top-edge drag hint preserves file geometry')
  const send = (value) => app.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].webContents.send('transfer:update', value), value)
  const snapshot = (id, direction, state, items = []) => ({ id, direction, state, projectId: 'p', current: '/private/current', destination: '/private/target', bytes: 1024, total: 2048, items })
  await send(snapshot('download-success', 'download', 'completed', [{ status: 'done' }]))
  await page.getByText('下载成功', { exact: true }).waitFor()
  await page.locator('[data-transfer-id="download-success"]').waitFor({ state: 'detached', timeout: 3000 })
  for (const direction of ['upload', 'download']) {
    const id = `${direction}-only`, error = `${direction} failed: fixture reason`
    await send(snapshot(id, direction, 'completed', [{ source: 'source', destination: '/file.txt', status: 'failed', error }]))
    const notice = page.locator(`[data-transfer-id="${id}"]`)
    await notice.getByText(direction === 'upload' ? '上传失败' : '下载失败', { exact: true }).waitFor()
    assert.equal(await page.locator('dialog:modal').count(), 0)
    await notice.getByRole('button', { name: '详情', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '传输详情', exact: true })
    await dialog.getByText(error, { exact: true }).waitFor()
    await dialog.locator('header .ib').click()
    await dialog.waitFor({ state: 'detached' })
    assert.equal(await notice.isVisible(), true)
    await notice.locator('.transfer-close').click()
    await notice.waitFor({ state: 'detached' })
  }
  console.log('PASS upload and download failures open user-requested centered details and retain their notice after closing')
  await send(snapshot('upload-failure', 'upload', 'completed', Array.from({ length: 12 }, (_, index) => ({ source: `file-${index}`, destination: `/private/destination/file-${index}.txt`, status: 'failed', error: `NETWORK_FAILURE_${index} connection interrupted` }))))
  await send(snapshot('download-failure', 'download', 'completed', [{ source: 'download', destination: 'C:/private/download.txt', status: 'failed', error: 'DOWNLOAD_FAILURE disk is full' }]))
  const notice = page.locator('.upload-status')
  await page.waitForFunction(() => document.querySelector('.upload-status')?.dataset.transferCount === '2')
  assert.equal(await notice.count(), 1)
  assert.doesNotMatch(await notice.innerText(), /NETWORK_FAILURE|DOWNLOAD_FAILURE|private/)
  for (const [theme, width, height, font, language] of [
    ['light', 1024, 680, 16, 'en'], ['dark', 1024, 680, 12, 'zh-CN'],
    ['dark', 1440, 900, 16, 'en'], ['light', 1440, 900, 12, 'zh-CN'],
    ...(dpi === 1 ? ['nord', 'dracula', 'catppuccin', 'solarized-light'].map((theme) => [theme, 1024, 680, 16, 'zh-CN']) : [])
  ]) {
    await page.setViewportSize({ width, height })
    await page.evaluate(async ({ theme, font, language }) => { const state = await window.awb.getState(); await window.awb.saveSettings({ ...state.db.settings, theme, uiFontSize: font, language }) }, { theme, font, language })
    await page.reload()
    await page.click('[data-a=rmode][data-id=files]')
    await first.waitFor()
    await page.waitForFunction(({ theme, font }) => document.documentElement.dataset.palette === theme && document.documentElement.style.getPropertyValue('--ui-size') === `${font}px`, { theme, font })
    await send(snapshot('upload-failure', 'upload', 'completed', Array.from({ length: 12 }, (_, index) => ({ source: `file-${index}`, destination: `/private/destination/file-${index}.txt`, status: 'failed', error: `NETWORK_FAILURE_${index} connection interrupted` }))))
    await send(snapshot('download-failure', 'download', 'completed', [{ source: 'download', destination: 'C:/private/download.txt', status: 'failed', error: 'DOWNLOAD_FAILURE disk is full' }]))
    await page.waitForFunction(() => document.querySelector('.upload-status')?.dataset.transferCount === '2')
    await notice.getByRole('button', { name: language === 'en' ? 'Details' : '详情', exact: true }).waitFor()
    await page.evaluate(() => document.fonts.ready)
    // Use the actual panel resize control in the same window.
    const separator = page.locator('.right-resize'); await separator.focus()
    for (let index = 0; index < 25; index++) await separator.press('ArrowRight')
    for (const panelWidth of [220, 360]) {
      if (panelWidth === 360) for (let index = 0; index < 7; index++) await separator.press('ArrowLeft')
      const fileBox = await first.boundingBox(), compact = await notice.boundingBox()
      assert.ok(compact.height < 100, 'Failure summary stays compact')
      await page.locator('.right').screenshot({ path: path.join(shots, `${dpi}-${theme}-${width}-${font}-${panelWidth}-summary.png`) })
      const details = notice.locator('.transfer-details-toggle'); await details.focus(); await page.keyboard.press('Enter')
      const dialog = page.getByRole('dialog', { name: language === 'en' ? 'Transfer details' : '传输详情', exact: true })
      await dialog.getByText('DOWNLOAD_FAILURE disk is full', { exact: true }).waitFor()
      await dialog.evaluate((node) => Promise.all(node.getAnimations().map((animation) => animation.finished.catch(() => {}))))
      assert.equal((await first.boundingBox()).y, fileBox.y, 'Opening details must not move the file list')
      assert.equal((await notice.boundingBox()).height, compact.height, 'The corner notice must stay compact while the dialog is open')
      assert.equal(await notice.locator('.transfer-detail-task').count(), 0)
      assert.equal(await dialog.locator('.transfer-detail-task p').count(), 13)
      const geometry = await dialog.evaluate((node) => {
        const box = node.getBoundingClientRect(), body = node.querySelector('.bdy'), footer = node.querySelector('footer').getBoundingClientRect()
        return { inside: box.left >= 24 && box.right <= innerWidth - 24 && box.bottom <= innerHeight - 24 && box.top >= 24, centered: Math.abs(box.x + box.width / 2 - innerWidth / 2) < 2 && Math.abs(box.y + box.height / 2 - innerHeight / 2) < 2, scrollable: body.scrollHeight > body.clientHeight, overflow: node.scrollWidth > node.clientWidth, modal: node.matches(':modal'), footer: footer.bottom <= box.bottom + 1 }
      })
      assert.deepEqual(geometry, { inside: true, centered: true, scrollable: true, overflow: false, modal: true, footer: true })
      for (let index = 0; index < 8; index++) { await page.keyboard.press('Tab'); assert.equal(await dialog.evaluate((node) => node.contains(document.activeElement)), true) }
      await dialog.locator('.bdy').evaluate((node) => { node.scrollTop = 0 })
      await page.screenshot({ path: path.join(shots, `${dpi}-${theme}-${width}-${font}-${panelWidth}-dialog.png`) })
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'detached' })
      assert.equal(await details.evaluate((node) => document.activeElement === node), true)
      await details.click()
      await dialog.locator(panelWidth === 220 ? 'header .ib' : 'footer button').click()
      await dialog.waitFor({ state: 'detached' })
      assert.equal(await details.evaluate((node) => document.activeElement === node), true)
      assert.doesNotMatch(await notice.innerText(), /NETWORK_FAILURE|DOWNLOAD_FAILURE/)
    }
  }
  await notice.locator('.transfer-close').focus(); await page.keyboard.press('Enter')
  await notice.waitFor({ state: 'detached' })
  console.log(`PASS ${dpi * 100}% DPI: combined failures, download expiry, keyboard details/close, narrow/wide panels, windows, fonts and languages`)
} finally { await app.close(); console.log(`Transfer feedback evidence: ${data}`) }
