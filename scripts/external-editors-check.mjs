import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ts from 'typescript'

const sourceModule = ts.transpileModule(fs.readFileSync(new URL('../src/main/external-editors.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
}).outputText
const { installedEditors, launchEditor } = await import(`data:text/javascript;base64,${Buffer.from(sourceModule).toString('base64')}`)

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-external-editors-'))
try {
  const folder = path.join(root, 'Programs', 'Microsoft VS Code')
  fs.mkdirSync(folder, { recursive: true })
  const executable = path.join(folder, 'Code.exe')
  fs.copyFileSync(process.execPath, executable)
  const environment = { LOCALAPPDATA: root, PATH: '' }
  assert.equal(installedEditors('中文.ts', 'win32', environment)[0]?.id, 'vscode')
  assert.equal(installedEditors('README', 'win32', environment)[0]?.id, 'vscode')
  assert.deepEqual(installedEditors('image.png', 'win32', environment), [])
  assert.deepEqual(installedEditors('archive.zip', 'win32', environment), [])
  fs.unlinkSync(executable)
  assert.deepEqual(installedEditors('source.ts', 'win32', environment), [])
  fs.writeFileSync(path.join(folder, 'Code.cmd'), '@echo unsafe wrapper')
  assert.deepEqual(installedEditors('source.ts', 'win32', environment), [])
  const output = path.join(root, 'arguments.json')
  const file = path.join(root, "中文 space's $(ignored) & example.ts")
  await launchEditor({ id: 'fixture', name: 'Fixture', file: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(output)},JSON.stringify(process.argv.slice(1)))`, '--'] }, file)
  const deadline = Date.now() + 10000
  while (!fs.existsSync(output) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
  assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), [file])
  await assert.rejects(launchEditor({ id: 'missing', name: 'Missing', file: path.join(root, 'missing.exe'), args: [] }, file))
  console.log('PASS editor discovery filters file types, rechecks executables and launches exact Unicode paths without a shell')
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
