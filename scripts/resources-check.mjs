import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { buildSync } from 'esbuild'
import { parse as parseToml } from 'smol-toml'
import { zipSync, strToU8 } from 'fflate'
import { parse as parseJson } from 'jsonc-parser'

const root = process.cwd(), data = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-resources-'))
const home = path.join(data, 'home')
fs.mkdirSync(path.join(root, '.cache'), { recursive: true })
const compiled = path.join(root, '.cache/resources-check.cjs')
buildSync({ entryPoints: ['src/main/resources.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: compiled, packages: 'external' })
const { ResourceManager } = createRequire(import.meta.url)(compiled)
const manager = new ResourceManager(path.join(data, 'settings'), home)
const targets = manager.targets()
const ids = targets.map((item) => item.id)
const target = (id) => targets.find((item) => item.id === id)
fs.mkdirSync(path.dirname(target('codex').mcpPath), { recursive: true })
fs.writeFileSync(target('codex').mcpPath, '# preserve comment\nmodel = "user-model"\n[mcp_servers.existing]\nurl="https://example.invalid/mcp?token=hidden"\n')
fs.mkdirSync(path.dirname(target('opencode').mcpPath), { recursive: true })
fs.writeFileSync(target('opencode').mcpPath, '{\n// keep JSONC comment\n"theme":"user-theme",\n}')
const added = manager.addMcp(targets, 'fixture', { command: 'node', args: ['server.js', 'with space'], env: { TOKEN: '${ENV_TOKEN}' } }, ids)
assert.ok(added.every((item) => item.ok), JSON.stringify(added))
assert.equal(parseToml(fs.readFileSync(target('codex').mcpPath, 'utf8')).model, 'user-model')
assert.match(fs.readFileSync(target('codex').mcpPath, 'utf8'), /# preserve comment/)
assert.match(fs.readFileSync(target('opencode').mcpPath, 'utf8'), /keep JSONC comment/)
assert.equal(JSON.parse(fs.readFileSync(target('claude').mcpPath, 'utf8')).mcpServers.fixture.command, 'node')
assert.ok(fs.existsSync(target('codex').mcpPath + '.awb-backup'))
assert.ok(manager.addMcp(targets, 'fixture', { url: 'https://example.invalid/mcp' }, ids).every((item) => !item.ok))
assert.ok(manager.addMcp(targets, 'remote', { url: 'https://example.invalid/mcp', headers: { Authorization: 'Bearer secret' } }, ['codex', 'pi']).every((item) => item.ok))
assert.equal(manager.list(targets, 'mcp', 'claude', 1, 'remote').total, 0)
assert.ok(!JSON.stringify(manager.list(targets, 'mcp', 'codex')).includes('hidden'))
assert.ok(!JSON.stringify(manager.list(targets, 'mcp', 'pi')).includes('Bearer secret'))
assert.throws(() => manager.addMcp(targets, 'bad', { command: 'node', args: 'wrong' }, ids), /args/)
console.log('PASS native MCP adapters, selected distribution, preserved TOML/JSONC, backups, duplicates, HTTP and secret redaction')

const source = path.join(data, 'source')
fs.mkdirSync(path.join(source, 'references'), { recursive: true })
fs.writeFileSync(path.join(source, 'SKILL.md'), '---\nname: fixture-skill\ndescription: "Use this for fixture testing"\n---\n# Body\n')
fs.writeFileSync(path.join(source, 'references', 'guide.md'), 'support file')
assert.ok(manager.importSkills(targets, source, ['claude', 'codex']).every((item) => item.ok))
assert.ok(manager.importSkills(targets, source, ['omp']).every((item) => item.ok))
assert.equal(fs.readFileSync(path.join(target('claude').skillPath, 'fixture-skill/references/guide.md'), 'utf8'), 'support file')
assert.ok(manager.importSkills(targets, source, ['claude']).every((item) => !item.ok))
for (let i = 0; i < 14; i++) {
  const dir = path.join(target('pi').skillPath, `example-${i}`)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: example-${i}\ndescription: Page fixture ${i}\n---\nBody`)
}
assert.equal(manager.list(targets, 'skills', 'pi', 1).items.length, 12)
assert.ok(manager.list(targets, 'skills', 'pi', 2).items.length > 0)
assert.equal(manager.list(targets, 'skills', 'pi', 1, 'example-13').total, 1)
const archive = path.join(data, 'skills.zip')
fs.writeFileSync(archive, zipSync({ 'bundle/zip-skill/SKILL.md': strToU8('---\nname: zip-skill\ndescription: ZIP fixture\n---\nBody'), 'bundle/zip-skill/scripts/check.sh': strToU8('echo fixture') }))
assert.ok(manager.importSkills(targets, archive, ['pi']).every((item) => item.ok))
assert.equal(fs.readFileSync(path.join(target('pi').skillPath, 'zip-skill/scripts/check.sh'), 'utf8'), 'echo fixture')
fs.writeFileSync(archive, zipSync({ '../escape/SKILL.md': strToU8('bad') }))
assert.throws(() => manager.importSkills(targets, archive, ['pi']), /不安全路径/)
const invalid = path.join(data, 'invalid')
fs.mkdirSync(invalid); fs.writeFileSync(path.join(invalid, 'SKILL.md'), 'not a skill')
assert.throws(() => manager.importSkills(targets, invalid, ['pi']), /YAML/)
const custom = [{ id: 'custom', name: 'Custom CLI' }]
manager.saveTarget({ id: 'custom', name: 'Custom CLI', mcpPath: path.join(data, 'custom.json'), skillPath: path.join(data, 'custom-skills'), format: 'standard' }, custom)
assert.ok(manager.addMcp(manager.targets(custom), 'custom-mcp', { command: 'node' }, ['custom'])[0].ok)
console.log('PASS folder/ZIP Skill import, support files, paging/search, conflict preservation, path traversal rejection, validation and custom agent mapping')

for (const id of ids) {
  let item = manager.list(targets, 'mcp', id, 1, 'fixture').items[0]
  manager.toggle(targets, 'mcp', id, item, false)
  assert.equal(manager.list(targets, 'mcp', id, 1, 'fixture').items[0].enabled, false)
  manager.toggle(targets, 'mcp', id, item, true)
  item = manager.list(targets, 'mcp', id, 1, 'fixture').items[0]
  assert.equal(item.enabled, true)
  assert.ok(manager.detail(targets, 'mcp', id, item).content.includes('********'))
  const skill = manager.list(targets, 'skills', id, 1, 'fixture-skill').items[0]
  const before = fs.readFileSync(skill.path)
  manager.toggle(targets, 'skills', id, skill, false)
  assert.equal(manager.list(targets, 'skills', id, 1, 'fixture-skill').items[0].enabled, false)
  manager.toggle(targets, 'skills', id, skill, true)
  assert.equal(manager.list(targets, 'skills', id, 1, 'fixture-skill').items[0].enabled, true)
  assert.deepEqual(fs.readFileSync(skill.path), before)
}
assert.match(fs.readFileSync(target('codex').mcpPath, 'utf8'), /# preserve comment/)
const unknown = { name: 'fixture-skill', path: path.join(data, 'outside', 'SKILL.md') }
assert.throws(() => manager.toggle(targets, 'skills', 'claude', unknown, false), /不属于/)
console.log('PASS persisted MCP/Skill toggles for all agents, redacted details, comment preservation and rejected out-of-scope mutations')
const inlineTarget = { ...target('codex'), id: 'inline', mcpPath: path.join(data, 'inline.toml') }
fs.writeFileSync(inlineTarget.mcpPath, '# Keep root comment\nmcp_servers = { "a.b" = { command = "node", enabled = true } }\n')
const inlineItem = manager.list([inlineTarget], 'mcp', 'inline').items[0]
manager.toggle([inlineTarget], 'mcp', 'inline', inlineItem, false)
assert.equal(parseToml(fs.readFileSync(inlineTarget.mcpPath, 'utf8')).mcp_servers['a.b'].enabled, false)
assert.match(fs.readFileSync(inlineTarget.mcpPath, 'utf8'), /# Keep root comment/)
const customTargets = manager.targets(custom)
assert.ok(manager.importSkills(customTargets, source, ['custom'])[0].ok)
const portable = manager.list(customTargets, 'skills', 'custom').items[0]
manager.toggle(customTargets, 'skills', 'custom', portable, false)
assert.ok(fs.existsSync(portable.path + '.awb-disabled'))
assert.equal(manager.list(customTargets, 'skills', 'custom').items[0].enabled, false)
manager.toggle(customTargets, 'skills', 'custom', portable, true)
assert.ok(fs.existsSync(portable.path))
console.log('PASS inline/quoted TOML edits and reversible portable custom Skill switches')
manager.addMcp(targets, 'private-endpoint', { url: 'https://example.invalid/mcp?token=do-not-expose', headers: { Authorization: 'private-value' } }, ['claude'])
const privateItem = manager.list(targets, 'mcp', 'claude', 1, 'private-endpoint').items[0]
manager.toggle(targets, 'mcp', 'claude', privateItem, false)
assert.ok(!JSON.stringify(manager.list(targets, 'mcp', 'claude')).includes('do-not-expose'))
assert.ok(!JSON.stringify(manager.detail(targets, 'mcp', 'claude', privateItem)).includes('private-value'))
const missingConfig = { ...customTargets.find((item) => item.id === 'custom'), id: 'missing', mcpPath: '', skillAdapter: 'codex' }
const missingItem = manager.list([missingConfig], 'skills', 'missing').items[0]
assert.throws(() => manager.toggle([missingConfig], 'skills', 'missing', missingItem, false), /配置文件/)
console.log('PASS disabled MCP detail redaction and fail-closed custom native settings paths')
const conflictFile = target('claude').mcpPath
const conflictConfig = JSON.parse(fs.readFileSync(conflictFile, 'utf8'))
conflictConfig.mcpServers['private-endpoint'] = { command: 'another-server' }
fs.writeFileSync(conflictFile, JSON.stringify(conflictConfig))
assert.equal(manager.list(targets, 'mcp', 'claude', 1, 'private-endpoint').items.length, 1)
assert.throws(() => manager.toggle(targets, 'mcp', 'claude', privateItem, true), /同名/)
assert.throws(() => manager.toggle(targets, 'mcp', 'claude', privateItem, false), /同名/)
assert.equal(JSON.parse(fs.readFileSync(conflictFile, 'utf8')).mcpServers['private-endpoint'].command, 'another-server')
console.log('PASS externally recreated MCP conflicts preserve both active and parked configurations')

const v2 = { ...target('opencode'), mcpPath: path.join(data, 'opencode-v2.jsonc') }
fs.writeFileSync(v2.mcpPath, '{\n// Keep native V2 config comment\n"providers": {"example":{"settings":{"apiKey":"keep-provider-secret"}}},\n"permissions": [\n// Keep unrelated permission comment\n{"action":"read","resource":"*","effect":"allow"}],\n"mcp":{"servers":{"native-existing":{"type":"remote","url":"https://example.invalid/mcp","disabled":true,"headers":{"Authorization":"hide-native-token"}}}}\n}')
assert.deepEqual(manager.list([v2], 'mcp', 'opencode').items.map(item => item.name), ['native-existing'], 'OpenCode V2 must list actual servers, not its servers container')
const nativeItem = manager.list([v2], 'mcp', 'opencode').items[0]
assert.equal(nativeItem.enabled, false)
manager.toggle([v2], 'mcp', 'opencode', nativeItem, true)
assert.equal(parseJson(fs.readFileSync(v2.mcpPath, 'utf8')).mcp.servers['native-existing'].disabled, false)
assert.ok(!manager.detail([v2], 'mcp', 'opencode', nativeItem).content.includes('hide-native-token'))
assert.ok(manager.addMcp([v2], 'native-added', { command: 'node', args: ['server.js'] }, ['opencode'])[0].ok)
assert.equal(parseJson(fs.readFileSync(v2.mcpPath, 'utf8')).mcp.servers['native-added'].disabled, false)
assert.equal(manager.addMcp([v2], 'native-added', { command: 'other' }, ['opencode'])[0].ok, false)
const nativeSkill = manager.list([v2], 'skills', 'opencode', 1, 'fixture-skill').items[0]
manager.toggle([v2], 'skills', 'opencode', nativeSkill, false)
assert.equal(manager.list([v2], 'skills', 'opencode', 1, 'fixture-skill').items[0].enabled, false)
assert.deepEqual(parseJson(fs.readFileSync(v2.mcpPath, 'utf8')).permissions.at(-1), { action: 'skill', resource: 'fixture-skill', effect: 'deny' })
manager.toggle([v2], 'skills', 'opencode', nativeSkill, true)
const nativeText = fs.readFileSync(v2.mcpPath, 'utf8'), nativeConfig = parseJson(nativeText)
assert.equal(nativeConfig.permissions.at(-1).effect, 'allow')
assert.equal(nativeConfig.permissions.length, 2)
assert.match(nativeText, /Keep native V2 config comment/)
assert.match(nativeText, /Keep unrelated permission comment/)
assert.equal(nativeConfig.providers.example.settings.apiKey, 'keep-provider-secret')
console.log('PASS native OpenCode V2 MCP discovery, disabled switches, Skill permissions, secret redaction and comment preservation')
const customOmp = { id: 'custom-omp', name: 'Custom OMP', cmd: 'omp', args: '', shell: 'pwsh', letter: 'O', color: '#95cfaa', env: [], resources: { skillPath: path.join(data, 'custom-omp/skills'), mcpPath: path.join(data, 'custom-omp/mcp.json'), format: 'standard', skillAdapter: 'omp' } }
const ompTargets = manager.targets([customOmp])
assert.ok(manager.importSkills(ompTargets, source, ['custom-omp'])[0].ok)
const ompSkill = manager.list(ompTargets, 'skills', 'custom-omp').items[0]
manager.toggle(ompTargets, 'skills', 'custom-omp', ompSkill, false)
assert.ok(fs.existsSync(path.join(data, 'custom-omp/config.yml')), 'Custom OMP adapters default to native config.yml')
assert.equal(manager.list(ompTargets, 'skills', 'custom-omp').items[0].enabled, false)
assert.equal(manager.skillDirectory(ompTargets, 'custom-omp', ompSkill, true), path.dirname(ompSkill.path))
assert.equal(manager.skillDirectory(customTargets, 'custom', portable, true), path.dirname(portable.path))
assert.throws(() => manager.skillDirectory(targets, 'claude', { name: 'fixture-skill', path: path.join(data, 'outside/SKILL.md') }, true), /资源已改变/)
const outside = path.join(data, 'outside-linked-skill')
fs.mkdirSync(outside)
fs.writeFileSync(path.join(outside, 'SKILL.md'), '---\nname: linked-skill\ndescription: External skill fixture\n---\nBody')
const link = path.join(target('claude').skillPath, 'linked')
fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
const linkedSkill = manager.list(targets, 'skills', 'claude', 1, 'linked-skill').items[0]
assert.equal(manager.skillDirectory(targets, 'claude', linkedSkill), link, 'Discovered links can be opened in the file manager')
assert.throws(() => manager.skillDirectory(targets, 'claude', linkedSkill, true), /资源范围|符号链接/)
assert.ok(fs.existsSync(path.join(outside, 'SKILL.md')))
fs.writeFileSync(path.join(target('claude').skillPath, 'SKILL.md'), '---\nname: root-skill\ndescription: Discovery root fixture\n---\nBody')
const rootSkill = manager.list(targets, 'skills', 'claude', 1, 'root-skill').items[0]
assert.throws(() => manager.skillDirectory(targets, 'claude', rootSkill, true), /资源范围|整个 Skill/)
console.log('PASS Skill folder actions accept listed native/portable directories and reject forged paths, external linked deletion and discovery-root deletion')
