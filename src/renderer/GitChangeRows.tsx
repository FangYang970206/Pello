import { useMemo } from 'react'
import { t } from '../shared/i18n'
import type { GitFile } from '../shared/types'
import { Icon } from './icons'
import { FileIcon } from './FileIcon'
import { VirtualFileRows } from './VirtualFileRows'
import { changeTree, type ChangeRow } from './git-change-tree'

export function GitChangeRows({ files, repository = '', tree, collapsed, onToggle, activePath, onOpen, menuPath, onMenu }: {
  files: GitFile[]; repository?: string; tree: boolean; collapsed: ReadonlySet<string>
  onToggle: (path: string) => void; activePath?: string; onOpen: (path: string) => void
  menuPath?: string
  onMenu: (row: ChangeRow, repository: string, trigger: HTMLButtonElement) => void
}) {
  const rows = useMemo(() => tree ? changeTree(files, repository, collapsed) : files.map((file): ChangeRow => ({ path: file.path, name: file.path.split('/').pop() || file.path, depth: 0, file })), [files, repository, tree, collapsed])
  return <div className={`git-change-rows ${tree ? 'tree' : 'flat'}`}><VirtualFileRows items={rows} render={(row) => {
    const file = row.file
    const open = !collapsed.has(row.path)
    const expanded = menuPath === row.path
    const minWidth = tree ? (file ? 166 : 102) + row.depth * 14 : undefined
    const relative = repository ? row.path.slice(repository.length + 1) : row.path
    return <div key={row.path} className={`git-change-item${activePath === file?.path && file ? ' on' : ''}`} style={{ minWidth }}>
      {file ? <button type="button" className="row" style={tree ? { paddingLeft: 28 + row.depth * 14 } : undefined} data-a="diff" data-id={file.path} title={file.path} onClick={() => onOpen(file.path)}>
        <span className={`st ${file.st}`}>{file.st}</span><FileIcon path={file.path} /><span className={`nm${tree ? ' grow' : ''}`}>{row.name}</span>
        {!tree ? <span className="dir grow">{relative.split('/').slice(0, -1).join('/')}</span> : null}
        <span className="num"><span className="a">+{file.add}</span>{file.del ? <span className="d">−{file.del}</span> : null}</span>
      </button> : <button type="button" className="row git-directory" style={{ paddingLeft: 8 + row.depth * 14 }} data-a="git-dir" data-id={row.path} title={row.path} aria-expanded={open} onClick={() => onToggle(row.path)} onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) return
        if ((event.key === 'ArrowLeft' && open) || (event.key === 'ArrowRight' && !open)) { event.preventDefault(); onToggle(row.path) }
      }}><Icon name="chev" className={`s chev${open ? ' open' : ''}`} /><Icon name={open ? 'folder-open' : 'folder'} className="s" /><span className="nm">{row.name}</span></button>}
      <button type="button" className="ib git-row-more" data-a="git-row-more" data-id={row.path} data-row-action aria-haspopup="menu" aria-expanded={expanded}
        aria-label={t("{{0}} 的更多操作", row.name)} title={t("{{0}} 的更多操作", row.name)} onClick={(event) => onMenu(row, repository, event.currentTarget)}><Icon name="more" className="s" /></button>
    </div>
  }} /></div>
}
