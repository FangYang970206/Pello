import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { _electron as electron } from 'playwright'
import { loadTypeScript } from './fixtures/load-ts.mjs'

const root = path.resolve('.')
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pello-custom-check-'))
const home = path.join(data, 'native'); fs.mkdirSync(home)
const quote = (value) => `'${value.replaceAll("'", "''")}'`
const shell = process.platform === 'win32' ? 'pwsh' : 'bash'
const cmd = `${process.platform === 'win32' ? '& ' : ''}${quote(process.execPath)}`
const args = quote(path.join(root, 'scripts/fixtures/custom-agent.cjs')) + ' --fixture-home ' + quote(home)
const custom = { id: 'custom-fixture', name: 'Custom fixture', cmd, args, shell, letter: 'T', color: '#a9c3df', env: [{ k: 'PELLO_FIXTURE_HOME', v: home }], session: { startArgs: '--session-id {sessionId}', resumeArgs: '--resume {sessionId}' } }
const { submittedCustomAgent, isConfiguredLaunch } = await loadTypeScript(new URL('../src/shared/executor.ts',import.meta.url))
assert.equal(submittedCustomAgent(cmd+' '+args,[custom],'local')?.id,custom.id)
assert.equal(submittedCustomAgent(cmd+' '+args,[custom,{...custom,id:'ambiguous'}],'local'),undefined)
assert.equal(submittedCustomAgent('echo hello | '+cmd+' '+args,[custom],'local'),undefined)
assert.equal(isConfiguredLaunch(cmd+' '+args+' --version',custom,'local'),false)
console.log('PASS manual launch identification rejects ambiguity, pipelines, and mutation of commands with extra arguments')
fs.mkdirSync(path.join(data,'terminal-history'))
fs.writeFileSync(path.join(data,'terminal-history',createHash('sha256').update('legacy').digest('hex')+'.log'),'LEGACY_CUSTOM_HISTORY')
fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify({ settings: { restore: true, defAgent: 'shell' }, custom: [custom], projects: [{ id: 'p', name: 'Custom regression', host: 'local', path: data, agent: custom.id }], sessions: { p: [{ id: 'a', kind: custom.id, shell }, { id: 'b', kind: custom.id, shell }, { id: 'manual', kind: 'shell', shell }, { id:'legacy',kind:custom.id,shell }] }, activeTab: { p: 'a' } }))
const env = { ...process.env, AWB_USER_DATA: data }; delete env.ELECTRON_RUN_AS_NODE
const failures = []
const check = async (name, run) => { try { await run(); console.log('PASS ' + name) } catch (error) { failures.push(name); console.error('FAIL ' + name + ': ' + error.message) } }
let app
const launch = () => electron.launch({ executablePath: process.env.AWB_APP_EXE, args: process.env.AWB_APP_EXE ? [] : [root], env })
try {
 app = await launch()
 let page = await app.firstWindow(); page.setDefaultTimeout(15000)
 await page.waitForFunction(() => ['a', 'b'].every(id => window.__awbBuffer?.(id)?.includes('CUSTOM_READY')))
 await check('custom agents without native activity reports are available and do not spin', async () => {
   assert.equal(await page.locator('[data-a=tab][data-id=a]').locator('..').locator('.terminal-status.spinning').count(), 0, 'Missing activity protocol defaults to available')
   await page.evaluate(() => window.awb.ptyWrite('a', 'FIXTURE_STATUS_working\r'))
   await page.locator('[data-a=tab][data-id=a] .terminal-status.spinning').waitFor()
   await page.evaluate(() => window.awb.ptyWrite('a', 'FIXTURE_STATUS_idle\r'))
   await page.locator('[data-a=tab][data-id=a] .terminal-status.ready').waitFor()
   assert.equal(await page.locator('[data-a=tab][data-id=b] .terminal-status.spinning').count(), 0, 'Reports must not change another terminal')
 })
 await check('legacy custom history without native identity is retained without guessing a new conversation',async()=>{
   await page.waitForFunction(()=>window.__awbBuffer?.('legacy')?.includes('缺少原生 ID'))
   const text=await page.evaluate(()=>window.__awbBuffer('legacy'))
   assert.ok(text.includes('LEGACY_CUSTOM_HISTORY')&&!text.includes('CUSTOM_READY'))
 })
 await check('custom terminals persist distinct exact native conversation IDs', async () => {
   const db = (await page.evaluate(() => window.awb.getState())).db
   assert.ok(db.sessions.p.find(t => t.id === 'a').agentSessionId, 'custom native identity is missing')
   assert.notEqual(db.sessions.p.find(t => t.id === 'a').agentSessionId, db.sessions.p.find(t => t.id === 'b').agentSessionId)
 })
 for (const [id, message] of [['a','FIRST_A'], ['b','FIRST_B'], ['a','SECOND_A']]) {
   await page.evaluate(({id,message})=>window.awb.ptyWrite(id,message+'\r'), {id,message})
   await page.waitForFunction(({id,message})=>window.__awbBuffer?.(id)?.includes('CUSTOM_REPLY') && window.__awbBuffer(id).includes(message),{id,message})
 }
 await check('manually launched configured custom agent appears in Recent', async () => {
   await page.waitForFunction(()=>window.__awbBuffer?.('manual')?.includes('>') || window.__awbBuffer?.('manual')?.includes('$'))
   await page.evaluate(()=>{window.customEvents=[];window.awb.onPty(e=>{if(e.type==='state'&&e.id==='manual')window.customEvents.push(e)})})
   await page.evaluate(command=>window.awb.ptyWrite('manual',command+'\r'),cmd+' '+args)
   await page.waitForFunction(()=>window.__awbBuffer?.('manual')?.includes('CUSTOM_READY'))
   const event=await page.evaluate(()=>window.customEvents.at(-1))
   assert.equal(event.agentKind, custom.id)
   await page.click('[data-a=agents-toggle]')
   await page.locator('[data-a=side-term][data-id=manual]').click()
   assert.equal(await page.locator('.tab.on [data-a=tab]').getAttribute('data-id'),'manual')
   await page.evaluate(()=>window.awb.ptyWrite('manual','MANUAL_FIRST\r'))
   await page.waitForFunction(()=>window.__awbBuffer('manual').includes('CUSTOM_REPLY ["MANUAL_FIRST"]'))
 })
 await app.close(); app=null
 app=await launch(); page=await app.firstWindow()
 await page.waitForFunction(()=>window.__awbBuffer?.('a')?.includes('CUSTOM_READY'))
 await check('relaunch resumes each native conversation, beyond transcript replay',async()=>{
   const text=await page.evaluate(()=>window.__awbBuffer('a'))
   const last=text.slice(text.lastIndexOf('CUSTOM_READY'))
   assert.ok(last.includes('FIRST_A')&&last.includes('SECOND_A')&&!last.includes('FIRST_B'),last)
   await page.waitForFunction(()=>window.__awbBuffer?.('manual')?.includes('CUSTOM_READY'))
   const manual=await page.evaluate(()=>window.__awbBuffer('manual'))
   assert.ok(manual.slice(manual.lastIndexOf('CUSTOM_READY')).includes('MANUAL_FIRST'))
 })
 await check('available status survives submit and renders in light/dark narrow and wide workspaces', async () => {
   const output = path.resolve('output/remote-agent-status'); fs.mkdirSync(output, { recursive: true })
   for (const [theme, width, height, fontSize] of [['light', 1024, 680, 16], ['dark', 1440, 900, 12]]) {
     await page.click('[data-a=settings]'); await page.click('[data-a=sec][data-id=look]')
     await page.locator(`[data-a=theme][data-id="${theme}"]`).click()
     await page.locator(`[data-a=theme][data-id="${theme}"][aria-checked=true]`).waitFor()
     await page.getByLabel('界面字号', { exact: true }).selectOption(String(fontSize))
     await page.waitForFunction(async (size) => (await window.awb.getState()).db.settings.uiFontSize === size, fontSize)
     await page.click('[data-a=back]'); await page.setViewportSize({ width, height })
     await page.locator('[data-a=tab][data-id=a]').click()
     await page.locator('[data-a=tab][data-id=a] .terminal-status.ready').waitFor()
     assert.equal(await page.locator('[data-a=tab][data-id=a] .terminal-status.spinning').count(), 0)
     await page.waitForFunction(() => window.__awbBuffer('a')?.includes('FIRST_A'))
     await page.screenshot({ path: path.join(output, `${theme}-${width}.png`) })
   }
 })
}finally{await app?.close()}
console.log('Evidence: '+data)
assert.deepEqual(failures,[])
