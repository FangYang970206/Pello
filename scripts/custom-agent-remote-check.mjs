import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import ssh2 from 'ssh2'
import { _electron as electron } from 'playwright'

assert.equal(process.platform,'win32','This check uses the local Ubuntu WSL fixture')
const wsl=(...args)=>execFileSync('wsl.exe',['-d','Ubuntu','--',...args],{encoding:'utf8',timeout:30000,windowsHide:true}).trim()
const user=wsl('id','-un'); assert.match(user,/^[a-z_][a-z0-9_-]*$/i)
assert.notEqual(user,'root')
const repo=wsl('mktemp','-d','/tmp/pello-custom-remote-XXXXXX');assert.match(repo,/^\/tmp\/pello-custom-remote-[A-Za-z0-9]+$/)
wsl('git','-C',repo,'init')
wsl('bash','-c',`printf 'synthetic file\n' > '${repo}/synthetic.txt'`)
const key=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs1',format:'pem'})
const clients=new Set(),children=new Set()
const server=new ssh2.Server({hostKeys:[key]},client=>{
  clients.add(client);client.on('error',()=>{});client.on('close',()=>clients.delete(client))
  let login='root'
  client.on('authentication',ctx=>{if(ctx.method==='password'&&ctx.password==='synthetic'&&['root',user].includes(ctx.username)){login=ctx.username;ctx.accept()}else ctx.reject()})
  client.on('ready',()=>client.on('session',accept=>{
    const session=accept();let tty=false
    session.on('pty',accept=>{tty=true;accept()})
    session.on('window-change',accept=>accept?.())
    session.on('exec',(accept,_reject,info)=>{
      const stream=accept()
      const command=tty?['timeout','45s','script','-qefc',info.command,'/dev/null']:['bash','-c',info.command]
      const child=spawn('wsl.exe',['-d','Ubuntu','-u',login,'--',...command],{windowsHide:true})
      children.add(child);child.on('error',()=>stream.end());child.stdin.on('error',()=>{})
      child.stdout.on('data',chunk=>{if(!stream.destroyed)stream.write(chunk)})
      child.stderr.on('data',chunk=>{if(!stream.destroyed)stream.stderr.write(chunk)})
      stream.on('data',chunk=>child.stdin.write(chunk));stream.on('end',()=>child.stdin.end())
      stream.on('close',()=>{child.stdin.end();child.kill()})
      child.on('exit',code=>{children.delete(child);if(!stream.destroyed){stream.exit(code||0);stream.end()}})
    })
  }))
})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const data=fs.mkdtempSync(path.join(os.tmpdir(),'pello-custom-remote-'))
const env={...process.env,AWB_USER_DATA:data};delete env.ELECTRON_RUN_AS_NODE
let app
try{
  app=await electron.launch({args:[path.resolve('.')],env});const page=await app.firstWindow();page.setDefaultTimeout(20000)
  await page.waitForFunction(()=>!!window.awb)
  const hosts=['root',user].map((login,index)=>({id:index?'owner':'root',name:index?'Repository owner':'Root fixture',addr:'127.0.0.1',user:login,port:server.address().port,auth:'password',password:'synthetic',platform:'linux',os:'Linux',on:true}))
  await page.evaluate(async hosts=>{const db=(await window.awb.getState()).db;await window.awb.saveHosts([...db.hosts,...hosts])},hosts)
  await page.evaluate(async repo=>{await window.awb.saveProjects([{id:'root-project',name:'Root fixture',host:'root',path:repo,agent:'shell'},{id:'owner-project',name:'Owner fixture',host:'owner',path:repo,agent:'shell'}])},repo)
  const test=await page.evaluate(()=>window.awb.testExec({cmd:'printf',args:"'REMOTE_LINUX_OK\\n'",shell:'pwsh',env:[],hostId:'root'}))
  assert.equal(test.code,0,JSON.stringify(test));assert.ok(test.text.includes('REMOTE_LINUX_OK'))
  console.log('PASS executor startup test actually runs on SSH Linux, normalizing Windows shell preference')
  await page.evaluate(async()=>{
    await window.awb.saveCustom([{id:'machine-custom',name:'Machine fixture',cmd:'windows-command-unavailable-on-linux',args:'',shell:'pwsh',env:[],letter:'T',color:'#a9c3df',hosts:{owner:{cmd:'printf',args:"'REMOTE_%s\\n' CUSTOM_OK",shell:'bash'}}}])
    window.customRemoteOutput='';window.awb.onPty(e=>{if(e.type==='data'&&e.id==='remote-custom')window.customRemoteOutput+=e.data})
    await window.awb.ptyCreate({id:'remote-custom',projectId:'owner-project',kind:'machine-custom',shell:'bash'})
  })
  await page.waitForFunction(()=>window.customRemoteOutput.includes('REMOTE_CUSTOM_OK'))
  await page.evaluate(()=>window.awb.ptyClose('remote-custom'))
  console.log('PASS remote custom launch uses its machine-specific command rather than its Windows command')
  await page.evaluate(()=>window.awb.ptyCreate({id:'remote-su',projectId:'root-project',kind:'shell',shell:'pwsh'}))
  await page.evaluate(()=>{window.remoteOutput='';window.awb.onPty(e=>{if(e.type==='data'&&e.id==='remote-su')window.remoteOutput+=e.data})})
  await page.evaluate(command=>window.awb.ptyWrite('remote-su',command+'\r'),`su - ${user}`)
  await new Promise(r=>setTimeout(r,1000))
  await page.evaluate(command=>window.awb.ptyWrite('remote-su',command+'\r'),`printf 'OWNER_TERMINAL_MARKER\\n'; id -u; git -C '${repo}' status --porcelain`)
  await page.waitForFunction(()=>window.remoteOutput.includes('?? synthetic.txt'))
  let rootResult
  try{rootResult=await page.evaluate(()=>window.awb.gitStatus('root-project',true))}catch(error){rootResult={error:error.message}}
  fs.writeFileSync(path.join(data,'root-git-result.json'),JSON.stringify(rootResult,null,2))
  assert.ok(!rootResult.isRepo || rootResult.error || rootResult.errors?.length,'fixture must reproduce root ownership rejection')
  console.log('REPRO terminal su changes the foreground shell user; Git backend remains the SSH login user')
  const ownerResult=await page.evaluate(()=>window.awb.gitStatus('owner-project',true))
  assert.equal(ownerResult.isRepo,true,JSON.stringify(ownerResult));assert.ok(ownerResult.files.some(f=>f.path==='synthetic.txt'))
  console.log('PASS using an SSH connection for the repository owner recognizes the actual Git change')
  await page.evaluate(()=>window.awb.ptyClose('remote-su'))
}finally{
 await app?.close();for(const client of clients)client.end();for(const child of children)child.kill();await new Promise(resolve=>server.close(resolve))
 // The resolved fixture path is checked above; remove only the directory created by this check.
 wsl('rm','-rf','--',repo)
}
console.log('Evidence: '+data)
