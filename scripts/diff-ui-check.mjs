import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { launchWorkbench } from './fixtures/launch-workbench.mjs'

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pello-diff-ui-'))
const project = path.join(data, 'repo')
fs.mkdirSync(project)
const git = (...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: project, encoding: 'utf8' })
const committed = ['keep this line', ...Array.from({ length: 80 }, (_, index) => `row ${index} ${'M'.repeat(180)}`)].join('\n') + '\n'
fs.writeFileSync(path.join(project, 'notes.txt'), committed)
git('init', '-q')
git('add', '.')
git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture')
const head = git('rev-parse', 'HEAD').trim()
fs.writeFileSync(path.join(project, 'notes.txt'), committed.replace('keep this line', 'changed this line'))
fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify({
  settings: { layout: 'balanced', restore: false, confirmKill: false },
  projects: [{ id: 'p', name: 'Diff UI', host: 'local', path: project, agent: 'shell' }],
}))
const env = { ...process.env, AWB_USER_DATA: data }
delete env.ELECTRON_RUN_AS_NODE
const app = await launchWorkbench({ args: ['.'], env })
try {
  const page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  await page.click('[data-a=rmode][data-id=changes]')
  await page.locator('[data-a=diff][data-id="notes.txt"]').click()
  await page.locator('[data-a=dmode][data-id=split]').click()
  const panes = page.locator('.diff-split .cm-scroller')
  await panes.nth(1).waitFor()
  await panes.nth(1).osWheel(0, 400)
  await page.waitForFunction(() => {
    const nodes = [...document.querySelectorAll('.diff-split .cm-scroller')]
    return nodes.length === 2 && nodes[0].scrollTop > 20 && Math.abs(nodes[0].scrollTop - nodes[1].scrollTop) < 2
  })
  await panes.nth(0).osWheel(240, 0)
  await page.waitForFunction(() => {
    const nodes = [...document.querySelectorAll('.diff-split .cm-scroller')]
    return nodes[0].scrollLeft > 20 && Math.abs(nodes[0].scrollLeft - nodes[1].scrollLeft) < 2
  })
  console.log('PASS split diff scrolls both axes together')
  await page.evaluate(() => {
    for (const node of document.querySelectorAll('.diff-split .cm-scroller')) { node.scrollTop = 0; node.scrollLeft = 0 }
  })

  await page.getByRole('button', { name: '还原此处更改', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('[aria-label="工作区内容"]')?.textContent?.includes('keep this line'))
  await page.getByRole('button', { name: '保存文件', exact: true }).click()
  await page.waitForFunction(() => !document.querySelector('.dot.unsaved'))
  assert.equal(fs.readFileSync(path.join(project, 'notes.txt'), 'utf8'), committed)
  assert.equal(git('rev-parse', 'HEAD').trim(), head)
  assert.equal(git('show', 'HEAD:notes.txt'), committed)
  const before = page.locator('[aria-label="变更前内容"]')
  await before.click()
  await before.evaluate((node) => {
    const line = node.querySelector('.cm-line')
    if (!line) throw new Error('comparison line missing')
    line.append('BASE')
  })
  await page.waitForTimeout(200)
  await page.waitForFunction(() => document.querySelector('[aria-label="变更前内容"]')?.textContent?.includes('BASE'))
  assert.equal(git('rev-parse', 'HEAD').trim(), head)
  assert.equal(git('show', 'HEAD:notes.txt'), committed, 'Editing the comparison side must not rewrite the commit')
  console.log('PASS the middle arrow restores a hunk onto the worktree and the comparison side leaves the commit unchanged')
} finally {
  await app.close()
}
