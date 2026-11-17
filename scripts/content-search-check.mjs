import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import ssh2 from 'ssh2'
import { _electron as electron } from 'playwright'
import { loadTypeScript } from './fixtures/load-ts.mjs'

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pello-content-search-'))
const project = path.join(data, "project 中文's $fixture")
const second = path.join(data, 'second'), limit = path.join(data, 'limit')
for (const dir of [project, second, limit]) fs.mkdirSync(dir)
const deep = Array.from({ length: 20 }, (_, index) => `level${index}`).join('/')
fs.mkdirSync(path.join(project, deep), { recursive: true })
fs.writeFileSync(path.join(project, deep, 'nested.txt'), 'Needle内容 in deep file\n')
const marker = 'Needle内容'
const longText = Array.from({ length: 150 }, (_, i) => i === 110 || i === 140 ? `line ${i} ${'prefix '.repeat(100)}${marker} ${i}` : `ordinary line ${i}`).join('\r\n')
fs.writeFileSync(path.join(project, 'long.txt'), longText)
fs.writeFileSync(path.join(project, 'guide.md'), '# Guide\n\n' + longText + '\n')
fs.writeFileSync(path.join(project, 'alpha.txt'), '\ufeff中文 😀 Needle内容 first\r\nneedle内容 second\r\nliteral [a].* $(nothing)\n')
for (const folder of ['.hidden', 'node_modules']) {
  fs.mkdirSync(path.join(project, folder)); fs.writeFileSync(path.join(project, folder, 'excluded.txt'), marker)
}
fs.writeFileSync(path.join(project, 'binary.bin'), Buffer.from(`abc\0${marker}`))
fs.writeFileSync(path.join(project, 'invalid.txt'), Buffer.from([0xff, 0xfe, 65]))
fs.writeFileSync(path.join(project, 'large.txt'), marker + 'x'.repeat(2_000_001))
fs.writeFileSync(path.join(second, 'only-second.txt'), 'SECOND_PROJECT_TOKEN')
fs.writeFileSync(path.join(limit, 'danger.txt'), 'a'.repeat(30000) + '!')
fs.writeFileSync(path.join(project, 'regex.txt'), 'cat-12 dog-34 cat-56x\r\nword sword word_\r\n')
fs.writeFileSync(path.join(limit, 'many.txt'), 'LIMIT_TOKEN\n'.repeat(2500))
for (let index = 0; index < 17; index++) fs.writeFileSync(path.join(limit, `batch-${index}.txt`), 'BATCH_TOKEN\n'.repeat(130))
fs.writeFileSync(path.join(limit, 'zz-tail.txt'), 'FINAL_PARTIAL_BATCH')
fs.symlinkSync(second, path.join(project, 'external-link'), process.platform === 'win32' ? 'junction' : 'dir')
const originals = new Map(['long.txt', 'guide.md', 'alpha.txt'].map((name) => [name, fs.readFileSync(path.join(project, name))]))
fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify({ settings: { restore: false, confirmKill: false, layout: 'balanced', theme: 'light', autoCheckUpdates: false }, projects: [
  { id: 'p', name: 'Content search', host: 'local', path: project, agent: 'shell' },
  { id: 'p2', name: 'Second project', host: 'local', path: second, agent: 'shell' },
  { id: 'limit', name: 'Limit fixture', host: 'local', path: limit, agent: 'shell' }
] }))
const env = { ...process.env, AWB_USER_DATA: data }; delete env.ELECTRON_RUN_AS_NODE
const shots = path.resolve('output/playwright/content-search'); fs.mkdirSync(shots, { recursive: true })
const app = await electron.launch({ args: ['.'], env })
let server
const clients = new Set(), workers = new Set(), pageErrors = []
try {
  const page = await app.firstWindow(); page.setDefaultTimeout(10000)
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.locator('[data-a=rmode][data-id=files]').waitFor()
  const run = (projectId, query, sensitive = false, regex = false, whole = false) => page.evaluate(async ({ projectId, query, sensitive, regex, whole }) => {
    const id = crypto.randomUUID(), items = []
    await window.awb.contentSearchStart(projectId, id, query, sensitive, regex, whole)
    let batch
    do { batch = await window.awb.contentSearchNext(id); items.push(...batch.items) } while (!batch.done)
    return { ...batch, items }
  }, { projectId, query, sensitive, regex, whole })
  const baseline = await run('p', marker)
  assert.equal(baseline.items.length, 4)
  assert.equal(baseline.items.flatMap((item) => item.matches).length, 7)
  assert.equal(baseline.skipped, 3)
  assert.equal(baseline.errors, 0)
  assert.equal(baseline.items.find((file) => file.path === 'alpha.txt').matches[0].column, 8)
  assert.equal((await run('p', marker, true)).items.flatMap((file) => file.matches).length, 6)
  assert.equal((await run('p', '[a].* $(nothing)')).items.length, 1, 'Search punctuation literally')
  assert.equal((await run('p', 'SECOND_PROJECT_TOKEN')).items.length, 0, 'Never follow an external directory junction')
  const limited = await run('limit', 'LIMIT_TOKEN')
  assert.equal(limited.items[0].matches.length, 2000); assert.equal(limited.limited, true)
  const batchedLimit = await run('limit', 'BATCH_TOKEN')
  assert.equal(batchedLimit.items.flatMap((file) => file.matches).length, 2000, 'Concurrent reads share one exact match limit across files')
  assert.equal(batchedLimit.limited, true)
  assert.equal(new Set(batchedLimit.items.map((file) => file.path)).size, batchedLimit.items.length, 'Concurrent batches never duplicate files')
  assert.equal((await run('limit', 'FINAL_PARTIAL_BATCH')).items[0].path, 'zz-tail.txt', 'The final incomplete read batch must be scanned')
  assert.equal((await run('p2', 'SECOND_PROJECT_TOKEN')).items[0].path, 'only-second.txt')
  await page.evaluate(() => window.awb.treeIgnoreSet('p', []))
  assert.equal((await run('p', marker)).items.flatMap((file) => file.matches).length, 8, 'Content search must honor edited project ignore rules while still skipping dot directories')
  await page.evaluate(() => window.awb.treeIgnoreSet('p', ['.git', 'node_modules', 'dist', 'out', '.next', '__pycache__', '.cache']))
  assert.equal((await run('p', '(cat|dog)-[0-9]+', false, true)).items[0].matches.length, 3)
  assert.equal((await run('p', '(cat|dog)-[0-9]+', false, true, true)).items[0].matches.length, 2)
  assert.equal((await run('p', 'word', false, false, true)).items[0].matches.length, 1)
  assert.equal((await run('p', '^word sword word_$', false, true)).items[0].matches.length, 1, 'Regex anchors must handle Windows CRLF')
  await assert.rejects(() => run('p', '[', false, true), /正则表达式无效/)
  await assert.rejects(() => run('p', '[', false, true, true), /正则表达式无效/)
  await assert.rejects(() => run('limit', '(a+)+$', false, true), /执行超时/)
  await assert.rejects(() => run('p', '\n'), /搜索参数无效/)
  await page.evaluate(async () => { await window.awb.contentSearchStart('p', 'cancel-fixture', 'ordinary', false); await window.awb.contentSearchCancel('cancel-fixture') })
  assert.equal((await page.evaluate(() => window.awb.contentSearchNext('cancel-fixture'))).done, true)
  console.log('PASS main-process content scanning: deep paths, CRLF/BOM/Chinese/emoji, literal punctuation, case, bounds, junctions, 2000-limit and cancellation')

  // Run the actual Windows remote worker over password-authenticated SSH.
  if (process.platform === 'win32') {
    const hostKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' })
    server = new ssh2.Server({ hostKeys: [hostKey] }, (client) => {
      clients.add(client); client.on('error', () => {}); client.once('close', () => clients.delete(client))
      client.on('authentication', (context) => context.method === 'password' && context.password === 'fixture-password' ? context.accept() : context.reject(['password']))
      client.on('ready', () => client.on('session', (accept) => accept().on('exec', (accept, _reject, info) => {
        const stream = accept(), encoded = /-EncodedCommand\s+([A-Za-z0-9+/=]+)/i.exec(info.command)?.[1]
        const child = encoded ? spawn('powershell.exe', ['-NoProfile', '-EncodedCommand', encoded], { windowsHide: true })
          : spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', info.command], { windowsHide: true })
        workers.add(child); child.stdin.on('error', () => {})
        child.stdout.on('data', (chunk) => { if (!stream.destroyed) stream.write(chunk) })
        child.stderr.on('data', (chunk) => { if (!stream.destroyed) stream.stderr.write(chunk) })
        stream.on('data', (chunk) => child.stdin.write(chunk)); stream.on('end', () => child.stdin.end())
        if (!encoded) child.stdin.end()
        stream.once('close', () => child.kill())
        child.once('close', (code) => { workers.delete(child); if (!stream.destroyed) { stream.exit(code ?? 1); stream.end() } })
      })))
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    await page.evaluate(async ({ port, project, limit }) => {
      const { db } = await window.awb.getState()
      await window.awb.saveHosts([...db.hosts, { id: 'search-remote', name: 'Search SSH fixture', platform: 'windows', os: 'Windows', on: true, addr: '127.0.0.1', port, user: 'fixture', auth: 'password', password: 'fixture-password' }])
      await window.awb.saveProjects([...db.projects, { id: 'remote', name: 'Remote search', host: 'search-remote', path: project, agent: 'shell' }, { id: 'remote-limit', name: 'Remote limits', host: 'search-remote', path: limit, agent: 'shell' }])
    }, { port: server.address().port, project, limit })
    const remote = await run('remote', marker)
    const sort = (files) => files.sort((a, b) => a.path.localeCompare(b.path))
    assert.deepEqual(sort(remote.items), sort(baseline.items))
    assert.equal(remote.skipped, baseline.skipped)
    assert.equal(remote.errors, 0)
    assert.equal((await run('remote', '(cat|dog)-[0-9]+', false, true, true)).items[0].matches.length, 2)
    assert.equal((await run('remote', 'word', false, false, true)).items[0].matches.length, 1)
    assert.equal((await run('remote', '^word sword word_$', false, true)).items[0].matches.length, 1)
    await assert.rejects(() => run('remote-limit', '(a+)+$', false, true), /执行超时/)
    await page.evaluate(() => window.awb.contentSearchStart('remote', 'remote-cancel', 'ordinary', false))
    const pending = page.evaluate(() => window.awb.contentSearchNext('remote-cancel'))
    const deadline = Date.now() + 10000
    while (!workers.size && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
    assert.ok(workers.size, 'Remote worker must have started before cancellation')
    await page.evaluate(() => window.awb.contentSearchCancel('remote-cancel'))
    assert.deepEqual((await pending).items, [])
    while (workers.size && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(workers.size, 0, 'Cancelling SSH search must close its worker')
    console.log('PASS Windows SSH: actual worker, stdin query, Unicode paths, UTF-16 columns, exclusions and safe boundaries match local results')
    const { CONTENT_SEARCH_LINUX } = await loadTypeScript('src/main/content-search-scripts.ts')
    // Validate Linux worker on a read-only copy in WSL when available.
    const linuxRoot = execFileSync('wsl.exe', ['-e', 'wslpath', '-a', project], { encoding: 'utf8', windowsHide: true }).trim()
    const output = execFileSync('wsl.exe', ['-e', 'python3', '-u', '-c', CONTENT_SEARCH_LINUX], { input: JSON.stringify({ root: linuxRoot, query: marker, sensitive: false, ignored: ['node_modules'] }), encoding: 'utf8', windowsHide: true })
    const events = output.trim().split(/\r?\n/).map((line) => JSON.parse(line))
    assert.deepEqual(sort(events.flatMap((event) => event.file ? [event.file] : [])), sort(baseline.items))
    for (const { query, regex, whole, count, error } of [
      { query: '(cat|dog)-[0-9]+', regex: true, whole: true, count: 2 },
      { query: '^word sword word_$', regex: true, count: 1 },
      { query: 'word', whole: true, count: 1 },
      { query: '[', regex: true, error: 'invalid' }
    ]) {
      const output = execFileSync('wsl.exe', ['-e', 'python3', '-u', '-c', CONTENT_SEARCH_LINUX], { input: JSON.stringify({ root: linuxRoot, query, sensitive: false, regex, whole, ignored: ['node_modules'] }), encoding: 'utf8', windowsHide: true })
      const events = output.trim().split(/\r?\n/).map((line) => JSON.parse(line))
      if (error) assert.equal(events[0].error, error)
      else assert.equal(events.flatMap((event) => event.file?.matches || []).length, count)
    }
    console.log('PASS Linux Python worker in WSL: actual scan and UTF-16 positions match local/Windows results')
  }

  await page.click('[data-a=rmode][data-id=files]')
  const initialNames = page.getByRole('textbox', { name: '搜索文件', exact: true })
  assert.equal(await initialNames.inputValue(), '')
  assert.equal(await initialNames.getAttribute('placeholder'), null)
  await page.screenshot({ path: path.join(shots, 'file-search-empty.png') })
  const nameGeometry = await initialNames.evaluate((node) => ({ height: node.getBoundingClientRect().height, border: getComputedStyle(node).borderLeftWidth, color: getComputedStyle(node).borderLeftColor }))
  assert.ok(nameGeometry.height >= 22 && nameGeometry.height <= 25 && Number.parseFloat(nameGeometry.border) > 0, `The empty filename field must remain compact and visibly outlined: ${JSON.stringify(nameGeometry)}`)
  await page.click('[data-a=file-search]')
  const input = page.getByRole('textbox', { name: '搜索内容', exact: true })
  await input.fill(marker)
  const results = page.getByRole('group', { name: /^(内容搜索结果|Content search results)$/ })
  await page.waitForFunction(() => document.querySelector('.content-search-results')?.getAttribute('aria-busy') === 'false')
  assert.equal(await results.locator('[data-a=content-hit]').count(), 7)
  assert.equal(await results.locator('.content-search-count,.content-search-line').count(), 0, 'No per-file counts or visible line numbers')
  assert.equal((await results.locator('.content-search-summary [role=status]').textContent()).trim(), '7 个结果')
  assert.doesNotMatch(await results.innerText(), /已跳过|分布于|Skipped|results in/)
  assert.deepEqual(await results.locator('summary').first().locator('span').allTextContents(), ['alpha.txt'])
  const target = results.locator('[data-id="long.txt"][data-line="111"]')
  await target.click()
  const source = page.locator('.source-editor textarea')
  await source.waitFor()
  await page.waitForFunction((marker) => {
    const field = document.querySelector('.source-editor textarea'), range = CSS.highlights.get('document-current')?.values().next().value
    const box = range?.getBoundingClientRect(), view = field?.getBoundingClientRect()
    return field?.value.slice(field.selectionStart, field.selectionEnd) === marker && box && view && box.top >= view.top && box.bottom <= view.bottom && box.left >= view.left && box.right <= view.right
  }, marker)
  assert.equal(await input.inputValue(), marker)
  assert.equal(await results.locator('[data-a=content-hit]').count(), 7)
  await results.locator('[data-id="long.txt"][data-line="141"]').click()
  assert.equal(await page.locator('[data-a=tab]').filter({ hasText: 'long.txt' }).count(), 1)
  const beforeDraft = await source.inputValue()
  await source.fill(beforeDraft + '\nUNSAVED_DRAFT')
  await results.locator('[data-id="guide.md"][data-line="113"]').click()
  await source.waitFor()
  await page.waitForFunction((marker) => { const field = document.querySelector('.source-editor textarea'); return field?.value.startsWith('# Guide') && field.value.slice(field.selectionStart, field.selectionEnd) === marker }, marker)
  await target.click()
  assert.ok((await source.inputValue()).endsWith('UNSAVED_DRAFT'))
  await source.focus(); await page.keyboard.press('Control+z')
  assert.equal(await source.inputValue(), beforeDraft)
  console.log('PASS content UI: grouped counts, exact vertical/horizontal navigation, repeated file reuse, Markdown source navigation, draft and undo retention')
  await page.keyboard.press('Control+e')
  const names = page.getByRole('textbox', { name: '搜索文件', exact: true })
  assert.equal(await names.inputValue(), '')
  assert.equal(await names.getAttribute('placeholder'), null)
  assert.equal(await names.evaluate((node) => document.activeElement === node), true)
  assert.equal(await page.locator('.project-search-modes').count(), 0)
  await names.fill('long.txt'); await page.locator('[data-a=search-file][data-id="long.txt"]').waitFor()
  await page.keyboard.press('Control+Shift+f')
  assert.equal(await input.inputValue(), marker)
  assert.equal(await input.evaluate((node) => document.activeElement === node), true)
  const options = page.getByRole('group', { name: '搜索选项', exact: true })
  assert.equal(await options.getByRole('button').count(), 3)
  await options.getByRole('button', { name: '使用正则表达式', exact: true }).click()
  await input.fill('(cat|dog)-[0-9]+')
  await page.waitForFunction(() => document.querySelectorAll('[data-a=content-hit]').length === 3)
  await options.getByRole('button', { name: '全字匹配', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('[data-a=content-hit]').length === 2)
  await results.locator('[data-a=content-hit]').first().click()
  await page.waitForFunction(() => { const field = document.querySelector('.source-editor textarea'); return field?.value.slice(field.selectionStart, field.selectionEnd) === 'cat-12' })
  await input.fill('['); await page.getByText('正则表达式无效', { exact: false }).waitFor()
  await options.getByRole('button', { name: '使用正则表达式', exact: true }).click()
  await options.getByRole('button', { name: '全字匹配', exact: true }).click()
  await input.fill(marker); await page.waitForFunction(() => document.querySelectorAll('[data-a=content-hit]').length === 7)
  await page.locator('.project-search').getByRole('button', { name: '区分大小写', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('[data-a=content-hit]').length === 6)
  await input.fill('old query'); await input.fill('NO_MATCH'); await page.getByText('没有匹配的内容', { exact: true }).waitFor()
  await input.fill('stop-query')
  await results.getByRole('button', { name: '停止搜索', exact: true }).click()
  await page.getByText('搜索已停止', { exact: true }).waitFor()
  await results.getByRole('button', { name: '重新搜索', exact: true }).click()
  await page.getByText('没有匹配的内容', { exact: true }).waitFor()
  await input.fill(marker)
  await page.waitForFunction(() => document.querySelectorAll('[data-a=content-hit]').length === 6)
  await input.press('Enter'); assert.equal(await results.locator('[data-a=content-hit]').first().evaluate((node) => document.activeElement === node), true)
  await input.focus(); await input.press('Escape')
  assert.equal(await input.count(), 1)
  assert.equal(await page.locator('[data-a=file-search]').evaluate((node) => document.activeElement === node), true)
  console.log('PASS separate file/content views, independent queries, Ctrl+E/Ctrl+Shift+F, inline case/word/regex controls, syntax errors, navigation, stop/retry and focus')

  await page.click('[data-a=file-search]'); await input.fill(marker)
  await page.waitForFunction(() => document.querySelectorAll('[data-a=content-hit]').length === 6)
  await page.getByRole('button', { name: '收起文件面板', exact: true }).click()
  await source.focus(); await page.keyboard.press('Control+e')
  assert.equal(await names.inputValue(), 'long.txt')
  await page.keyboard.press('Control+Shift+f')
  assert.equal(await input.inputValue(), marker)
  await page.click('[data-a=settings]'); await page.click('[data-a=sec][data-id=keys]')
  await page.getByText('搜索文件', { exact: true }).waitFor()
  await page.getByText('搜索内容', { exact: true }).waitFor()
  assert.deepEqual(await page.locator('.srow').filter({ hasText: '搜索文件' }).locator('kbd').allTextContents(), ['Ctrl', 'E'])
  assert.deepEqual(await page.locator('.srow').filter({ hasText: '搜索内容' }).locator('kbd').allTextContents(), ['Ctrl', 'Shift', 'F'])
  await page.keyboard.press('Control+e')
  assert.equal(await page.locator('.settings').isVisible(), true)
  await page.click('[data-a=back]')
  await page.locator('[data-a=proj][data-id=p2]').click()
  assert.equal(await input.inputValue(), '', 'The second project has its own content query')
  await input.fill('SECOND_PROJECT_TOKEN')
  await page.waitForFunction(() => document.querySelector('[data-a=content-hit][data-id="only-second.txt"]'))
  await page.keyboard.press('Control+e')
  assert.equal(await names.inputValue(), '', 'The second project has its own filename query')
  await names.fill('only-second')
  await page.locator('[data-a=proj][data-id=p]').click()
  assert.equal(await names.inputValue(), 'long.txt')
  await page.keyboard.press('Control+Shift+f')
  assert.equal(await input.inputValue(), marker)
  await page.waitForFunction(() => document.querySelectorAll('[data-a=content-hit]').length === 6)
  // Actual container widths, UI font sizes and theme/language variants.
  for (const [width, height] of [[1024, 680], [1440, 900]]) for (const theme of ['light', 'dark']) for (const fontSize of [12, 16]) for (const language of ['zh-CN', 'en']) {
    await page.setViewportSize({ width, height })
    await page.click('[data-a=settings]')
    await page.click('[data-a=sec][data-id=general]')
    await page.locator('[data-set=language]').selectOption(language)
    await page.waitForFunction((language) => document.documentElement.lang === language, language)
    await page.click('[data-a=sec][data-id=look]')
    await page.click(`[data-a=theme][data-id=${theme}]`)
    await page.getByLabel(/^(界面字号|Interface font size)$/).selectOption(String(fontSize))
    await page.waitForFunction((fontSize) => getComputedStyle(document.documentElement).getPropertyValue('--ui-size') === `${fontSize}px`, fontSize)
    await page.click('[data-a=back]')
    for (const panelWidth of [220, 420]) {
      const handle = page.getByRole('separator', { name: /调整文件面板宽度|Resize file panel/ })
      const currentWidth = await page.locator('.right').evaluate((node) => node.getBoundingClientRect().width)
      const steps = Math.round((panelWidth - currentWidth) / 20)
      for (let i = 0; i < Math.abs(steps); i++) await handle.press(steps > 0 ? 'ArrowLeft' : 'ArrowRight')
      const geometry = await page.locator('.project-search').evaluate((node) => {
        const input = node.querySelector('input').getBoundingClientRect(), box = node.querySelector('.project-search-input').getBoundingClientRect(), controls = [...node.querySelectorAll('button')].map((button) => button.getBoundingClientRect())
        return { inputWidth: input.width, height: box.height, fits: controls.every((rect) => rect.left >= box.left && rect.right <= box.right) && input.right <= box.right, width: box.width }
      })
      assert.ok(geometry.fits && geometry.inputWidth >= 64, JSON.stringify(geometry))
      assert.ok(geometry.height >= 26 && geometry.height <= 29, `Compact content input: ${JSON.stringify(geometry)}`)
      assert.doesNotMatch(await results.innerText(), /已跳过|分布于|Skipped|results in/)
      assert.equal(await results.locator('.content-search-count,.content-search-line').count(), 0)
      assert.ok(await results.locator('[data-a=content-hit] mark').first().evaluate((node) => node.getBoundingClientRect().width > 0))
      const typography = await page.evaluate(() => {
        const read = (node) => { const style = getComputedStyle(node); return { family: style.fontFamily, size: style.fontSize, weight: style.fontWeight } }
        return { normal: read(document.body), query: read(document.querySelector('.project-search-input input')), hit: read(document.querySelector('.content-search-hit')), match: read(document.querySelector('.content-search-hit mark')) }
      })
      assert.deepEqual(typography.query, typography.normal, 'Search input must use the normal interface font')
      assert.deepEqual(typography.hit, typography.normal, 'Result snippets must use the normal interface font')
      assert.deepEqual(typography.match, typography.normal, 'Match highlights must not enlarge or embolden text')
      await page.screenshot({ path: path.join(shots, `${theme}-${width}-${fontSize}-${language}-${panelWidth}.png`) })
      if (panelWidth === 220) {
        await page.keyboard.press('Control+e')
        const field = page.getByRole('textbox', { name: /^(搜索文件|Search files)$/ })
        await page.locator('[data-a=search-file][data-id="long.txt"]').waitFor()
        const dimensions = await field.evaluate((node) => {
          const row = document.querySelector('[data-a=search-file]'), label = row.querySelector('.nm')
          const style = getComputedStyle(node), normal = getComputedStyle(label)
          return { height: node.getBoundingClientRect().height, bar: node.parentElement.getBoundingClientRect().height, row: row.getBoundingClientRect().height, font: [style.fontFamily, style.fontSize, style.fontWeight], normal: [normal.fontFamily, normal.fontSize, normal.fontWeight] }
        })
        assert.ok(dimensions.height >= 22 && dimensions.height <= 25 && dimensions.bar <= dimensions.row + 1, JSON.stringify(dimensions))
        assert.deepEqual(dimensions.font, dimensions.normal, 'Filename search must match file tree text')
        if (width === 1024 && fontSize === 16 && language === 'zh-CN') await page.screenshot({ path: path.join(shots, `file-search-${theme}-compact.png`) })
        await page.keyboard.press('Control+Shift+f')
      }
    }
  }
  for (const [name, bytes] of originals) assert.deepEqual(fs.readFileSync(path.join(project, name)), bytes)
  assert.deepEqual(pageErrors, [])
  console.log(`PASS theme/window/container/font geometry and fresh screenshots in ${shots}; source files unchanged`)
} finally {
  for (const child of workers) child.kill()
  for (const client of clients) client.destroy()
  if (server) await new Promise((resolve) => server.close(resolve))
  await app.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 1 }).catch(() => {})
  await app.close()
}

// Native Chromium scale factors exercise real DPI layout, separately from viewport width.
for (const scale of [1, 1.25, 1.5, 2]) {
  const dpiApp = await electron.launch({ args: ['.', `--force-device-scale-factor=${scale}`], env })
  try {
    const page = await dpiApp.firstWindow(); page.setDefaultTimeout(10000)
    await page.evaluate(() => window.awb.winResize(1024, 680))
    await page.waitForFunction(() => innerWidth === 1024)
    await page.click('[data-a=file-search]')
    await page.getByRole('textbox', { name: /^(搜索内容|Search content)$/ }).fill(marker)
    await page.waitForFunction(() => document.querySelector('.content-search-results')?.getAttribute('aria-busy') === 'false')
    assert.equal(await page.locator('[data-a=content-hit]').count(), 7)
    assert.ok(Math.abs(await page.evaluate(() => devicePixelRatio) - scale) < .01)
    const handle = page.getByRole('separator', { name: /调整文件面板宽度|Resize file panel/ })
    for (let index = 0; index < 12; index++) await handle.press('ArrowRight')
    const query = page.getByRole('textbox', { name: /^(搜索内容|Search content)$/ })
    assert.ok((await query.boundingBox()).width >= 64)
    await query.fill(marker.toLowerCase()); await query.fill(marker)
    await page.locator('[data-a=content-hit][data-id="long.txt"][data-line="111"]').click()
    await page.waitForFunction((marker) => { const field = document.querySelector('.source-editor textarea'); return field?.value.slice(field.selectionStart, field.selectionEnd) === marker && field.scrollTop > 500 }, marker)
    await page.screenshot({ path: path.join(shots, `dpi-${scale}.png`) })
    console.log(`PASS ${scale * 100}% DPI: narrow panel input, click and actual match navigation`)
  } finally { await dpiApp.close() }
}
