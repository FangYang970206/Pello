import { t } from '../shared/i18n'
import type { GitFile, GitPanel, Host, Project, ProjectSearchOptions, SearchLocation, TransferSnapshot, TreeNode } from '../shared/types'
import { hostDisplayName } from '../shared/types'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Icon } from './icons'
import type { TermTab } from './Workspace'
import { FileOperationDialog } from './FileOperationDialog'
import { UploadStatus, transferNeedsAttention } from './UploadStatus'
import { ContentSearchResults } from './ContentSearchResults'
import { VirtualFileRows } from './VirtualFileRows'
import { GitChangeRows } from './GitChangeRows'

const NO_COLLAPSED_CHANGES: ReadonlySet<string> = new Set()

function MoveEntryDialog({ projectId, path, directory, onCancel, onMove }: { projectId: string; path: string; directory: boolean; onCancel: () => void; onMove: (parent: string) => Promise<void> }) {
  const [parent, setParent] = useState('')
  const [nodes, setNodes] = useState<TreeNode[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let current = true
    setLoading(true); setError('')
    void window.awb.gitTree(projectId, parent).then((items) => { if (current) setNodes(items.filter((item) => item.dir)) }).catch((reason: unknown) => { if (current) setError(reason instanceof Error ? reason.message : t("无法读取目录")) }).finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [projectId, parent])
  const oldParent = path.split('/').slice(0, -1).join('/')
  return <FileOperationDialog title={t("移动到")} busy={busy} onClose={onCancel} onSubmit={(event) => { event.preventDefault(); if (busy || loading || !!error || parent === oldParent) return; setBusy(true); void onMove(parent).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : t("移动失败"))).finally(() => setBusy(false)) }}
    footer={<><button type="button" className="btn" disabled={busy} onClick={onCancel}>{t("取消")}</button><button className="btn pri" disabled={busy || loading || !!error || parent === oldParent}>{busy ? t("正在移动…") : t("移动到此处")}</button></>}>
      <p>{t("对象：")}{path}</p><p>{t("目标：")}{parent || t("项目根目录")}</p>
      <button type="button" className="btn sm" disabled={!parent || busy} onClick={() => setParent(parent.split('/').slice(0, -1).join('/'))}>{t("上一级")}</button>
      <div className="move-directories" aria-label={t("目标文件夹")}>{loading ? <p role="status">{t("正在读取…")}</p> : nodes.map((node) => <button type="button" className="row" key={node.path} disabled={busy || (directory && (node.path === path || node.path.startsWith(`${path}/`)))} onClick={() => setParent(node.path)}><Icon name="folder" className="s" />{node.name}</button>)}</div>
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
    void onSubmit(name).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : t("重命名失败"))).finally(() => setBusy(false))
  }}>
    <Icon name={directory ? 'folder' : 'file'} className="s" />
    <input className="tx" aria-label={t("文件新名称")} autoFocus value={name} disabled={busy} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape' && !busy) { event.preventDefault(); event.stopPropagation(); onCancel() } }} />
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
    if (term) void window.awb.treeReference(projectId, path, term.kind, term.shell).then((value) => { if (current) setResult({ id: term.id, text: value }) }).catch((reason: unknown) => { if (current) setError(reason instanceof Error ? reason.message : t("无法引用此文件")) })
    return () => { current = false }
  }, [projectId, path, term?.id, term?.kind, term?.shell])
  return <FileOperationDialog title={t("引用到当前终端")} onClose={onCancel} onSubmit={(event) => { event.preventDefault(); if (term && preview) onConfirm(term.id, preview) }}
    footer={<><button type="button" className="btn" onClick={onCancel}>{t("取消")}</button><button className="btn pri" disabled={!term || !preview}>{t("粘贴引用")}</button></>}>
      <label className="fld"><span>{t("目标终端")}</span><select className="sel" value={id} onChange={(event) => setId(event.target.value)}>{terms.map((item) => <option key={item.id} value={item.id}>{item.name || `${item.kind} · ${item.id}`}</option>)}</select></label>
      {!terms.length ? <p role="alert">{t("此项目没有可用终端")}</p> : null}
      <p>{t("将粘贴以下路径，不会自动回车：")}</p><pre className="mono">{preview || (term && !error ? t("正在解析…") : '')}</pre>
      {error ? <p role="alert" className="bad">{error}</p> : null}
  </FileOperationDialog>
}

function CreateEntryDialog({ parent, directory, windows, existing, onCancel, onCreate }: { parent: string; directory: boolean; windows: boolean; existing: string[]; onCancel: () => void; onCreate: (name: string) => Promise<void> }) {
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const invalid = !name || name === '.' || name === '..' || /[\\/\0]/.test(name) || (windows && (/[<>:"|?*]/.test(name) || [...name].some((char) => char.charCodeAt(0) < 32) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)))
  const duplicate = existing.some((item) => windows ? item.toLocaleLowerCase() === name.toLocaleLowerCase() : item === name)
  return <FileOperationDialog title={directory ? t("新建文件夹") : t("新建文件")} busy={busy} onClose={onCancel} onSubmit={(event) => { event.preventDefault(); if (invalid || duplicate || busy) return; setBusy(true); setError(''); void onCreate(name).catch((err: unknown) => setError(err instanceof Error ? err.message : t("创建失败"))).finally(() => setBusy(false)) }}
    footer={<><button type="button" className="btn" disabled={busy} onClick={onCancel}>{t("取消")}</button><button className="btn pri" disabled={busy || invalid || duplicate}>{busy ? t("正在创建…") : t("创建")}</button></>}>
      <p>{t("位置：")}{parent || t("项目根目录")}</p>
      <label className="fld"><span>{t("名称")}</span><input className="tx" autoFocus value={name} disabled={busy} onChange={(event) => setName(event.target.value)} /></label>
      {name && invalid ? <p role="alert" className="bad">{t("名称无效")}</p> : null}{!invalid && duplicate ? <p role="alert" className="bad">{t("已存在同名文件或文件夹")}</p> : null}{error ? <p role="alert" className="bad">{error}</p> : null}
  </FileOperationDialog>
}

export function RightPanel({
  project,
  context,
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
  contentQueries,
  setContentQueries,
  searchFocus,
  searchOptions,
  setSearchOptions,
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
  onReloadFile,
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
  context?: import('../shared/types').TerminalContext | null
  host: Host
  mode: 'files' | 'changes' | 'search'
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
  contentQueries: Record<string, string>
  setContentQueries: React.Dispatch<React.SetStateAction<Record<string, string>>>
  searchFocus: { mode: 'files' | 'search'; sequence: number }
  searchOptions: Record<string, ProjectSearchOptions>
  setSearchOptions: React.Dispatch<React.SetStateAction<Record<string, ProjectSearchOptions>>>
  selections: Record<string, { path: string; dir: boolean }>
  setSelections: React.Dispatch<React.SetStateAction<Record<string, { path: string; dir: boolean }>>>
  scrollPositions: React.RefObject<Record<string, number>>
  width: number
  placement?: 'left' | 'right'
  onResize: (width: number) => void
  activePath?: string
  onMode: (mode: 'files' | 'changes' | 'search') => void
  onToggleDir: (path: string) => void
  onOpenDiff: (path: string) => void
  onOpenFile: (path: string, anchor?: string, location?: SearchLocation) => void
  onReloadFile: (projectId: string, path: string) => void
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
  const [changeViews, setChangeViews] = useState<Record<string, boolean>>({})
  const [collapsedChanges, setCollapsedChanges] = useState<Record<string, ReadonlySet<string>>>({})
  const changeTree = !!changeViews[project.id]
  const collapsed = collapsedChanges[project.id] || NO_COLLAPSED_CHANGES
  function toggleChangeDirectory(path: string) {
    setCollapsedChanges((state) => {
      const next = new Set(state[project.id])
      if (next.has(path)) next.delete(path); else next.add(path)
      return { ...state, [project.id]: next }
    })
  }
  const [treeError, setTreeError] = useState('')
  const searchInput = useRef<HTMLInputElement>(null)
  const contentInput = useRef<HTMLInputElement>(null)
  const searchButton = useRef<HTMLButtonElement>(null)
  const sensitive = searchOptions[project.id]?.sensitive || false
  const regex = searchOptions[project.id]?.regex || false
  const whole = searchOptions[project.id]?.whole || false
  function updateSearch(options: Partial<ProjectSearchOptions>) {
    setSearchOptions((current) => ({ ...current, [project.id]: { sensitive, regex, whole, ...options } }))
  }
  const [creating, setCreating] = useState<{ projectId: string; parent: string; directory: boolean } | null>(null)
  const [referencePath, setReferencePath] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<{ projectId: string; path: string; dir: boolean } | null>(null)
  const [moving, setMoving] = useState<{ projectId: string; path: string; dir: boolean } | null>(null)
  const [renameFocus, setRenameFocus] = useState<{ projectId: string; path: string } | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [movingDrop, setMovingDrop] = useState(false)
  const treeDrag = useRef<{ projectId: string; path: string; dir: boolean } | null>(null)
  const attention = transfers.filter(transferNeedsAttention)
  const query = queries[project.id] || ''
  const contentQuery = contentQueries[project.id] || ''
  const searching = useRef(false)
  useLayoutEffect(() => {
    if (mode === searchFocus.mode && searchFocus.sequence) {
      const input = mode === 'files' ? searchInput.current : contentInput.current
      input?.focus(); input?.select()
    }
  }, [searchFocus, mode, project.id])
  useEffect(() => { if (mode === 'search') contentInput.current?.focus() }, [mode])
  function searchAction() {
    onMode('search')
    contentInput.current?.focus()
  }
  const [search, setSearch] = useState<{ projectId: string; query: string; items: TreeNode[]; loading: boolean; error: string }>({ projectId: '', query: '', items: [], loading: false, error: '' })
  useEffect(() => {
    if (!query.trim() || mode !== 'files') return
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
            if (!cancelled && (batch.items.length || done)) setSearch((state) => ({ ...state, items: [...state.items, ...batch.items], loading: !done }))
          }
        } catch (error) {
          if (!cancelled) setSearch((state) => ({ ...state, loading: false, error: error instanceof Error ? error.message : t("搜索失败") }))
        }
      })()
    }, 250)
    return () => { cancelled = true; window.clearTimeout(timer); void window.awb.treeSearchCancel(id) }
  }, [project.id, query, mode])
  const selection = selections[project.id]
  function parentOf(file: string) { const index = file.lastIndexOf('/'); return index < 0 ? '' : file.slice(0, index) }
  function dragDirectory(element: EventTarget | null, internal = false): string {
    const row = element instanceof Element ? element.closest<HTMLElement>('[data-a="tog"], [data-a="preview"], [data-a="search-file"]') : null
    if (row?.dataset.id !== undefined) return row.dataset.a === 'tog' ? row.dataset.id : parentOf(row.dataset.id)
    if (internal) return ''
    return selection ? (selection.dir ? selection.path : parentOf(selection.path)) : ''
  }
  const treeDragType = 'application/x-pello-tree-entry'
  function dragEntry(path: string, dir: boolean) {
    return {
      draggable: true,
      onDragStart: (event: React.DragEvent) => {
        treeDrag.current = { projectId: project.id, path, dir }
        event.dataTransfer.setData(treeDragType, path)
        event.dataTransfer.effectAllowed = 'move'
        setMovingDrop(true)
      },
      onDragEnd: () => { treeDrag.current = null; setDropTarget(null); setMovingDrop(false) }
    }
  }
  function validMove(parent: string) {
    const source = treeDrag.current
    if (!source || source.projectId !== project.id) return false
    const normalize = (value: string) => host.platform === 'windows' ? value.toLowerCase() : value
    const from = normalize(source.path), to = normalize(parent)
    const destination = [to, from.split('/').at(-1)].filter(Boolean).join('/')
    return to !== parentOf(from) && (!source.dir || (to !== from && !to.startsWith(`${from}/`))) && !from.startsWith(`${destination}/`)
  }
  function onTreeDragOver(event: React.DragEvent<HTMLDivElement>) {
    const internal = event.dataTransfer.types.includes(treeDragType)
    if (!internal && !event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    const destination = dragDirectory(event.target, internal)
    const allowed = !internal || validMove(destination)
    event.dataTransfer.dropEffect = allowed ? internal ? 'move' : 'copy' : 'none'
    setDropTarget(allowed ? destination : null)
  }
  function onTreeDrop(event: React.DragEvent<HTMLDivElement>) {
    const internal = event.dataTransfer.types.includes(treeDragType)
    if (!internal && !event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    const destination = dragDirectory(event.target, internal)
    setDropTarget(null)
    if (internal) {
      const source = treeDrag.current
      if (!source || !validMove(destination) || event.dataTransfer.getData(treeDragType) !== source.path) return
      setTreeError('')
      void onMove(source.projectId, source.path, destination, source.dir).catch((error: unknown) => setTreeError(error instanceof Error ? error.message : t("移动失败")))
      return
    }
    try {
      const paths = Array.from(event.dataTransfer.files, (file) => window.awb.droppedFilePath(file))
      if (!paths.length || paths.some((value) => !value)) throw new Error(t("无法读取拖入文件的本机路径"))
      void window.awb.transferDrop(project.id, destination, paths).catch((error: unknown) => setTreeError(error instanceof Error ? error.message : t("导入失败")))
    } catch (error) { setTreeError(error instanceof Error ? error.message : t("导入失败")) }
  }
  const dropHandlers = { onDragOver: onTreeDragOver, onDrop: onTreeDrop, onDragLeave: (event: React.DragEvent<HTMLDivElement>) => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDropTarget(null) } }
  const treeList = useRef<HTMLDivElement>(null)
  const searchProject = useRef(project.id)
  const previousQuery = useRef(query)
  const clearRestore = useRef<number | null>(null)
  const restoreFrame = useRef(0)
  function restoreTreeScroll(top: number) {
    clearRestore.current = top
    restoreFrame.current = 0
    const step = () => {
      const list = treeList.current
      if (!list || clearRestore.current === null) return
      if (list.scrollTop !== top) list.scrollTop = top
      if (++restoreFrame.current < 30) requestAnimationFrame(step)
      else clearRestore.current = null
    }
    requestAnimationFrame(step)
  }
  useLayoutEffect(() => {
    const active = !!query.trim()
    if (searchProject.current !== project.id) {
      clearRestore.current = null
      restoreFrame.current = 0
    }
    if (searchProject.current === project.id && previousQuery.current.trim() && !active) {
      restoreTreeScroll(scrollPositions.current[project.id] || 0)
    }
    searchProject.current = project.id
    previousQuery.current = query
  }, [query, project.id, treeLoaded])
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
      else if (action === 'reload') onReloadFile(project.id, path)
      else if (action === 'reference') setReferencePath(path)
      else if (action === 'trash') onTrash(project.id, path, dir)
      else if (action === 'rename') setRenaming({ projectId: project.id, path, dir })
      else if (action === 'move') setMoving({ projectId: project.id, path, dir })
      else if (action === 'download') await window.awb.transferDownload(project.id, path, dir)
      else if (action === 'create-file' || action === 'create-directory') setCreating({ projectId: project.id, parent: path, directory: action === 'create-directory' })
      else if (action === 'import-files' || action === 'import-directory') await window.awb.transferPick(project.id, path, action === 'import-files' ? 'files' : 'directory')
      else if (action) await window.awb.treeAction(project.id, path, dir, action)
    } catch (error) { setTreeError(error instanceof Error ? error.message : t("文件操作失败")) }
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
  const renderChanges = (items: GitFile[], repository = '') => <GitChangeRows files={items} repository={repository} tree={changeTree} collapsed={collapsed} onToggle={toggleChangeDirectory} activePath={activePath} onOpen={onOpenDiff} />
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
            {editor || <button {...dragEntry(node.path, true)} className={`row ${selection?.dir && selection.path === node.path ? 'on' : ''} ${dropTarget === node.path ? 'drop-target' : ''}`} style={{ paddingLeft: pad }} data-a="tog" data-id={node.path} title={node.path} aria-expanded={open} aria-pressed={selection?.dir && selection.path === node.path} onClick={() => selectNode(node)} onDoubleClick={() => onToggleDir(node.path)} onContextMenu={(event) => { event.preventDefault(); void treeMenu(node.path, true) }} onKeyDown={(event) => {
              menuKey(event, node.path, true)
              if (event.key === 'F2') { event.preventDefault(); selectNode(node); setRenaming({ projectId: project.id, path: node.path, dir: true }) }
              if ((event.key === 'ArrowRight' && !open) || (event.key === 'ArrowLeft' && open)) { event.preventDefault(); onToggleDir(node.path) }
            }}>
              <span onClick={(event) => { event.stopPropagation(); selectNode(node); onToggleDir(node.path) }}><Icon name="chev" className={`s chev${open ? ' open' : ''}`} /></span>
              <Icon name="folder" className="s" />
              <span className="nm">{node.name}</span>
            </button>}
            {open ? treeChildren[key] ? renderTree(treeChildren[key], depth + 1) : <div className="tree-loading" style={{ paddingLeft: pad + 20 }}>{t("正在读取…")}</div> : null}
          </div>
        )
      }
      const change = changed.get(node.path)
      if (editor) return <div key={node.path}>{editor}</div>
      return (
        <button
          key={node.path}
          {...dragEntry(node.path, false)}
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
      body = <div className="rmeta">{t("正在读取…")}</div>
    } else if (!isRepo && !repositories.length) {
      body = (
        <div className="empty" style={{ background: 'none' }}>
          <div className="in">
            <div className="glyph">
              <Icon name="folder" />
            </div>
            {!errors.length ? <><p style={{ marginTop: 8 }}>{t("不是 Git 仓库")}</p>
            </> : null}
            {errors.map((error) => <p role="alert" className="bad" key={error}>{error}</p>)}
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
            <p style={{ marginTop: 8 }}>{t("工作区干净")}</p>
            <p style={{ fontSize: 11, color: 'var(--faint)' }}>{branch || t("当前分支")} {t(" 上没有未提交的变更")}</p>
          </div>
        </div>
      )
    } else {
      body = (
        <>
          {repositories.length ? <label className="repository-filter"><span className="vh">{t("选择仓库")}</span><select className="sel" aria-label={t("选择仓库")} value={filter} onChange={(event) => setRepositoryFilter(event.target.value)}>
            <option value="">{t("所有仓库")}</option>{repositories.map((repo) => <option key={repo.path} value={repo.path}>{repo.path} · {repo.count} {t(" 项变更")}</option>)}
          </select></label> : null}
          {errors.map((error) => <p role="alert" className="repository-help bad" key={error}>{error}</p>)}
          <div className="rlist">
            {repositories.length ? repositories.filter((repo) => !filter || repo.path === filter).map((repo) => <details className="repository-group" key={`${project.id}:${repo.path}`} data-repository={repo.path} open>
              <summary><Icon name="branch" className="s" /><span className="grow">{repo.path}</span><small>{repo.branch || 'HEAD'} · {repo.count}</small></summary>
              {renderChanges(files.filter((file) => file.repository === repo.path), repo.path)}
              {!repo.count ? <p className="repository-help">{t("工作区干净")}</p> : null}
            </details>) : renderChanges(files)}
          </div>
        </>
      )
    }
    body = <><div className="rmeta git-toolbar">
      <span className="br grow"><Icon name="branch" className="s" />{repositories.length ? t("{{0}} 个仓库", repositories.length) : branch || (isRepo ? 'HEAD' : t("变更"))}</span>
      <button type="button" className="ib" data-a="git-view" title={changeTree ? t("切换为平铺列表") : t("切换为树状结构")} aria-label={changeTree ? t("切换为平铺列表") : t("切换为树状结构")} aria-pressed={changeTree} onClick={() => setChangeViews((state) => ({ ...state, [project.id]: !changeTree }))}><Icon name={changeTree ? 'tree' : 'list'} className="s" /></button>
      <button type="button" className="ib" data-a="git-refresh" title={rescanning ? t("正在扫描…") : t("重新扫描仓库")} aria-label={t("重新扫描仓库")} aria-busy={rescanning} disabled={rescanning} onClick={() => void rescan()}><Icon name="refresh" className={`s${rescanning ? ' git-scanning' : ''}`} /></button>
    </div>{body}</>
  } else if (mode === 'search') {
    body = <>
      <div className="project-search" role="search" aria-label={t("内容搜索区域")} onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); searchButton.current?.focus() }
        else if (event.key === 'Enter' && event.target === contentInput.current) { event.preventDefault(); window.document.querySelector<HTMLButtonElement>('[data-a="content-hit"]')?.focus() }
      }}>
        <div className="project-search-input">
          <input ref={contentInput} aria-label={t("搜索内容")} placeholder={t("搜索")} maxLength={500} value={contentQuery} onChange={(event) => setContentQueries((current) => ({ ...current, [project.id]: event.target.value }))} />
          <div className="project-search-options" role="group" aria-label={t("搜索选项")}>
            <button className="ib" aria-label={t("区分大小写")} title={t("区分大小写")} aria-pressed={sensitive} onClick={() => updateSearch({ sensitive: !sensitive })}><Icon name="match-case" /></button>
            <button className="ib" aria-label={t("全字匹配")} title={t("全字匹配")} aria-pressed={whole} onClick={() => updateSearch({ whole: !whole })}><Icon name="whole-word" /></button>
            <button className="ib" aria-label={t("使用正则表达式")} title={t("使用正则表达式")} aria-pressed={regex} onClick={() => updateSearch({ regex: !regex })}><Icon name="regex" /></button>
          </div>
        </div>
      </div>
      {contentQuery.trim() ? <ContentSearchResults projectId={project.id} query={contentQuery} sensitive={sensitive} regex={regex} whole={whole} onOpen={(path, location) => onOpenFile(path, undefined, location)} />
        : <div className="rlist"><p className="repository-help">{t("输入搜索词以搜索项目文件内容")}</p></div>}
    </>
  } else {
    body = (
      <>
        {treeError ? <p role="alert" className="repository-help bad">{treeError}</p> : null}
        <div className="project-search file-name-search" role="search" aria-label={t("文件搜索区域")}>
          <input ref={searchInput} className="tx" aria-label={t("搜索文件")} maxLength={500} value={query} onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setQueries((current) => ({ ...current, [project.id]: '' })); treeList.current?.focus() }
            else if (event.key === 'Enter') { event.preventDefault(); window.document.querySelector<HTMLButtonElement>('[data-a="search-file"]')?.focus() }
          }} onChange={(event) => {
            const value = event.target.value
            if (value.trim() && !searching.current && treeList.current) scrollPositions.current[project.id] = treeList.current.scrollTop
            if (value.trim()) clearRestore.current = null
            searching.current = !!value.trim()
            setQueries((current) => ({ ...current, [project.id]: value }))
          }} />
        </div>
        {dropTarget !== null ? <div className="tree-drop-hint" role="status">{movingDrop ? t("移动到 {{0}}", dropTarget || t("项目根目录")) : host.id !== 'local' ? t("松开以上传") : <>{t("复制到 · ")}{project.path}{dropTarget ? `${host.platform === 'windows' ? '\\' : '/'}${dropTarget.replaceAll('/', host.platform === 'windows' ? '\\' : '/')}` : ''}</>}</div> : null}
        {query.trim() ? <div className="rlist" role="group" aria-label={t("文件搜索结果")} tabIndex={0} {...dropHandlers} onContextMenu={treeBackgroundContext} onKeyDown={treeBackgroundKey}>
          {search.projectId === project.id && search.query === query ? <>
            <VirtualFileRows key={`${project.id}:${query}`} items={search.items} render={(node) => <button {...dragEntry(node.path, false)} className="row" data-a="search-file" onContextMenu={(event) => { event.preventDefault(); void treeMenu(node.path, false) }} onKeyDown={(event) => menuKey(event, node.path, false)} data-id={node.path} key={node.path} title={node.path} onClick={() => {
              selectNode(node)
              onOpenFile(node.path)
            }}><Icon name="file" className="s" /><span className="nm">{node.path}</span></button>} />
            {search.loading ? <p role="status" className="repository-help">{t("正在搜索…")}</p> : null}
            {search.error ? <p role="alert" className="repository-help bad">{search.error}</p> : null}
            {!search.loading && !search.error && !search.items.length ? <p className="repository-help">{t("没有匹配的文件")}</p> : null}
          </> : <p role="status" className="repository-help">{t("正在搜索…")}</p>}
        </div> : null}
        <div ref={treeList} role="group" aria-label={t("文件树")} aria-busy={!treeLoaded} data-project={project.id} tabIndex={0} onContextMenu={treeBackgroundContext} onKeyDown={treeBackgroundKey} className={`rlist ${dropTarget === '' ? 'drop-target' : ''} ${query.trim() ? 'tree-searching' : ''}`} {...dropHandlers} onScroll={(event) => { if (!scrollRestore.current && !searching.current && clearRestore.current === null) scrollPositions.current[project.id] = event.currentTarget.scrollTop }} onWheel={() => { scrollRestore.current = null; clearRestore.current = null }} onPointerDown={() => { scrollRestore.current = null; clearRestore.current = null }}>{!treeLoaded ? <p role="status" className="repository-help">{t("正在读取文件树…")}</p> : tree.length ? renderTree(tree, 0) : <p style={{ fontSize: 12, color: 'var(--faint)', padding: '4px 8px' }}>{t("目录是空的")}</p>}</div>
      </>
    )
  }

  return (
    <aside className="right" data-placement={placement} aria-label={t("文件面板")}>
      <div className="right-resize" role="separator" aria-label={t("调整文件面板宽度")} aria-orientation="vertical" aria-valuenow={width} aria-valuemin={220} tabIndex={0}
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
        <div className="mode-cluster">
          <div className="seg plain-seg" role="radiogroup" aria-label={t("文件面板模式")}>
            <button className={mode === 'files' ? 'on' : ''} role="radio" aria-checked={mode === 'files'} aria-label={t("文件")} title={t("文件")} data-a="rmode" data-id="files" onClick={() => onMode('files')}>
              <Icon name="file" className="s" />
            </button>
            <button className={mode === 'changes' ? 'on' : ''} role="radio" aria-checked={mode === 'changes'} aria-label={t("变更")} title={t("变更")} data-a="rmode" data-id="changes" onClick={() => onMode('changes')}>
              <Icon name="changes" className="s" />
            </button>
          </div>
          <button ref={searchButton} className={`ib ${mode === 'search' ? 'on' : ''}`} data-a="file-search" aria-label={t("搜索内容")} aria-pressed={mode === 'search'} title={t("搜索内容")} onClick={searchAction}><Icon name="search" /></button>
        </div>
        <span className="grow" />
        <button className="ib" data-a="right" title={t("收起面板")} aria-label={t("收起文件面板")} onClick={onCollapse}>
          <Icon name="panel" />
        </button>
      </div>
      {context ? <div className="terminal-file-context" role="status" title={`${context.user}@${context.hostname} · ${context.cwd}`}><Icon name="server" className="s" /><span>{context.user}@{context.hostname}<small>{context.cwd}</small></span></div> : null}
      {body}
      {moving ? <MoveEntryDialog projectId={moving.projectId} path={moving.path} directory={moving.dir} onCancel={() => setMoving(null)} onMove={async (parent) => { await onMove(moving.projectId, moving.path, parent, moving.dir); setMoving(null) }} /> : null}
      {transfers.length ? <section className="transfer-list" aria-label={t("传输任务")}>
        {transfers.filter((task) => !transferNeedsAttention(task)).map((task) => <UploadStatus key={task.id} tasks={[task]} onDismiss={onDismissTransfer} />)}
        {attention.length ? <UploadStatus key="attention" tasks={attention} onDismiss={onDismissTransfer} /> : null}
      </section> : null}
      {referencePath !== null ? <ReferenceDialog projectId={project.id} path={referencePath} terms={referenceTerms} onCancel={() => setReferencePath(null)} onConfirm={(id, value) => { onReference(id, value); setReferencePath(null) }} /> : null}
      {creating ? <CreateEntryDialog parent={creating.parent} directory={creating.directory} windows={host.platform === 'windows'} existing={(creating.parent ? treeChildren[`${creating.projectId}:${creating.parent}`] || [] : tree).map((node) => node.name)} onCancel={() => setCreating(null)} onCreate={async (name) => {
        const entry = creating
        const path = await window.awb.treeCreate(entry.projectId, entry.parent, name, entry.directory)
        onTreeRulesChanged()
        setCreating(null)
        const visible = await onRevealFile(entry.projectId, entry.directory ? `${path}/_` : path).catch((error: unknown) => { setTreeError(error instanceof Error ? error.message : t("已创建，但无法定位")); return false })
        if (visible) {
          setSelections((current) => ({ ...current, [entry.projectId]: { path, dir: entry.directory } }))
          if (!entry.directory) onOpenFile(path)
        }
      }} /> : null}
      <div className="rfoot">
        <Icon name={host.id === 'local' ? 'laptop' : 'server'} className="s" />
        <span>{hostDisplayName(host)}</span>
        <span>·</span>
        <span>{host.os}</span>
      </div>
    </aside>
  )
}
