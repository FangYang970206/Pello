import type { GitFile, GitPanel, Host, Project, TransferSnapshot, TreeNode } from '../shared/types'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Icon } from './icons'
import type { TermTab } from './Workspace'
import { FileOperationDialog } from './FileOperationDialog'
import { UploadStatus } from './UploadStatus'

function MoveEntryDialog({ projectId, path, directory, onCancel, onMove }: { projectId: string; path: string; directory: boolean; onCancel: () => void; onMove: (parent: string) => Promise<void> }) {
  const [parent, setParent] = useState('')
  const [nodes, setNodes] = useState<TreeNode[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let current = true
    setLoading(true); setError('')
    void window.awb.gitTree(projectId, parent).then((items) => { if (current) setNodes(items.filter((item) => item.dir)) }).catch((reason: unknown) => { if (current) setError(reason instanceof Error ? reason.message : '无法读取目录') }).finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [projectId, parent])
  const oldParent = path.split('/').slice(0, -1).join('/')
  return <FileOperationDialog title="移动到" busy={busy} onClose={onCancel} onSubmit={(event) => { event.preventDefault(); if (busy || loading || !!error || parent === oldParent) return; setBusy(true); void onMove(parent).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : '移动失败')).finally(() => setBusy(false)) }}
    footer={<><button type="button" className="btn" disabled={busy} onClick={onCancel}>取消</button><button className="btn pri" disabled={busy || loading || !!error || parent === oldParent}>{busy ? '正在移动…' : '移动到此处'}</button></>}>
      <p>对象：{path}</p><p>目标：{parent || '项目根目录'}</p>
      <button type="button" className="btn sm" disabled={!parent || busy} onClick={() => setParent(parent.split('/').slice(0, -1).join('/'))}>上一级</button>
      <div className="move-directories" aria-label="目标文件夹">{loading ? <p role="status">正在读取…</p> : nodes.map((node) => <button type="button" className="row" key={node.path} disabled={busy || (directory && (node.path === path || node.path.startsWith(`${path}/`)))} onClick={() => setParent(node.path)}><Icon name="folder" className="s" />{node.name}</button>)}</div>
      {error ? <p role="alert" className="bad">{error}</p> : null}
  </FileOperationDialog>
}

function RenameRow({ path, directory, padding, onCancel, onSubmit }: { path: string; directory: boolean; padding: number; onCancel: () => void; onSubmit: (name: string) => Promise<void> }) {
  const [name, setName] = useState(path.split('/').pop() || '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  return <form className="tree-rename" style={{ paddingLeft: padding }} onSubmit={(event) => {
    event.preventDefault()
    if (busy || !name) return
    setBusy(true); setError('')
    void onSubmit(name).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : '重命名失败')).finally(() => setBusy(false))
  }}>
    <Icon name={directory ? 'folder' : 'file'} className="s" />
    <input className="tx" aria-label="文件新名称" autoFocus value={name} disabled={busy} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape' && !busy) { event.preventDefault(); event.stopPropagation(); onCancel() } }} />
    {error ? <small role="alert" className="bad">{error}</small> : null}
  </form>
}

function ReferenceDialog({ projectId, path, terms, onCancel, onConfirm }: { projectId: string; path: string; terms: TermTab[]; onCancel: () => void; onConfirm: (id: string, text: string) => void }) {
  const [id, setId] = useState(terms[0]?.id || '')
  const [result, setResult] = useState<{ id: string; text: string } | null>(null)
  const [error, setError] = useState('')
  const term = terms.find((item) => item.id === id)
  const preview = result?.id === id ? result.text : ''
  useEffect(() => {
    let current = true
    setResult(null); setError('')
    if (term) void window.awb.treeReference(projectId, path, term.kind, term.shell).then((value) => { if (current) setResult({ id: term.id, text: value }) }).catch((reason: unknown) => { if (current) setError(reason instanceof Error ? reason.message : '无法引用此文件') })
    return () => { current = false }
  }, [projectId, path, term?.id, term?.kind, term?.shell])
  return <FileOperationDialog title="引用到当前终端" onClose={onCancel} onSubmit={(event) => { event.preventDefault(); if (term && preview) onConfirm(term.id, preview) }}
    footer={<><button type="button" className="btn" onClick={onCancel}>取消</button><button className="btn pri" disabled={!term || !preview}>粘贴引用</button></>}>
      <label className="fld"><span>目标终端</span><select className="sel" value={id} onChange={(event) => setId(event.target.value)}>{terms.map((item) => <option key={item.id} value={item.id}>{item.name || `${item.kind} · ${item.id}`}</option>)}</select></label>
      {!terms.length ? <p role="alert">此项目没有可用终端</p> : null}
      <p>将粘贴以下路径，不会自动回车：</p><pre className="mono">{preview || (term && !error ? '正在解析…' : '')}</pre>
      {error ? <p role="alert" className="bad">{error}</p> : null}
  </FileOperationDialog>
}

function CreateEntryDialog({ parent, directory, windows, existing, onCancel, onCreate }: { parent: string; directory: boolean; windows: boolean; existing: string[]; onCancel: () => void; onCreate: (name: string) => Promise<void> }) {
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const invalid = !name || name === '.' || name === '..' || /[\\/\0]/.test(name) || (windows && (/[<>:"|?*]/.test(name) || [...name].some((char) => char.charCodeAt(0) < 32) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)))
  const duplicate = existing.some((item) => windows ? item.toLocaleLowerCase() === name.toLocaleLowerCase() : item === name)
  return <FileOperationDialog title={directory ? '新建文件夹' : '新建文件'} busy={busy} onClose={onCancel} onSubmit={(event) => { event.preventDefault(); if (invalid || duplicate || busy) return; setBusy(true); setError(''); void onCreate(name).catch((err: unknown) => setError(err instanceof Error ? err.message : '创建失败')).finally(() => setBusy(false)) }}
    footer={<><button type="button" className="btn" disabled={busy} onClick={onCancel}>取消</button><button className="btn pri" disabled={busy || invalid || duplicate}>{busy ? '正在创建…' : '创建'}</button></>}>
      <p>位置：{parent || '项目根目录'}</p>
      <label className="fld"><span>名称</span><input className="tx" autoFocus value={name} disabled={busy} onChange={(event) => setName(event.target.value)} /></label>
      {name && invalid ? <p role="alert" className="bad">名称无效</p> : null}{!invalid && duplicate ? <p role="alert" className="bad">已存在同名文件或文件夹</p> : null}{error ? <p role="alert" className="bad">{error}</p> : null}
  </FileOperationDialog>
}

export function RightPanel({
  project,
  host,
  mode,
  files,
  loaded,
  isRepo,
  branch,
  repositories = [],
  errors = [],
  tree,
  treeLoaded,
  treeChildren,
  openDirs,
  queries,
  setQueries,
  selections,
  setSelections,
  scrollPositions,
  width,
  placement = 'right',
  onResize,
  activePath,
  onMode,
  onToggleDir,
  onOpenDiff,
  onOpenFile,
  onRevealFile,
  onTreeRulesChanged,
  referenceTerms,
  onReference,
  onTrash,
  onRename,
  onMove,
  transfers,
  onDismissTransfer,
  onCollapse,
  onRescan
}: {
  project: Project
  host: Host
  mode: 'files' | 'changes'
  files: GitFile[]
  loaded: boolean
  isRepo: boolean
  branch: string
  repositories?: GitPanel['repositories']
  errors?: string[]
  tree: TreeNode[]
  treeLoaded: boolean
  treeChildren: Record<string, TreeNode[]>
  openDirs: Record<string, boolean>
  queries: Record<string, string>
  setQueries: React.Dispatch<React.SetStateAction<Record<string, string>>>
  selections: Record<string, { path: string; dir: boolean }>
  setSelections: React.Dispatch<React.SetStateAction<Record<string, { path: string; dir: boolean }>>>
  scrollPositions: React.RefObject<Record<string, number>>
  width: number
  placement?: 'left' | 'right'
  onResize: (width: number) => void
  activePath?: string
  onMode: (mode: 'files' | 'changes') => void
  onToggleDir: (path: string) => void
  onOpenDiff: (path: string) => void
  onOpenFile: (path: string) => void
  onRevealFile: (projectId: string, path: string) => Promise<boolean>
  onTreeRulesChanged: () => void
  referenceTerms: TermTab[]
  onReference: (id: string, text: string) => void
  onTrash: (projectId: string, path: string, directory: boolean) => void
  onRename: (projectId: string, path: string, name: string, directory: boolean) => Promise<void>
  onMove: (projectId: string, path: string, parent: string, directory: boolean) => Promise<void>
  transfers: TransferSnapshot[]
  onDismissTransfer: (id: string) => void
  onCollapse: () => void
  onRescan: () => Promise<void>
}) {
  const drag = useRef<{ x: number; width: number } | null>(null)
  const [repositoryFilter, setRepositoryFilter] = useState('')
  const [rescanning, setRescanning] = useState(false)
  const [treeError, setTreeError] = useState('')
  const [conflictBatch, setConflictBatch] = useState<Record<string, boolean>>({})
  function transferPath(destination: string): string {
    const value = destination.replaceAll('\\', '/')
    const root = project.path.replaceAll('\\', '/').replace(/\/+$/, '') + '/'
    const inside = host.platform === 'windows' ? value.toLowerCase().startsWith(root.toLowerCase()) : value.startsWith(root)
    return inside ? value.slice(root.length) : value.split('/').pop() || value
  }
  const [creating, setCreating] = useState<{ projectId: string; parent: string; directory: boolean } | null>(null)
  const [referencePath, setReferencePath] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<{ projectId: string; path: string; dir: boolean } | null>(null)
  const [moving, setMoving] = useState<{ projectId: string; path: string; dir: boolean } | null>(null)
  const [renameFocus, setRenameFocus] = useState<{ projectId: string; path: string } | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const transferList = useRef<HTMLElement>(null)
  const latestTransferId = transfers.at(-1)?.id
  useLayoutEffect(() => {
    if (transferList.current) transferList.current.scrollTop = transferList.current.scrollHeight
  }, [project.id, latestTransferId])
  const query = queries[project.id] || ''
  const [search, setSearch] = useState<{ projectId: string; query: string; items: TreeNode[]; loading: boolean; error: string }>({ projectId: '', query: '', items: [], loading: false, error: '' })
  useEffect(() => {
    if (!query.trim()) return
    let cancelled = false
    const id = crypto.randomUUID()
    setSearch({ projectId: project.id, query, items: [], loading: true, error: '' })
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          await window.awb.treeSearchStart(project.id, id, query)
          if (cancelled) { await window.awb.treeSearchCancel(id); return }
          let done = false
          while (!done && !cancelled) {
            const batch = await window.awb.treeSearchNext(id)
            done = batch.done
            if (!cancelled) setSearch((state) => ({ ...state, items: [...state.items, ...batch.items], loading: !done }))
          }
        } catch (error) {
          if (!cancelled) setSearch((state) => ({ ...state, loading: false, error: error instanceof Error ? error.message : '搜索失败' }))
        }
      })()
    }, 250)
    return () => { cancelled = true; window.clearTimeout(timer); void window.awb.treeSearchCancel(id) }
  }, [project.id, query])
  const selection = selections[project.id]
  function parentOf(file: string) { const index = file.lastIndexOf('/'); return index < 0 ? '' : file.slice(0, index) }
  function dragDirectory(element: EventTarget | null): string {
    const row = element instanceof Element ? element.closest<HTMLElement>('[data-a="tog"], [data-a="preview"], [data-a="search-file"]') : null
    if (row?.dataset.id !== undefined) return row.dataset.a === 'tog' ? row.dataset.id : parentOf(row.dataset.id)
    return selection ? (selection.dir ? selection.path : parentOf(selection.path)) : ''
  }
  function onTreeDragOver(event: React.DragEvent<HTMLDivElement>) {
    if (!Array.from(event.dataTransfer.types).includes('Files')) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setDropTarget(dragDirectory(event.target))
  }
  function onTreeDrop(event: React.DragEvent<HTMLDivElement>) {
    if (!Array.from(event.dataTransfer.types).includes('Files')) return
    event.preventDefault()
    const destination = dragDirectory(event.target)
    setDropTarget(null)
    try {
      const paths = Array.from(event.dataTransfer.files, (file) => window.awb.droppedFilePath(file))
      if (!paths.length || paths.some((value) => !value)) throw new Error('无法读取拖入文件的本机路径')
      void window.awb.transferDrop(project.id, destination, paths).catch((error: unknown) => setTreeError(error instanceof Error ? error.message : '导入失败'))
    } catch (error) { setTreeError(error instanceof Error ? error.message : '导入失败') }
  }
  const dropHandlers = { onDragOver: onTreeDragOver, onDrop: onTreeDrop, onDragLeave: (event: React.DragEvent<HTMLDivElement>) => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDropTarget(null) } }
  const treeList = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!renameFocus || renameFocus.projectId !== project.id || renaming) return
    const row = [...(treeList.current?.querySelectorAll<HTMLButtonElement>('[data-a="preview"], [data-a="tog"]') || [])].find((item) => item.dataset.id === renameFocus.path)
    if (row) { row.focus(); setRenameFocus(null) }
  }, [renameFocus, renaming, project.id, tree, treeChildren])
  const scrollRestore = useRef<{ projectId: string; top: number } | null>({ projectId: project.id, top: scrollPositions.current[project.id] || 0 })
  const scrollProject = useRef(project.id)
  if (scrollProject.current !== project.id) {
    scrollProject.current = project.id
    scrollRestore.current = { projectId: project.id, top: scrollPositions.current[project.id] || 0 }
  }
  useLayoutEffect(() => {
    const pending = scrollRestore.current, list = treeList.current
    if (!pending || !list || !treeLoaded || pending.projectId !== project.id || query.trim()) return
    if (pending.top === 0 || list.scrollHeight - list.clientHeight >= pending.top) {
      list.scrollTop = pending.top
      scrollRestore.current = null
    }
  })
  function selectNode(node: TreeNode) {
    setSelections((current) => ({ ...current, [project.id]: { path: node.path, dir: node.dir } }))
  }
  async function treeMenu(path: string, dir: boolean) {
    setSelections((current) => ({ ...current, [project.id]: { path, dir } }))
    setTreeError('')
    try {
      const action = await window.awb.treeMenu(project.id, path, dir)
      if (action === 'open') onOpenFile(path)
      else if (action === 'reference') setReferencePath(path)
      else if (action === 'trash') onTrash(project.id, path, dir)
      else if (action === 'rename') setRenaming({ projectId: project.id, path, dir })
      else if (action === 'move') setMoving({ projectId: project.id, path, dir })
      else if (action === 'download') await window.awb.transferDownload(project.id, path, dir)
      else if (action === 'create-file' || action === 'create-directory') setCreating({ projectId: project.id, parent: path, directory: action === 'create-directory' })
      else if (action === 'import-files' || action === 'import-directory') await window.awb.transferPick(project.id, path, action === 'import-files' ? 'files' : 'directory')
      else if (action) await window.awb.treeAction(project.id, path, dir, action)
    } catch (error) { setTreeError(error instanceof Error ? error.message : '文件操作失败') }
  }
  function treeBackgroundContext(event: React.MouseEvent<HTMLDivElement>) {
    if (event.target instanceof Element && event.target.closest('.row')) return
    event.preventDefault(); event.currentTarget.focus(); void treeMenu('', true)
  }
  function treeBackgroundKey(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget) menuKey(event, '', true)
  }
  function menuKey(event: React.KeyboardEvent, path: string, dir: boolean) {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault()
      void treeMenu(path, dir)
    }
  }
  async function rescan() {
    setRescanning(true)
    try { await onRescan() } finally { setRescanning(false) }
  }
  const filter = repositories.some((repo) => repo.path === repositoryFilter) ? repositoryFilter : ''
  const renderChange = (file: GitFile) => {
    const parts = (file.repository ? file.path.slice(file.repository.length + 1) : file.path).split('/')
    const name = parts.pop() || file.path
    return <button key={file.path} className={`row ${activePath === file.path ? 'on' : ''}`} data-a="diff" data-id={file.path} title={file.path} onClick={() => onOpenDiff(file.path)}>
      <span className={`st ${file.st}`}>{file.st}</span><span className="nm">{name}</span><span className="dir grow">{parts.join('/')}</span>
      <span className="num"><span className="a">+{file.add}</span>{file.del ? <span className="d">−{file.del}</span> : null}</span>
    </button>
  }
  const changed = new Map(files.map((file) => [file.path, file]))
  const renderTree = (nodes: TreeNode[], depth: number) =>
    nodes.map((node) => {
      const pad = 6 + depth * 14
      const editor = renaming?.projectId === project.id && renaming.path === node.path ? <RenameRow path={node.path} directory={node.dir} padding={node.dir ? pad : 26 + depth * 14} onCancel={() => { setRenaming(null); setRenameFocus({ projectId: project.id, path: node.path }) }} onSubmit={async (name) => { await onRename(project.id, node.path, name, node.dir); setRenaming(null); setRenameFocus({ projectId: project.id, path: [node.path.split('/').slice(0, -1).join('/'), name].filter(Boolean).join('/') }) }} /> : null
      if (node.dir) {
        const key = `${project.id}:${node.path}`
        const open = !!openDirs[key]
        return (
          <div key={node.path}>
            {editor || <button className={`row ${selection?.dir && selection.path === node.path ? 'on' : ''} ${dropTarget === node.path ? 'drop-target' : ''}`} style={{ paddingLeft: pad }} data-a="tog" data-id={node.path} title={node.path} aria-expanded={open} aria-pressed={selection?.dir && selection.path === node.path} onClick={() => selectNode(node)} onDoubleClick={() => onToggleDir(node.path)} onContextMenu={(event) => { event.preventDefault(); void treeMenu(node.path, true) }} onKeyDown={(event) => {
              menuKey(event, node.path, true)
              if (event.key === 'F2') { event.preventDefault(); selectNode(node); setRenaming({ projectId: project.id, path: node.path, dir: true }) }
              if ((event.key === 'ArrowRight' && !open) || (event.key === 'ArrowLeft' && open)) { event.preventDefault(); onToggleDir(node.path) }
            }}>
              <span onClick={(event) => { event.stopPropagation(); selectNode(node); onToggleDir(node.path) }}><Icon name="chev" className={`s chev${open ? ' open' : ''}`} /></span>
              <Icon name="folder" className="s" />
              <span className="nm">{node.name}</span>
            </button>}
            {open ? treeChildren[key] ? renderTree(treeChildren[key], depth + 1) : <div className="tree-loading" style={{ paddingLeft: pad + 20 }}>正在读取…</div> : null}
          </div>
        )
      }
      const change = changed.get(node.path)
      if (editor) return <div key={node.path}>{editor}</div>
      return (
        <button
          key={node.path}
          className={`row ${selection && !selection.dir && selection.path === node.path ? 'on' : ''}`}
          style={{ paddingLeft: 26 + depth * 14 }}
          data-a="preview"
          data-id={node.path}
          aria-pressed={!!selection && !selection.dir && selection.path === node.path}
          onClick={() => { selectNode(node); onOpenFile(node.path) }}
          onContextMenu={(event) => { event.preventDefault(); void treeMenu(node.path, false) }}
          onKeyDown={(event) => { menuKey(event, node.path, false); if (event.key === 'F2') { event.preventDefault(); selectNode(node); setRenaming({ projectId: project.id, path: node.path, dir: false }) } }}
          title={node.path}
        >
          <Icon name="file" className="s" />
          <span className="nm grow" style={change ? { color: change.st === 'A' ? 'var(--green)' : change.st === 'D' ? 'var(--red)' : 'var(--amber)' } : undefined}>
            {node.name}
          </span>
          {change ? <span className={`st ${change.st}`}>{change.st}</span> : null}
        </button>
      )
    })

  let body
  if (mode === 'changes') {
    if (!loaded) {
      body = <div className="rmeta">正在读取…</div>
    } else if (!isRepo && !repositories.length) {
      body = (
        <div className="empty" style={{ background: 'none' }}>
          <div className="in">
            <div className="glyph">
              <Icon name="folder" />
            </div>
            <p style={{ marginTop: 8 }}>不是 Git 仓库</p>
            <p className="repository-help">未发现子仓库。自动发现目录中的 Git 仓库，跳过依赖、构建、缓存及符号链接目录。</p>
            {errors.map((error) => <p className="bad" key={error}>{error}</p>)}
            <button className="btn sm" disabled={rescanning} onClick={() => void rescan()}>{rescanning ? '正在扫描…' : '重新扫描仓库'}</button>
          </div>
        </div>
      )
    } else if (!files.length && !repositories.length) {
      body = (
        <div className="empty" style={{ background: 'none' }}>
          <div className="in">
            <div className="glyph">
              <Icon name="check" />
            </div>
            <p style={{ marginTop: 8 }}>工作区干净</p>
            <p style={{ fontSize: 11, color: 'var(--faint)' }}>{branch || '当前分支'} 上没有未提交的变更</p>
          </div>
        </div>
      )
    } else {
      body = (
        <>
          <div className="rmeta">
            <span className="br">
              <Icon name="branch" className="s" />
              {repositories.length ? `${repositories.length} 个仓库` : branch || 'HEAD'}
            </span>
            <span className="grow" />
            <span>git status</span>
          </div>
          {repositories.length ? <div className="repository-discovery"><small title="自动发现子仓库；跳过依赖、构建、缓存及符号链接目录。">自动发现子仓库</small><button className="btn sm" aria-label="重新扫描仓库" disabled={rescanning} onClick={() => void rescan()}>{rescanning ? '正在扫描…' : '重新扫描'}</button></div> : null}

          {repositories.length ? <label className="repository-filter"><span className="vh">选择仓库</span><select className="sel" aria-label="选择仓库" value={filter} onChange={(event) => setRepositoryFilter(event.target.value)}>
            <option value="">所有仓库</option>{repositories.map((repo) => <option key={repo.path} value={repo.path}>{repo.path} · {repo.count} 项变更</option>)}
          </select></label> : null}
          {errors.map((error) => <p role="alert" className="repository-help bad" key={error}>{error}</p>)}
          <div className="rlist">
            {repositories.length ? repositories.filter((repo) => !filter || repo.path === filter).map((repo) => <details className="repository-group" key={`${project.id}:${repo.path}`} data-repository={repo.path} open>
              <summary><Icon name="branch" className="s" /><span className="grow">{repo.path}</span><small>{repo.branch || 'HEAD'} · {repo.count}</small></summary>
              {files.filter((file) => file.repository === repo.path).map(renderChange)}
              {!repo.count ? <p className="repository-help">工作区干净</p> : null}
            </details>) : files.map(renderChange)}
          </div>
        </>
      )
    }
  } else {
    body = (
      <>
        {treeError ? <p role="alert" className="repository-help bad">{treeError}</p> : null}
        <label className="repository-filter"><span className="vh">搜索文件</span><input className="sel" aria-label="搜索文件" placeholder="搜索文件名或路径" value={query} onChange={(event) => setQueries((current) => ({ ...current, [project.id]: event.target.value }))} /></label>
        {dropTarget !== null ? <div className="tree-drop-hint" role="status">{host.id !== 'local' ? '松开以上传' : <>复制到 · {project.path}{dropTarget ? `${host.platform === 'windows' ? '\\' : '/'}${dropTarget.replaceAll('/', host.platform === 'windows' ? '\\' : '/')}` : ''}</>}</div> : null}
        {query.trim() ? <div className="rlist" role="group" aria-label="文件搜索结果" tabIndex={0} {...dropHandlers} onContextMenu={treeBackgroundContext} onKeyDown={treeBackgroundKey}>
          {search.projectId === project.id && search.query === query ? <>
            {search.items.map((node) => <button className="row" data-a="search-file" onContextMenu={(event) => { event.preventDefault(); void treeMenu(node.path, false) }} onKeyDown={(event) => menuKey(event, node.path, false)} data-id={node.path} key={node.path} title={node.path} onClick={() => {
              selectNode(node)
              onOpenFile(node.path)
            }}><Icon name="file" className="s" /><span className="nm">{node.path}</span></button>)}
            {search.loading ? <p role="status" className="repository-help">正在搜索…</p> : null}
            {search.error ? <p role="alert" className="repository-help bad">{search.error}</p> : null}
            {!search.loading && !search.error && !search.items.length ? <p className="repository-help">没有匹配的文件</p> : null}
          </> : <p role="status" className="repository-help">正在搜索…</p>}
        </div> : null}
        <div ref={treeList} role="group" aria-label="文件树" aria-busy={!treeLoaded} data-project={project.id} tabIndex={0} onContextMenu={treeBackgroundContext} onKeyDown={treeBackgroundKey} className={`rlist ${dropTarget === '' ? 'drop-target' : ''}`} {...dropHandlers} onScroll={(event) => { if (!scrollRestore.current) scrollPositions.current[project.id] = event.currentTarget.scrollTop }} onWheel={() => { scrollRestore.current = null }} onPointerDown={() => { scrollRestore.current = null }} style={query.trim() ? { display: 'none' } : undefined}>{!treeLoaded ? <p role="status" className="repository-help">正在读取文件树…</p> : tree.length ? renderTree(tree, 0) : <p style={{ fontSize: 12, color: 'var(--faint)', padding: '4px 8px' }}>目录是空的</p>}</div>
      </>
    )
  }

  return (
    <aside className="right" data-placement={placement} aria-label="文件面板">
      <div className="right-resize" role="separator" aria-label="调整文件面板宽度" aria-orientation="vertical" aria-valuenow={width} aria-valuemin={220} tabIndex={0}
        onPointerDown={(event) => {
          event.preventDefault()
          event.currentTarget.setPointerCapture(event.pointerId)
          drag.current = { x: event.clientX, width }
        }}
        onPointerMove={(event) => {
          if (drag.current) onResize(drag.current.width + (drag.current.x - event.clientX) * (placement === 'left' ? -1 : 1))
        }}
        onPointerUp={(event) => { drag.current = null; event.currentTarget.releasePointerCapture(event.pointerId) }}
        onPointerCancel={() => { drag.current = null }}
        onLostPointerCapture={() => { drag.current = null }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault()
            onResize(width + (event.key === 'ArrowLeft' ? 20 : -20) * (placement === 'left' ? -1 : 1))
          }
        }} />
      <div className="rh">
        <div className="seg" role="radiogroup" aria-label="文件面板模式">
          <button className={mode === 'files' ? 'on' : ''} role="radio" aria-checked={mode === 'files'} data-a="rmode" data-id="files" onClick={() => onMode('files')}>
            文件
          </button>
          <button className={mode === 'changes' ? 'on' : ''} role="radio" aria-checked={mode === 'changes'} data-a="rmode" data-id="changes" onClick={() => onMode('changes')}>
            变更{files.length ? <span className="c">{files.length}</span> : null}
          </button>
        </div>
        <span className="grow" />
        <button className="ib" data-a="right" title="收起面板" aria-label="收起文件面板" onClick={onCollapse}>
          <Icon name="panel" />
        </button>
      </div>
      {body}
      {moving ? <MoveEntryDialog projectId={moving.projectId} path={moving.path} directory={moving.dir} onCancel={() => setMoving(null)} onMove={async (parent) => { await onMove(moving.projectId, moving.path, parent, moving.dir); setMoving(null) }} /> : null}
      {transfers.length ? <section ref={transferList} className="transfer-list" aria-label="传输任务">{transfers.map((task) => task.direction === 'upload' ? <UploadStatus key={task.id} task={task} onDismiss={onDismissTransfer} /> : <div className="transfer-task" key={task.id}>
        <strong>{task.state === 'running' ? (task.direction === 'download' ? '正在下载' : '正在导入') : task.state === 'conflicts' ? '请选择同名项目的处理方式' : task.state === 'cancelled' ? '已取消' : (task.direction === 'download' ? '下载结束' : '导入结束')}</strong>
        <span title={task.current}>{transferPath(task.current || task.destination)}</span>
        {task.state === 'running' && task.total ? <progress max={task.total} value={task.bytes} aria-label="当前文件进度" /> : null}
        {task.warnings?.map((message) => <small key={message} role="alert" title={message}>{message}</small>)}
        {task.state === 'running' && !task.total && task.direction === 'download' ? <span>已下载 {task.bytes} 字节</span> : null}
        {task.items.map((item) => <small key={`${item.source}:${item.destination}`} title={item.destination}>{item.status === 'done' ? '完成' : item.status === 'conflict' ? '同名冲突' : '失败'} · {transferPath(item.destination)}{item.error ? ` · ${item.error}` : ''}</small>)}
        {task.state === 'conflicts' ? <label className="transfer-batch"><input type="checkbox" checked={!!conflictBatch[task.id]} onChange={(event) => setConflictBatch((current) => ({ ...current, [task.id]: event.target.checked }))} />应用到本批次同类冲突</label> : null}
        {task.state === 'conflicts' && task.pendingConflicts ? <span>待处理 {task.pendingConflicts} 项冲突</span> : null}
        {task.state === 'running' ? <button className="btn sm" disabled={task.phase === 'publishing'} title={task.phase === 'publishing' ? '正在完成替换，请稍候' : undefined} onClick={() => void window.awb.transferCancel(task.id)}>取消传输</button> : task.state === 'conflicts' ? <div>{([['skip', '跳过冲突项'], ['keep', '冲突项保留两者'], ...(task.items.length && task.items.every((item) => item.replaceable) ? [['overwrite', '覆盖冲突文件'] as const] : []), ...(task.items.some((item) => item.mergeable) ? [['merge', '合并同名目录'] as const] : []), ['cancel', '取消传输']] as const).map(([choice, label]) => <button className="btn sm" key={choice} onClick={() => { void window.awb.transferDecide(task.id, choice, !!conflictBatch[task.id]).catch((error: unknown) => setTreeError(error instanceof Error ? error.message : '处理冲突失败')) }}>{label}</button>)}</div> : <div>{task.items.some((item) => item.status === 'conflict') ? <button className="btn sm" onClick={() => { void window.awb.transferKeepBoth(task.id).catch((error: unknown) => setTreeError(error instanceof Error ? error.message : '处理冲突失败')) }}>冲突项保留两者</button> : null}{task.retryable !== false && task.items.some((item) => item.status === 'failed' && item.source && item.error !== '部分内容未能复制' && item.error !== '部分内容未能上传') ? <button className="btn sm" onClick={() => { void window.awb.transferRetry(task.id).catch((error: unknown) => setTreeError(error instanceof Error ? error.message : '重试失败')) }}>重试失败项</button> : null}<button className="btn sm" onClick={() => onDismissTransfer(task.id)}>关闭</button></div>}
      </div>)}</section> : null}
      {referencePath !== null ? <ReferenceDialog projectId={project.id} path={referencePath} terms={referenceTerms} onCancel={() => setReferencePath(null)} onConfirm={(id, value) => { onReference(id, value); setReferencePath(null) }} /> : null}
      {creating ? <CreateEntryDialog parent={creating.parent} directory={creating.directory} windows={host.platform === 'windows'} existing={(creating.parent ? treeChildren[`${creating.projectId}:${creating.parent}`] || [] : tree).map((node) => node.name)} onCancel={() => setCreating(null)} onCreate={async (name) => {
        const entry = creating
        const path = await window.awb.treeCreate(entry.projectId, entry.parent, name, entry.directory)
        onTreeRulesChanged()
        setCreating(null)
        const visible = await onRevealFile(entry.projectId, entry.directory ? `${path}/_` : path).catch((error: unknown) => { setTreeError(error instanceof Error ? error.message : '已创建，但无法定位'); return false })
        if (visible) {
          setSelections((current) => ({ ...current, [entry.projectId]: { path, dir: entry.directory } }))
          if (!entry.directory) onOpenFile(path)
        }
      }} /> : null}
      <div className="rfoot">
        <Icon name={host.id === 'local' ? 'laptop' : 'server'} className="s" />
        <span>{host.name}</span>
        <span>·</span>
        <span>{host.os}</span>
      </div>
    </aside>
  )
}
