import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import ts from 'typescript'
import { parse as parseToml } from 'smol-toml'
import { zipSync, strToU8 } from 'fflate'

const root = process.cwd(), data = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-resources-'))
const home = path.join(data, 'home')
fs.mkdirSync(path.join(root, '.cache'), { recursive: true })
const compiled = path.join(root, '.cache/resources-check.cjs')
fs.writeFileSync(compiled, ts.transpileModule(fs.readFileSync('src/main/resources.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText)
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
