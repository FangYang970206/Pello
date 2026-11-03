import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { AgentInfo, Database, FileDiff, GitPanel, Host, SettingsSection, ShellKind, ThemeName, TreeNode } from '../shared/types'
import { PRESETS, SHELL_AGENT, cmdline, resolveAgent, shellLabel, uid } from '../shared/types'
import { Icon } from './icons'
import appIcon from '../../assets/icon-small.svg'
import { dropTerm, paint, syncTermSize, writeNotice, writeTerm } from './terms'
import { SettingsView } from './SettingsView'
import { ConfirmDialog, ExecDialog, HostDialog, NewProjectDialog, NewTermDialog, dialogOpener, focusableIn } from './Dialogs'
import { RightPanel } from './RightPanel'
import { Workspace, type FileTab, type Tab, type TermTab } from './Workspace'
import { codeFont, uiFont } from '../shared/fonts'
import { AUTO_SAVE_DELAY, documentKey, editableText, fileText, isDirty, recordChange, undoDocument, type DocumentDraft } from './documents'

type Modal =
  | { type: 'project' }
  | { type: 'term' }
  | { type: 'exec'; id?: string }
  | { type: 'host'; id?: string }
  | { type: 'confirm'; title: string; body: ReactNode; ok: string; run: () => void; save?: () => void }

type GitState = GitPanel & { untracked: Record<string, boolean> }

function shellFor(host: Host | undefined, pref: ShellKind): ShellKind {
  if (host?.platform === 'linux') return pref === 'zsh' ? 'zsh' : 'bash'
  if (pref === 'cmd') return 'cmd'
  return 'pwsh'
}

export function App() {
  const [db, setDb] = useState<Database | null>(null)
  const [installed, setInstalled] = useState<Record<string, boolean>>({})
  const [route, setRoute] = useState<'work' | 'settings'>('work')
  const [section, setSection] = useState<SettingsSection>('general')
  const [projectId, setProjectId] = useState<string | null>(null)
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeMap, setActiveMap] = useState<Record<string, string | undefined>>({})
  const activeMapRef = useRef(activeMap)
  activeMapRef.current = activeMap
  const [menuId, setMenuId] = useState<string | null>(null)
  const [right, setRight] = useState(true)
  const [rightWidth, setRightWidth] = useState(() => Number(localStorage.getItem('awb:rightWidth')) || 296)
  const [rmode, setRmode] = useState<'files' | 'changes'>('changes')
  const [dmode, setDmode] = useState<'unified' | 'split'>('unified')
  const [openDirs, setOpenDirs] = useState<Record<string, boolean>>({})
  const openDirsRef = useRef(openDirs)
  openDirsRef.current = openDirs
  const [modal, setModal] = useState<Modal | null>(null)
  const [toasts, setToasts] = useState<{ id: string; text: string; bad?: boolean }[]>([])
  const [git, setGit] = useState<GitState | null>(null)
  const [tree, setTree] = useState<TreeNode[]>([])
  const [treeChildren, setTreeChildren] = useState<Record<string, TreeNode[]>>({})
  const directoryRequests = useRef(new Set<string>())
  const [diff, setDiff] = useState<FileDiff | null>(null)
  const [documents, setDocuments] = useState<Record<string, DocumentDraft>>({})
  const documentsRef = useRef(documents)
  documentsRef.current = documents
  const savingDocuments = useRef(new Set<string>())
  const autoSaveTimers = useRef(new Map<string, { draft: string; timer: ReturnType<typeof setTimeout> }>())
  const [gitTick, setGitTick] = useState(0)
  const booted = useRef(false)
  const closingTerms = useRef(new Set<string>())
  const touring = useRef(false)
  const modalRef = useRef<Modal | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const settingsOpener = useRef<HTMLElement | null>(null)
  const settingsReturn = useRef<HTMLElement | null>(null)
  modalRef.current = modal

  useEffect(() => { localStorage.setItem('awb:rightWidth', String(rightWidth)) }, [rightWidth])

  function resizeRight(width: number) {
    const sideWidth = window.innerWidth <= 1180 ? 216 : 240
    setRightWidth(Math.max(220, Math.min(width, window.innerWidth - sideWidth - 320, 800)))
  }

  useEffect(() => {
    const onResize = () => setRightWidth((width) => Math.max(220, Math.min(width, window.innerWidth - (window.innerWidth <= 1180 ? 216 : 240) - 320, 800)))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  async function toggleDirectory(rel: string) {
    if (!project) return
    const key = `${project.id}:${rel}`
    const open = !openDirs[key]
    setOpenDirs((map) => ({ ...map, [key]: open }))
    if (!open || directoryRequests.current.has(key)) return
    directoryRequests.current.add(key)
    try {
      const nodes = await window.awb.gitTree(project.id, rel)
      setTreeChildren((map) => ({ ...map, [key]: nodes }))
    } catch (error) {
      setOpenDirs((map) => ({ ...map, [key]: false }))
      toast(error instanceof Error ? error.message : '无法读取目录', true)
    } finally { directoryRequests.current.delete(key) }
  }

  const toast = useCallback((text: string, bad = false) => {
    const id = uid('z')
    if (toastTimer.current) clearTimeout(toastTimer.current)
    setToasts([{ id, text, bad }])
    toastTimer.current = setTimeout(() => {
      setToasts((list) => list.filter((item) => item.id !== id))
      toastTimer.current = null
    }, 2000)
  }, [])

  useEffect(() => {
    void window.awb.getState().then((state) => {
      setDb(state.db)
      setInstalled(state.installed)
    })
  }, [])

  useEffect(() => {
    if (!db) return
    document.documentElement.dataset.theme = db.settings.theme
    document.documentElement.style.setProperty('--fs', `${db.settings.fontSize}px`)
    document.documentElement.style.setProperty('--mono', codeFont(db.settings.fontFamily))
    document.documentElement.style.setProperty('--ui', uiFont(db.settings.uiFontFamily))
    document.documentElement.style.setProperty('--ui-size', `${db.settings.uiFontSize || 13}px`)
    document.documentElement.style.setProperty('--editor-size', `${db.settings.editorFontSize || 14}px`)
  }, [db])

  useEffect(() => {
    if (!menuId) return
    const close = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('.pmenu, .more')) return
      setMenuId(null)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [menuId])

  const project = db?.projects.find((item) => item.id === projectId) || null
  const host = db?.hosts.find((item) => item.id === project?.host) || db?.hosts[0]
  const theme: ThemeName = db?.settings.theme || 'dark'
  const projectTabs = project ? tabs.filter((tab) => tab.projectId === project.id) : []
  const active = projectTabs.find((tab) => tab.id === activeMap[project?.id || '']) ?? projectTabs[0]
  const preview = active?.type === 'file' ? documents[documentKey(active.projectId, active.path)] || null : null
  const agents: AgentInfo[] = db
    ? [...PRESETS.map((item) => resolveAgent(item.id, db.custom, installed)), ...db.custom.map((item) => resolveAgent(item.id, db.custom, installed)), SHELL_AGENT]
    : []

  const persist = useCallback((next: Tab[], activeIds?: Record<string, string | undefined>) => {
    if (!db) return
    const map = activeIds ?? activeMapRef.current
    for (const item of db.projects) {
      const terms = next
        .filter((tab): tab is TermTab => tab.type === 'term' && tab.projectId === item.id)
        .map((tab) => ({ id: tab.id, kind: tab.kind, shell: tab.shell }))
      const wanted = map[item.id]
      const activeId = terms.some((term) => term.id === wanted) ? wanted : terms[0]?.id ?? null
      void window.awb.saveSessions(item.id, terms, activeId)
    }
  }, [db])

  const openTerm = useCallback(async (target: NonNullable<typeof project>, kind: string, shell: ShellKind, activate = true, existingId?: string) => {
    const id = existingId || uid('t')
    closingTerms.current.delete(id)
    const tab: TermTab = {
      id,
      type: 'term',
      projectId: target.id,
      kind,
      shell,
      state: kind === 'shell' ? 'idle' : 'running',
      startedAt: kind === 'shell' ? null : Date.now(),
      exitCode: null,
      inputReady: false
    }
    setTabs((list) => (list.some((item) => item.id === id) ? list : [...list, tab]))
    if (activate) setActiveMap((map) => ({ ...map, [target.id]: id }))
    try {
      const info = await window.awb.ptyCreate({ id, projectId: target.id, kind, shell })
      syncTermSize(id)
      setTabs((list) => {
        const next = list.map((item) =>
          item.id === id && item.type === 'term'
            ? { ...item, shell: info.shell, state: info.state as TermTab['state'], startedAt: info.startedAt, exitCode: info.exitCode, inputReady: info.inputReady }
            : item
        )
        const ids = activate ? { ...activeMapRef.current, [target.id]: id } : activeMapRef.current
        persist(next, ids)
        return next
      })
      return id
    } catch (err) {
      setTabs((list) => {
        const next = list.filter((item) => item.id !== id)
        const mine = next.filter((item) => item.projectId === target.id)
        const current = activeMapRef.current[target.id]
        const keep = current !== id && mine.some((item) => item.id === current) ? current : mine[0]?.id
        const activeIds = { ...activeMapRef.current, [target.id]: keep }
        setActiveMap(activeIds)
        persist(next, activeIds)
        return next
      })
      toast(err instanceof Error ? err.message : '无法启动终端', true)
      return null
    }
  }, [persist, toast])

  useEffect(() => {
    if (!db || touring.current) return
    touring.current = true
    void window.awb.meta().then((meta) => {
      if (!meta.capture) return
      void import('./tour').then((mod) => mod.runTour())
    })
  }, [db])

  useEffect(() => {
    if (!db || booted.current) return
    booted.current = true
    const first = db.projects[0]?.id ?? null
    setProjectId(first)
    if (!db.settings.restore) return
    const seeded: Record<string, string | undefined> = {}
    for (const item of db.projects) {
      const saved = db.sessions[item.id] || []
      if (!saved.length) continue
      const wanted = db.activeTab?.[item.id]
      seeded[item.id] = saved.some((term) => term.id === wanted) ? wanted : saved[0].id
      for (const term of saved) void openTerm(item, term.kind, term.shell, false, term.id)
    }
    setActiveMap(seeded)
  }, [db, openTerm])

  useEffect(() => {
    setActiveMap((map) => {
      const ids = new Set([...Object.keys(map), ...tabs.map((tab) => tab.projectId)])
      const next = { ...map }
      let changed = false
      for (const id of ids) {
        const mine = tabs.filter((tab) => tab.projectId === id)
        if (!mine.length) {
          if (id in next) {
            delete next[id]
            changed = true
          }
          continue
        }
        if (!mine.some((tab) => tab.id === next[id])) {
          next[id] = mine[0].id
          changed = true
        }
      }
      return changed ? next : map
    })
  }, [tabs])

  useEffect(() => {
    return window.awb.onPty((event) => {
      if (closingTerms.current.has(event.id)) return
      if (event.type === 'data') {
        writeTerm(event.id, event.data)
        return
      }
      setTabs((list) =>
        list.map((tab) =>
          tab.id === event.id && tab.type === 'term'
            ? { ...tab, state: event.state, exitCode: event.exitCode, startedAt: event.startedAt, inputReady: event.inputReady }
            : tab
        )
      )
      if (!event.announce) return
      const mode = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
      if (event.reason === 'kill') writeNotice(event.id, mode, 'red', '[进程已被强制结束]')
      writeNotice(event.id, mode, 'faint', `[进程已退出，退出码 ${event.exitCode ?? 0}]`)
    })
  }, [])

  useEffect(() => {
    if (!project || route !== 'work') return
    let stop = false
    const load = () => {
      void window.awb
        .gitStatus(project.id)
        .then((panel) => {
          if (!stop) setGit(panel)
        })
        .catch(() => undefined)
      if (rmode === 'files') {
        void window.awb
          .gitTree(project.id)
          .then((nodes) => {
            if (!stop) setTree(nodes)
          })
          .catch(() => undefined)
        for (const [key, open] of Object.entries(openDirsRef.current)) {
          if (!open || !key.startsWith(`${project.id}:`) || directoryRequests.current.has(key)) continue
          directoryRequests.current.add(key)
          void window.awb.gitTree(project.id, key.slice(project.id.length + 1)).then((nodes) => {
            if (!stop) setTreeChildren((map) => ({ ...map, [key]: nodes }))
          }).catch(() => undefined).finally(() => directoryRequests.current.delete(key))
        }
      }
    }
    load()
    const timer = setInterval(load, rmode === 'files' ? 4000 : 2000)
    return () => {
      stop = true
      clearInterval(timer)
    }
  }, [project?.id, route, rmode, gitTick])

  useEffect(() => {
    setGit(null)
    setTree([])
    setDiff(null)
  }, [projectId])

  useEffect(() => {
    if (!project || active?.type !== 'diff') return
    let stop = false
    void window.awb.gitDiff(project.id, active.path, !!git?.untracked[active.path]).then((file) => {
      if (!stop) setDiff(file)
    }).catch((err) => toast(err instanceof Error ? err.message : '无法读取差异', true))
    return () => {
      stop = true
    }
  }, [project?.id, active?.type === 'diff' ? active.path : '', gitTick])

  useEffect(() => {
    if (!project || active?.type !== 'file') return
    const key = documentKey(project.id, active.path)
    if (documentsRef.current[key]) return
    let stop = false
    void window.awb.gitRead(project.id, active.path).then((file) => {
      if (!stop) setDocuments((map) => ({ ...map, [key]: { ...file, projectId: project.id, path: active.path, draft: editableText(file.text) } }))
    }).catch((error) => toast(error instanceof Error ? error.message : '无法读取文件', true))
    return () => {
      stop = true
    }
  }, [project?.id, active?.type === 'file' ? active.id + active.path : ''])

  useEffect(() => {
    window.awb.setUnsavedChanges(Object.values(documents).some(isDirty))
  }, [documents])

  useEffect(() => {
    const onUnload = (event: BeforeUnloadEvent) => {
      if (!Object.values(documentsRef.current).some(isDirty)) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onUnload)
    return () => window.removeEventListener('beforeunload', onUnload)
  }, [])

  function putDocument(key: string, doc: DocumentDraft) {
    documentsRef.current = { ...documentsRef.current, [key]: doc }
    setDocuments((map) => ({ ...map, [key]: doc }))
  }

  function updateFileDraft(id: string, update: (doc: DocumentDraft) => DocumentDraft) {
    const tab = tabs.find((item): item is FileTab => item.id === id && item.type === 'file')
    if (!tab) return
    const key = documentKey(tab.projectId, tab.path)
    const doc = documentsRef.current[key]
    if (!doc) return
    const next = update(doc)
    putDocument(key, next)
    setTabs((list) => list.map((item) => item.id === id ? { ...item, pinned: true, dirty: isDirty(next) } : item))
  }

  function editFile(id: string, draft: string) { updateFileDraft(id, (doc) => recordChange(doc, draft)) }
  function historyFile(id: string, redo: boolean) { updateFileDraft(id, (doc) => undoDocument(doc, redo)) }
  function composeFile(id: string, composing: boolean) { updateFileDraft(id, (doc) => ({ ...doc, composing })) }

  async function saveFile(tab: FileTab, automatic = false): Promise<boolean> {
    const key = documentKey(tab.projectId, tab.path)
    const doc = documentsRef.current[key]
    if (!doc?.version || doc.binary || doc.missing || doc.tooBig || savingDocuments.current.has(key)) return false
    if (!isDirty(doc)) return true
    savingDocuments.current.add(key)
    putDocument(key, { ...doc, saving: true, error: undefined })
    try {
      const saved = await window.awb.gitWrite(tab.projectId, tab.path, fileText(doc), doc.version)
      const latest = documentsRef.current[key] || doc
      const draft = latest.draft === doc.draft ? editableText(saved.text) : latest.draft
      putDocument(key, { ...latest, ...saved, draft, saving: false, error: undefined })
      setTabs((list) => list.map((item) => item.id === tab.id ? { ...item, dirty: draft !== editableText(saved.text) } : item))
      setGitTick((tick) => tick + 1)
      toast(automatic ? '已自动保存' : '文件已保存')
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : '保存失败'
      putDocument(key, { ...(documentsRef.current[key] || doc), saving: false, error: message })
      if (!automatic) toast(message, true)
      return false
    } finally { savingDocuments.current.delete(key) }
  }

  useEffect(() => {
    const timers = autoSaveTimers.current
    const paused = modal?.type === 'confirm'
    for (const [key, pending] of timers) {
      const doc = documents[key]
      if (paused || !doc || !isDirty(doc) || doc.saving || doc.composing || doc.error || doc.draft !== pending.draft) {
        clearTimeout(pending.timer)
        timers.delete(key)
      }
    }
    if (paused) return
    for (const [key, doc] of Object.entries(documents)) {
      if (!isDirty(doc) || doc.saving || doc.composing || doc.error || doc.binary || doc.missing || doc.tooBig || timers.has(key)) continue
      const tab = tabs.find((item): item is FileTab => item.type === 'file' && item.projectId === doc.projectId && item.path === doc.path)
      if (!tab) continue
      const timer = setTimeout(() => { timers.delete(key); void saveFile(tab, true) }, AUTO_SAVE_DELAY)
      timers.set(key, { draft: doc.draft, timer })
    }
  }, [documents, tabs, modal])

  useEffect(() => () => { for (const { timer } of autoSaveTimers.current.values()) clearTimeout(timer) }, [])

  async function previewHtml(id: string) {
    const tab = tabs.find((item): item is FileTab => item.id === id && item.type === 'file')
    if (!tab) return
    const doc = documentsRef.current[documentKey(tab.projectId, tab.path)]
    if (doc && isDirty(doc) && !await saveFile(tab)) return
    try { await window.awb.openHtmlPreview(tab.projectId, tab.path) } catch (error) { toast(String(error), true) }
  }

  function reloadFile(id: string) {
    const tab = tabs.find((item): item is FileTab => item.id === id && item.type === 'file')
    if (!tab) return
    const key = documentKey(tab.projectId, tab.path)
    const reload = () => {
      setModal(null)
      void window.awb.gitRead(tab.projectId, tab.path).then((file) => {
        setDocuments((map) => ({ ...map, [key]: { ...file, projectId: tab.projectId, path: tab.path, draft: editableText(file.text) } }))
        setTabs((list) => list.map((item) => item.id === tab.id ? { ...item, dirty: false } : item))
      }).catch((error) => toast(String(error), true))
    }
    if (documentsRef.current[key] && isDirty(documentsRef.current[key])) {
      setModal({ type: 'confirm', title: '重新读取文件？', body: '这会放弃此文件尚未保存的更改。', ok: '放弃并重新读取', run: reload })
    } else reload()
  }

  async function closeTab(id: string) {
    const tab = tabs.find((item) => item.id === id)
    if (!tab || closingTerms.current.has(id)) return
    if (tab.type === 'term') {
      closingTerms.current.add(id)
      try {
        await window.awb.ptyClose(id)
      } catch (error) {
        closingTerms.current.delete(id)
        toast(error instanceof Error ? error.message : '无法关闭终端', true)
        return
      }
      dropTerm(id)
    }
    if (tab.type === 'file') setDocuments((map) => {
      const next = { ...map }
      delete next[documentKey(tab.projectId, tab.path)]
      return next
    })
    setTabs((list) => {
      const next = list.filter((item) => item.id !== id)
      const mine = next.filter((item) => item.projectId === tab.projectId)
      let preferred = activeMapRef.current[tab.projectId]
      if (preferred === id) preferred = undefined
      const keep = mine.some((item) => item.id === preferred) ? preferred : mine[0]?.id
      const activeIds = { ...activeMapRef.current, [tab.projectId]: keep }
      activeMapRef.current = activeIds
      setActiveMap(activeIds)
      persist(next, activeIds)
      return next
    })
  }

  function requestClose(id: string) {
    const tab = tabs.find((item) => item.id === id)
    if (!tab || !db) return
    if (tab.type === 'file') {
      const doc = documentsRef.current[documentKey(tab.projectId, tab.path)]
      if (doc?.saving) { toast('文件正在保存，请稍候'); return }
      if (doc && isDirty(doc)) {
        setModal({ type: 'confirm', title: '文件尚未保存', body: `${tab.path} 有未保存的更改。`, ok: '放弃并关闭',
          run: () => { setModal(null); void closeTab(id) },
          save: () => { void saveFile(tab).then((saved) => { if (saved) { setModal(null); void closeTab(id) } }) }
        })
        return
      }
    }
    if (tab.type !== 'term' || tab.state !== 'running' || !db.settings.confirmKill) {
      void closeTab(id)
      return
    }
    const agent = resolveAgent(tab.kind, db.custom, installed)
    const procName = tab.kind === 'shell' ? shellLabel(tab.shell) : agent.name
    const procCmd = cmdline(agent) || shellLabel(tab.shell)
    setModal({
      type: 'confirm',
      title: '关闭标签？',
      ok: '结束并关闭',
      body: (
        <>
          关闭标签会结束正在运行的 <b>{procName}</b>（<span className="mono">{procCmd}</span>）。未保存的会话会丢失，已写入磁盘的文件不受影响。
        </>
      ),
      run: () => {
        setModal(null)
        void closeTab(id)
      }
    })
  }

  function selectProject(id: string) {
    setProjectId(id)
    const mine = tabs.filter((tab) => tab.projectId === id)
    if (mine.length && !mine.some((tab) => tab.id === activeMap[id])) {
      const activeIds = { ...activeMap, [id]: mine[0].id }
      setActiveMap(activeIds)
      persist(tabs, activeIds)
    }
    setRoute('work')
    setModal(null)
    setMenuId(null)
  }

  function selectTab(id: string) {
    if (!project) return
    const activeIds = { ...activeMap, [project.id]: id }
    setActiveMap(activeIds)
    if (tabs.some((tab) => tab.id === id && tab.type === 'term')) persist(tabs, activeIds)
  }

  function askDiscard() {
    if (!project || active?.type !== 'diff') return
    const rel = active.path
    const untracked = !!git?.untracked[rel]
    setModal({
      type: 'confirm',
      title: untracked ? '删除新文件？' : '放弃更改？',
      ok: untracked ? '删除文件' : '放弃更改',
      body: untracked ? (
        <>
          <span className="mono">{rel}</span> 尚未被 Git 跟踪，将从磁盘删除（<code className="mono">git clean -f</code>），无法撤销。
        </>
      ) : (
        <>
          <span className="mono">{rel}</span> 的工作区修改将被还原（git restore），无法撤销。
        </>
      ),
      run: () => {
        setModal(null)
        void window.awb
          .gitDiscard(project.id, rel, !!git?.untracked[rel])
          .then(() => {
            setTabs((list) => {
              const next = list.filter((tab) => !(tab.type === 'diff' && tab.projectId === project.id && tab.path === rel))
              if (activeMap[project.id] === active.id) {
                const rest = next.filter((tab) => tab.projectId === project.id)
                const keep = rest[0]?.id
                const activeIds = { ...activeMap, [project.id]: keep }
                setActiveMap(activeIds)
                persist(next, activeIds)
              }
              return next
            })
            setGitTick((n) => n + 1)
            toast(untracked ? '已删除文件' : '已放弃更改')
          })
          .catch((err) => toast(err instanceof Error ? err.message : '放弃失败', true))
      }
    })
  }

  function openDiff(rel: string) {
    if (!project) return
    const existing = tabs.find((tab) => tab.type === 'diff' && tab.projectId === project.id)
    if (existing) {
      setTabs((list) => list.map((tab) => (tab.id === existing.id && tab.type === 'diff' ? { ...tab, path: rel } : tab)))
      setActiveMap((map) => ({ ...map, [project.id]: existing.id }))
      return
    }
    const id = uid('d')
    setTabs((list) => [...list, { id, type: 'diff', projectId: project.id, path: rel }])
    setActiveMap((map) => ({ ...map, [project.id]: id }))
  }

  function openFile(rel: string) {
    if (!project) return
    const opened = tabs.find((tab) => tab.type === 'file' && tab.projectId === project.id && tab.path === rel)
    if (opened) { selectTab(opened.id); return }
    const existing = tabs.find((tab) => tab.type === 'file' && tab.projectId === project.id && !tab.pinned)
    if (existing && existing.type === 'file') {
      setDocuments((map) => {
        const next = { ...map }
        delete next[documentKey(existing.projectId, existing.path)]
        return next
      })
      setTabs((list) => list.map((tab) => (tab.id === existing.id && tab.type === 'file' ? { ...tab, path: rel } : tab)))
      setActiveMap((map) => ({ ...map, [project.id]: existing.id }))
      return
    }
    const id = uid('f')
    setTabs((list) => [...list, { id, type: 'file', projectId: project.id, path: rel, pinned: false }])
    setActiveMap((map) => ({ ...map, [project.id]: id }))
  }

  function pinFile(id: string) {
    setTabs((list) => list.map((tab) => (tab.id === id && tab.type === 'file' ? { ...tab, pinned: true } : tab)))
  }

  function askRemove(id: string) {
    if (!db) return
    const item = db.projects.find((projectItem) => projectItem.id === id)
    if (!item) return
    const unsaved = Object.values(documentsRef.current).filter((doc) => doc.projectId === id && isDirty(doc)).length
    if (Object.values(documentsRef.current).some((doc) => doc.projectId === id && doc.saving)) { toast('文件正在保存，请稍候'); return }
    const itemHost = db.hosts.find((hostItem) => hostItem.id === item.host) || db.hosts[0]
    const running = tabs.filter((tab) => tab.projectId === id && tab.type === 'term' && tab.state === 'running').length
    setMenuId(null)
    setModal({
      type: 'confirm',
      title: '移除项目？',
      ok: '移除',
      body: (
        <>
          将从列表中移除 {item.name}，并关闭它的所有终端。{itemHost?.name || '本机'}上的目录 <span className="mono">{item.path}</span> 及其中的文件不会被删除。
          {running ? <> 有 {running} 个正在运行的进程会被结束。</> : null}
          {unsaved ? <> 此项目有 {unsaved} 个文件尚未保存，更改会被放弃。</> : null}
        </>
      ),
      run: async () => {
        const terms = tabs.filter((tab) => tab.projectId === id && tab.type === 'term')
        for (const tab of terms) closingTerms.current.add(tab.id)
        try {
          await Promise.all(terms.map((tab) => window.awb.ptyClose(tab.id)))
        } catch (error) {
          for (const tab of terms) closingTerms.current.delete(tab.id)
          toast(error instanceof Error ? error.message : '无法关闭项目终端', true)
          return
        }
        for (const tab of terms) dropTerm(tab.id)
        const projects = db.projects.filter((projectItem) => projectItem.id !== id)
        setTabs((list) => list.filter((tab) => tab.projectId !== id))
        setDocuments((map) => Object.fromEntries(Object.entries(map).filter(([, doc]) => doc.projectId !== id)))
        setDb({ ...db, projects })
        if (projectId === id) setProjectId(projects[0]?.id ?? null)
        setModal(null)
        void window.awb.saveProjects(projects)
        void window.awb.saveSessions(id, [], null)
        toast(`已移除 ${item.name}`)
      }
    })
  }

  function openSettings(next?: SettingsSection) {
    if (route !== 'settings') {
      settingsOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    }
    if (next) setSection(next)
    setRoute('settings')
  }

  function closeSettings() {
    settingsReturn.current = settingsOpener.current
    settingsOpener.current = null
    setRoute('work')
  }

  function onAppKey(key: string) {
    if (modalRef.current || document.querySelector('dialog[open]')) return
    if (key === 'n') setModal({ type: 'project' })
    else if (key === 't') {
      if (!project) setModal({ type: 'project' })
      else setModal({ type: 'term' })
    } else if (key === ',') openSettings()
    else if (key === 'b') setRight((value) => !value)
    else if (key === 'w' && active) requestClose(active.id)
    else if (key === 's' && active?.type === 'file') void saveFile(active)
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (document.querySelector('dialog[open]')) return
      const target = event.target instanceof Element ? event.target : null
      const field = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')
      const inTerm = !!target?.closest('.xterm')
      if (event.key === 'Escape') {
        if (modalRef.current) {
          setModal(null)
          return
        }
        if (menuId) {
          setMenuId(null)
          return
        }
        if (!field && route === 'settings') {
          closeSettings()
          return
        }
      }
      if (field || inTerm || modalRef.current) return
      if (!event.ctrlKey || event.altKey || event.metaKey) return
      const key = event.key.toLowerCase()
      if (key === 'n' || key === 't' || key === ',' || key === 'b' || key === 'w' || (key === 's' && active?.type === 'file')) {
        event.preventDefault()
        onAppKey(key)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const workspaceLocked = route === 'settings' || modal !== null
  useLayoutEffect(() => {
    document.querySelectorAll<HTMLElement>('aside.side, #center, aside.right').forEach((el) => {
      if (workspaceLocked) {
        el.setAttribute('inert', '')
        el.setAttribute('aria-hidden', 'true')
      } else {
        el.removeAttribute('inert')
        el.removeAttribute('aria-hidden')
      }
    })
    const restore = (node: HTMLElement | null) => {
      if (!node?.isConnected || node.closest('[inert]')) return false
      node.focus()
      return true
    }
    if (restore(dialogOpener.current)) dialogOpener.current = null
    if (route === 'work' && restore(settingsReturn.current)) settingsReturn.current = null
  }, [workspaceLocked, route])

  useEffect(() => {
    if (route !== 'settings' || modal) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || document.querySelector('dialog[open]')) return
      const root = document.querySelector('.settings')
      if (!root) return
      const items = focusableIn(root)
      if (!items.length) return
      const current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      const index = current ? items.indexOf(current) : -1
      const next = event.shiftKey ? (index <= 0 ? items.length - 1 : index - 1) : index === -1 || index >= items.length - 1 ? 0 : index + 1
      event.preventDefault()
      event.stopPropagation()
      items[next].focus()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [route, modal])

  const withRight = route === 'work' && !!project && right
  const editing = modal?.type === 'exec' ? db?.custom.find((item) => item.id === modal.id) || null : null
  const editingHost = modal?.type === 'host' && modal.id ? db?.hosts.find((item) => item.id === modal.id) || null : null

  return (
    <>
      <div id="app" className={withRight ? 'with-right' : ''} style={{ '--right-width': `${rightWidth}px` } as CSSProperties}>
        <header className="title">
          <div className="brand">
            <img className="logo" src={appIcon} width="18" height="18" alt="" aria-hidden="true" />
            Agent Workbench
          </div>
          <span className="grow" />
          <div className="wc">
            <button aria-label="最小化" onClick={() => void window.awb.winMin()}>
              <Icon name="minus" className="s" />
            </button>
            <button aria-label="最大化" onClick={() => void window.awb.winMax()}>
              <Icon name="square" className="s" />
            </button>
            <button className="close" aria-label="关闭窗口" onClick={() => void window.awb.winClose()}>
              <Icon name="x" className="s" />
            </button>
          </div>
        </header>
        <div className="body">
          <div id="workspace" style={{ display: route === 'settings' ? 'none' : 'contents' }} inert={workspaceLocked ? true : undefined} aria-hidden={workspaceLocked ? true : undefined}>
              <aside className="side" aria-label="项目">
                <button className="newp" data-a="newproj" onClick={() => setModal({ type: 'project' })}>
                  <Icon name="plus" />
                  新建项目
                </button>
                <div className="sec">项目</div>
                <nav className="plist" aria-label="项目">
                  {db?.projects.length ? (
                    db.projects.map((item) => {
                      const itemHost = db.hosts.find((hostItem) => hostItem.id === item.host) || db.hosts[0]
                      const live = tabs.some((tab) => tab.projectId === item.id && tab.type === 'term' && tab.state === 'running')
                      const on = projectId === item.id && route === 'work'
                      const open = menuId === item.id
                      return (
                        <div
                          key={item.id}
                          className={`proj ${on ? 'on' : ''} ${open ? 'menu' : ''}`}
                          data-a="proj"
                          data-id={item.id}
                          aria-current={on ? 'true' : undefined}
                          onContextMenu={(event) => {
                            event.preventDefault()
                            setMenuId(item.id)
                          }}
                        >
                          <button className="project-open" aria-label={`打开项目 ${item.name}`} aria-current={on ? 'true' : undefined}
                            title={`${item.name}\n${item.path}`} onClick={() => selectProject(item.id)}>
                            <span className="pi">{item.name[0]?.toUpperCase()}</span>
                            <span className="grow">
                              <span className="n" style={{ display: 'block' }}>{item.name}</span>
                              <span className="m">
                                <Icon name={itemHost.id === 'local' ? 'laptop' : 'server'} className="s" />
                                {itemHost.name}
                              </span>
                            </span>
                            {live ? <span className="live" title="有终端在运行" aria-label="有终端在运行" /> : null}
                          </button>
                          <button
                            className="more"
                            data-a="proj-more"
                            data-id={item.id}
                            aria-label={`项目菜单 ${item.name}`}
                            onClick={(event) => {
                              event.stopPropagation()
                              setMenuId(open ? null : item.id)
                            }}
                          >
                            <Icon name="more" className="s" />
                          </button>
                          {open ? (
                            <div className="pmenu" role="menu">
                              <button
                                data-a="proj-remove"
                                role="menuitem"
                                onClick={(event) => {
                                  event.stopPropagation()
                                  askRemove(item.id)
                                }}
                              >
                                移除项目
                              </button>
                            </div>
                          ) : null}
                        </div>
                      )
                    })
                  ) : (
                    <p style={{ fontSize: 12, color: 'var(--faint)', padding: '4px 8px' }}>暂无项目</p>
                  )}
                </nav>
                <div className="sfoot">
                  <button className="navb" data-a="settings" onClick={() => openSettings()}>
                    <Icon name="settings" />
                    设置
                  </button>
                </div>
              </aside>
              <div id="mainwrap" style={{ display: 'contents' }}>
                <Workspace
                  project={project}
                  tabs={tabs}
                  active={active}
                  rightOpen={right}
                  dmode={dmode}
                  theme={theme}
                  fontSize={db?.settings.fontSize || 13}
                  fontFamily={db?.settings.fontFamily}
                  agents={agents}
                  installed={installed}
                  diff={diff}
                  preview={preview}
                  onSelect={selectTab}
                  onClose={requestClose}
                  onNewTerm={() => (project ? setModal({ type: 'term' }) : setModal({ type: 'project' }))}
                  onNewProject={() => setModal({ type: 'project' })}
                  onQuick={() => {
                    if (!project || !db || !host) return
                    void openTerm(project, project.agent, shellFor(host, db.settings.defShell))
                  }}
                  onInterrupt={(id) => {
                    void window.awb.ptyInterrupt(id).then((action) => {
                      if (action === 'hint') writeTerm(id, paint(theme, 'amber', '再次按 Ctrl+C 退出'))
                    })
                  }}
                  onToggleRight={() => setRight((value) => !value)}
                  onDmode={setDmode}
                  onDiscard={askDiscard}
                  onAppKey={onAppKey}
                  onPinFile={pinFile}
                  onEditFile={editFile}
                  onSaveFile={(id) => { const tab = tabs.find((item): item is FileTab => item.id === id && item.type === 'file'); if (tab) void saveFile(tab) }}
                  onReloadFile={reloadFile}
                  onHistoryFile={historyFile}
                  onComposeFile={composeFile}
                  onPreviewHtml={(id) => void previewHtml(id)}
                  untracked={!!(active && active.type === 'diff' && git?.untracked[active.path])}
                />
                {withRight && project && host ? (
                  <RightPanel
                    project={project}
                    host={host}
                    mode={rmode}
                    files={git?.files || []}
                    loaded={!!git}
                    isRepo={!!git?.isRepo}
                    branch={git?.branch || project.branch}
                    tree={tree}
                    treeChildren={treeChildren}
                    openDirs={openDirs}
                    width={rightWidth}
                    onResize={resizeRight}
                    activePath={active && active.type !== 'term' ? active.path : undefined}
                    onMode={setRmode}
                    onToggleDir={(dir) => void toggleDirectory(dir)}
                    onOpenDiff={openDiff}
                    onOpenFile={openFile}
                    onCollapse={() => setRight(false)}
                  />
                ) : null}
              </div>
          </div>
          {route === 'settings' && db ? (
            <SettingsView
              section={section}
              settings={db.settings}
              custom={db.custom}
              hosts={db.hosts}
              installed={installed}
              onSection={(id) => {
                setSection(id)
                document.querySelector('.scontent')?.scrollTo(0, 0)
              }}
              onBack={() => closeSettings()}
              onSettings={(settings) => {
                setDb({ ...db, settings })
                void window.awb.saveSettings(settings)
              }}
              onEditExec={(id) => setModal({ type: 'exec', id })}
              onNewExec={() => setModal({ type: 'exec' })}
              onEditHost={(id) => setModal({ type: 'host', id })}
              onNewHost={() => setModal({ type: 'host' })}
              onInstall={(name, cmd) => toast(cmd ? `请先安装 ${name}，并确保命令 ${cmd} 在 PATH 中` : name)}
              onLocalHost={() => toast('本机无需配置')}
            />
          ) : null}
        </div>
      </div>
      <div id="modal">
        {modal?.type === 'confirm' ? <ConfirmDialog title={modal.title} body={modal.body} ok={modal.ok} onOk={modal.run} onSave={modal.save} onClose={() => setModal(null)} /> : null}
        {modal?.type === 'project' && db ? (
          <NewProjectDialog
            hosts={db.hosts}
            settings={db.settings}
            custom={db.custom}
            installed={installed}
            onClose={() => setModal(null)}
            onToast={toast}
            onHosts={async (hosts) => {
              const saved = await window.awb.saveHosts(hosts)
              setDb((current) => current ? { ...current, hosts: saved.hosts } : current)
            }}
            onCreate={(draft) => {
              const created = { id: uid('p'), name: draft.name, host: draft.host, path: draft.path, branch: draft.branch, agent: draft.agent }
              const projects = [created, ...db.projects]
              setDb({ ...db, projects })
              setProjectId(created.id)
              setRoute('work')
              setModal(null)
              void window.awb.saveProjects(projects)
              toast('已创建项目')
            }}
          />
        ) : null}
        {modal?.type === 'term' && project && host ? (
          <NewTermDialog
            host={host}
            cwd={project.path}
            initialKind={project.agent}
            initialShell={shellFor(host, db?.settings.defShell || 'pwsh')}
            agents={agents}
            onClose={() => setModal(null)}
            onManage={() => {
              setModal(null)
              openSettings('agents')
            }}
            onOpen={(kind, shell) => {
              setModal(null)
              void openTerm(project, kind, shell)
            }}
          />
        ) : null}
        {modal?.type === 'exec' && db ? (
          <ExecDialog
            initial={editing && modal.id ? editing : null}
            cwd={project?.path || ''}
            onClose={() => setModal(null)}
            onToast={toast}
            onDelete={(id) => {
              const custom = db.custom.filter((item) => item.id !== id)
              setDb({ ...db, custom })
              setModal(null)
              void window.awb.saveCustom(custom)
            }}
            onSave={async (exec) => {
              const custom = exec.id ? db.custom.map((item) => (item.id === exec.id ? exec : item)) : [...db.custom, { ...exec, id: uid('c') }]
              const saved = await window.awb.saveCustom(custom)
              setDb((current) => current ? { ...current, custom: saved.custom } : current)
              setModal(null)
              const state = await window.awb.getState(); setInstalled(state.installed)
              toast('已保存执行器')
            }}
          />
        ) : null}
        {modal?.type === 'host' && db ? (
          <HostDialog
            initial={editingHost}
            onClose={() => setModal(null)}
            onToast={toast}
            onDelete={(id) => {
              setModal({
                type: 'confirm',
                title: '移除机器？',
                ok: '移除',
                body: '使用这台机器的项目将无法打开终端。',
                run: async () => {
                  const hosts = db.hosts.filter((item) => item.id !== id)
                  try {
                    const saved = await window.awb.saveHosts(hosts)
                    setDb((current) => current ? { ...current, hosts: saved.hosts } : current)
                    setModal(null)
                  } catch (error) { toast(String(error), true) }
                }
              })
            }}
            onSave={async (item) => {
              const hosts = item.id ? db.hosts.map((hostItem) => (hostItem.id === item.id ? item : hostItem)) : [...db.hosts, { ...item, id: uid('h') }]
              const saved = await window.awb.saveHosts(hosts)
              setDb((current) => current ? { ...current, hosts: saved.hosts } : current)
              setModal(null)
              toast('已保存')
            }}
          />
        ) : null}
      </div>
      <div id="toasts" aria-live="polite">
        {toasts.map((item) => (
          <div key={item.id} className={`toast ${item.bad ? 'bad' : ''}`}>
            <Icon name={item.bad ? 'x' : 'check'} className="s" />
            {item.text}
          </div>
        ))}
      </div>
    </>
  )
}
