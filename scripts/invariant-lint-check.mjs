import assert from 'node:assert/strict'
import { checkInvariants, projectFiles } from './invariant-lint.mjs'

const files = projectFiles()
const cases = [
  ['AWB001', 'src/renderer/TerminalPane.tsx', '.onBinary(', '.onMissingBinary('],
  ['AWB002', 'src/renderer/TerminalPane.tsx', 'lineHeight: 1,', 'lineHeight: 1.45,'],
  ['AWB003', 'src/renderer/Workspace.tsx', 'const terms = tabs.filter', 'const terms = mine.filter'],
  ['AWB004', 'src/renderer/Workspace.tsx', '<main className="center" id="center">', '<main className="center" id="center"><kbd>Ctrl T</kbd>'],
  ['AWB005', 'src/renderer/MarkdownEditor.tsx', "import { useEffect", "import fs from 'node:fs'\nimport { useEffect"],
  ['AWB006', 'src/main/pty.ts', 'await session.dispose()', 'void session.dispose()'],
  ['AWB007', 'src/main/pty.ts', "Buffer.from(data, 'latin1')", "Buffer.from(data, 'utf8')"],
  ['AWB008', 'src/main/index.ts', 'const closing = win', 'const closing = win; closing?.destroy()'],
  ['AWB009', 'src/main/index.ts', 'return publicHost(host)', 'return host'],
  ['AWB010', 'src/shared/types.ts', "{ id: 'pi',", "{ id: 'gemini',"],
  ['AWB011', 'src/main/git.ts', "fileTree(target: Target, rel = ''): Promise<TreeNode[]> {", "fileTree(target: Target, rel = '', depth = 0): Promise<TreeNode[]> { if (depth > 5) return []"],
  ['AWB012', 'src/main/git.ts', 'versionOf(current) !== version', 'false'],
  ['AWB013', 'src/renderer/RightPanel.tsx', 'onPointerMove=', 'onMouseMove='],
  ['AWB014', 'src/renderer/App.tsx', '{ ...latest, ...saved, draft,', '{ ...saved, draft,'],
  ['AWB015', 'src/renderer/styles/extra.css', '.termhost {', '.termhost { padding: 12px;'],
  ['AWB016', 'src/renderer/styles/workbench.css', 'flex:0 1 auto', 'flex:1 1 auto'],
  ['AWB017', 'src/renderer/styles/workbench.css', '.dot.terminal-status.busy{background:var(--amber)}', '.dot.terminal-status.busy{background:var(--green)}'],
  ['AWB018', 'package.json', 'node scripts/workspace-check.mjs', 'echo skipped'],
  ['AWB019', 'AGENTS.md', 'npm run check', 'npx skipped'],
  ['AWB020', 'src/main/ssh.ts', 'hostVerifier:', 'missingVerifier:'],
  ['AWB021', 'src/main/preview.ts', "server.listen(0, '127.0.0.1'", "server.listen(0, '0.0.0.0'"],
  ['AWB022', 'src/renderer/App.tsx', 'savingDocuments.current.has(key)', "savingDocuments.current.has('unrelated')"],
  ['AWB023', 'src/renderer/MarkdownEditor.tsx', '!interacted.current', 'false'],
  ['AWB024', 'src/main/preview.ts', '!/\\.html?$/i.test(rel)', '!/./.test(rel)'],
  ['AWB025', 'src/renderer/documents.ts', '120_000', '800'],
  ['AWB026', 'src/renderer/FilePane.tsx', 'sandbox="allow-scripts"', 'sandbox="allow-scripts allow-same-origin"'],
  ['AWB027', 'src/renderer/ResourceSettings.tsx', '<b className="resource-name">{item.name}</b>', '<b className="resource-name">{item.name}</b><small>{item.path}</small>'],
  ['AWB028', 'src/renderer/ResourceDialog.tsx', 'dialog.showModal()', 'dialog.show()'],
  ['AWB029', 'src/renderer/TerminalPane.tsx', 'document.fonts.load(font)', 'Promise.resolve([])'],
  ['AWB030', 'src/renderer/FilePane.tsx', 'key={preview.url}', 'key={path}']
]
for (const [id, file, before, after] of cases) {
  const mutated = new Map(files)
  assert.ok(files.get(file)?.includes(before), `${id}: mutation is stale`)
  let text = files.get(file).replaceAll(before, after)
  if (id === 'AWB012') text = text.replaceAll('versionOf(fs.readFileSync(abs)) !== version', 'false')
  mutated.set(file, text)
  const errors = checkInvariants(mutated)
  assert.ok(errors.some((error) => error.id === id), `${id}: lint did not catch its regression`)
}
console.log(`Invariant lint negative cases passed (${cases.length})`)
