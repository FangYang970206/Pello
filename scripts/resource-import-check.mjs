import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { buildSync } from 'esbuild'
import { zipSync, strToU8 } from 'fflate'

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-resource-import-'))
const compiled = path.resolve('.cache/goal-upgrade/resource-import-check.cjs')
buildSync({ entryPoints: ['src/main/resources.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: compiled, packages: 'external' })
const { ResourceManager } = createRequire(import.meta.url)(compiled)
const manager = new ResourceManager(path.join(data, 'store'), path.join(data, 'home'))
const targets = manager.targets()
const source = path.join(data, 'skills')
const skill = (name) => `---\nname: ${name}\ndescription: ${name} fixture\n---\nBody\n`
fs.mkdirSync(path.join(source, 'group/deep/child/references'), { recursive: true })
fs.writeFileSync(path.join(source, 'SKILL.md'), skill('outer-skill'))
fs.writeFileSync(path.join(source, 'group/deep/child/SKILL.md'), skill('child-skill'))
fs.writeFileSync(path.join(source, 'group/deep/child/references/test.md'), 'reference')
assert.ok(manager.importSkills(targets, source, ['pi']).every((result) => result.ok))
assert.deepEqual(manager.list(targets, 'skills', 'pi').items.map((item) => item.name).sort(), ['child-skill', 'outer-skill'], 'Every nested SKILL.md must be discovered, even below another skill')
const archive = path.join(data, 'skills.zip')
fs.writeFileSync(archive, zipSync({ 'bundle/SKILL.md': strToU8(skill('zip-outer')), 'bundle/children/deep/SKILL.md': strToU8(skill('zip-inner')) }))
assert.ok(manager.importSkills(targets, archive, ['codex']).every((result) => result.ok))
assert.deepEqual(manager.list(targets, 'skills', 'codex').items.map((item) => item.name).sort(), ['zip-inner', 'zip-outer'])
console.log('PASS folder and ZIP import discover all nested Skill roots')
const fixtures = [
  ['claude.jsonc', '{// keep\n"mcpServers":{"standard":{"command":"node","args":["server.js"],"env":{"TOKEN":"private-fixture"}}}}'],
  ['vscode.json', '{"servers":{"vscode":{"type":"http","url":"https://example.invalid/mcp","headers":{"Authorization":"private-fixture"}}}}'],
  ['opencode.json', '{"mcp":{"servers":{"native":{"type":"local","command":["node","server.js"],"environment":{"TOKEN":"private-fixture"},"disabled":true}}}}'],
  ['codex.toml', '[mcp_servers.codex]\ncommand="node"\nargs=["server.js"]\nenabled=false\n'],
  ['servers.yml', 'mcpServers:\n  yaml-server:\n    command: node\n    args: [server.js]\n']
]
for (const [name, body] of fixtures) {
  const file = path.join(data, name)
  fs.writeFileSync(file, body)
  const preview = manager.scanMcp(file)
  assert.equal(preview.length, 1)
  assert.ok(!JSON.stringify(preview).includes('private-fixture'), 'Import preview must not expose credentials')
  const results = manager.importMcpConfig(targets, file, ['pi'], preview.map((item) => item.id))
  assert.ok(results.every((item) => item.ok), JSON.stringify(results))
}
assert.equal(manager.list(targets, 'mcp', 'pi', 1, 'native').items[0].enabled, false)
assert.equal(manager.list(targets, 'mcp', 'pi', 1, 'codex').items[0].enabled, false)
console.log('PASS native MCP configuration extraction across JSON, JSONC, TOML and YAML with redacted preview and disabled-state preservation')
const disabledSource = path.join(data, 'opencode.json'), disabledPreview = manager.scanMcp(disabledSource)
assert.ok(manager.importMcpConfig(targets, disabledSource, ['claude', 'codex', 'opencode'], disabledPreview.map((item) => item.id)).every((item) => item.ok))
for (const agent of ['claude', 'codex', 'opencode']) assert.equal(manager.list(targets, 'mcp', agent, 1, 'native').items[0].enabled, false)
const before = fs.readFileSync(targets.find((target) => target.id === 'pi').mcpPath)
assert.ok(manager.importMcpConfig(targets, disabledSource, ['pi'], disabledPreview.map((item) => item.id)).every((item) => !item.ok))
assert.deepEqual(fs.readFileSync(targets.find((target) => target.id === 'pi').mcpPath), before)
const invalidMcp = path.join(data, 'invalid-mcp.json')
fs.writeFileSync(invalidMcp, '{"mcp":{"servers":{"bad-args":{"type":"local","command":["node"],"args":"not-an-array"},"bad-enabled":{"command":"node","enabled":"false"}}}}')
assert.ok(manager.scanMcp(invalidMcp).every((item) => item.error))
