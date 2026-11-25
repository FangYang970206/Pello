import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildSync } from 'esbuild'
import { _electron as electron } from 'playwright'
import { assertPerformanceBuild, finishPerformance, median, performanceReport, savePaintSample } from './fixtures/performance-metrics.mjs'

const baseline = process.argv.includes('--baseline'), profile = process.argv.includes('--profile')
assertPerformanceBuild()
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pello-hotspot-ui-')), output = path.resolve('output/performance')
fs.mkdirSync(output, { recursive: true })
fs.writeFileSync(path.join(data, 'large.txt'), '\ufeff' + '中文 content\r\n'.repeat(50000))
fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify({ settings: { restore: false, autoCheckUpdates: false, layout: 'balanced', uiFontSize: 16 }, projects: [{ id: 'p', name: 'Performance', host: 'local', path: data, agent: 'shell' }] }))
const home = path.join(data, '.resource-home')
const env = { ...process.env, AWB_USER_DATA: data, AWB_RESOURCE_HOME: home }; delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: ['.', '--force-device-scale-factor=1'], env })
const report = performanceReport('hotspotUi')
try {
  const page = await app.firstWindow(); page.setDefaultTimeout(20000)
  await page.locator('[data-a=proj][data-id=p]').waitFor()
  await page.evaluate(() => window.awb.winResize(1440, 900))
  await page.keyboard.press('Control+e')
  await page.locator('[data-a=preview][data-id="large.txt"]').click()
  const editor = page.getByLabel('文件内容', { exact: true }); await editor.waitFor()
  const session = await page.context().newCDPSession(page)
  if (profile) { await session.send('Profiler.enable'); await session.send('Profiler.start') }
  const saves = []
  for (let run = 0; run < 3; run++) { await editor.press('Control+End'); await editor.press('p'); saves.push(await savePaintSample(page, editor)) }
  report.samples.savePaintMs = saves; report.metrics.savePaintMs = median(saves)
  if (profile) { const { profile: cpu } = await session.send('Profiler.stop'); fs.writeFileSync(path.join(output, `hotspot-save-${baseline ? 'before' : 'after'}.cpuprofile`), JSON.stringify(cpu)) }
  await page.screenshot({ path: path.join(output, `hotspot-source-${baseline ? 'before' : 'after'}.png`) })
  if (!baseline) {
    for (let index = 0; index < 600; index++) {
      const folder = path.join(home, '.agents/skills', `skill-${index}`)
      fs.mkdirSync(folder, { recursive: true }); fs.writeFileSync(path.join(folder, 'SKILL.md'), `---\nname: skill-${index}\ndescription: Synthetic resource IPC fixture\n---\nBody`)
    }
    const resources = await page.evaluate(async () => {
      const old = window.awb.resourceList('skills', 'codex', 1, '').then(() => false, () => true)
      const latest = window.awb.resourceList('skills', 'codex', 1, 'skill-599')
      return { cancelled: await old, latest: await latest }
    })
    assert.equal(resources.cancelled, true, 'A superseded real IPC list must stop scanning')
    assert.equal(resources.latest.total, 1); assert.equal(resources.latest.items[0].name, 'skill-599')
    report.checks.latestResources = true
  }
  const code = buildSync({ entryPoints: ['src/renderer/document-search.ts'], bundle: true, format: 'iife', globalName: '__hotspotSearch', write: false }).outputFiles[0].text
  await page.addScriptTag({ content: code })
  const dom = await page.evaluate(() => {
    const host = document.createElement('div'); host.hidden = true; document.body.append(host)
    const nodes = [], fragment = document.createDocumentFragment()
    for (let index = 0; index < 12000; index++) { const span = document.createElement('span'); span.textContent = `text ${index} 中😀 `; fragment.append(span); if (index % 30 === 0) fragment.append(document.createTextNode('')); nodes.push(span) }
    host.append(fragment)
    const text = window.__hotspotSearch.domText(host).text
    const matches = nodes.slice(10000).map((node, index) => { const from = text.indexOf(`text ${index + 10000} `); return { from, to: from + node.textContent.length } })
    const samples = []
    for (let run = 0; run < 3; run++) {
      const start = performance.now(), map = window.__hotspotSearch.domText(host)
      for (let index = 0; index < matches.length; index++) {
        const range = map.range(matches[index])
        if (range.toString() !== nodes[index + 10000].textContent) throw new Error(`Wrong range ${index}`)
      }
      samples.push(performance.now() - start)
    }
    // Cross-node ranges, empty nodes, UTF-16 offsets, filtered scripts and gutters.
    host.replaceChildren(); host.innerHTML = '<span>ab</span><span></span><span>中😀</span><script>hidden</script><span class="cm-gutters">hidden</span><span>cd</span>'
    const map = window.__hotspotSearch.domText(host)
    if (map.text !== 'ab中😀cd' || map.range({ from: 1, to: 5 }).toString() !== 'b中😀' || map.range({ from: 5, to: 7 }).toString() !== 'cd') throw new Error('Cross-node or Unicode range changed')
    host.remove(); return samples
  })
  report.samples.domRangesMs = dom; report.metrics.domRangesMs = median(dom)
  report.checks.unicodeRanges = true
  assert.equal(fs.readFileSync(path.join(data, 'large.txt'), 'utf8'), '\ufeff' + '中文 content\r\n'.repeat(50000) + 'ppp')
  report.checks.savedContent = true
  console.log(JSON.stringify(report, null, 2))
  fs.writeFileSync(path.join(output, `hotspot-ui-${baseline ? 'before' : 'after'}.json`), JSON.stringify(report, null, 2))
  if (!baseline) finishPerformance(report, { outputPath: path.join(output, 'hotspot-ui-after.json') })
  console.log('PASS real source save paint and Unicode/cross-node document range lookup')
} finally { await app.close() }
