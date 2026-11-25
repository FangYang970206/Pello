import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright'

const data=fs.mkdtempSync(path.join(os.tmpdir(),'pello-custom-ui-'))
const shots=path.resolve('output/playwright/custom-agent');fs.mkdirSync(shots,{recursive:true})
const custom={id:'public-test',name:'Public custom CLI',cmd:'node',args:'--version',shell:'pwsh',env:[],letter:'Q',color:'#a9c3df'}
fs.writeFileSync(path.join(data,'workbench.json'),JSON.stringify({settings:{autoCheckUpdates:false},custom:[custom],hosts:[{id:'linux',name:'Linux machine with a deliberately long descriptive name',addr:'127.0.0.1',user:'fixture',port:1,auth:'key',platform:'linux',os:'Linux',on:false}]}))
const env={...process.env,AWB_USER_DATA:data};delete env.ELECTRON_RUN_AS_NODE
const dpi=Number(process.argv.find(arg=>arg.startsWith('--dpi='))?.slice(6)||1)
const app=await electron.launch({args:[path.resolve('.'),`--force-device-scale-factor=${dpi}`],env})
try{
 const page=await app.firstWindow();page.setDefaultTimeout(15000)
 const open=async()=>{await page.click('[data-a=settings]');await page.click('[data-a=sec][data-id=agents]');await page.click('[data-a=custom][data-id=public-test]')}
 await open()
 await page.selectOption('[data-ce=host]','linux')
 assert.equal(await page.locator('[data-a=ces][data-id=pwsh]').count(),0)
 assert.equal(await page.locator('[data-a=ces][data-id=cmd]').count(),0)
 assert.equal(await page.locator('[data-a=ces][data-id=bash]').getAttribute('aria-checked'),'true')
 await page.fill('[data-ce=cmd]','qwen-linux')
 await page.fill('[data-ce=args]','--bare')
 await page.selectOption('[data-ce=host]','')
 assert.equal(await page.inputValue('[data-ce=cmd]'),'node')
 await page.click('[data-a=ce-test]')
 await page.waitForFunction(()=>document.querySelector('#ceout')?.textContent?.includes('退出码 0'))
 const bash=await page.evaluate(()=>window.awb.testExec({cmd:'printf',args:"'NATIVE_BASH_TEST\\n'",shell:'bash',env:[]}))
 assert.equal(bash.code,0,JSON.stringify(bash));assert.ok(bash.text.includes('NATIVE_BASH_TEST'))
 const missing=await page.evaluate(()=>window.awb.testExec({cmd:'pello_nonexistent_custom_agent_42',args:'',shell:'pwsh',env:[]}))
 assert.notEqual(missing.code,0,'an unavailable command must fail the startup test')
 await page.click('[data-a=ce-more]');await page.click('[data-ce=resume]')
 await page.click('[data-a=ce-save]')
 assert.ok((await page.locator('#ceout').innerText()).includes('都必须包含'))
 const rejected=await page.evaluate(async()=>{const db=(await window.awb.getState()).db;try{await window.awb.saveCustom([{...db.custom[0],session:{startArgs:'--continue',resumeArgs:'--continue'}}]);return false}catch{return true}})
 assert.ok(rejected,'main process must reject a session protocol that cannot identify the terminal conversation')
 await page.fill('[data-ce=start-args]','--session-id {sessionId}')
 await page.fill('[data-ce=resume-args]','--resume {sessionId}')
 assert.equal(await page.locator('#modal .sws .sw').count(),16)
 await page.locator('#modal .sws .sw').last().press('Space')
 assert.equal(await page.locator('#modal .sws .sw').last().getAttribute('aria-pressed'),'true')
 await page.click('[data-a=ce-save]');await page.getByRole('dialog').waitFor({state:'detached'})
 const saved=(await page.evaluate(()=>window.awb.getState())).db.custom[0]
 assert.equal(saved.hosts.linux.cmd,'qwen-linux');assert.equal(saved.hosts.linux.shell,'bash');assert.equal(saved.cmd,'node')
 assert.equal(saved.session.resumeArgs,'--resume {sessionId}')
 assert.equal(saved.color,'#e6a2a9')
 console.log('PASS per-machine commands, Linux shell choices, native local Bash tests, missing-command failure, and saved resume settings')
 for(const [theme,language,width,height,font,narrow] of [['light','zh-CN',1440,900,12,false],['dark','en',1024,680,16,false],['dark','zh-CN',1024,680,12,true],['light','en',1440,900,16,true]]){
   await app.evaluate(({BrowserWindow},{width,height})=>{const win=BrowserWindow.getAllWindows()[0];win.setSize(width,height)}, {width,height})
   await page.evaluate(async({theme,language,font})=>{const db=(await window.awb.getState()).db;await window.awb.saveSettings({...db.settings,theme,language,uiFontSize:font})},{theme,language,font})
   await page.reload();await open();await page.click('[data-a=ce-more]')
   assert.equal(await page.locator('#modal h2').innerText(),language==='en'?'Edit executor':'编辑执行器')
   assert.equal(await page.evaluate(()=>document.documentElement.dataset.theme),theme)
   assert.equal(await page.locator('#modal .fld>span').first().evaluate(e=>parseFloat(getComputedStyle(e).fontSize)),font)
   await page.evaluate(narrow=>{document.querySelector('#modal .dlg').style.width=narrow?'360px':''},narrow)
   await page.locator('[data-ce=cmd]').fill('node')
   await page.locator('[data-ce=cmd]').focus();assert.equal(await page.locator('[data-ce=cmd]').evaluate(e=>e===document.activeElement),true)
   const geometry=await page.evaluate(()=>{
     const dialog=document.querySelector('#modal .dlg'),bdy=dialog.querySelector('.bdy'),input=dialog.querySelector('[data-ce=cmd]'),save=dialog.querySelector('[data-a=ce-save]')
     const box=dialog.getBoundingClientRect(),i=input.getBoundingClientRect(),s=save.getBoundingClientRect()
     return {width:i.width,ratio:i.width/box.width,scrollWidth:bdy.scrollWidth,clientWidth:bdy.clientWidth,saveVisible:s.bottom<=innerHeight&&s.top>=0,bodyHeight:bdy.clientHeight}
   })
   assert.ok(geometry.width>=64&&geometry.ratio>.25,JSON.stringify(geometry));assert.ok(geometry.saveVisible&&geometry.bodyHeight>100,JSON.stringify(geometry));assert.ok(geometry.scrollWidth<=geometry.clientWidth+1,JSON.stringify(geometry))
   await page.screenshot({path:path.join(shots,`${dpi}-${theme}-${language}-${font}-${narrow?'narrow':'normal'}.png`)})
   const palette = page.locator('#modal .sws')
   await palette.scrollIntoViewIfNeeded()
   const swatchesFit = await palette.evaluate((node) => {
     const body = node.closest('.bdy').getBoundingClientRect()
     return Array.from(node.querySelectorAll('.sw')).every((swatch) => {
       const rect = swatch.getBoundingClientRect()
       return rect.left >= body.left && rect.right <= body.right && rect.width >= 18
     })
   })
   assert.ok(swatchesFit)
   await page.screenshot({path:path.join(shots,`palette-${dpi}-${theme}-${language}-${font}.png`)})
 }
 console.log(`PASS rendered custom dialog, light/dark, Chinese/English, 12/16px, both window sizes, and a 360px container at ${dpi*100}% DPI`)
}finally{await app.close()}
