import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

type Editor = { id: string; name: string; file: string; args: string[] }

const textExtensions = new Set('txt md mdx markdown json jsonc jsonl yaml yml toml ini conf config xml html htm css scss less js jsx mjs cjs ts tsx vue svelte py pyi rb php go rs c h cpp hpp cs java kt swift sh bash zsh ps1 bat cmd sql graphql proto csv tsv log env gitignore gitattributes dockerfile'.split(' '))

/** Discover executable files directly; never launch a shell or a PATH-provided batch wrapper. */
export function installedEditors(filename: string, platform = process.platform, environment = process.env): Editor[] {
  const extension = path.extname(filename).slice(1).toLowerCase()
  if (extension && !textExtensions.has(extension)) return []
  const specifications = [
    { id: 'vscode', name: 'Visual Studio Code', exe: 'Code.exe', linux: 'code', folders: ['Microsoft VS Code'], args: ['--new-window'] },
    { id: 'cursor', name: 'Cursor', exe: 'Cursor.exe', linux: 'cursor', folders: ['cursor', 'Cursor'], args: ['--new-window'] },
    { id: 'windsurf', name: 'Windsurf', exe: 'Windsurf.exe', linux: 'windsurf', folders: ['Windsurf'], args: ['--new-window'] },
    { id: 'sublime', name: 'Sublime Text', exe: 'sublime_text.exe', linux: 'subl', folders: ['Sublime Text', 'Sublime Text 3'], args: [] },
    { id: 'notepad-plus', name: 'Notepad++', exe: 'notepad++.exe', linux: '', folders: ['Notepad++'], args: [] }
  ]
  const roots = platform === 'win32' ? [environment.LOCALAPPDATA && path.join(environment.LOCALAPPDATA, 'Programs'), environment.ProgramFiles, environment['ProgramFiles(x86)']].filter((root): root is string => !!root) : []
  return specifications.flatMap((specification) => {
    const candidates = platform === 'win32'
      ? [...roots.flatMap((root) => specification.folders.map((folder) => path.join(root, folder, specification.exe))), ...(environment.PATH || '').split(';').filter(Boolean).map((root) => path.join(root, specification.exe))]
      : specification.linux ? (environment.PATH || '').split(':').filter(Boolean).map((root) => path.join(root, specification.linux)) : []
    const file = candidates.find((candidate) => {
      try { fs.accessSync(candidate, fs.constants.X_OK); return fs.statSync(candidate).isFile() } catch { return false }
    })
    return file ? [{ id: specification.id, name: specification.name, file: fs.realpathSync(file), args: specification.args }] : []
  })
}

export async function launchEditor(editor: Editor, file: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(editor.file, [...editor.args, file], { detached: true, stdio: 'ignore', windowsHide: true, shell: false })
    child.once('error', reject)
    child.once('spawn', () => { child.unref(); resolve() })
  })
}
