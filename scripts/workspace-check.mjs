import { installDocumentHarness, documentCommand } from './fixtures/document-harness.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-workspace-'))
const projectDir = path.join(data, 'project')
fs.mkdirSync(projectDir)
const shell = process.platform === 'win32' ? 'pwsh' : 'bash'
const quote = (value) => `'${value.replaceAll("'", process.platform === 'win32' ? "''" : "'\\''")}'`
const deep = 'src/main/java/com/example/cloud/project/service/internal'
fs.mkdirSync(path.join(projectDir, deep), { recursive: true })
fs.writeFileSync(path.join(projectDir, deep, 'Main.java'), 'class Main {}\n')
fs.writeFileSync(path.join(projectDir, 'note.txt'), 'original\r\n中文\r\n')
fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify({
  settings: { layout: 'balanced', theme: 'dark', fontSize: 13, defShell: shell, defAgent: 'shell', restore: true, confirmKill: false },
  custom: [{ id: 'ui', name: 'UI fixture', cmd: `${process.platform === 'win32' ? '& ' : ''}${quote(process.execPath)}`,
    args: `${quote(path.join(root, 'scripts/fixtures/terminal-ui.cjs'))} ${quote(path.join(data, 'input.log'))}`, shell, letter: 'U', color: '#7fb2ff', env: [] }],
  projects: [{ id: 'p', name: 'Workspace regression', host: 'local', path: projectDir, agent: 'shell' }, { id: 'p2', name: 'Second project', host: 'local', path: projectDir, agent: 'shell' }],
  sessions: { p: [{ id: 'ui', kind: 'ui', shell }] }
}))
const failures = []
const check = async (name, run) => {
  try { await run(); console.log(`PASS ${name}`) }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message}`) }
}
const env = { ...process.env, AWB_USER_DATA: data }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: [root], cwd: root, env })
try {
  const page = await app.firstWindow()
  await installDocumentHarness(app, page)
  page.setDefaultTimeout(5000)
  await page.waitForFunction(() => window.__awbBuffer?.('ui')?.includes('FOOTER_VISIBLE'))
  await check('terminal footer fits inside the visible pane', async () => {
    const box = await page.evaluate(() => {
      const host = document.querySelector('.termhost').getBoundingClientRect()
      const screen = document.querySelector('.xterm-screen').getBoundingClientRect()
      return { bottom: screen.bottom, limit: host.bottom - 16, right: screen.right, rightLimit: host.right - 16 }
    })
    assert.ok(box.bottom <= box.limit + 1 && box.right <= box.rightLimit + 1, JSON.stringify(box))
  })
  await check('legacy mouse clicks reach the terminal application', async () => {
    const screen = await page.locator('.xterm-screen').boundingBox()
    await page.mouse.click(screen.x + 50, screen.y + 10)
    await page.waitForFunction(() => window.__awbBuffer?.('ui')?.includes('CLICK_COUNT=1'), {}, { timeout: 1200 })
  })
  await page.evaluate(() => window.awb.ptyWrite('ui', 's'))
  await check('SGR mouse clicks reach the terminal application', async () => {
    const screen = await page.locator('.xterm-screen').boundingBox()
    await page.mouse.click(screen.x + 100, screen.y + 10)
    await page.waitForFunction(() => /CLICK_COUNT=[1-9]/.test(window.__awbBuffer?.('ui') || ''), {}, { timeout: 1200 })
  })
  await page.evaluate(() => { window.__terminalNode = document.querySelector('.termhost .xterm') })
  await check('changing terminal fonts retains the terminal instance and screen', async () => {
    await page.click('[data-a=settings]')
    await page.click('[data-a=sec][data-id=look]')
    await page.getByLabel('终端字体', { exact: true }).selectOption('JetBrains Mono')
    await page.getByLabel('字号', { exact: true }).selectOption('18')
    await page.click('[data-a=back]')
    assert.equal(await page.evaluate(() => window.__terminalNode === document.querySelector('.termhost .xterm')), true)
    assert.ok(await page.evaluate(() => window.__awbBuffer('ui').includes('TERM_HEADER')))
    await page.click('[data-a=settings]')
    await page.click('[data-a=sec][data-id=look]')
    await page.getByLabel('终端字体', { exact: true }).selectOption('Cascadia Mono')
    await page.getByLabel('字号', { exact: true }).selectOption('13')
    await page.click('[data-a=back]')
  })
  await page.click('[data-a=rmode][data-id=files]')
  await page.click('[data-a=preview][data-id="note.txt"]')
  await page.click('[data-a=tab][data-id=ui]')
  await check('opening files preserves terminal screen and input modes', async () => {
    assert.equal(await page.evaluate(() => window.__terminalNode === document.querySelector('.termhost .xterm')), true)
    assert.ok(await page.evaluate(() => window.__awbBuffer('ui').includes('TERM_HEADER')))
  })
  await check('directories expand beyond the former depth limit', async () => {
    let rel = ''
    for (const part of deep.split('/')) {
      rel += `${rel ? '/' : ''}${part}`
      await page.locator(`[data-a=tog][data-id="${rel}"]`).click({ timeout: 1200 })
    }
    assert.equal(await page.locator(`[data-a=preview][data-id="${deep}/Main.java"]`).count(), 1)
  })
  await check('file sidebar can be dragged to the left', async () => {
    const handle = page.getByRole('separator', { name: '调整文件面板宽度' })
    const before = await page.locator('.right').boundingBox()
    const box = await handle.boundingBox()
    assert.ok(box)
    await page.mouse.move(box.x + box.width / 2, box.y + 40)
    await page.mouse.down()
    await page.mouse.move(box.x - 120, box.y + 40, { steps: 8 })
    await page.mouse.up()
    await page.waitForFunction((width) => document.querySelector('.right').getBoundingClientRect().width >= width + 100, before.width)
    const after = await page.locator('.right').boundingBox()
    assert.ok(after.width >= before.width + 100, JSON.stringify({ before, after }))
  })
  await check('file contents can be edited and saved with Ctrl+S', async () => {
    await page.click('[data-a=preview][data-id="note.txt"]')
    const editor = page.getByRole('textbox', { name: '文件内容' })
    await editor.fill('changed\n中文编辑\n')
    await editor.press('Control+s')
    await page.waitForFunction(() => !document.querySelector('.tab.on .unsaved'))
    assert.equal(fs.readFileSync(path.join(projectDir, 'note.txt'), 'utf8'), 'changed\r\n中文编辑\r\n')
  })
  await check('unsaved edits survive tab switches and can be saved on close', async () => {
    const editor = page.getByRole('textbox', { name: '文件内容' })
    await editor.fill('pending draft\n')
    await page.click(`[data-a=preview][data-id="${deep}/Main.java"]`)
    await page.click('[data-a=preview][data-id="note.txt"]')
    assert.equal(await editor.inputValue(), 'pending draft\n')
    await page.locator('.tab.on [data-a=close]').click()
    await page.getByRole('dialog', { name: '文件尚未保存' }).waitFor()
    await page.getByRole('button', { name: '取消', exact: true }).click()
    assert.equal(await editor.inputValue(), 'pending draft\n')
    await page.locator('.tab.on [data-a=close]').click()
    await page.click('[data-a=save-close]')
    await page.getByRole('dialog', { name: '文件尚未保存' }).waitFor({ state: 'detached' })
    assert.equal(fs.readFileSync(path.join(projectDir, 'note.txt'), 'utf8'), 'pending draft\r\n')
  })
  await check('external edits are not overwritten by a stale editor', async () => {
    await page.click('[data-a=preview][data-id="note.txt"]')
    const editor = page.getByRole('textbox', { name: '文件内容' })
    await editor.fill('my unsaved edit')
    fs.writeFileSync(path.join(projectDir, 'note.txt'), 'external change\n')
    await documentCommand(app, page, 'save')
    await page.getByRole('alert').filter({ hasText: '文件已被其他程序修改' }).waitFor()
    assert.equal(fs.readFileSync(path.join(projectDir, 'note.txt'), 'utf8'), 'external change\n')
    assert.equal(await editor.inputValue(), 'my unsaved edit')
    await documentCommand(app, page, 'reload')
    await page.click('[data-a=confirm]')
    await page.waitForFunction(() => document.querySelector('textarea[aria-label="文件内容"]')?.value === 'external change\n')
  })
  await check('application close can be cancelled without ending the terminal', async () => {
    await app.evaluate(({ dialog }) => {
      globalThis.__unsavedPrompts = 0
      dialog.showMessageBoxSync = () => { globalThis.__unsavedPrompts++; return 0 }
    })
    await page.getByRole('textbox', { name: '文件内容' }).fill('keep editing')
    await page.getByRole('button', { name: '关闭窗口', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('textarea[aria-label="文件内容"]')?.value === 'keep editing')
    assert.equal(await app.evaluate(() => globalThis.__unsavedPrompts), 1)
    await app.evaluate(({ app }) => app.quit())
    assert.equal(await app.evaluate(() => globalThis.__unsavedPrompts), 2)
    await page.keyboard.press('Control+s')
    await page.waitForFunction(() => !document.querySelector('.tab.on .unsaved'))
    await page.click('[data-a=tab][data-id=ui]')
    assert.ok(await page.evaluate(() => window.__awbBuffer('ui').includes('TERM_HEADER')))
  })
  await check('project switches and resizing retain one terminal screen', async () => {
    await page.click('[data-a=tab][data-id=ui]')
    await page.click('[data-a=proj][data-id=p2]')
    await page.click('[data-a=proj][data-id=p]')
    assert.equal(await page.evaluate(() => window.__terminalNode === document.querySelector('.termhost .xterm')), true)
    for (const [width, height] of [[1024, 680], [1440, 900]]) {
      await page.evaluate(([width, height]) => window.awb.winResize(width, height), [width, height])
      await page.waitForFunction((width) => window.innerWidth === width, width)
      await page.waitForFunction(() => {
        const pane = document.querySelector('.pane:not([hidden]) .termhost').getBoundingClientRect()
        const screen = document.querySelector('.pane:not([hidden]) .xterm-screen').getBoundingClientRect()
        return screen.bottom <= pane.bottom - 15 && screen.right <= pane.right - 15
      })
      await page.waitForFunction(() => (window.__awbBuffer('ui').match(/TERM_HEADER/g) || []).length === 1)
      assert.equal(await page.evaluate(() => (window.__awbBuffer('ui').match(/TERM_HEADER/g) || []).length), 1)
    }
  })
  await check('file writes reject traversal and symbolic links outside the project', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-outside-'))
    fs.writeFileSync(path.join(outside, 'outside.txt'), 'untouched')
    fs.symlinkSync(outside, path.join(projectDir, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    const rejected = await page.evaluate(async () => {
      const read = await window.awb.gitRead('p', 'note.txt')
      const paths = ['../outside.txt', 'escape/outside.txt']
      return await Promise.all(paths.map((rel) => window.awb.gitWrite('p', rel, 'wrong', read.version).then(() => false, () => true)))
    })
    assert.deepEqual(rejected, [true, true])
    assert.equal(fs.readFileSync(path.join(outside, 'outside.txt'), 'utf8'), 'untouched')
  })
  await page.click(`[data-a=preview][data-id="${deep}/Main.java"]`)
  const shots = path.join(root, 'output/playwright')
  fs.mkdirSync(shots, { recursive: true })
  await page.screenshot({ path: path.join(shots, 'workspace-editor.png') })
} finally {
  await app.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 1 }).catch(() => {})
  const page = app.windows()[0]
  const closed = app.waitForEvent('close')
  await page.getByRole('button', { name: '关闭窗口', exact: true }).click()
  await closed
}
assert.equal(failures.length, 0, failures.join(', '))
