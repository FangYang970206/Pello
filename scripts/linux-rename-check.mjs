import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import ts from 'typescript'

const sourceModule = ts.transpileModule(fs.readFileSync(new URL('../src/main/linux-rename.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
}).outputText
const { LINUX_RENAME_SCRIPT } = await import(`data:text/javascript;base64,${Buffer.from(sourceModule).toString('base64')}`)

const harness = `import os, pathlib, subprocess, sys, tempfile
script = sys.argv[1]
with tempfile.TemporaryDirectory(prefix='awb-linux-rename-') as tmp:
    root = pathlib.Path(tmp) / "project 中文's"
    root.mkdir()
    (root / 'old name.txt').write_text('source')
    (root / 'occupied.txt').write_text('destination')
    def run(old, new, directory='0', parent=''):
        return subprocess.run([sys.executable, '-c', script, str(root), old, new, directory, parent], capture_output=True)
    assert run('old name.txt', 'occupied.txt').returncode != 0
    assert (root / 'old name.txt').read_text() == 'source'
    assert (root / 'occupied.txt').read_text() == 'destination'
    assert run('old name.txt', "新 名's.txt").returncode == 0
    assert (root / "新 名's.txt").read_text() == 'source'
    (root / 'folder').mkdir()
    (root / 'folder' / 'nested.txt').write_text('nested')
    assert run('folder', 'renamed', '1').returncode == 0
    assert (root / 'renamed' / 'nested.txt').read_text() == 'nested'
    (root / 'destination').mkdir()
    assert run('renamed', 'renamed', '1', 'destination').returncode == 0
    assert (root / 'destination' / 'renamed' / 'nested.txt').read_text() == 'nested'
    outside = pathlib.Path(tmp) / 'outside'
    outside.mkdir()
    (outside / 'untouched').write_text('safe')
    (root / 'link').symlink_to(outside, target_is_directory=True)
    assert run('link/untouched', 'bad').returncode != 0
    assert run('../outside/untouched', 'bad').returncode != 0
    assert run('link', 'bad', '1').returncode != 0
    assert (outside / 'untouched').read_text() == 'safe'
print('PASS Linux atomic no-replace rename: files, directories, Unicode, collision and symlink boundaries')
`

const runner = process.platform === 'win32' ? 'wsl.exe' : 'python3'
const args = process.platform === 'win32' ? ['-d', 'Ubuntu', '--', 'python3', '-c', harness, LINUX_RENAME_SCRIPT] : ['-c', harness, LINUX_RENAME_SCRIPT]
const output = execFileSync(runner, args, { encoding: 'utf8', timeout: 30000 })
assert.match(output, /PASS Linux atomic/)
console.log(output.trim())
