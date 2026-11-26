import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import ssh2 from 'ssh2'
import { _electron as electron } from 'playwright'
import { zipSync, strToU8 } from 'fflate'

assert.equal(process.platform,'win32','This check uses the local Ubuntu WSL fixture')
const wsl=(...args)=>execFileSync('wsl.exe',['-d','Ubuntu','--',...args],{encoding:'utf8',timeout:30000,windowsHide:true}).trim()
const rootRead = (...args) => execFileSync('wsl.exe', ['-d', 'Ubuntu', '-u', 'root', '--', ...args], { encoding: 'utf8', timeout: 30000, windowsHide: true }).trim()
const user=wsl('id','-un'); assert.match(user,/^[a-z_][a-z0-9_-]*$/i)
assert.notEqual(user,'root')
const repo=wsl('mktemp','-d','/tmp/pello-custom-remote-XXXXXX');assert.match(repo,/^\/tmp\/pello-custom-remote-[A-Za-z0-9]+$/)
wsl('git','-C',repo,'init')
wsl('bash','-c',`printf 'synthetic file\n' > '${repo}/synthetic.txt'`)
const key=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs1',format:'pem'})
const clients=new Set(),children=new Set()
let holdWrite
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
      child.stdout.on('data',chunk=>{
        if (holdWrite && login === 'root' && chunk.toString() === 'OK\n') {
          const release = holdWrite; holdWrite = undefined
          release(() => { if (!stream.destroyed) stream.write(chunk) })
        } else if(!stream.destroyed)stream.write(chunk)
      })
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
  assert.equal(rootResult.isRepo, true, JSON.stringify(rootResult))
  assert.ok(rootResult.files.some((file) => file.path === 'synthetic.txt'))
  console.log('PASS SSH root reads Git status using the repository owner identity')
  const ownerResult=await page.evaluate(()=>window.awb.gitStatus('owner-project',true))
  assert.equal(ownerResult.isRepo,true,JSON.stringify(ownerResult));assert.ok(ownerResult.files.some(f=>f.path==='synthetic.txt'))
  console.log('PASS using an SSH connection for the repository owner recognizes the actual Git change')
  await page.evaluate(()=>window.awb.ptyClose('remote-su'))

  const configs = ['root', 'owner'].map((hostId) => ({
    id: '', name: 'Shared name', hostId, format: 'standard', skillAdapter: 'claude',
    skillPath: `${repo}/${hostId}/.agents/skills`, mcpPath: `${repo}/${hostId}/mcp.jsonc`,
    env: [{ k: 'PELLO_REMOTE_TEMPLATE', v: `value-${hostId}-é中`, secret: false }]
  }))
  const scope = (hostId, executorId = 'machine-custom') => ({ hostId, executorId })
  await page.evaluate(async (configs) => {
    for (const config of configs) {
      const saved = await window.awb.saveTemplate(config)
      const template = saved.templates.find((entry) => entry.hostId === config.hostId)
      for (const executorId of ['machine-custom', 'claude']) await window.awb.bindTemplate({ hostId: config.hostId, executorId }, template.id)
    }
  }, configs)
  for (const hostId of ['root', 'owner']) {
    const result = await page.evaluate((hostId) => window.awb.testExec({
      executorId: 'machine-custom', hostId, shell: 'bash', env: [], cmd: 'printf', args: "'%s\\n' \"$PELLO_REMOTE_TEMPLATE\""
    }), hostId)
    assert.equal(result.code, 0, JSON.stringify(result))
    assert.ok(result.text.split(/[\r\n]+/).includes(`value-${hostId}-é中`), result.text)
  }
  console.log('PASS SSH template environments reach the target process over stdin, independently for two machine identities')

  const write = await page.evaluate((scopes) => window.awb.addMcp('team-fixture', { command: 'node', env: { TOKEN: 'ssh-fixture-secret' } }, scopes),
    [scope('root'), scope('root', 'claude'), scope('owner')])
  assert.ok(write.every((row) => row.ok), JSON.stringify(write))
  assert.match(rootRead('cat', configs[0].mcpPath), /team-fixture/)
  assert.match(wsl('cat', configs[1].mcpPath), /team-fixture/)
  const initial = await page.evaluate(async (scope) => (await window.awb.resourceList('mcp', scope, 1, '')).items[0], scope('owner'))
  await page.evaluate(({ scope, item }) => window.awb.resourceToggle('mcp', scope, item, false), { scope: scope('owner'), item: initial })
  const detail = await page.evaluate(({ scope, item }) => window.awb.resourceDetail('mcp', scope, item), { scope: scope('owner'), item: initial })
  assert.equal(detail.enabled, false)
  assert.doesNotMatch(detail.content, /ssh-fixture-secret/)
  assert.match(wsl('cat', configs[1].mcpPath + '.awb-backup'), /mcpServers/)
  const source = `${repo}/ssh-source.jsonc`
  wsl('bash', '-c', `printf '%s' '{"mcpServers":{"from-ssh":{"command":"node","env":{"TOKEN":"ssh-import-hidden"}}}}' > '${source}'`)
  const previews = await page.evaluate((source) => window.awb.scanResources('mcp', source, 'owner'), source)
  assert.equal(previews[0].name, 'from-ssh')
  assert.doesNotMatch(JSON.stringify(previews), /ssh-import-hidden/)
  const imported = await page.evaluate(({ source, scopes, ids }) => window.awb.importMcpConfig(source, scopes, ids, 'owner'),
    { source, scopes: [scope('root'), scope('owner')], ids: previews.map((item) => item.id) })
  assert.ok(imported.every((row) => row.ok), JSON.stringify(imported))
  assert.match(wsl('cat', configs[1].mcpPath), /from-ssh/)
  const samePath = await page.evaluate(async (paths) => {
    const { db } = await window.awb.getState()
    const original = db.templates.find((entry) => entry.hostId === 'root')
    const renamed = await window.awb.saveHosts(db.hosts.map((host) => host.id === 'owner' ? { ...host, name: 'Renamed SSH owner' } : host))
    if (!renamed.templateBindings.some((entry) => entry.hostId === 'owner')) throw new Error('Machine rename broke its template binding')
    await window.awb.saveTemplate({ ...original, mcpPath: paths.owner })
    try {
      return await window.awb.addMcp('same-path-two-hosts', { command: 'node' }, ['owner', 'root'].map((hostId) => ({ hostId, executorId: 'machine-custom' })))
    } finally { await window.awb.saveTemplate(original) }
  }, { owner: configs[1].mcpPath })
  assert.equal(samePath[0].ok, true)
  // Both fixture identities use the same Linux filesystem. The second actual write sees the duplicate.
  assert.equal(samePath[1].skipped, true)
  console.log('PASS machine-scoped MCP list, toggle, backups, shared paths and redacted SSH file import')

  const archive = path.join(data, 'fixture.zip')
  fs.writeFileSync(archive, zipSync({ 'zip/SKILL.md': strToU8('---\nname: team-skill\ndescription: Fixture\n---\nBody\n'), 'zip/references/guide.md': strToU8('Supporting file') }))
  const skills = await page.evaluate(({ archive, scopes }) => window.awb.importSkills(archive, scopes, ['team-skill']),
    { archive, scopes: [scope('owner'), scope('owner', 'claude'), scope('root')] })
  assert.ok(skills.every((row) => row.ok), JSON.stringify(skills))
  const skill = await page.evaluate(async (scope) => (await window.awb.resourceList('skills', scope, 1, '')).items[0], scope('owner'))
  assert.equal(skill.name, 'team-skill')
  await page.evaluate(({ scope, skill }) => window.awb.resourceToggle('skills', scope, skill, false), { scope: scope('owner'), skill })
  assert.equal(JSON.parse(wsl('cat', `${repo}/owner/.agents/settings.json`)).skillOverrides['team-skill'], 'off')
  assert.equal(rootRead('cat', `${configs[0].skillPath}/team-skill/references/guide.md`), 'Supporting file')
  const listing = await page.evaluate((folder) => window.awb.browseResources('owner', folder, true), `${repo}/owner`)
  assert.ok(listing.dirs.some((item) => item.name === '.agents'))
  assert.ok(listing.files.some((item) => item.name === 'mcp.jsonc'))
  const repeated = await page.evaluate(({ archive, scopes }) => window.awb.importSkills(archive, scopes, ['team-skill']), { archive, scopes: [scope('owner')] })
  assert.equal(repeated[0].ok, false)
  assert.equal(wsl('cat', `${configs[1].skillPath}/team-skill/references/guide.md`), 'Supporting file')
  console.log('PASS SSH Skill ZIP, shared destination deduplication, hidden paths, native toggles and conflict preservation')

  await page.reload()
  await page.click('[data-a=settings]'); await page.click('[data-a=sec][data-id=mcp]')
  await page.getByRole('button', { name: '添加 MCP', exact: true }).click()
  await page.getByRole('button', { name: '从配置文件导入', exact: true }).click()
  await page.getByLabel('来源机器', { exact: true }).selectOption('owner')
  const browse = page.getByRole('button', { name: '浏览', exact: true })
  await browse.click()
  const pick = page.getByRole('dialog', { name: '选择文件', exact: true })
  await pick.getByLabel('浏览路径').fill(repo)
  await pick.getByLabel('浏览路径').press('Enter')
  await pick.getByRole('button', { name: 'ssh-source.jsonc', exact: true }).dblclick()
  await page.getByText('发现 1 项 · 已选择 1 项', { exact: true }).waitFor()
  await browse.click()
  await page.keyboard.press('Escape')
  await pick.waitFor({ state: 'detached' })
  assert.ok(await browse.evaluate((button) => button === document.activeElement))
  await page.keyboard.press('Escape')
  console.log('PASS SSH MCP file chooser loads file preview and restores focus after nested Escape')

  const staged = new Promise((resolve) => { holdWrite = resolve })
  const distribution = page.evaluate((scopes) => window.awb.addMcp('delete-during-write', { command: 'node' }, scopes), [scope('root'), scope('owner')])
  const release = await Promise.race([staged, distribution.then((result) => { throw new Error('SSH write did not reach its approval boundary: ' + JSON.stringify(result)) })])
  await page.evaluate(async () => {
    const { db } = await window.awb.getState()
    await window.awb.saveHosts(db.hosts.filter((host) => host.id !== 'root'))
  })
  release()
  const guarded = await distribution
  assert.deepEqual(guarded.map((row) => row.ok), [false, true])
  assert.doesNotMatch(rootRead('cat', configs[0].mcpPath), /delete-during-write/)
  assert.match(wsl('cat', configs[1].mcpPath), /delete-during-write/)
  console.log('PASS removing a machine during a staged write rejects publication and leaves other targets operational')
}finally{
 await app?.close();for(const client of clients)client.end();for(const child of children)child.kill();await new Promise(resolve=>server.close(resolve))
 // The resolved fixture path is checked above; remove only the directory created by this check.
 rootRead('rm','-rf','--',repo)
}
console.log('Evidence: '+data)
