import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { _electron as electron } from 'playwright'

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pello-search-navigation-'))
const project = path.join(data, 'project'); fs.mkdirSync(project)
const text = Array.from({ length: 180 }, (_, index) => index === 40 || index === 130 ? `Paragraph ${index} **NAV_TARGET**` : `Paragraph ${index} with ordinary text.`).join('\n\n')
fs.writeFileSync(path.join(project, 'navigation.md'), '# Search navigation\n\n' + text)
fs.writeFileSync(path.join(project, 'navigation.txt'), text)
const code = Array.from({ length: 180 }, (_, index) => index === 40 || index === 130 ? `const value${index} = "CODE_TARGET"` : `const value${index} = ${index}`).join('\n')
fs.writeFileSync(path.join(project, 'code.md'), '# Code navigation\n\n' + 'Introductory paragraph before the lazy code block.\n\n'.repeat(40) + '```js\n' + code + '\n```\n')
fs.writeFileSync(path.join(project, 'navigation.html'), '<!doctype html><html><body>' + text.split('\n\n').map((line) => `<p>${line}</p>`).join('') + '</body></html>')
const git = (...args) => execFileSync('git', args, { cwd: project, windowsHide: true })
git('init', '-q'); git('add', '.'); git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture')
fs.writeFileSync(path.join(project, 'navigation.txt'), 'Worktree\n' + text)
const originals = new Map(fs.readdirSync(project).filter((name) => name !== '.git').map((name) => [name, fs.readFileSync(path.join(project, name))]))
fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify({ settings: { layout: 'balanced', restore: false, confirmKill: false }, projects: [{ id: 'p', name: 'Search navigation', path: project, host: 'local', agent: 'shell' }] }))
const env = { ...process.env, AWB_USER_DATA: data }; delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: ['.'], env })
try {
  const page = await app.firstWindow(); page.setDefaultTimeout(8000)
  await page.setViewportSize({ width: 1024, height: 680 })
  await page.click('[data-a=rmode][data-id=files]')
  await page.click('[data-a=preview][data-id="navigation.md"]')
  await page.getByRole('textbox', { name: 'Markdown 内容', exact: true }).waitFor()
  const query = page.getByRole('textbox', { name: '查找内容', exact: true })
  const visible = async (index) => {
    await page.waitForFunction((index) => {
      const active = document.querySelector('.markdown-editor .search-active'), editor = document.querySelector('.markdown-editor')
      if (!active || !editor || document.querySelector('.search-count')?.textContent !== `${index} / 2`) return false
      const box = active.getBoundingClientRect(), viewport = editor.getBoundingClientRect()
      return box.top >= viewport.top && box.bottom <= viewport.bottom && box.left >= viewport.left && box.right <= viewport.right
    }, index, { timeout: 2000 })
  }
  await page.keyboard.press('Control+f'); await query.fill('NAV_TARGET')
  await visible(1)
  assert.equal(await query.evaluate((node) => document.activeElement === node), true, 'Automatic reveal must keep find-field focus')
  const first = await page.locator('.markdown-editor').evaluate((node) => node.scrollTop)
  await page.getByRole('button', { name: '下一个匹配', exact: true }).click()
  await visible(2)
  assert.ok(await page.locator('.markdown-editor').evaluate((node) => node.scrollTop) > first + 1000)
  await query.press('Shift+Enter'); await visible(1)
  await query.press('Enter'); await visible(2)
  console.log('PASS Markdown first/next/previous matches automatically reveal the actual highlighted text without changing focus or contents')
  await page.keyboard.press('Escape')
  const cases = [
    ['source', 'navigation.txt', '.source-editor textarea', '.source-editor textarea'],
    ['code', 'code.md', '.ProseMirror', '.markdown-editor'],
    ['html', 'navigation.html', 'iframe', 'iframe'],
    ['split', 'navigation.txt', '.diff-split .cm-content', '.cm-merge-b .cm-scroller'],
    ['unified', 'navigation.txt', '.diff-unified', '.diff-unified']
  ].filter(([kind]) => !process.argv.includes('--code') || kind === 'code')
  const failures = []
  for (const [kind, name, ready, scroller] of cases) {
    try {
      if (kind === 'split' || kind === 'unified') {
        await page.click('[data-a=rmode][data-id=changes]')
        await page.click(`[data-a=diff][data-id="${name}"]`)
        await page.click(`[data-a=dmode][data-id=${kind}]`)
      } else {
        await page.click('[data-a=rmode][data-id=files]')
        await page.click(`[data-a=preview][data-id="${name}"]`)
      }
      await page.locator(ready).first().waitFor()
      if (kind === 'html') await page.frameLocator('iframe').locator('p').last().waitFor()
      await page.keyboard.press('Control+f'); await query.fill(kind === 'code' ? 'CODE_TARGET' : 'NAV_TARGET')
      const viewVisible = async (index, total = 2) => {
        await page.waitForFunction(({ index, total }) => document.querySelector('.search-count')?.textContent === `${index} / ${total}`, { index, total })
        if (kind === 'html') {
          await page.frameLocator('iframe').locator('body').evaluate(() => new Promise((resolve, reject) => {
            const start = performance.now()
            const check = () => {
              const range = CSS.highlights.get('document-current')?.values().next().value
              const box = range?.getBoundingClientRect()
              if (box && box.top >= 0 && box.bottom <= innerHeight) resolve()
              else if (performance.now() - start > 2000) reject(new Error('HTML search did not reveal the match'))
              else requestAnimationFrame(check)
            }; check()
          }))
          return
        }
        await page.waitForFunction(({ kind, scroller }) => {
          const viewport = document.querySelector(scroller)?.getBoundingClientRect()
          const highlight = kind === 'split' || kind === 'code' ? document.querySelector('.search-active') : CSS.highlights.get('document-current')?.values().next().value
          const box = highlight?.getBoundingClientRect()
          return box && viewport && box.top >= viewport.top && box.bottom <= viewport.bottom && box.left >= viewport.left && box.right <= viewport.right
        }, { kind, scroller }, { timeout: 2000 })
      }
      await viewVisible(1)
      await page.getByRole('button', { name: '下一个匹配', exact: true }).click(); await viewVisible(2)
      await page.getByRole('button', { name: '上一个匹配', exact: true }).click(); await viewVisible(1)
      await query.press('F3'); await viewVisible(2)
      await query.press('Shift+F3'); await viewVisible(1)
      if (kind === 'source') {
        await query.fill('Paragraph 40'); await viewVisible(1, 1)
        await page.locator(scroller).evaluate((node) => { node.scrollTop = 0 })
        await page.getByRole('button', { name: '下一个匹配', exact: true }).click(); await viewVisible(1, 1)
        await page.locator(scroller).evaluate((node) => { node.scrollTop = 0 })
        await page.keyboard.press('Control+f'); await viewVisible(1, 1)
      }
      if (kind === 'split') {
        await page.waitForFunction(() => { const nodes = [...document.querySelectorAll('.diff-split .cm-scroller')]; return Math.abs(nodes[0].scrollTop - nodes[1].scrollTop) < 2 }, null, { timeout: 2000 })
        const positions = await page.locator('.diff-split .cm-scroller').evaluateAll((nodes) => nodes.map((node) => node.scrollTop))
        assert.ok(Math.abs(positions[0] - positions[1]) < 2, 'Diff navigation must keep both panes synchronized')
      }
      console.log(`PASS ${kind} first/next/previous actual-match visibility`)
    } catch (error) {
      failures.push(kind); console.error(`FAIL ${kind}:`, error.message)
      if (kind === 'code') console.error('Code navigation state:', await page.evaluate(() => {
        const block = document.querySelector('.milkdown-code-block'), active = document.querySelector('.search-active')
        return { scroll: document.querySelector('.markdown-editor')?.scrollTop, block: block?.getBoundingClientRect().toJSON(), active: active?.outerHTML, editors: document.querySelectorAll('.cm-editor').length, text: block?.textContent.slice(0, 240) }
      }))
    } finally {
      await page.keyboard.press('Escape')
    }
  }
  for (const [name, contents] of originals) assert.deepEqual(fs.readFileSync(path.join(project, name)), contents, 'Navigation must not save or rewrite files')
  assert.deepEqual(failures, [])
} catch (error) {
  const page = await app.firstWindow()
  console.error('Search navigation state:', await page.evaluate(() => {
    const editor = document.querySelector('.markdown-editor'), active = document.querySelector('.markdown-editor .search-active')
    return { count: document.querySelector('.search-count')?.textContent, scrollTop: editor?.scrollTop, viewport: editor?.getBoundingClientRect().toJSON(), active: active?.getBoundingClientRect().toJSON() }
  }))
  throw error
} finally {
  await app.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 1 }).catch(() => {})
  await app.close()
}
