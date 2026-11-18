import type { GitFile } from '../shared/types'

export type ChangeRow = { path: string; name: string; depth: number; file?: GitFile }
type Directory = { path: string; name: string; directories: Map<string, Directory>; files: GitFile[] }

/** Paths stay project-relative for Git operations, including nested repositories. */
export function changeTree(files: GitFile[], repository: string, collapsed: ReadonlySet<string>): ChangeRow[] {
  const root: Directory = { path: repository, name: '', directories: new Map(), files: [] }
  for (const file of files) {
    const relative = repository ? file.path.slice(repository.length + 1) : file.path
    const parts = relative.split('/')
    parts.pop()
    let parent = root
    for (const name of parts) {
      let directory = parent.directories.get(name)
      if (!directory) {
        directory = { path: `${parent.path ? parent.path + '/' : ''}${name}`, name, directories: new Map(), files: [] }
        parent.directories.set(name, directory)
      }
      parent = directory
    }
    parent.files.push(file)
  }
  const rows: ChangeRow[] = []
  function visit(directory: Directory, depth: number) {
    for (const child of [...directory.directories.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      // Trailing slash keeps directory keys distinct from a deleted file of the same name.
      rows.push({ path: child.path + '/', name: child.name, depth })
      if (!collapsed.has(child.path + '/')) visit(child, depth + 1)
    }
    for (const file of directory.files.sort((a, b) => a.path.localeCompare(b.path))) {
      rows.push({ path: file.path, name: file.path.split('/').pop() || file.path, depth, file })
    }
  }
  visit(root, 0)
  return rows
}
