import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'node:http'
import { _electron as electron } from 'playwright'

// Install the public CLI separately in an ignored directory. No credentials or real model endpoints.
const cli = path.resolve(process.argv.find(arg => arg.startsWith('--cli='))?.slice(6) || '.cache/qwen-test/node_modules/@qwen-code/qwen-code/cli.js')
assert.ok(fs.existsSync(cli), 'Install @qwen-code/qwen-code@0.27.4 in .cache/qwen-test or provide --cli=...')
const root = path.resolve('.')
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pello-qwen-native-'))
const project = path.join(data, 'project'); fs.mkdirSync(project)
const requests = []
const server = createServer((req, res) => {
  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => {
    const request = JSON.parse(body || '{}'); requests.push(request)
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const chunk = { id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: 'SYNTHETIC_LOCAL_REPLY' }, finish_reason: null }] }
    res.write('data: ' + JSON.stringify(chunk) + '\n\n')
    chunk.choices = [{ index: 0, delta: {}, finish_reason: 'stop' }]
    res.end('data: ' + JSON.stringify(chunk) + '\n\ndata: [DONE]\n\n')
  })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const quote = value => `'${value.replaceAll("'", "''")}'`
const cmd = `${process.platform === 'win32' ? '& ' : ''}${quote(process.execPath)}`
const args = `${quote(cli)} --bare --no-telemetry --chat-recording --auth-type openai --openai-api-key fixture --openai-base-url http://127.0.0.1:${server.address().port}/v1 --model fixture`
const shell = process.platform === 'win32' ? 'pwsh' : 'bash'
const custom = { id: 'public-qwen', name: 'Public Qwen Code', cmd, args, shell, env: [], letter: 'Q', color: '#a9c3df', session: { startArgs: '--session-id {sessionId}', resumeArgs: '--resume {sessionId}' } }
fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify({settings:{restore:true,autoCheckUpdates:false},custom:[custom],projects:[{id:'p',name:'Synthetic Qwen test',host:'local',path:project,agent:custom.id}],sessions:{p:[{id:'qwen',kind:custom.id,shell},{id:'manual',kind:'shell',shell}]},activeTab:{p:'qwen'}}))
const env = { ...process.env, AWB_USER_DATA: data, HOME: data, USERPROFILE: data, XDG_CONFIG_HOME: path.join(data,'config'), XDG_DATA_HOME: path.join(data,'share'), QWEN_CODE_DISABLE_AUTO_UPDATE:'1' }; delete env.ELECTRON_RUN_AS_NODE
let app
try {
  app = await electron.launch({args:[root],env})
  let page = await app.firstWindow(); page.setDefaultTimeout(30000)
  await page.waitForFunction(()=>window.__awbBuffer?.('qwen')?.includes('输入您的消息'))
  const first = (await page.evaluate(()=>window.awb.getState())).db.sessions.p.find(t=>t.id==='qwen').agentSessionId
  assert.ok(first)
  for (const message of ['SYNTHETIC_FIRST_TURN','SYNTHETIC_SECOND_TURN']) {
    const count = requests.length
    await page.evaluate(message=>window.awb.ptyWrite('qwen',message),message)
    await new Promise(r=>setTimeout(r,150))
    await page.evaluate(()=>window.awb.ptyWrite('qwen','\r'))
    await page.waitForFunction(()=>window.__awbBuffer?.('qwen')?.includes('SYNTHETIC_LOCAL_REPLY'))
    const deadline=Date.now()+20000
    while(requests.length===count && Date.now()<deadline) await new Promise(r=>setTimeout(r,50))
    assert.ok(requests.length>count,'Qwen must call the local fixture')
    await new Promise(r=>setTimeout(r,600))
  }
  console.log('PASS real Qwen CLI exchanges two synthetic turns with a loopback-only model')
  await page.evaluate(()=>{window.manualEvents=[];window.awb.onPty(e=>{if(e.type==='state'&&e.id==='manual')window.manualEvents.push(e)})})
  await page.waitForFunction(()=>window.__awbBuffer?.('manual')?.includes('>'))
  await page.evaluate(command=>window.awb.ptyWrite('manual',command+'\r'),cmd+' '+args)
  await page.waitForFunction(()=>window.__awbBuffer?.('manual')?.includes('输入您的消息'))
  const manual=await page.evaluate(()=>window.manualEvents.at(-1))
  assert.equal(manual.agentKind,custom.id)
  assert.ok(manual.agentSessionId && manual.agentSessionId!==first)
  await page.click('[data-a=agents-toggle]');await page.locator('[data-a=side-term][data-id=manual]').click()
  assert.equal(await page.locator('.tab.on [data-a=tab]').getAttribute('data-id'),'manual')
  await page.evaluate(()=>window.awb.ptyWrite('manual','SYNTHETIC_MANUAL_FIRST'))
  await new Promise(r=>setTimeout(r,150));await page.evaluate(()=>window.awb.ptyWrite('manual','\r'))
  await page.waitForFunction(()=>window.__awbBuffer?.('manual')?.includes('SYNTHETIC_LOCAL_REPLY'))
  console.log('PASS real Qwen manually launched from Shell is a distinct recognized custom Agent')
  await page.screenshot({path:path.join(data,'qwen-before-restart.png')})
  await app.close();app=null
  const count=requests.length
  app=await electron.launch({args:[root],env});page=await app.firstWindow();page.setDefaultTimeout(30000)
  await page.evaluate(()=>{window.resumedOutput={qwen:'',manual:''};window.awb.onPty(e=>{if(e.type==='data'&&e.id in window.resumedOutput)window.resumedOutput[e.id]+=e.data})})
  await page.waitForFunction(()=>Object.values(window.resumedOutput).every(text=>text.includes('输入您的消息')))
  await new Promise(r=>setTimeout(r,600))
  await page.evaluate(()=>window.awb.ptyWrite('qwen','SYNTHETIC_THIRD_TURN'))
  await new Promise(r=>setTimeout(r,150))
  await page.evaluate(()=>window.awb.ptyWrite('qwen','\r'))
  const deadline=Date.now()+25000
  while(!requests.slice(count).some(r=>JSON.stringify(r.messages).includes('SYNTHETIC_THIRD_TURN'))&&Date.now()<deadline)await new Promise(r=>setTimeout(r,50))
  const resumed=requests.slice(count).find(r=>JSON.stringify(r.messages).includes('SYNTHETIC_THIRD_TURN'))
  assert.ok(resumed,'restored native CLI must send a new turn to the local model')
  assert.ok(JSON.stringify(resumed.messages).includes('SYNTHETIC_FIRST_TURN'))
  assert.ok(JSON.stringify(resumed.messages).includes('SYNTHETIC_SECOND_TURN'))
  assert.ok(!JSON.stringify(resumed.messages).includes('SYNTHETIC_MANUAL_FIRST'))
  await page.evaluate(()=>window.awb.ptyWrite('manual','SYNTHETIC_MANUAL_SECOND'))
  await new Promise(r=>setTimeout(r,150));await page.evaluate(()=>window.awb.ptyWrite('manual','\r'))
  const manualDeadline=Date.now()+20000
  while(!requests.slice(count).some(r=>JSON.stringify(r.messages).includes('SYNTHETIC_MANUAL_SECOND'))&&Date.now()<manualDeadline)await new Promise(r=>setTimeout(r,50))
  const manualResumed=requests.slice(count).find(r=>JSON.stringify(r.messages).includes('SYNTHETIC_MANUAL_SECOND'))
  assert.ok(manualResumed)
  assert.ok(JSON.stringify(manualResumed.messages).includes('SYNTHETIC_MANUAL_FIRST'))
  assert.ok(!JSON.stringify(manualResumed.messages).includes('SYNTHETIC_FIRST_TURN'))
  console.log('PASS real Qwen resumes its exact native multi-turn context after full Pello restart')
  await page.screenshot({path:path.join(data,'qwen-after-restart.png')})
}catch(error){if(app){const page=await app.firstWindow();console.error(await page.evaluate(()=>['qwen','manual'].map(id=>({id,text:window.__awbBuffer?.(id)?.slice(-2200)}))))}throw error}
finally{await app?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
console.log('Evidence: '+data)
