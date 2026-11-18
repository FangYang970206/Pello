import { useMemo } from 'react'
import type { GitFile } from '../shared/types'
import { Icon } from './icons'
import { VirtualFileRows } from './VirtualFileRows'
import { changeTree, type ChangeRow } from './git-change-tree'

export function GitChangeRows({ files, repository = '', tree, collapsed, onToggle, activePath, onOpen }: {
  files: GitFile[]; repository?: string; tree: boolean; collapsed: ReadonlySet<string>
  onToggle: (path: string) => void; activePath?: string; onOpen: (path: string) => void
}) {
  const rows = useMemo(() => tree ? changeTree(files, repository, collapsed) : files.map((file): ChangeRow => ({ path: file.path, name: file.path.split('/').pop() || file.path, depth: 0, file })), [files, repository, tree, collapsed])
  return <div className={`git-change-rows ${tree ? 'tree' : 'flat'}`}><VirtualFileRows items={rows} render={(row) => {
    const file = row.file
    const open = !collapsed.has(row.path)
    if (!file) return <button key={row.path} className="row git-directory" style={{ paddingLeft: 8 + row.depth * 14, minWidth: 80 + row.depth * 14 }} data-a="git-dir" data-id={row.path} title={row.path} aria-expanded={open} onClick={() => onToggle(row.path)} onKeyDown={(event) => {
      if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) return
      if ((event.key === 'ArrowLeft' && open) || (event.key === 'ArrowRight' && !open)) { event.preventDefault(); onToggle(row.path) }
    }}><Icon name="chev" className={`s chev${open ? ' open' : ''}`} /><Icon name={open ? 'folder-open' : 'folder'} className="s" /><span className="nm">{row.name}</span></button>
    const relative = repository ? file.path.slice(repository.length + 1) : file.path
    return <button key={row.path} className={`row ${activePath === file.path ? 'on' : ''}`} style={tree ? { paddingLeft: 28 + row.depth * 14, minWidth: 144 + row.depth * 14 } : undefined} data-a="diff" data-id={file.path} title={file.path} onClick={() => onOpen(file.path)}>
      <span className={`st ${file.st}`}>{file.st}</span><span className={`nm${tree ? ' grow' : ''}`}>{row.name}</span>
      {!tree ? <span className="dir grow">{relative.split('/').slice(0, -1).join('/')}</span> : null}
      <span className="num"><span className="a">+{file.add}</span>{file.del ? <span className="d">−{file.del}</span> : null}</span>
    </button>
  }} /></div>
}
