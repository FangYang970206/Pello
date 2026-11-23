import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { buildSync } from 'esbuild'
import { zipSync, strToU8 } from 'fflate'

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pello-discovery-'))
const compiled = path.resolve('.cache/skill-discovery/check.cjs')
buildSync({ stdin: { contents: "export { SkillDiscovery } from './src/main/skill-discovery'; export { ResourceManager } from './src/main/resources'; export { SKILL_REPOSITORIES } from './src/shared/skill-catalog'", resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', packages: 'external', outfile: compiled })
const { SkillDiscovery, ResourceManager, SKILL_REPOSITORIES } = createRequire(import.meta.url)(compiled)
const resources = new ResourceManager(path.join(data, 'store'), path.join(data, 'home')), targets = resources.targets()
const revision = 'a'.repeat(40), requests = []
const skill = (name, description = `Description for ${name}`) => strToU8(`---\nname: ${name}\ndescription: ${description}\n---\nBody`)
let mode = 'ok'
const download = async (url, init) => {
  requests.push(url)
  assert.equal(init.redirect, 'error')
  if (mode === 'offline') return new Response('offline', { status: 503 })
  if (mode === 'cancel') return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
  if (url.includes('/commits/')) return Response.json({ sha: revision })
  if (url.includes('/git/trees/')) return Response.json({ tree: [{ path: 'skills/one/SKILL.md' }, { path: 'skills/nested/two/SKILL.md' }], truncated: false })
  assert.ok(url.endsWith(revision), 'Download must use the previewed immutable revision')
  const repo = SKILL_REPOSITORIES.find((item) => url.includes(item.repository)) || { root: 'skills' }
  const prefix = `repo-${revision}/${repo.root}`
  const files = {
    [`${prefix}/one/SKILL.md`]: skill('first-skill'),
    [`${prefix}/one/references/read.md`]: strToU8('supporting reference'),
    [`${prefix}/one/scripts/install.sh`]: strToU8('exit 99 # must never execute'),
    [`${prefix}/nested/two/SKILL.md`]: skill('second-skill', 'long upstream description '.repeat(50)),
    [`repo-${revision}/tests/fixture/SKILL.md`]: skill('excluded-fixture')
  }
  if (mode === 'traversal') files[`${prefix}/../../escape/SKILL.md`] = skill('escape')
  if (mode === 'expanded') files[`${prefix}/large.bin`] = new Uint8Array(33 * 1024 * 1024)
  if (mode === 'description') files[`${prefix}/one/SKILL.md`] = skill('first-skill', 'x'.repeat(8193))
  if (mode === 'oversize') return new Response('small', { headers: { 'content-length': String(33 * 1024 * 1024) } })
  return new Response(zipSync(files))
}
const discovery = new SkillDiscovery(path.join(data, 'cache'), resources, download)
try {
  for (const repo of SKILL_REPOSITORIES) {
    const snapshot = await discovery.scan(repo.id, randomUUID())
    assert.deepEqual(snapshot.items.map((item) => item.name).sort(), ['first-skill', 'second-skill'])
    assert.equal(snapshot.revision, revision)
    assert.equal(snapshot.items.find((item) => item.name === 'second-skill').description, 'long upstream description '.repeat(50).trim())
    await discovery.close(snapshot.id)
  }
  console.log('PASS all five curated roots exclude samples, discover nested Skills and pin immutable revisions')
  const snapshot = await discovery.scan('mattpocock', randomUUID())
  assert.ok(discovery.install(snapshot.id, targets, ['pi', 'codex'], ['first-skill']).every((item) => item.ok))
  for (const id of ['pi', 'codex']) {
    const root = targets.find((target) => target.id === id).skillPath
    assert.ok(fs.existsSync(path.join(root, 'first-skill/references/read.md')))
    assert.ok(!fs.existsSync(path.join(root, 'second-skill')))
  }
  const before = fs.readFileSync(path.join(targets.find((target) => target.id === 'pi').skillPath, 'first-skill/SKILL.md'))
  assert.ok(discovery.install(snapshot.id, targets, ['pi'], ['first-skill']).every((item) => !item.ok))
  assert.deepEqual(fs.readFileSync(path.join(targets.find((target) => target.id === 'pi').skillPath, 'first-skill/SKILL.md')), before)
  assert.ok(discovery.install(snapshot.id, targets, ['claude'], snapshot.items.map((item) => item.id)).every((item) => item.ok))
  assert.throws(() => discovery.install(snapshot.id, targets, ['claude'], ['not-in-preview']))
  await discovery.close(snapshot.id)
  assert.throws(() => discovery.install(snapshot.id, targets, ['claude'], ['first-skill']))
  for (const failure of ['offline', 'oversize', 'traversal', 'expanded', 'description']) {
    mode = failure
    await assert.rejects(discovery.scan('impeccable', randomUUID()), failure === 'offline' ? /HTTP 503/ : undefined)
    assert.deepEqual(fs.readdirSync(path.join(data, 'cache')), [], 'Failed scans must remove downloaded data')
  }
  mode = 'cancel'
  const id = randomUUID(), pending = discovery.scan('mattpocock', id)
  const cancelled = assert.rejects(pending, /取消/)
  await discovery.close(id)
  await cancelled
  await assert.rejects(discovery.scan('unknown', randomUUID()))
  mode = 'ok'
  const imported = await discovery.scan('https://github.com/example/engineering-skills', randomUUID())
  assert.equal(imported.items.length, 2)
  assert.ok(discovery.preview(imported.id, 'first-skill').content.includes('Body'))
  assert.throws(() => discovery.preview(imported.id, '../escape'))
  await discovery.close(imported.id)
  const remembered = new SkillDiscovery(path.join(data, 'cache'), resources, download)
  assert.ok((await remembered.repositories()).some((item) => item.repository === 'example/engineering-skills'))
  const directory = await discovery.scan('https://github.com/example/engineering-skills/tree/main/skills/one', randomUUID())
  assert.deepEqual(directory.items.map((item) => item.name), ['first-skill'])
  await discovery.close(directory.id)
  for (const invalid of ['http://github.com/a/b', 'https://example.com/a/b', 'https://github.com/a/b/blob/main/SKILL.md', 'https://user:secret@github.com/a/b']) await assert.rejects(discovery.scan(invalid, randomUUID()))
  console.log('PASS manual GitHub repository/directory import, persistent catalogue, complete Skill previews, branch pinning and rejection of unsupported URLs')
  console.log('PASS partial/all multi-Agent installation, supporting files, no overwrite/execution, invalid selections, download/extraction limits, traversal, cancellation and cleanup')
  const liveUrl = process.argv.find((arg) => arg.startsWith('--live-url='))?.slice(11)
  if (process.argv.includes('--live') || liveUrl) {
    const live = new SkillDiscovery(path.join(data, 'live'), resources)
    const only = process.argv.find((arg) => arg.startsWith('--repository='))?.split('=')[1]
    try { for (const repo of liveUrl ? [{ id: liveUrl }] : SKILL_REPOSITORIES.filter((item) => !only || item.id === only)) {
      const value = await live.scan(repo.id, randomUUID())
      if (liveUrl) {
        assert.ok(value.items.length > 0)
        assert.ok(live.preview(value.id, value.items[0].name).content.length > 20)
        assert.ok(live.install(value.id, targets, ['pi'], value.items.map((item) => item.name)).every((item) => item.ok))
      }
      console.log(`PASS live ${value.repository} ${value.revision}: ${value.items.length} Skills`); await live.close(value.id)
    } }
    finally { await live.dispose() }
  }
} finally { await discovery.dispose() }
