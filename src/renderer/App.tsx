import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import { getLanguage, hasMessageFragment, setLanguage, subscribeLanguage, t } from '../shared/i18n'
import type { AgentInfo, Database, FileDiff, GitPanel, Host, Settings, SettingsSection, ShellKind, ThemeName, TreeNode, WorkSession } from '../shared/types'
import { legacySessionId, sessionOf } from '../shared/work-sessions'
import { PRESETS, SHELL_AGENT, cmdline, hostDisplayName, resolveAgent, shellLabel, uid } from '../shared/types'
import { Icon } from './icons'
import appIcon from '../../assets/pello-rounded-small.svg'
import { dropTerm, holdTermHistory, paint, prependTermHistory, queueSnapshot, releaseTermHistory, retainTermHistory, setTerminalHistoryEnabled, snapshotTerms, syncTermSize, writeNotice, writeTerm } from './terms'
import { SettingsView } from './SettingsView'
import { ConfirmDialog, ExecDialog, HostDialog, NewProjectDialog, NewTermDialog, dialogOpener, focusableIn } from './Dialogs'
import { RightPanel } from './RightPanel'
import { ProjectSidebar } from './ProjectSidebar'
import { SidebarResize } from './SidebarResize'
import { TemporarySessionDialog } from './TemporarySessionDialog'
import { Workspace, fileTarget, type DiffTab, type FileTab, type Tab, type TermTab } from './Workspace'
import { codeFont, uiFont } from '../shared/fonts'
import { themeVariables, workbenchTheme } from '../shared/themes'
import { AUTO_SAVE_DELAY, documentKey, editableText, fileText, isDirty, recordChange, undoDocument, type DocumentDraft } from './documents'
import type { TransferSnapshot } from '../shared/types'
import { TRANSFER_SUCCESS_DURATION, transferSucceeded } from './UploadStatus'
import { loadTerminalLayouts } from './terminal-layout'
import { preferredGroupTab } from './workspace-layout'
import { executorForHost } from '../shared/executor'
import { savedTerminal } from './terminal-state'

type Modal =
  | { type: 'project' }
  | { type: 'temporary' }
  | { type: 'temporary-term'; root: string; hostId: string }
  | { type: 'term'; newSession?: boolean }
  | { type: 'exec'; id?: string; hostId?: string }
  | { type: 'host'; id?: string }
  | { type: 'confirm'; title: string; body: ReactNode; ok: string; run: () => void | Promise<void>; save?: () => void; className?: string }

type GitState = GitPanel & { untracked: Record<string, boolean> }

function shellFor(host: Host | undefined, pref: ShellKind): ShellKind {
  if (host?.platform === 'linux') return pref === 'zsh' ? 'zsh' : 'bash'
  if (host?.id === 'local' && pref === 'bash') return 'bash'
  if (pref === 'cmd') return 'cmd'
  return 'pwsh'
}

export function App() {
  const language = useSyncExternalStore(subscribeLanguage, getLanguage)
  useLayoutEffect(() => { document.documentElement.lang = language }, [language])
  const [db, setDb] = useState<Database | null>(null)
  const [installed, setInstalled] = useState<Record<string, boolean>>({})
  const [route, setRoute] = useState<'work' | 'settings'>('work')
  const [section, setSection] = useState<SettingsSection>('general')
  const [projectId, setProjectId] = useState<string | null>(null)
  const projectIdRef = useRef(projectId)
  projectIdRef.current = projectId
  const [tabs, setTabs] = useState<Tab[]>([])
  const restoredHistory = useRef<Record<string, { text: string }>>({})
  const historyTimers = useRef<Record<string, ReturnType<typeof setTimeout> | undefined>>({})
  const [workSessions, setWorkSessions] = useState<Record<string, WorkSession[]>>({})
  const sessionsRef = useRef(workSessions)
  const [selectedSessions, setSelectedSessions] = useState<Record<string, string>>({})
  const selectedSessionsRef = useRef(selectedSessions)
  function putSessions(next: Record<string, WorkSession[]>) { sessionsRef.current = next; setWorkSessions(next) }
  function pickSession(project: string, id: string) {
    const next = { ...selectedSessionsRef.current, [project]: id }
    selectedSessionsRef.current = next; setSelectedSessions(next)
  }
  const [activeMap, setActiveMap] = useState<Record<string, string | undefined>>({})
  const activeMapRef = useRef(activeMap)
  activeMapRef.current = activeMap
  const lastTerminal = useRef<Record<string, string>>({})
  useEffect(() => {
    for (const [project, id] of Object.entries(activeMap)) if (tabs.some((tab) => tab.id === id && tab.type === 'term')) lastTerminal.current[project] = id!
  }, [activeMap, tabs])
  const [menuId, setMenuId] = useState<string | null>(null)
  const [right, setRight] = useState(false)
  const [rightWidth, setRightWidth] = useState(() => Number(localStorage.getItem('awb:rightWidth')) || 296)
  const [sidebarWidth, setSidebarWidth] = useState(() => Math.max(180, Math.min(480, Number(localStorage.getItem('awb:sidebarWidth')) || (innerWidth <= 1180 ? 216 : 240))))
  const [temporaryBusy, setTemporaryBusy] = useState(false)
  const temporaryPending = useRef<Database['projects'][number] | null>(null)
  const temporaryStarting = useRef(false)
  const [rmode, setRmode] = useState<'files' | 'changes' | 'search'>('changes')
  const [diffModes, setDiffModes] = useState<Record<string, 'unified' | 'split'>>({})
  const [defaultDiffMode, setDefaultDiffMode] = useState<'unified' | 'split'>('unified')
  const [openDirs, setOpenDirs] = useState<Record<string, boolean>>({})
  const [treeQueries, setTreeQueries] = useState<Record<string, string>>({})
  const [contentQueries, setContentQueries] = useState<Record<string, string>>({})
  const [panelSearchFocus, setPanelSearchFocus] = useState({ mode: 'files' as 'files' | 'search', sequence: 0 })
  const [projectSearchOptions, setProjectSearchOptions] = useState<Record<string, import('../shared/types').ProjectSearchOptions>>({})
  const [treeSelections, setTreeSelections] = useState<Record<string, { path: string; dir: boolean }>>({})
  const treeScrollPositions = useRef<Record<string, number>>({})
  const openDirsRef = useRef(openDirs)
  openDirsRef.current = openDirs
  const [modal, setModal] = useState<Modal | null>(null)
  const [toasts, setToasts] = useState<{ id: string; text: string; bad?: boolean }[]>([])
  const [git, setGit] = useState<GitState | null>(null)
  const [tree, setTree] = useState<TreeNode[]>([])
  const [treeProjectId, setTreeProjectId] = useState<string | null>(null)
  const [treeChildren, setTreeChildren] = useState<Record<string, TreeNode[]>>({})
  const directoryRequests = useRef(new Set<string>())
  const [diffs, setDiffs] = useState<Record<string, FileDiff>>({})
  const [diffBaselines, setDiffBaselines] = useState<Record<string, DocumentDraft>>({})
  const [documents, setDocuments] = useState<Record<string, DocumentDraft>>({})
  const documentsRef = useRef(documents)
  documentsRef.current = documents
  const savingDocuments = useRef(new Set<string>())
  const refreshingDocuments = useRef(new Map<string, symbol>())
  const pathMutations = useRef(new Map<string, { projectId: string; path: string; directory: boolean; caseInsensitive?: boolean }>())
  const [fileReadTick, setFileReadTick] = useState(0)
  function replacementAt(projectId: string, path: string): boolean {
    return [...pathMutations.current].some(([key, operation]) => {
      if (!key.startsWith('replace:') || projectId !== operation.projectId) return false
      const current = operation.caseInsensitive ? path.toLowerCase() : path, parent = operation.caseInsensitive ? operation.path.toLowerCase() : operation.path
      return current === parent || (operation.directory && (!parent || current.startsWith(`${parent}/`)))
    })
  }
  const autoSaveTimers = useRef(new Map<string, { draft: string; timer: ReturnType<typeof setTimeout> }>())
  const [gitTick, setGitTick] = useState(0)
  const [transferStates, setTransferStates] = useState<Record<string, TransferSnapshot>>({})
  const uploadDismissTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const dismissTransfer = useCallback((id: string) => {
    clearTimeout(uploadDismissTimers.current.get(id))
    uploadDismissTimers.current.delete(id)
    setTransferStates((current) => { const next = { ...current }; delete next[id]; return next })
    void window.awb.transferDismiss(id).catch((error: unknown) => console.error(t("清理传输记录失败"), error))
  }, [])
  useEffect(() => {
    const timers = uploadDismissTimers.current
    const unsubscribe = window.awb.onTransfer((snapshot) => {
      if (snapshot.state === 'completed' || snapshot.state === 'cancelled') setGitTick((tick) => tick + 1)
      if (snapshot.state === 'cancelled' && !snapshot.warnings?.length && !snapshot.items.some((item) => hasMessageFragment(item.error, '保留于'))) { dismissTransfer(snapshot.id); return }
      setTransferStates((current) => ({ ...current, [snapshot.id]: snapshot }))
      if (transferSucceeded(snapshot)) {
        if (!timers.has(snapshot.id)) timers.set(snapshot.id, setTimeout(() => dismissTransfer(snapshot.id), TRANSFER_SUCCESS_DURATION))
      } else {
        clearTimeout(timers.get(snapshot.id)); timers.delete(snapshot.id)
      }
    })
    return () => { unsubscribe(); for (const timer of timers.values()) clearTimeout(timer); timers.clear() }
  }, [dismissTransfer])
  const booted = useRef(false)
  const restoring = useRef(false)
  const closingTerms = useRef(new Set<string>())
  const touring = useRef(false)
  const modalRef = useRef<Modal | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const replacementConfirm = useRef<string | null>(null)
  useEffect(() => window.awb.onReplacement((event) => {
    const normalize = (value: string) => event.caseInsensitive ? value.toLowerCase() : value
    const targets = event.targets || [{ projectId: event.projectId, path: event.path }]
    const matches = (projectId: string, path: string) => targets.some((target) => target.projectId === projectId && (normalize(path) === normalize(target.path) || (event.directory && (!target.path || normalize(path).startsWith(`${normalize(target.path)}/`)))))
    const affected = () => Object.values(documentsRef.current).filter((doc) => matches(doc.projectId, doc.path))
    const finishLock = () => {
      for (const key of pathMutations.current.keys()) if (key.startsWith(`replace:${event.id}:`)) pathMutations.current.delete(key)
      setFileReadTick((tick) => tick + 1)
      for (const doc of affected()) putDocument(documentKey(doc.projectId, doc.path), { ...doc, replacing: false })
      if (replacementConfirm.current === event.id) { replacementConfirm.current = null; setModal(null) }
    }
    if (event.phase === 'finish') {
      if (!event.success) { finishLock(); return }
      if (event.directory) setTreeChildren((map) => Object.fromEntries(Object.entries(map).filter(([key]) => !targets.some((target) => key === `${target.projectId}:${target.path}` || key.startsWith(`${target.projectId}:${target.path}${target.path ? '/' : ''}`)))))
      void Promise.all(affected().map(async (previous) => {
        const key = documentKey(previous.projectId, previous.path)
        try {
          const file = await window.awb.gitRead(previous.projectId, previous.path)
          const doc = documentsRef.current[key]
          if (doc === previous) {
            const next = recordChange({ ...doc, editAt: 0 }, editableText(file.text))
            putDocument(key, { ...next, ...file, tooBig: file.tooBig, assetToken: file.assetToken, fileStamp: file.fileStamp, replacing: false, replacementId: event.id, saving: false, error: undefined })
            setTabs((list) => list.map((tab) => tab.type === 'file' && fileTarget(tab) === previous.projectId && tab.path === previous.path ? { ...tab, dirty: false } : tab))
          }
        } catch (error) {
          const doc = documentsRef.current[key]
          if (doc) putDocument(key, { ...doc, error: error instanceof Error ? error.message : t("覆盖后读取失败") })
        }
      })).finally(() => { setGitTick((tick) => tick + 1); finishLock() })
      return
    }
    const docs = affected(), dirty = docs.filter(isDirty)
    if (replacementConfirm.current || (dirty.length && (modalRef.current || document.querySelector('dialog[open]'))) || docs.some((doc) => doc.saving || doc.composing || savingDocuments.current.has(documentKey(doc.projectId, doc.path))) || [...pathMutations.current.values()].some((operation) => matches(operation.projectId, operation.path) || (operation.directory && targets.some((target) => target.projectId === operation.projectId && normalize(target.path).startsWith(`${normalize(operation.path)}/`))))) {
      window.awb.replacementReady(event.id, false); return
    }
    targets.forEach((target, index) => pathMutations.current.set(`replace:${event.id}:${index}`, { ...target, directory: !!event.directory, caseInsensitive: event.caseInsensitive }))
    setFileReadTick((tick) => tick + 1)
    for (const doc of docs) {
      const key = documentKey(doc.projectId, doc.path), timer = autoSaveTimers.current.get(key)
      if (timer) { clearTimeout(timer.timer); autoSaveTimers.current.delete(key) }
      putDocument(key, { ...doc, replacing: true })
    }
    if (!dirty.length) { window.awb.replacementReady(event.id, true); return }
    replacementConfirm.current = event.id
    setModal({ type: 'confirm', title: t("覆盖未保存的文件？"), ok: t("放弃草稿并覆盖"), body: <>{event.directory ? t("替换目录") : t("文件")} <span className="mono">{event.path}</span> {t(" 会影响 ")}{dirty.length} {t(" 个未保存的文件。")}{dirty.map((doc) => <span className="mono" style={{ display: 'block' }} key={`${doc.projectId}:${doc.path}`}>{doc.path}</span>)}{t("覆盖成功后将读取新内容，撤销历史仍会保留。")}</>, run: () => { replacementConfirm.current = null; setModal(null); window.awb.replacementReady(event.id, true) } })
  }), [])
  useEffect(() => {
    if (!modal && replacementConfirm.current) { const id = replacementConfirm.current; replacementConfirm.current = null; window.awb.replacementReady(id, false) }
  }, [modal])
  const settingsOpener = useRef<HTMLElement | null>(null)
  const settingsReturn = useRef<HTMLElement | null>(null)
  modalRef.current = modal

  function resizeRight(width: number) {
    const next = Math.max(220, Math.min(width, window.innerWidth - sidebarWidth - 320, 800))
    setRightWidth(next)
    localStorage.setItem('awb:rightWidth', String(next))
  }

  function resizeSidebar(width: number) {
    const next = Math.max(180, Math.min(480, width, innerWidth - (right ? rightWidth : 0) - 320))
    setSidebarWidth(next)
    localStorage.setItem('awb:sidebarWidth', String(next))
  }

  useEffect(() => {
    const onResize = () => setRightWidth((width) => Math.max(220, Math.min(width, window.innerWidth - sidebarWidth - 320, 800)))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [sidebarWidth])

  async function toggleDirectory(rel: string) {
    if (!project) return
    const key = `${panelProject!.id}:${rel}`
    const open = !openDirs[key]
    setOpenDirs((map) => ({ ...map, [key]: open }))
    if (!open || directoryRequests.current.has(key)) return
    directoryRequests.current.add(key)
    try {
      const nodes = await window.awb.gitTree(panelProject!.id, rel)
      setTreeChildren((map) => ({ ...map, [key]: nodes }))
    } catch (error) {
      setOpenDirs((map) => ({ ...map, [key]: false }))
      toast(error instanceof Error ? error.message : t("无法读取目录"), true)
    } finally { directoryRequests.current.delete(key) }
  }

  async function revealFile(projectId: string, rel: string) {
    const segments = rel.split('/')
    segments.pop()
    const dirs = segments.map((_, index) => segments.slice(0, index + 1).join('/'))
    const listings = await Promise.all(dirs.map(async (dir) => [dir, await window.awb.gitTree(projectId, dir)] as const))
    if (projectIdRef.current !== projectId) return false
    setTreeChildren((current) => {
      const next = { ...current }
      for (const [dir, nodes] of listings) next[`${projectId}:${dir}`] = nodes
      return next
    })
    setOpenDirs((current) => {
      const next = { ...current }
      for (const dir of dirs) next[`${projectId}:${dir}`] = true
      return next
    })
    return true
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
      setLanguage(state.db.settings.language)
      setDb(state.db)
      putSessions(state.db.workSessions || {})
      selectedSessionsRef.current = state.db.activeSession || {}
      setSelectedSessions(selectedSessionsRef.current)
      setInstalled(state.installed)
    })
  }, [])

  useEffect(() => {
    if (!db) return
    document.documentElement.dataset.theme = workbenchTheme(db.settings.theme).mode
    document.documentElement.dataset.palette = db.settings.theme
    document.documentElement.dataset.density = db.settings.density || 'comfortable'
    for (const [key, value] of Object.entries(themeVariables(db.settings.theme))) document.documentElement.style.setProperty(key, value)
    document.documentElement.style.setProperty('--fs', `${db.settings.fontSize}px`)
    document.documentElement.style.setProperty('--mono', codeFont(db.settings.fontFamily))
    document.documentElement.style.setProperty('--ui', uiFont(db.settings.uiFontFamily))
    document.documentElement.style.setProperty('--ui-size', `${db.settings.uiFontSize || 13}px`)
    document.documentElement.style.setProperty('--editor-size', `${db.settings.editorFontSize || 14}px`)
    setTerminalHistoryEnabled(db.settings.restore !== false)
  }, [db])

  useEffect(() => {
    if (projectId) localStorage.setItem('awb:lastProject', projectId)
  }, [projectId])

  useEffect(() => {
    const layout = db?.settings.layout || 'focus'
    setRight(layout !== 'focus')
    if (layout === 'review') { setRightWidth(360); setDefaultDiffMode(window.innerWidth >= 1180 ? 'split' : 'unified') }
    else if (layout === 'balanced') { setRightWidth(Number(localStorage.getItem('awb:rightWidth')) || 296); setDefaultDiffMode('unified') }
  }, [db?.settings.layout])

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
  const theme: ThemeName = db?.settings.theme || 'light'
  const sessionId = project ? selectedSessions[project.id] || workSessions[project.id]?.[0]?.id : undefined
  const projectTabs = project ? tabs.filter((tab) => tab.projectId === project.id && (tab.type !== 'term' || sessionOf(tab) === sessionId)) : []
  const active = projectTabs.find((tab) => tab.id === activeMap[project?.id || '']) ?? projectTabs[0]
  const panelTerminal = active?.type === 'term' ? active : projectTabs.find((tab): tab is TermTab => tab.type === 'term' && tab.id === lastTerminal.current[projectId || '']) || projectTabs.find((tab): tab is TermTab => tab.type === 'term')
  const terminalContext = panelTerminal?.context
  const panelProject = project && terminalContext ? { ...project, id: terminalContext.id, path: terminalContext.cwd } : project
  const agents: AgentInfo[] = db
    ? [...PRESETS.map((item) => resolveAgent(item.id, db.custom, installed)), ...db.custom.map((item) => resolveAgent(item.id, db.custom, installed)), SHELL_AGENT]
    : []

  const persist = useCallback((next: Tab[], activeIds?: Record<string, string | undefined>) => {
    if (!db) return
    const map = activeIds ?? activeMapRef.current
    for (const item of db.projects) {
      const terms = next
        .filter((tab): tab is TermTab => tab.type === 'term' && tab.projectId === item.id)
        .map(savedTerminal)
      const wanted = map[item.id]
      const activeId = terms.some((term) => term.id === wanted) ? wanted : terms[0]?.id ?? null
      const groups = (sessionsRef.current[item.id] || []).map((session) => ({ ...session, activeTab: terms.find((term) => term.id === wanted && term.sessionId === session.id)?.id || session.activeTab }))
      sessionsRef.current = { ...sessionsRef.current, [item.id]: groups }
      void window.awb.saveSessions(item.id, terms, activeId, groups, selectedSessionsRef.current[item.id]).catch((error) => toast(String(error), true))
    }
  }, [db, toast])

  useEffect(() => {
    if (!db) return
    if (tabs.some((tab) => tab.type === 'term' && tab.agentSessionId)) persist(tabs)
  }, [db, persist, tabs])

  const flushRestoredHistory = useCallback(async (id: string) => {
    const entry = restoredHistory.current[id]
    if (!entry) return
    if (historyTimers.current[id]) clearTimeout(historyTimers.current[id])
    delete historyTimers.current[id]
    delete restoredHistory.current[id]
    try { await prependTermHistory(id, entry.text) }
    finally { releaseTermHistory(id); queueSnapshot(id) }
  }, [])

  const forgetTermHistory = useCallback((id: string) => {
    if (historyTimers.current[id]) clearTimeout(historyTimers.current[id])
    delete historyTimers.current[id]
    delete restoredHistory.current[id]
    releaseTermHistory(id)
  }, [])

  useEffect(() => {
    const flush = async () => {
      await Promise.all(Object.keys(restoredHistory.current).map(flushRestoredHistory))
      await snapshotTerms()
    }
    const unloading = () => { void flush() }
    window.addEventListener('beforeunload', unloading)
    const off = window.awb.onFlushTerminalHistory(flush)
    return () => { window.removeEventListener('beforeunload', unloading); off() }
  }, [flushRestoredHistory])

  const openTerm = useCallback(async (target: NonNullable<typeof project>, kind: string, shell: ShellKind, activate = true, existingId?: string, existingName?: string, targetSession?: string, restoreHistory = false, existingAgentSessionId?: string) => {
    const id = existingId || uid('t')
    const groupId = targetSession || selectedSessionsRef.current[target.id] || sessionsRef.current[target.id]?.[0]?.id || legacySessionId(target.id)
    if (!sessionsRef.current[target.id]?.some((session) => session.id === groupId)) {
      const next = { ...sessionsRef.current, [target.id]: [...(sessionsRef.current[target.id] || []), { id: groupId, name: target.temporary ? target.name : t("会话一") }] }
      sessionsRef.current = next; setWorkSessions(next)
    }
    if (activate) {
      const next = { ...selectedSessionsRef.current, [target.id]: groupId }
      selectedSessionsRef.current = next; setSelectedSessions(next)
    }
    closingTerms.current.delete(id)
    const tab: TermTab = {
      id,
      type: 'term',
      projectId: target.id,
      sessionId: groupId,
      kind,
      shell,
      state: kind === 'shell' ? 'idle' : 'running',
      startedAt: kind === 'shell' ? null : Date.now(),
      exitCode: null,
      inputReady: true,
      name: existingName,
      hasRun: kind !== 'shell',
      agentKind: kind === 'shell' ? null : kind,
      agentSessionId: existingAgentSessionId
    }
    setTabs((list) => (list.some((item) => item.id === id) ? list : [...list, tab]))
    if (activate) setActiveMap((map) => ({ ...map, [target.id]: id }))
    if (activate) lastTerminal.current[target.id] = id
    try {
      if (restoreHistory && existingId) {
        const history = await window.awb.terminalHistory(id).catch(() => '')
        if (history) {
          retainTermHistory(id, history)
          restoredHistory.current[id] = { text: history }
          holdTermHistory(id)
        }
      }
      const info = await window.awb.ptyCreate({ id, projectId: target.id, kind, shell, agentSessionId: existingAgentSessionId })
      // Replay is a display operation, independent of Agent completion. Keep
      // startup screen setup out of the historical scrollback transaction.
      if (restoredHistory.current[id]) historyTimers.current[id] = setTimeout(() => flushRestoredHistory(id), 1200)
      syncTermSize(id)
      setTabs((list) => {
        const next = list.map((item) =>
          item.id === id && item.type === 'term'
            ? { ...item, shell: info.shell, state: info.state as TermTab['state'], startedAt: info.startedAt, exitCode: info.exitCode, inputReady: info.inputReady, agentKind: info.agentKind, agentSessionId: info.agentSessionId ?? item.agentSessionId }
            : item
        )
        const ids = activate ? { ...activeMapRef.current, [target.id]: id } : activeMapRef.current
        persist(next, ids)
        return next
      })
      return id
    } catch (err) {
      if (existingId) {
        const message = err instanceof Error ? err.message : t("无法启动终端")
        flushRestoredHistory(id)
        writeNotice(id, db?.settings.theme || 'light', 'red', t("[无法恢复会话：{{0}}。右键终端可选择重新连接。]", message))
        setTabs((list) => list.map((item) => item.id === id && item.type === 'term' ? { ...item, state: 'failed', startedAt: null, exitCode: null, inputReady: false } : item))
        toast(t("会话 {{0}} 未能恢复：{{1}}", existingName || id, message), true)
        return null
      }
      setTabs((list) => {
        const next = list.filter((item) => item.id !== id)
        const mine = next.filter((item) => item.projectId === target.id && (item.type !== 'term' || sessionOf(item) === selectedSessionsRef.current[target.id]))
        const current = activeMapRef.current[target.id]
        const keep = current !== id && mine.some((item) => item.id === current) ? current : mine[0]?.id
        const activeIds = { ...activeMapRef.current, [target.id]: keep }
        setActiveMap(activeIds)
        persist(next, activeIds)
        return next
      })
      toast(err instanceof Error ? err.message : t("无法启动终端"), true)
      return null
    }
  }, [db?.settings.theme, flushRestoredHistory, persist, toast])

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
    const last = localStorage.getItem('awb:lastProject')
    const first = db.projects.find((item) => item.id === last)?.id ?? db.projects[0]?.id ?? null
    setProjectId(first)
    if (!db.settings.restore) return
    restoring.current = true
    const seeded: Record<string, string | undefined> = {}
    const pending: Promise<unknown>[] = []
    for (const item of db.projects) {
      const saved = db.sessions[item.id] || []
      if (!saved.length) continue
      const wanted = db.activeTab?.[item.id]
      seeded[item.id] = saved.some((term) => term.id === wanted) ? wanted : saved[0].id
      for (const term of saved) pending.push(openTerm(item, term.kind, term.shell, false, term.id, term.name, term.sessionId, true, term.agentSessionId))
    }
    activeMapRef.current = seeded
    setActiveMap(seeded)
    void Promise.allSettled(pending).then(() => { restoring.current = false; setTabs((list) => [...list]) })
  }, [db, openTerm])

  useEffect(() => {
    if (restoring.current) return
    setActiveMap((map) => {
      const ids = new Set([...Object.keys(map), ...tabs.map((tab) => tab.projectId)])
      const next = { ...map }
      let changed = false
      for (const id of ids) {
        const mine = tabs.filter((tab) => tab.projectId === id && (tab.type !== 'term' || sessionOf(tab) === selectedSessionsRef.current[id]))
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
  }, [tabs, selectedSessions])

  useEffect(() => {
    return window.awb.onPty((event) => {
      if (closingTerms.current.has(event.id)) return
      if (event.type === 'data') {
        writeTerm(event.id, event.data)
        return
      }
      queueSnapshot(event.id)
      setTabs((list) =>
        list.map((tab) =>
          tab.id === event.id && tab.type === 'term'
            ? { ...tab, context: event.context === undefined ? tab.context : event.context, hasRun: tab.hasRun || event.state === 'running', state: event.state, exitCode: event.exitCode, startedAt: event.startedAt, inputReady: event.inputReady, agentKind: event.agentKind, agentSessionId: event.agentSessionId ?? tab.agentSessionId }
            : tab
        )
      )
      if (!event.announce) return
      const mode = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
      if (event.reason === 'kill') writeNotice(event.id, mode, 'red', t("[进程已被强制结束]"))
      writeNotice(event.id, mode, 'faint', t("[进程已退出，退出码 {{0}}]", event.exitCode ?? 0))
    })
  }, [])

  useEffect(() => {
    const project = panelProject
    if (!project || route !== 'work' || !right) return
    let stop = false
    let loading = false
    const load = () => {
      if (loading || stop) return
      loading = true
      void window.awb
        .gitStatus(project.id)
        .then((panel) => {
          if (!stop) setGit(panel)
        })
        .catch(() => { if (!stop) setGit({ isRepo: false, branch: '', files: [], untracked: {}, errors: [t("{{0}}：无法读取 Git 状态", project.name)] }) })
        .finally(() => { loading = false })
      if (rmode === 'files') {
        void window.awb
          .gitTree(project.id)
          .then((nodes) => {
            if (!stop) { setTree(nodes); setTreeProjectId(project.id) }
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
  }, [panelProject?.id, route, right, rmode, gitTick])

  useEffect(() => {
    setGit(null)
    setTree([])
    setTreeProjectId(null)
  }, [projectId, panelProject?.id])

  const openDiffPaths = JSON.stringify(tabs.filter((tab): tab is DiffTab => tab.projectId === projectId && tab.type === 'diff').map((tab) => ({ path: tab.path, target: fileTarget(tab), untracked: tab.untracked })))
  const untrackedPaths = JSON.stringify(git?.untracked || {})
  useEffect(() => {
    if (!projectId) return
    let stop = false
    const untracked: Record<string, boolean> = JSON.parse(untrackedPaths)
    for (const { path, target, untracked: prior } of JSON.parse(openDiffPaths) as { path: string; target: string; untracked?: boolean }[]) void window.awb.gitDiff(target, path, target === panelProject?.id ? !!untracked[path] : !!prior).then((file) => {
      if (!stop) setDiffs((current) => ({ ...current, [documentKey(target, path)]: file }))
    }).catch((err) => { if (!stop) toast(err instanceof Error ? err.message : t("无法读取差异"), true) })
    return () => {
      stop = true
    }
  }, [projectId, openDiffPaths, untrackedPaths, gitTick])

  const openDocumentPaths = JSON.stringify(tabs.filter((tab): tab is FileTab | DiffTab => tab.projectId === projectId && tab.type !== 'term').map((tab) => ({ path: tab.path, target: fileTarget(tab) })))
  const documentReads = useRef(new Map<string, Promise<import('../shared/types').FileContent>>())
  useEffect(() => {
    if (!projectId) return
    let stop = false
    for (const { path, target } of JSON.parse(openDocumentPaths) as { path: string; target: string }[]) {
      const key = documentKey(target, path)
      if (replacementAt(target, path) || documentsRef.current[key]) continue
      let request = documentReads.current.get(key)
      if (!request) {
        request = window.awb.gitRead(target, path).finally(() => documentReads.current.delete(key))
        documentReads.current.set(key, request)
      }
      void request.then((file) => {
        if (!stop && !documentsRef.current[key]) putDocument(key, { ...file, projectId: target, path, draft: editableText(file.text) })
      }).catch((error) => { if (!stop) toast(error instanceof Error ? error.message : t("无法读取文件"), true) })
    }
    return () => {
      stop = true
    }
  }, [projectId, openDocumentPaths, fileReadTick])

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
    if (replacementAt(doc.projectId, doc.path)) doc = { ...doc, replacing: true }
    documentsRef.current = { ...documentsRef.current, [key]: doc }
    setDocuments((map) => ({ ...map, [key]: doc }))
  }

  function updateFileDraft(id: string, update: (doc: DocumentDraft) => DocumentDraft) {
    const tab = tabs.find((item) => item.id === id && item.type !== 'term')
    if (!tab || tab.type === 'term') return
    const key = documentKey(fileTarget(tab), tab.path)
    const doc = documentsRef.current[key]
    if (!doc) return
    if (doc.replacing) return
    const next = update(doc)
    putDocument(key, next)
    setTabs((list) => list.map((item) => item.type !== 'term' && fileTarget(item) === fileTarget(tab) && item.path === tab.path ? { ...item, dirty: isDirty(next) } : item))
  }

  function editFile(id: string, draft: string) { updateFileDraft(id, (doc) => recordChange(doc, draft)) }
  function historyFile(id: string, redo: boolean) { updateFileDraft(id, (doc) => undoDocument(doc, redo)) }
  function composeFile(id: string, composing: boolean) { updateFileDraft(id, (doc) => ({ ...doc, composing })) }

  async function saveFile(tab: FileTab | DiffTab, automatic = false): Promise<boolean> {
    const key = documentKey(fileTarget(tab), tab.path)
    const doc = documentsRef.current[key]
    if ([...pathMutations.current.values()].some((operation) => operation.projectId === fileTarget(tab) && (tab.path === operation.path || (operation.directory && tab.path.startsWith(`${operation.path}/`))))) return false
    if (!doc || doc.binary || doc.tooBig || savingDocuments.current.has(key)) return false
    if (!isDirty(doc)) return true
    savingDocuments.current.add(key)
    putDocument(key, { ...doc, saving: true, error: undefined })
    try {
      const saved = await window.awb.gitWrite(fileTarget(tab), tab.path, fileText(doc), doc.version)
      const latest = documentsRef.current[key] || doc
      const draft = latest.draft === doc.draft ? editableText(saved.text) : latest.draft
      putDocument(key, { ...latest, ...saved, draft, assetToken: saved.assetToken, fileStamp: saved.fileStamp, saving: false, error: undefined })
      setTabs((list) => list.map((item) => item.type !== 'term' && fileTarget(item) === fileTarget(tab) && item.path === tab.path ? { ...item, dirty: draft !== editableText(saved.text) } : item))
      setGitTick((tick) => tick + 1)
      toast(automatic ? t("已自动保存") : t("文件已保存"))
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : t("保存失败")
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
      if (!isDirty(doc) || doc.saving || doc.replacing || doc.composing || doc.error || doc.binary || doc.tooBig || timers.has(key)) continue
      const tab = tabs.find((item) => item.type !== 'term' && fileTarget(item) === doc.projectId && item.path === doc.path)
      if (!tab || tab.type === 'term') continue
      const timer = setTimeout(() => { timers.delete(key); void saveFile(tab, true) }, AUTO_SAVE_DELAY)
      timers.set(key, { draft: doc.draft, timer })
    }
  }, [documents, tabs, modal])

  useEffect(() => () => { for (const { timer } of autoSaveTimers.current.values()) clearTimeout(timer) }, [])

  async function previewHtml(id: string) {
    const tab = tabs.find((item): item is FileTab => item.id === id && item.type === 'file')
    if (!tab) return
    const doc = documentsRef.current[documentKey(fileTarget(tab), tab.path)]
    if (doc && isDirty(doc) && !await saveFile(tab)) return
    try { await window.awb.openHtmlPreview(fileTarget(tab), tab.path) } catch (error) { toast(String(error), true) }
  }

  async function refreshDocument(target: string, path: string, force: boolean) {
    const key = documentKey(target, path), previous = documentsRef.current[key]
    const blocked = () => [...pathMutations.current.values()].some((operation) => operation.projectId === target &&
      (operation.path === path || (operation.directory && (!operation.path || path.startsWith(`${operation.path}/`)))))
    if (!previous || blocked() || previous.saving || previous.composing || (!force && (isDirty(previous) || refreshingDocuments.current.has(key)))) return
    const ticket = Symbol()
    refreshingDocuments.current.set(key, ticket)
    try {
      const file = await window.awb.gitRefresh(target, path, force ? undefined : previous.fileStamp)
      if (!file || refreshingDocuments.current.get(key) !== ticket || documentsRef.current[key] !== previous || blocked()) return
      if (!force && previous.version === file.version && previous.missing === file.missing && previous.tooBig === file.tooBig) {
        if (previous.fileStamp !== file.fileStamp) putDocument(key, { ...previous, fileStamp: file.fileStamp })
        return
      }
      const draft = editableText(file.text)
      putDocument(key, { ...recordChange({ ...previous, editAt: 0 }, draft), ...file, draft,
        assetToken: file.assetToken, fileStamp: file.fileStamp, tooBig: file.tooBig, error: undefined, replacementId: crypto.randomUUID() })
      setTabs((list) => list.map((tab) => tab.type !== 'term' && fileTarget(tab) === target && tab.path === path ? { ...tab, dirty: false } : tab))
      if (force || tabs.some((tab) => tab.type === 'diff' && fileTarget(tab) === target && tab.path === path)) setGitTick((tick) => tick + 1)
    } catch (error) {
      if (force && documentsRef.current[key] === previous) toast(error instanceof Error ? error.message : t("无法读取文件"), true)
    } finally {
      if (refreshingDocuments.current.get(key) === ticket) refreshingDocuments.current.delete(key)
    }
  }

  function reloadPath(target: string, path: string) {
    const doc = documentsRef.current[documentKey(target, path)]
    if (!doc) { openFile(path, undefined, undefined, target); return }
    if (doc.saving || doc.composing) { toast(t("文件操作正在进行"), true); return }
    const reload = () => { setModal(null); void refreshDocument(target, path, true) }
    if (isDirty(doc)) setModal({ type: 'confirm', title: t("重新读取文件？"), body: t("这会放弃此文件尚未保存的更改。"), ok: t("放弃并重新读取"), run: reload })
    else reload()
  }

  function reloadFile(id: string) {
    const tab = tabs.find((item) => item.id === id)
    if (tab && tab.type !== 'term') reloadPath(fileTarget(tab), tab.path)
  }

  const refreshTarget = active && active.type !== 'term' ? fileTarget(active) : undefined
  const refreshPath = active && active.type !== 'term' ? active.path : undefined
  const refreshLocal = refreshTarget === project?.id && project?.host === 'local'
  useEffect(() => {
    if (route !== 'work' || !refreshTarget || !refreshPath) return
    const check = () => { void refreshDocument(refreshTarget, refreshPath, false) }
    check()
    window.addEventListener('focus', check)
    const timer = refreshLocal ? window.setInterval(() => { if (document.visibilityState === 'visible') check() }, 2000) : undefined
    return () => { window.removeEventListener('focus', check); window.clearInterval(timer) }
  }, [route, refreshTarget, refreshPath, refreshLocal, active?.id])

  async function closeTab(id: string) {
    const tab = tabs.find((item) => item.id === id)
    if (!tab || closingTerms.current.has(id)) return
    if (tab.type === 'term') {
      closingTerms.current.add(id)
      try {
        await window.awb.ptyClose(id)
      } catch (error) {
        closingTerms.current.delete(id)
        toast(error instanceof Error ? error.message : t("无法关闭终端"), true)
        return
      }
      dropTerm(id)
      forgetTermHistory(id)
    }
    if (tab.type !== 'term' && !tabs.some((item) => item.id !== id && item.type !== 'term' && fileTarget(item) === fileTarget(tab) && item.path === tab.path)) setDocuments((map) => {
      const next = { ...map }
      delete next[documentKey(fileTarget(tab), tab.path)]
      return next
    })
    if (tab.type === 'diff') {
      setDiffModes((map) => { const next = { ...map }; delete next[id]; return next })
      if (!tabs.some((item) => item.id !== id && item.type === 'diff' && fileTarget(item) === fileTarget(tab) && item.path === tab.path)) {
        const key = documentKey(fileTarget(tab), tab.path)
        setDiffBaselines((map) => { const next = { ...map }; delete next[key]; return next })
        setDiffs((map) => { const next = { ...map }; delete next[key]; return next })
      }
    }
    setTabs((list) => {
      const next = list.filter((item) => item.id !== id)
      const mine = next.filter((item) => item.projectId === tab.projectId && (item.type !== 'term' || sessionOf(item) === selectedSessionsRef.current[tab.projectId]))
      let preferred = activeMapRef.current[tab.projectId]
      if (preferred === id) {
        const layout = loadTerminalLayouts()[`${tab.projectId}:${selectedSessionsRef.current[tab.projectId]}`]
        preferred = preferredGroupTab(layout, mine.map((item) => item.id), id)
      }
      const keep = mine.some((item) => item.id === preferred) ? preferred : mine[0]?.id
      const activeIds = { ...activeMapRef.current, [tab.projectId]: keep }
      activeMapRef.current = activeIds
      setActiveMap(activeIds)
      persist(next, activeIds)
      return next
    })
  }

  function requestClose(id: string, requireConfirm = false) {
    if (modalRef.current || document.querySelector('dialog[open]') || closingTerms.current.has(id)) return
    const tab = tabs.find((item) => item.id === id)
    if (!tab || !db) return
    if (tab.type !== 'term') {
      const doc = documentsRef.current[documentKey(fileTarget(tab), tab.path)]
      if (doc?.saving) { toast(t("文件正在保存，请稍候")); return }
      const shared = tabs.some((item) => item.id !== id && item.type !== 'term' && fileTarget(item) === fileTarget(tab) && item.path === tab.path)
      if (doc && isDirty(doc) && !shared) {
        setModal({ type: 'confirm', title: t("文件尚未保存"), body: t("{{0}} 有未保存的更改。", tab.path), ok: t("放弃并关闭"),
          run: () => { setModal(null); void closeTab(id) },
          save: () => { void saveFile(tab).then((saved) => { if (saved) { setModal(null); void closeTab(id) } }) }
        })
        return
      }
    }
    if (tab.type !== 'term' || (!requireConfirm && tab.kind === 'shell' && (tab.state !== 'running' || !db.settings.confirmKill))) {
      void closeTab(id)
      return
    }
    const agent = resolveAgent(tab.kind, db.custom, installed)
    const procName = tab.kind === 'shell' ? shellLabel(tab.shell) : agent.name
    const procCmd = cmdline(agent) || shellLabel(tab.shell)
    setModal({
      type: 'confirm',
      title: t("关闭标签？"),
      ok: t("结束并关闭"),
      body: (
        <>
          {t("关闭标签会结束正在运行的 ")}<b>{procName}</b>{t('（')}<span className="mono">{procCmd}</span>{t("）。未保存的会话会丢失，已写入磁盘的文件不受影响。")}</>
      ),
      run: () => {
        setModal(null)
        void closeTab(id)
      }
    })
  }

  function selectProject(id: string) {
    setProjectId(id)
    const wantedSession = selectedSessionsRef.current[id] || sessionsRef.current[id]?.[0]?.id
    const mine = tabs.filter((tab) => tab.projectId === id && (tab.type !== 'term' || sessionOf(tab) === wantedSession))
    const saved = db?.activeTab?.[id]
    const wanted = mine.find((tab) => tab.id === saved)
    if (wanted) {
      const activeIds = { ...activeMap, [id]: wanted.id }
      setActiveMap(activeIds)
      if (restoring.current) return
    } else if (mine.length && !mine.some((tab) => tab.id === activeMap[id])) {
      const activeIds = { ...activeMap, [id]: mine[0].id }
      setActiveMap(activeIds)
      persist(tabs, activeIds)
    }
    setRoute('work')
    setModal(null)
    setMenuId(null)
  }

  function selectTab(id: string) {
    const tab = tabs.find((item) => item.id === id)
    if (!tab) return
    if (tab.type === 'term') pickSession(tab.projectId, sessionOf(tab))
    const activeIds = { ...activeMap, [tab.projectId]: id }
    setProjectId(tab.projectId); setRoute('work'); setActiveMap(activeIds)
    if (tab.type === 'term') persist(tabs, activeIds)
  }

  function selectSession(project: string, id: string) {
    pickSession(project, id)
    const session = sessionsRef.current[project]?.find((item) => item.id === id)
    const mine = tabs.filter((tab): tab is TermTab => tab.type === 'term' && tab.projectId === project && sessionOf(tab) === id)
    const wanted = mine.find((tab) => tab.id === session?.activeTab) || mine[0]
    const ids = { ...activeMapRef.current, [project]: wanted?.id }
    activeMapRef.current = ids; setActiveMap(ids)
    setProjectId(project); setRoute('work'); setMenuId(null)
    persist(tabs, ids)
  }

  async function renameSession(project: string, id: string, name: string) {
    const existing = sessionsRef.current[project] || [{ id, name }]
    const groups = existing.map((item) => item.id === id ? { ...item, name } : item)
    const terms = tabs.filter((tab): tab is TermTab => tab.type === 'term' && tab.projectId === project).map(savedTerminal)
    await window.awb.saveSessions(project, terms, activeMapRef.current[project], groups, selectedSessionsRef.current[project])
    putSessions({ ...sessionsRef.current, [project]: groups })
  }

  function removeSession(project: string, id: string) {
    const group = sessionsRef.current[project]?.find((item) => item.id === id)
    if (!group) return
    const terms = tabs.filter((tab): tab is TermTab => tab.type === 'term' && tab.projectId === project && sessionOf(tab) === id)
    setModal({ type: 'confirm', title: t("删除会话？"), body: t("删除 {{0}} 将关闭其中的 {{1}} 个终端，项目文件会保留。", group.name, terms.length), ok: t("删除会话"), run: async () => {
      for (const term of terms) closingTerms.current.add(term.id)
      try { await Promise.all(terms.map((term) => window.awb.ptyClose(term.id))) }
      catch (error) { for (const term of terms) closingTerms.current.delete(term.id); toast(String(error), true); return }
      for (const term of terms) { dropTerm(term.id); forgetTermHistory(term.id) }
      const groups = (sessionsRef.current[project] || []).filter((item) => item.id !== id)
      putSessions({ ...sessionsRef.current, [project]: groups })
      if (selectedSessionsRef.current[project] === id) pickSession(project, groups[0]?.id || '')
      setTabs((list) => {
        const next = list.filter((tab) => !terms.some((term) => term.id === tab.id))
        const mine = next.filter((tab) => tab.projectId === project && (tab.type !== 'term' || sessionOf(tab) === selectedSessionsRef.current[project]))
        const keep = mine.find((tab) => tab.id === activeMapRef.current[project]) || mine[0]
        const ids = { ...activeMapRef.current, [project]: keep?.id }
        activeMapRef.current = ids; setActiveMap(ids); persist(next, ids)
        return next
      })
      setModal(null)
    } })
  }

  async function createTerminal(kind: string, shell: ShellKind, newSession = false) {
    if (!project) return
    let groupId = sessionId
    const created = newSession || !groupId
    if (created) {
      groupId = uid('s')
      const groups = sessionsRef.current[project.id] || []
      let number = groups.length + 1
      while (groups.some((group) => group.name === `会话 ${number}`)) number++
      putSessions({ ...sessionsRef.current, [project.id]: [...groups, { id: groupId, name: t("会话 {{0}}", number) }] })
    }
    const result = await openTerm(project, kind, shell, true, undefined, undefined, groupId)
    if (result) setModal(null)
    else {
      if (created) {
        putSessions({ ...sessionsRef.current, [project.id]: (sessionsRef.current[project.id] || []).filter((group) => group.id !== groupId) })
        pickSession(project.id, sessionId || '')
        setTabs((list) => {
          const previous = sessionsRef.current[project.id]?.find((group) => group.id === sessionId)
          const mine = list.filter((tab) => tab.projectId === project.id && tab.type === 'term' && sessionOf(tab) === sessionId)
          const keep = mine.find((tab) => tab.id === previous?.activeTab) || mine[0]
          const ids = { ...activeMapRef.current, [project.id]: keep?.id }
          activeMapRef.current = ids; setActiveMap(ids); persist(list, ids)
          return [...list]
        })
      }
      throw new Error(t("终端启动失败，请检查项目目录、环境连接与执行器配置后重试。"))
    }
  }

  async function createTemporary(kind: string, shell: ShellKind) {
    if (modal?.type !== 'temporary-term') return
    let target = temporaryPending.current
    if (!target) {
      const result = await window.awb.createTemporarySession(modal.root, modal.hostId)
      setDb(result.database)
      target = result.database.projects.find((item) => item.id === result.projectId)!
      temporaryPending.current = target
    }
    setProjectId(target.id); setRoute('work')
    if (!await openTerm(target, kind, shell, true)) throw new Error(t("临时终端启动失败，请重试"))
    temporaryPending.current = null; setModal(null)
  }

  async function newTemporary() {
    if (temporaryStarting.current) return
    temporaryStarting.current = true; setTemporaryBusy(true)
    temporaryPending.current = null
    try {
      setModal({ type: 'temporary' })
    } catch (error) { toast(String(error), true) }
    finally { temporaryStarting.current = false; setTemporaryBusy(false) }
  }

  async function renameProject(id: string, name: string) {
    if (!db) return
    const projects = db.projects.map((item) => item.id === id ? { ...item, name } : item)
    setDb(await window.awb.saveProjects(projects))
  }

  async function togglePin(id: string) {
    if (!db) return
    const target = db.projects.find((item) => item.id === id)
    if (!target) return
    const projects = db.projects.map((item) => item.id === id ? { ...item, pinned: !item.pinned } : item)
    setDb(await window.awb.saveProjects(projects))
    toast(target.pinned ? t("已取消置顶 {{0}}", target.name) : t("已置顶 {{0}}", target.name))
  }

  async function renameTerm(id: string, name: string) {
    const tab = tabs.find((item) => item.id === id && item.type === 'term')
    if (!tab) return
    const terms = tabs.filter((item): item is TermTab => item.type === 'term' && item.projectId === tab.projectId).map((item) => ({ ...savedTerminal(item), name: item.id === id ? name : item.name }))
    await window.awb.saveSessions(tab.projectId, terms, activeMapRef.current[tab.projectId], sessionsRef.current[tab.projectId], selectedSessionsRef.current[tab.projectId])
    setTabs((list) => list.map((item) => item.id === id ? { ...item, name } : item))
  }

  function askDiscard(id: string) {
    const tab = tabs.find((item) => item.id === id)
    if (!project || tab?.type !== 'diff') return
    const rel = tab.path
    const targetId = fileTarget(tab)
    const untracked = targetId === panelProject?.id ? !!git?.untracked[rel] : !!tab.untracked
    setModal({
      type: 'confirm',
      title: untracked ? t("删除新文件？") : t("放弃更改？"),
      ok: untracked ? t("删除文件") : t("放弃更改"),
      body: untracked ? (
        <>
          <span className="mono">{rel}</span> {t(" 尚未被 Git 跟踪，将从磁盘删除（")}<code className="mono">git clean -f</code>{t("），无法撤销。")}</>
      ) : (
        <>
          <span className="mono">{rel}</span> {t(" 的工作区修改将被还原（git restore），无法撤销。")}</>
      ),
      run: () => {
        setModal(null)
        const key = documentKey(fileTarget(tab), rel)
        const previous = documentsRef.current[key]
        void window.awb
          .gitDiscard(fileTarget(tab), rel, !!git?.untracked[rel])
          .then(async () => {
            const file = await window.awb.gitRead(fileTarget(tab), rel)
            const latest = documentsRef.current[key]
            const refreshed = latest ? latest === previous
              ? recordChange({ ...latest, ...file, editAt: 0 }, editableText(file.text))
              : { ...latest, ...file } : null
            if (refreshed) putDocument(key, refreshed)
            setDiffBaselines((map) => { const next = { ...map }; delete next[key]; return next })
            setDiffs((map) => { const next = { ...map }; delete next[key]; return next })
            setTabs((list) => {
              const next = list.filter((tab) => !(tab.type === 'diff' && fileTarget(tab) === targetId && tab.path === rel))
                .map((tab) => tab.type === 'file' && fileTarget(tab) === targetId && tab.path === rel ? { ...tab, dirty: !!refreshed && isDirty(refreshed) } : tab)
              if (!next.some((item) => item.id === activeMapRef.current[project.id])) {
                const rest = next.filter((tab) => tab.projectId === project.id)
                const layout = loadTerminalLayouts()[`${project.id}:${selectedSessionsRef.current[project.id]}`]
                const keep = preferredGroupTab(layout, rest.map((item) => item.id), tab.id) || rest[0]?.id
                const activeIds = { ...activeMapRef.current, [project.id]: keep }
                activeMapRef.current = activeIds
                setActiveMap(activeIds)
                persist(next, activeIds)
              }
              return next
            })
            setGitTick((n) => n + 1)
            toast(untracked ? t("已删除文件") : t("已放弃更改"))
          })
          .catch((err) => toast(err instanceof Error ? err.message : t("放弃失败"), true))
      }
    })
  }

  function openedDocument(type: 'file' | 'diff', rel: string, targetId = panelProject?.id): FileTab | DiffTab | undefined {
    if (!project) return
    const selected = activeMapRef.current[project.id]
    const layout = loadTerminalLayouts()[`${project.id}:${selectedSessionsRef.current[project.id]}`]
    const group = layout?.find((group) => (group.tabs || [group.id]).includes(selected || ''))
    const candidates = tabs.filter((tab): tab is FileTab | DiffTab => tab.type === type && tab.projectId === project.id && fileTarget(tab) === targetId && tab.path === rel)
    return candidates.find((tab) => tab.id === selected) || (group ? candidates.find((tab) => (group.tabs || [group.id]).includes(tab.id)) : candidates[0])
  }

  function openDiff(rel: string) {
    if (!project) return
    const existing = openedDocument('diff', rel)
    if (existing) {
      setActiveMap((map) => ({ ...map, [project.id]: existing.id }))
      return
    }
    const id = uid('d')
    const doc = documentsRef.current[documentKey(panelProject!.id, rel)]
    setTabs((list) => [...list, { id, type: 'diff', projectId: project.id, targetId: panelProject!.id, untracked: !!git?.untracked[rel], path: rel, dirty: !!doc && isDirty(doc) }])
    setActiveMap((map) => ({ ...map, [project.id]: id }))
  }

  function openFile(rel: string, anchor?: string, location?: import('../shared/types').SearchLocation, targetId = panelProject?.id) {
    if (!project || !targetId) return
    const opened = openedDocument('file', rel, targetId)
    if (opened) { setTabs((list) => list.map((tab) => tab.id === opened.id ? { ...tab, anchor, location } : tab)); selectTab(opened.id); void refreshDocument(targetId, rel, false); return }
    if (replacementAt(targetId, rel)) { toast(t("此目录正在替换，完成后可打开文件")); return }
    const id = uid('f')
    const doc = documentsRef.current[documentKey(targetId, rel)]
    setTabs((list) => [...list, { id, type: 'file', projectId: project.id, targetId, path: rel, anchor, location, dirty: !!doc && isDirty(doc) }])
    setActiveMap((map) => ({ ...map, [project.id]: id }))
  }

  async function renameTree(projectId: string, rel: string, name: string, directory: boolean): Promise<void> {
    await relocateTree(projectId, rel, directory, () => window.awb.treeRename(projectId, rel, name, directory))
  }

  async function moveTree(projectId: string, rel: string, parent: string, directory: boolean): Promise<void> {
    await relocateTree(projectId, rel, directory, () => window.awb.treeMove(projectId, rel, parent, directory))
  }

  async function relocateTree(projectId: string, rel: string, directory: boolean, operation: () => Promise<string | null>): Promise<void> {
    const affected = (value: string) => value === rel || (directory && value.startsWith(`${rel}/`))
    const pending = Object.values(documentsRef.current).filter((doc) => doc.projectId === projectId && affected(doc.path))
    if (pending.some((doc) => doc.saving || savingDocuments.current.has(documentKey(projectId, doc.path)))) throw new Error(t("文件正在保存，请稍候"))
    const lockId = documentKey(projectId, rel)
    if ([...pathMutations.current.values()].some((item) => item.projectId === projectId && (affected(item.path) || (item.directory && rel.startsWith(`${item.path}/`))))) throw new Error(t("文件操作正在进行"))
    pathMutations.current.set(lockId, { projectId, path: rel, directory })
    for (const doc of pending) {
      const key = documentKey(projectId, doc.path), timer = autoSaveTimers.current.get(key)
      if (timer) { clearTimeout(timer.timer); autoSaveTimers.current.delete(key) }
    }
    try {
      const nextPath = await operation()
      if (!nextPath || nextPath === rel) return
      const remap = (value: string) => affected(value) ? nextPath + value.slice(rel.length) : value
      const destination = (value: string) => value === nextPath || (directory && value.startsWith(`${nextPath}/`))
      const parentOf = (value: string) => value.split('/').slice(0, -1).join('/')
      const oldParent = parentOf(rel), newParent = parentOf(nextPath)
      const oldList = oldParent ? treeChildren[`${projectId}:${oldParent}`] || [] : tree
      const movingNode = oldList.find((node) => node.path === rel)
      const docs: Record<string, DocumentDraft> = {}
      for (const [key, doc] of Object.entries(documentsRef.current)) {
        if (doc.projectId !== projectId || !affected(doc.path)) docs[key] = doc
      }
      for (const doc of Object.values(documentsRef.current)) {
        if (doc.projectId !== projectId || !affected(doc.path)) continue
        const path = remap(doc.path)
        docs[documentKey(projectId, path)] = { ...doc, path, assetToken: undefined }
      }
      documentsRef.current = docs; setDocuments(docs)
      setTabs((list) => list.map((tab) => {
        if (tab.type === 'term' || fileTarget(tab) !== projectId || (!affected(tab.path) && !destination(tab.path))) return tab
        const path = remap(tab.path), doc = docs[documentKey(projectId, path)]
        return { ...tab, path, dirty: !!doc && isDirty(doc) }
      }))
      const rewriteNodes = (nodes: TreeNode[], parent: string) => {
        const result = nodes.filter((node) => oldParent === newParent || node.path !== rel).map((node) => affected(node.path) ? { ...node, path: remap(node.path), name: node.path === rel ? nextPath.split('/').pop()! : node.name } : node)
        if (oldParent !== newParent && parent === newParent && movingNode && !result.some((node) => node.path === nextPath)) result.push({ ...movingNode, path: nextPath, name: nextPath.split('/').pop()! })
        return result
      }
      if (projectIdRef.current === projectId) setTree((nodes) => rewriteNodes(nodes, ''))
      setTreeChildren((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(`${projectId}:`) || !destination(key.slice(projectId.length + 1))).map(([key, nodes]) => {
        const prefix = `${projectId}:`
        if (!key.startsWith(prefix)) return [key, nodes]
        const path = key.slice(prefix.length)
        return [`${prefix}${remap(path)}`, rewriteNodes(nodes, remap(path))]
      })))
      setOpenDirs((current) => Object.fromEntries(Object.entries(current).map(([key, open]) => { const prefix = `${projectId}:`; return key.startsWith(prefix) ? [`${prefix}${remap(key.slice(prefix.length))}`, open] : [key, open] })))
      if (newParent && oldParent !== newParent) setOpenDirs((current) => ({ ...current, [`${projectId}:${newParent}`]: true }))
      setTreeSelections((current) => current[projectId] && affected(current[projectId].path) ? { ...current, [projectId]: { ...current[projectId], path: remap(current[projectId].path) } } : current)
      setGitTick((tick) => tick + 1)
    } finally {
      pathMutations.current.delete(lockId)
      setDocuments((current) => ({ ...current }))
    }
  }

  function askTrash(projectId: string, rel: string, directory: boolean) {
    if (!rel) return
    const owner = db?.projects.find((item) => item.id === projectId)
    const projectHost = db?.hosts.find((item) => item.id === owner?.host)
    if (!owner || !projectHost) { toast(t("项目或环境不存在"), true); return }
    const remote = projectHost.id !== 'local'
    const affected = (path: string) => path === rel || (directory && path.startsWith(`${rel}/`))
    const relevant = Object.values(documentsRef.current).filter((doc) => doc.projectId === projectId && affected(doc.path))
    if (relevant.some((doc) => doc.saving || savingDocuments.current.has(documentKey(projectId, doc.path)))) { toast(t("文件正在保存，请稍候"), true); return }
    for (const doc of relevant) {
      const key = documentKey(projectId, doc.path), pending = autoSaveTimers.current.get(key)
      if (pending) { clearTimeout(pending.timer); autoSaveTimers.current.delete(key) }
    }
    const dirty = relevant.filter(isDirty).length
    const remove = async () => {
      if (Object.values(documentsRef.current).some((doc) => doc.projectId === projectId && affected(doc.path) && (doc.saving || savingDocuments.current.has(documentKey(projectId, doc.path))))) { toast(t("文件正在保存，请稍候"), true); return }
      try {
        await window.awb.treeTrash(projectId, rel, directory)
        const nextDocs = Object.fromEntries(Object.entries(documentsRef.current).filter(([, doc]) => !(doc.projectId === projectId && affected(doc.path))))
        documentsRef.current = nextDocs; setDocuments(nextDocs)
        setTabs((list) => {
          const next = list.filter((tab) => !(tab.type !== 'term' && fileTarget(tab) === projectId && affected(tab.path)))
          const wanted = activeMapRef.current[projectId]
          if (wanted && !next.some((tab) => tab.id === wanted)) {
            const fallback = next.find((tab) => tab.projectId === projectId && (tab.type !== 'term' || sessionOf(tab) === selectedSessionsRef.current[projectId]))?.id
            const activeIds = { ...activeMapRef.current, [projectId]: fallback }
            activeMapRef.current = activeIds; setActiveMap(activeIds)
          }
          return next
        })
        setTreeSelections((current) => current[projectId] && affected(current[projectId].path) ? Object.fromEntries(Object.entries(current).filter(([id]) => id !== projectId)) : current)
        setOpenDirs((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(`${projectId}:`) || !affected(key.slice(projectId.length + 1)))))
        setModal(null); setGitTick((tick) => tick + 1); toast(remote ? t("远程对象已永久删除") : t("已移入回收站"))
      } catch (error) { toast(error instanceof Error ? error.message : t("删除失败"), true) }
    }
    const impact = <>{remote ? t('将从远程机器永久删除以下对象，无法通过工作台恢复。') : t('将以下对象移入系统回收站。')} <span className="mono">{rel}</span> {directory ? t('包含文件夹内的全部内容。') : null}
      {dirty ? t('其中有 {{0}} 个未保存的文件，删除后这些草稿将被放弃。', dirty) : null}</>
    if (remote) setModal({ type: 'confirm', title: t("删除远程对象？"), ok: t("继续"), body: impact, run: () => setModal({ type: 'confirm', title: t("再次确认永久删除？"), ok: t("永久删除"), body: impact, run: remove }) })
    else setModal({ type: 'confirm', title: t("移入回收站？"), ok: t("移入回收站"), body: impact, run: remove })
  }

  function askRemove(id: string) {
    if (!db) return
    const item = db.projects.find((projectItem) => projectItem.id === id)
    if (!item) return
    const targetIds = new Set([id, ...tabs.filter((tab) => tab.projectId === id).map(fileTarget)])
    const unsaved = Object.values(documentsRef.current).filter((doc) => targetIds.has(doc.projectId) && isDirty(doc)).length
    if (Object.values(documentsRef.current).some((doc) => targetIds.has(doc.projectId) && doc.saving)) { toast(t("文件正在保存，请稍候")); return }
    const itemHost = db.hosts.find((hostItem) => hostItem.id === item.host) || db.hosts[0]
    const running = tabs.filter((tab) => tab.projectId === id && tab.type === 'term' && tab.state === 'running').length
    setMenuId(null)
    setModal({
      type: 'confirm',
      title: t("移除项目？"),
      ok: t("移除"),
      body: (
        <>
          {t("将从列表中移除 ")}{item.name}{t("，并关闭它的所有终端。")}{itemHost ? hostDisplayName(itemHost) : t("本机")}{t("上的目录 ")}<span className="mono">{item.path}</span> {t(" 及其中的文件不会被删除。")}{running ? <> {t(" 有 ")}{running} {t(" 个正在运行的进程会被结束。")}</> : null}
          {unsaved ? <> {t(" 此项目有 ")}{unsaved} {t(" 个文件尚未保存，更改会被放弃。")}</> : null}
        </>
      ),
      run: async () => {
        const terms = tabs.filter((tab) => tab.projectId === id && tab.type === 'term')
        for (const tab of terms) closingTerms.current.add(tab.id)
        try {
          await Promise.all(terms.map((tab) => window.awb.ptyClose(tab.id)))
        } catch (error) {
          for (const tab of terms) closingTerms.current.delete(tab.id)
          toast(error instanceof Error ? error.message : t("无法关闭项目终端"), true)
          return
        }
        for (const tab of terms) { dropTerm(tab.id); forgetTermHistory(tab.id) }
        const projects = db.projects.filter((projectItem) => projectItem.id !== id)
        setTabs((list) => list.filter((tab) => tab.projectId !== id))
        setDocuments((map) => Object.fromEntries(Object.entries(map).filter(([, doc]) => !targetIds.has(doc.projectId))))
        setDb({ ...db, projects })
        if (projectId === id) setProjectId(projects[0]?.id ?? null)
        setModal(null)
        void window.awb.saveProjects(projects)
        void window.awb.saveSessions(id, [], null)
        toast(t("已移除 {{0}}", item.name))
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
    else if (key === 'w' && active && route === 'work') {
      const target = document.activeElement
      if (target?.matches('input,textarea,select') && !target.closest('.xterm')) return
      requestClose(active.id, true)
    }
    else if (key === 's' && active && active.type !== 'term') void saveFile(active)
  }

  useEffect(() => window.awb.onCloseTab(() => onAppKey('w')))

  useEffect(() => {
    const onSearchKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || !event.ctrlKey || event.altKey || event.metaKey || route !== 'work' || !project || modalRef.current || document.querySelector('dialog[open],[role=dialog][aria-modal=true]')) return
      const key = event.key.toLowerCase()
      const mode = key === 'e' && !event.shiftKey ? 'files' : key === 'f' && event.shiftKey ? 'search' : null
      if (!mode) return
      event.preventDefault(); event.stopPropagation()
      setRight(true); setRmode(mode)
      setPanelSearchFocus((current) => ({ mode, sequence: current.sequence + 1 }))
    }
    window.addEventListener('keydown', onSearchKey, true)
    return () => window.removeEventListener('keydown', onSearchKey, true)
  })

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
      if (key === 'n' || key === 't' || key === ',' || key === 'b' || key === 'w' || (key === 's' && active && active.type !== 'term')) {
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
      const themeControl = document.querySelector<HTMLButtonElement>('.settings-theme')
      if (themeControl) items.unshift(themeControl)
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
  const temporaryHost = modal?.type === 'temporary-term' ? db?.hosts.find((item) => item.id === modal.hostId) : undefined
  const savePreferences = (settings: Settings, options?: { inlineError: boolean }) =>
    window.awb.saveSettings(settings).then((saved) => {
      setLanguage(saved.settings.language)
      setDb(saved)
      return true
    }).catch((error) => {
      if (!options?.inlineError) toast(String(error), true)
      return false
    })

  const removeHost = (id: string) => {
    if (!db) return
    const machine = db.hosts.find((host) => host.id === id)
    if (!machine || machine.id === 'local') return
    const templateCount = db.templates.filter((item) => item.hostId === id).length
    const bindingCount = db.templateBindings.filter((item) => item.hostId === id).length
    setModal({
      type: 'confirm',
      className: 'settings-dialog settings-dialog-narrow',
      title: t("移除机器？"),
      ok: t("移除机器"),
      body: <>
        <p>{t("确定移除「{{0}}」？", hostDisplayName(machine))}</p>
        <div className="settings-warning">
          <p>{t("同时删除该机器的 {{0}} 个模板、{{1}} 个模板绑定以及执行器在这台机器上的专属配置。", templateCount, bindingCount)}</p>
          <p className="resource-help">{t("使用这台机器的项目将无法打开终端。")} {t("机器上的 Skill 和 MCP 文件会保留。")}</p>
        </div>
      </>,
      run: async () => {
        try {
          const saved = await window.awb.saveHosts(db.hosts.filter((item) => item.id !== id))
          setDb((current) => current ? { ...current, hosts: saved.hosts, custom: saved.custom, templates: saved.templates, templateBindings: saved.templateBindings } : current)
          setModal(null)
        } catch (error) { toast(String(error), true) }
      }
    })
  }

  return (
    <>
      <div id="app" className={withRight ? 'with-right' : ''} data-panel-side={db?.settings.panelSide || 'right'} style={{ '--right-width': `${rightWidth}px`, '--sidebar-width': `${sidebarWidth}px` } as CSSProperties}>
        <header className={route === 'settings' ? 'title settings-title' : 'title'}>
          <div className="brand">
            <img className="logo" src={appIcon} width="18" height="18" alt="" aria-hidden="true" />
            Pello
          </div>
          {route === 'settings' ? <span className="crumb">{t("设置")}</span> : null}
          <span className="grow" />
          <div className="wc">
            {route === 'settings' && db ? <>
              <button className="settings-theme" aria-label={t("切换深浅主题")} onClick={() => void savePreferences({ ...db.settings, theme: workbenchTheme(theme).mode === 'light' ? 'dark' : 'light' })}>
                <Icon name="palette" />
              </button><span className="window-rule" aria-hidden="true" />
            </> : null}
            <button aria-label={t("最小化")} onClick={() => void window.awb.winMin()}>
              <Icon name="minus" className="s" />
            </button>
            <button aria-label={t("最大化")} onClick={() => void window.awb.winMax()}>
              <Icon name="square" className="s" />
            </button>
            <button className="close" aria-label={t("关闭窗口")} onClick={() => { snapshotTerms(); void window.awb.winClose() }}>
              <Icon name="x" className="s" />
            </button>
          </div>
        </header>
        <div className="body">
          <div id="workspace" style={{ display: route === 'settings' ? 'none' : 'contents' }} inert={workspaceLocked ? true : undefined} aria-hidden={workspaceLocked ? true : undefined}>
              <aside className="side" aria-label={t("项目")}>
                <SidebarResize width={sidebarWidth} onResize={resizeSidebar} />
                <nav className="plist" aria-label={t("项目")}>
                  <ProjectSidebar projects={db?.projects || []} hosts={db?.hosts || []} terms={tabs.filter((tab): tab is TermTab => tab.type === 'term')} agents={agents} onNewTemporary={() => void newTemporary()} temporaryBusy={temporaryBusy}
                    sessions={workSessions} selectedSession={sessionId} onSession={selectSession} onRenameSession={renameSession} onRemoveSession={removeSession}
                    projectId={projectId} activeId={active?.id} menuId={menuId} onMenu={setMenuId} onProject={selectProject} onTerm={selectTab}
                    onRenameProject={renameProject} onRenameTerm={renameTerm} onRemoveProject={askRemove} onCloseTerm={requestClose}
                    onTogglePin={togglePin} onNewProject={() => setModal({ type: 'project' })}
                    onProjectAction={(id, action) => { void window.awb.treeAction(id, '', true, action).catch((error) => toast(String(error))) }}
                    onNewSession={(id) => { selectProject(id); setModal({ type: 'term', newSession: true }) }} />
                </nav>
                <div className="sfoot">
                  <button className="navb" data-a="settings" onClick={() => openSettings()}>
                    <Icon name="settings" />
                    {t("设置")}</button>
                </div>
              </aside>
              <div id="mainwrap" style={{ display: 'contents' }}>
                <Workspace
                  project={project}
                  workspaceVisible={route === 'work'}
                  sessionId={sessionId}
                  tabs={tabs}
                  active={active}
                  rightOpen={right}
                  diffModes={diffModes}
                  defaultDiffMode={defaultDiffMode}
                  theme={theme}
                  fontSize={db?.settings.fontSize || 13}
                  fontFamily={db?.settings.fontFamily}
                  agents={agents}
                  installed={installed}
                  diffs={diffs}
                  baselines={diffBaselines}
                  onBaseline={(id, text) => {
                    const tab = tabs.find((item) => item.id === id)
                    if (tab?.type !== 'diff') return
                    const key = documentKey(fileTarget(tab), tab.path), diff = diffs[key]
                    if (!diff) return
                    setDiffBaselines((map) => ({ ...map, [key]: recordChange(map[key] || { projectId: fileTarget(tab), path: tab.path, text: diff.before, draft: editableText(diff.before), binary: false, missing: false, version: null }, text) }))
                  }}
                  onBaselineHistory={(id, redo) => {
                    const tab = tabs.find((item) => item.id === id)
                    if (tab?.type !== 'diff') return
                    const key = documentKey(fileTarget(tab), tab.path)
                    setDiffBaselines((map) => map[key] ? { ...map, [key]: undoDocument(map[key], redo) } : map)
                  }}
                  documents={documents}
                  onSelect={selectTab}
                  onRenameTerm={renameTerm}
                  onNavigateFile={(path, anchor, targetId) => openFile(path, anchor, undefined, targetId)}
                  onSplitTab={async (id) => {
                    const tab = tabs.find((tab) => tab.id === id)
                    if (!tab) throw new Error(t("标签已关闭"))
                    if (tab.type !== 'term') {
                      const nextId = uid(tab.type === 'file' ? 'f' : 'd')
                      if (tab.type === 'diff') setDiffModes((current) => ({ ...current, [nextId]: current[tab.id] || defaultDiffMode }))
                      setTabs((list) => [...list, { ...tab, id: nextId, anchor: undefined, location: undefined }])
                      setActiveMap((map) => ({ ...map, [tab.projectId]: nextId }))
                      return nextId
                    }
                    const term = tab
                    const target = db?.projects.find((item) => item.id === term?.projectId)
                    if (!term || !target) throw new Error(t("终端已关闭"))
                    const result = await openTerm(target, term.kind, term.shell, true, undefined, undefined, sessionOf(term))
                    if (!result) throw new Error(t("分栏终端启动失败"))
                    return result
                  }}
                  onClose={requestClose}
                  onNewTerm={() => (project ? setModal({ type: 'term' }) : setModal({ type: 'project' }))}
                  onQuick={() => {
                    if (!project || !db || !host) return
                    const custom = db.custom.find((item) => item.id === project.agent)
                    void openTerm(project, project.agent, shellFor(host, custom ? executorForHost(custom, project.host).shell : db.settings.defShell))
                  }}
                  onInterrupt={(id) => {
                    void window.awb.ptyInterrupt(id).then((action) => {
                      if (action === 'hint') writeTerm(id, paint(theme, 'amber', t("再次按 Ctrl+C 退出")))
                    })
                  }}
                  onReconnect={(id) => {
                    const term = tabs.find((tab): tab is TermTab => tab.id === id && tab.type === 'term')
                    const target = db?.projects.find((item) => item.id === term?.projectId)
                    if (term && target) void openTerm(target, term.kind, term.shell, true, term.id, term.name, sessionOf(term), true, term.agentSessionId)
                  }}
                  onToggleRight={() => setRight((value) => !value)}
                  onDmode={(id, mode) => {
                    setDiffModes((current) => ({ ...Object.fromEntries(tabs.filter((tab) => tab.type === 'diff').map((tab) => [tab.id, current[tab.id] || defaultDiffMode])), [id]: mode }))
                    setDefaultDiffMode(mode)
                  }}
                  onDiscard={askDiscard}
                  onAppKey={onAppKey}
                  onEditFile={editFile}
                  onSaveFile={(id) => { const tab = tabs.find((item) => item.id === id && item.type !== 'term'); if (tab && tab.type !== 'term') void saveFile(tab) }}
                  onReloadFile={reloadFile}
                  onHistoryFile={historyFile}
                  onComposeFile={composeFile}
                  onPreviewHtml={(id) => void previewHtml(id)}
                  untracked={git?.untracked || {}}
                />
                {withRight && project && host ? (
                  <RightPanel
                    project={panelProject!}
                    context={terminalContext}
                    host={host}
                    mode={rmode}
                    files={git?.files || []}
                    loaded={!!git}
                    isRepo={!!git?.isRepo}
                    branch={git?.branch || project.branch}
                    repositories={git?.repositories}
                    errors={git?.errors}
                    tree={treeProjectId === panelProject?.id ? tree : []}
                    treeLoaded={treeProjectId === panelProject?.id}
                    treeChildren={treeChildren}
                    openDirs={openDirs}
                    queries={treeQueries}
                    setQueries={setTreeQueries}
                    contentQueries={contentQueries}
                    setContentQueries={setContentQueries}
                    searchFocus={panelSearchFocus}
                    searchOptions={projectSearchOptions}
                    setSearchOptions={setProjectSearchOptions}
                    selections={treeSelections}
                    setSelections={setTreeSelections}
                    scrollPositions={treeScrollPositions}
                    width={rightWidth}
                    placement={db?.settings.panelSide}
                    onResize={resizeRight}
                    activePath={active && active.type !== 'term' ? active.path : undefined}
                    onMode={setRmode}
                    onToggleDir={(dir) => void toggleDirectory(dir)}
                    onOpenDiff={openDiff}
                    onOpenFile={openFile}
                    onReloadFile={reloadPath}
                    onRevealFile={revealFile}
                    onTreeRulesChanged={() => setGitTick((tick) => tick + 1)}
                    referenceTerms={tabs.filter((tab): tab is TermTab => tab.type === 'term' && tab.projectId === project.id && tab.state !== 'exited' && tab.state !== 'failed').sort((a, b) => Number(b.id === lastTerminal.current[project.id]) - Number(a.id === lastTerminal.current[project.id]))}
                    onReference={(id, text) => { const term = tabs.find((tab): tab is TermTab => tab.id === id && tab.type === 'term' && tab.projectId === project.id && tab.state !== 'exited' && tab.state !== 'failed'); if (!term) { toast(t("目标终端已关闭"), true); return }; window.awb.ptyWrite(id, text); selectTab(id) }}
                    onTrash={askTrash}
                    onRename={renameTree}
                    onMove={moveTree}
                    transfers={Object.values(transferStates).filter((item) => item.projectId === panelProject?.id)}
                    onDismissTransfer={dismissTransfer}
                    onCollapse={() => setRight(false)}
                    onRescan={async () => { const id = panelProject!.id; try { const panel = await window.awb.gitStatus(id, true); if (projectIdRef.current === project.id) setGit(panel) } catch { toast(t("无法重新扫描仓库，请检查连接和目录权限"), true) } }}
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
              templates={db.templates}
              templateBindings={db.templateBindings}
              onDatabase={(saved) => setDb((current) => current ? { ...current, templates: saved.templates, templateBindings: saved.templateBindings } : current)}
              projects={db.projects}
              installed={installed}
              onSection={(id) => {
                setSection(id)
                document.querySelector('.scontent')?.scrollTo(0, 0)
              }}
              onBack={() => closeSettings()}
              onSettings={savePreferences}
              onEditExec={(id, hostId) => setModal({ type: 'exec', id, hostId })}
              onNewExec={(hostId) => setModal({ type: 'exec', hostId })}
              onEditHost={(id) => setModal({ type: 'host', id })}
              onRemoveHost={removeHost}
              onNewHost={() => setModal({ type: 'host' })}
              onInstall={(name, cmd) => toast(cmd ? t("请先安装 {{0}}，并确保命令 {{1}} 在 PATH 中", name, cmd) : name)}
              onLocalHost={() => setModal({ type: 'host', id: 'local' })}
            />
          ) : null}
        </div>
      </div>
      <div id="modal">
        {modal?.type === 'confirm' ? <ConfirmDialog title={modal.title} body={modal.body} ok={modal.ok} onOk={modal.run} onSave={modal.save} className={modal.className} onClose={() => setModal(null)} /> : null}
        {modal?.type === 'temporary' && db ? <TemporarySessionDialog hosts={db.hosts} onCreate={async (root, hostId) => { const directory = await window.awb.configureTemporaryDirectory(root, hostId); setModal({ type: 'temporary-term', root: directory, hostId }) }} onClose={() => setModal(null)} /> : null}
        {modal?.type === 'temporary-term' && db && temporaryHost ? <NewTermDialog newSession host={temporaryHost} cwd={modal.root} initialKind={db.settings.defAgent} initialShell={shellFor(temporaryHost, db.settings.defShell)} agents={modal.hostId === 'local' ? agents : agents.map((agent) => ({ ...agent, installed: true }))} onClose={() => setModal(null)} onManage={() => { setModal(null); openSettings('agents') }} onOpen={createTemporary} /> : null}
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
              setDb((current) => current ? { ...current, hosts: saved.hosts, custom: saved.custom, templates: saved.templates, templateBindings: saved.templateBindings } : current)
            }}
            onCreate={(draft) => {
              const created = { id: uid('p'), name: draft.name, host: draft.host, path: draft.path, branch: draft.branch, agent: draft.agent }
              const projects = [created, ...db.projects]
              setDb({ ...db, projects })
              setProjectId(created.id)
              setRoute('work')
              setModal(null)
              void window.awb.saveProjects(projects)
              toast(t("已创建项目"))
            }}
          />
        ) : null}
        {modal?.type === 'term' && project && host ? (
          <NewTermDialog
            newSession={modal.newSession || !sessionId}
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
            onOpen={(kind, shell) => createTerminal(kind, shell, modal.newSession)}
          />
        ) : null}
        {modal?.type === 'exec' && db ? (
          <ExecDialog
            initial={editing && modal.id ? editing : null}
            hostId={modal.hostId}
            cwd={project?.path || ''}
            hosts={db.hosts}
            templates={db.templates}
            templateBindings={db.templateBindings}
            onClose={() => setModal(null)}
            onToast={toast}
            onDelete={async (id) => {
              const custom = db.custom.filter((item) => item.id !== id)
              const saved = await window.awb.saveCustom(custom)
              setDb((current) => current ? { ...current, custom: saved.custom, templateBindings: saved.templateBindings } : current)
              setModal(null)
            }}
            onSave={async (exec, changes) => {
              const id = exec.id || uid('c')
              const custom = exec.id ? db.custom.map((item) => (item.id === id ? exec : item)) : [...db.custom, { ...exec, id }]
              const saved = await window.awb.saveCustom(custom, [...changes].map(([hostId, templateId]) => ({ hostId, executorId: id, templateId })))
              setDb((current) => current ? { ...current, custom: saved.custom, templateBindings: saved.templateBindings } : current)
              setModal(null)
              const state = await window.awb.getState(); setInstalled(state.installed)
              toast(t("已保存执行器"))
            }}
          />
        ) : null}
        {modal?.type === 'host' && db ? (
          <HostDialog
            hosts={db.hosts}
            initial={editingHost}
            alignToSettings={route === 'settings'}
            onClose={() => setModal(null)}
            onToast={toast}
            onDelete={removeHost}
            onSave={async (item) => {
              const hosts = item.id ? db.hosts.map((hostItem) => (hostItem.id === item.id ? item : hostItem)) : [...db.hosts, { ...item, id: uid('h') }]
              const saved = await window.awb.saveHosts(hosts)
              setDb((current) => current ? { ...current, hosts: saved.hosts } : current)
              setModal(null)
              toast(t("已保存"))
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
