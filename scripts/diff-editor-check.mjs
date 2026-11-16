import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { _electron as electron } from 'playwright'

const root = path.resolve('.')
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pello-diff-editor-'))
const project = path.join(data, 'repo')
fs.mkdirSync(project)
const git = (...args) => execFileSync('git', args, { cwd: project, windowsHide: true })
git('init', '-q')
const before = Array.from({ length: 150 }, (_, i) => `line ${i + 1} ${'wide '.repeat(60)}`).join('\n') + '\n'
const after = before.replace('line 2 ', 'changed 2 ').replace('line 140 ', 'changed 140 ')
fs.writeFileSync(path.join(project, 'fixture.txt'), before)
fs.writeFileSync(path.join(project, 'deleted.txt'), 'deleted original\n')
git('add', '.')
git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture')
fs.writeFileSync(path.join(project, 'fixture.txt'), after)
fs.unlinkSync(path.join(project, 'deleted.txt'))
fs.writeFileSync(path.join(project, 'untracked.txt'), 'untracked contents\n')
fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify({
  settings: { layout: 'balanced', restore: false, theme: 'dark' },
  projects: [{ id: 'p', name: 'Diff fixture', path: project, host: 'local', agent: 'shell' }]
}))
const env = { ...process.env, AWB_USER_DATA: data }
delete env.ELECTRON_RUN_AS_NODE
const dpi = Number(process.env.AWB_TEST_DPI || 1)
const app = await electron.launch({ args: [root, `--force-device-scale-factor=${dpi}`], cwd: root, env })
try {
  const page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  await page.locator('[data-a=diff][data-id="fixture.txt"]').click()
  await page.locator('[data-a=dmode][data-id=split]').click()
  assert.equal(await page.locator('.diff-actions button').count(), 4)
  assert.ok((await page.locator('.diff-actions button').evaluateAll((nodes) => nodes.map((node) => ({
    icon: !!node.querySelector('svg'), text: node.textContent.trim(), label: node.getAttribute('aria-label'), title: node.getAttribute('title')
  })))).every((item) => item.icon && !item.text && item.label && item.title), 'Diff actions must use named, tooltip-equipped icons')
  await page.locator('.diff-actions [data-a=discard]').click()
  await page.locator('[data-a=confirm]').waitFor()
  await page.keyboard.press('Escape')
  assert.equal(fs.readFileSync(path.join(project, 'fixture.txt'), 'utf8'), after, 'Canceling the discard icon must keep file contents')
  assert.equal(await page.locator('.diff-split .cm-content[contenteditable=true]').count(), 2, 'both diff panes must be editable')
  const contents = page.locator('.diff-split .cm-content')
  const checkChangedLineStyle = async () => {
    await page.waitForFunction(() => document.querySelectorAll('.diff-split .cm-changedText').length >= 2)
    const styles = await page.locator('.diff-split .cm-changedText').evaluateAll((nodes) => nodes.map((node) => {
      const text = getComputedStyle(node), line = getComputedStyle(node.closest('.cm-changedLine'))
      return { backgroundImage: text.backgroundImage, decoration: text.textDecorationLine, lineBackground: line.backgroundColor }
    }))
    assert.ok(styles.length >= 2, 'both panes must render changed text')
    assert.ok(styles.every((style) => style.backgroundImage === 'none' && style.decoration === 'none'), `changed text must have no red/green underline: ${JSON.stringify(styles)}`)
    assert.ok(styles.every((style) => !['transparent', 'rgba(0, 0, 0, 0)'].includes(style.lineBackground)), 'changed lines must retain their background highlight')
  }
  await contents.first().waitFor()
  assert.deepEqual(await contents.evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).fontSize)), ['13px', '13px'], 'Both diff panes must use the terminal font size')
  fs.mkdirSync(path.join(root, 'output/playwright/diff-editor'), { recursive: true })
  await page.screenshot({ path: path.join(root, 'output/playwright/diff-editor/split-initial.png') })
  await checkChangedLineStyle()
  await page.getByRole('button', { name: '还原此处更改', exact: true }).first().click()
  await page.getByRole('button', { name: '保存文件', exact: true }).click()
  await page.waitForFunction(() => !document.querySelector('.dot.unsaved'))
  assert.equal(fs.readFileSync(path.join(project, 'fixture.txt'), 'utf8'), after.replace('changed 2 ', 'line 2 '), 'hunk revert must leave the other changed block intact')
  const scrollers = page.locator('.diff-split .cm-scroller')
  for (const side of [0, 1]) {
    await scrollers.nth(side).evaluate((node, side) => node.scrollTo({ top: 1000 + side * 100, left: 500 + side * 50 }), side)
    await page.waitForTimeout(150)
    const positions = await scrollers.evaluateAll((nodes) => nodes.map((node) => [node.scrollTop, node.scrollLeft]))
    assert.ok(positions[0][0] > 0 && positions[0][1] > 0)
    assert.ok(Math.abs(positions[0][0] - positions[1][0]) < 2 && Math.abs(positions[0][1] - positions[1][1]) < 2, `scroll must follow either pane: ${positions}`)
  }
  const divider = page.getByRole('separator', { name: '调整差异分栏' })
  const originalWidth = await page.locator('.cm-merge-a').evaluate((node) => node.clientWidth)
  await divider.focus()
  await page.keyboard.press('ArrowLeft')
  assert.ok(await page.locator('.cm-merge-a').evaluate((node) => node.clientWidth) < originalWidth)
  const box = await divider.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + 30)
  await page.mouse.down()
  await page.mouse.move(box.x + 70, box.y + 30)
  await page.mouse.up()
  assert.ok(await page.locator('.cm-merge-a').evaluate((node) => node.clientWidth) > originalWidth)
  for (const side of [0, 1]) {
    await scrollers.nth(side).evaluate((node) => { node.scrollLeft = 100000 })
    await page.waitForTimeout(150)
    const offsets = await scrollers.evaluateAll((nodes) => nodes.map((node) => node.scrollLeft))
    assert.ok(offsets[0] > 0 && Math.abs(offsets[0] - offsets[1]) < 2, `unequal panes must share horizontal range: ${offsets}`)
  }
  await contents.nth(1).fill('edited right\n')
  await page.keyboard.press('Control+s')
  await page.waitForFunction(() => !document.querySelector('.dot.unsaved'))
  assert.equal(fs.readFileSync(path.join(project, 'fixture.txt'), 'utf8'), 'edited right\n')
  await contents.nth(0).fill('editable baseline\n')
  await page.evaluate(() => { window.__diffFontNodes = [...document.querySelectorAll('.diff-split .cm-content')] })
  for (const size of [10, 18, 24, 13]) {
    await page.click('[data-a=settings]'); await page.click('[data-a=sec][data-id=look]')
    await page.getByLabel('字号', { exact: true }).selectOption(String(size))
    await page.getByLabel('源码字号', { exact: true }).selectOption('17')
    await page.click('[data-a=back]')
    await page.waitForFunction((size) => [...document.querySelectorAll('.diff-split .cm-content,.diff-split .cm-gutters')].every((node) => getComputedStyle(node).fontSize === `${size}px`), size)
    assert.equal(await page.evaluate(() => window.__diffFontNodes.every((node, i) => node === document.querySelectorAll('.diff-split .cm-content')[i])), true, 'Font changes must preserve both editor instances')
    assert.ok((await contents.nth(0).textContent()).includes('editable baseline'))
    assert.ok((await contents.nth(1).textContent()).includes('edited right'))
    assert.equal(fs.readFileSync(path.join(project, 'fixture.txt'), 'utf8'), 'edited right\n', 'Changing fonts must retain the unsaved baseline')
  }
  await page.locator('[data-a=dmode][data-id=unified]').click()
  await page.locator('[data-a=dmode][data-id=split]').click()
  await contents.nth(0).focus()
  await page.keyboard.press('Control+z')
  await page.waitForFunction(() => document.querySelector('.cm-merge-a .cm-content')?.textContent.startsWith('line 1'))
  await page.keyboard.press('Control+Shift+z')
  await page.waitForFunction(() => document.querySelector('.cm-merge-a .cm-content')?.textContent.includes('editable baseline'))
  assert.equal(git('show', 'HEAD:fixture.txt').toString(), before, 'editing baseline must not rewrite Git HEAD')
  await page.getByRole('button', { name: '还原此处更改', exact: true }).first().click()
  await page.waitForFunction(() => document.querySelector('.cm-merge-b .cm-content')?.textContent.includes('editable baseline'))
  await page.locator('[data-a=dmode][data-id=unified]').click()
  await page.locator('.diff-unified').focus()
  await page.keyboard.press('Control+s')
  await page.waitForFunction(() => !document.querySelector('.dot.unsaved'))
  assert.equal(fs.readFileSync(path.join(project, 'fixture.txt'), 'utf8'), 'editable baseline\n')
  await page.locator('[data-a=dmode][data-id=split]').click()
  // An external modification must be rejected by the usual version guard.
  await contents.nth(1).fill('unsaved conflict\n')
  // Git status can briefly hold a Windows file handle; wait for the external
  // writer to acquire it without changing the conflict being exercised.
  for (let attempt = 0; ; attempt++) {
    try { await fs.promises.writeFile(path.join(project, 'fixture.txt'), 'external change\n'); break }
    catch (error) {
      if (attempt >= 10 || !['UNKNOWN', 'EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error
      await page.waitForTimeout(50)
    }
  }
  await page.getByRole('button', { name: '保存文件', exact: true }).click()
  await page.locator('.file-error').waitFor()
  assert.equal(fs.readFileSync(path.join(project, 'fixture.txt'), 'utf8'), 'external change\n')
  await page.getByRole('button', { name: '重新读取文件', exact: true }).click()
  await page.getByRole('button', { name: '放弃并重新读取', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.cm-merge-b .cm-content')?.textContent.includes('external change'))
  await page.locator('[data-a=diff][data-id="deleted.txt"]').click()
  await page.getByRole('button', { name: '还原此处更改', exact: true }).first().click()
  fs.writeFileSync(path.join(project, 'deleted.txt'), 'concurrent creation\n')
  await page.getByRole('button', { name: '保存文件', exact: true }).click()
  await page.locator('.file-error').waitFor()
  assert.equal(fs.readFileSync(path.join(project, 'deleted.txt'), 'utf8'), 'concurrent creation\n', 'recreating a deleted file must not replace a concurrent writer')
  fs.unlinkSync(path.join(project, 'deleted.txt'))
  await page.getByRole('button', { name: '保存文件', exact: true }).click()
  await page.waitForFunction(() => !document.querySelector('.dot.unsaved'))
  assert.equal(fs.readFileSync(path.join(project, 'deleted.txt'), 'utf8'), 'deleted original\n', 'hunk revert must recreate a deleted file')
  await page.locator('[data-a=diff][data-id="untracked.txt"]').click()
  await page.getByRole('button', { name: '删除文件', exact: true }).click()
  await page.locator('[data-a=confirm]').waitFor()
  await page.keyboard.press('Escape')
  assert.equal(fs.readFileSync(path.join(project, 'untracked.txt'), 'utf8'), 'untracked contents\n', 'Untracked delete icon must also require confirmation')
  await page.locator('[data-a=diff][data-id="fixture.txt"]').click()
  for (const theme of ['dark', 'light']) for (const [width, height] of [[1024, 680], [1440, 900]]) for (const size of [12, 16]) {
    await page.locator('[data-a=settings]').click()
    await page.locator('[data-a=sec][data-id=look]').click()
    await page.locator(`[data-a=theme][data-id=${theme}]`).click()
    await page.locator('[aria-label="界面字号"],[aria-label="Interface font size"]').selectOption(String(size))
    await page.locator('[data-a=sec][data-id=general]').click()
    await page.locator('[aria-label="应用语言"],[aria-label="Application language"]').selectOption(width === 1024 ? 'en' : 'zh-CN')
    await page.locator('[data-a=back]').click()
    await page.evaluate(([width, height]) => window.awb.winResize(width, height), [width, height])
    await page.waitForTimeout(150)
    await checkChangedLineStyle()
    const assertToolbar = async (compact) => {
      const geometry = await page.locator('.pane').filter({ has: page.locator('.diffbar') }).evaluate((pane) => {
        const box = pane.getBoundingClientRect(), bar = pane.querySelector('.diffbar').getBoundingClientRect()
        return { width: box.width, height: box.height, barHeight: bar.height,
          controls: [...pane.querySelectorAll('.diff-actions button')].map((node) => { const b = node.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height } }),
          left: box.left, right: box.right, top: bar.top, bottom: bar.bottom }
      })
      assert.ok(geometry.controls.every((b) => b.width >= 28 && b.height >= 28 && b.left >= geometry.left && b.right <= geometry.right + 1 && b.top >= geometry.top && b.bottom <= geometry.bottom), JSON.stringify(geometry))
      assert.ok(geometry.height - geometry.barHeight > 300, 'Diff text must retain visible reading space')
      if (compact) assert.ok(geometry.width <= 321, `Exercise a real narrow container: ${JSON.stringify(geometry)}`)
      await page.locator('[data-a=dmode][data-id=unified]').focus()
      await page.keyboard.press('Space')
      await page.locator('[data-a=dmode][data-id=split]').focus()
      await page.keyboard.press('Space')
      assert.equal(await page.locator('[data-a=dmode][data-id=split]').getAttribute('aria-checked'), 'true')
    }
    await assertToolbar(false)
    fs.mkdirSync(path.join(root, 'output/playwright/diff-editor'), { recursive: true })
    await page.screenshot({ path: path.join(root, `output/playwright/diff-editor/${dpi}-${theme}-${width}-${size}.png`) })
    if (width === 1024) {
      for (let step = 0; step < 20; step++) await page.locator('.right-resize').press('ArrowLeft')
      await assertToolbar(true)
      await page.screenshot({ path: path.join(root, `output/playwright/diff-editor/${dpi}-${theme}-narrow-${size}.png`) })
      for (let step = 0; step < 20; step++) await page.locator('.right-resize').press('ArrowRight')
    }
  }
  assert.ok(Math.abs(await page.evaluate(() => devicePixelRatio) - dpi) < .01)
  console.log(`PASS ${dpi}x DPI: named action icons, Ctrl+S, discard cancellation, themes, windows, narrow containers, UI 12/16, Chinese/English, editable diff, font/draft/undo preservation, synchronized axes, resizing, hunk revert and guarded save (${data})`)
} catch (error) {
  const page = await app.firstWindow()
  console.error(await page.evaluate(() => ({ scroll: [...document.querySelectorAll('.cm-scroller')].map(n => ({ width:n.clientWidth, total:n.scrollWidth, left:n.scrollLeft, content:n.querySelector('.cm-content')?.getBoundingClientRect().width, min:n.querySelector('.cm-content')?.style.minWidth, gutters:n.querySelector('.cm-gutters')?.getBoundingClientRect().width })), errors: [...document.querySelectorAll('.file-error')].map((node) => node.textContent), editors: [...document.querySelectorAll('.cm-content')].map((node) => node.textContent?.slice(0, 100)), tabs: [...document.querySelectorAll('.tabs .tab')].map((node) => node.textContent) })))
  throw error
} finally {
  // Exercise normal cleanup even if a failed assertion leaves a dirty draft.
  await app.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 1 })
  await app.close()
}
