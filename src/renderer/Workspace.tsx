import { t } from '../shared/i18n'
import { useEffect, useRef, useState, type ComponentProps } from 'react'
import type { AgentInfo, FileDiff, ProcState, Project, SearchLocation, ShellKind, ThemeName } from '../shared/types'
import { resolveAgent } from '../shared/types'
import { Icon, Mark } from './icons'
import { TerminalPane } from './TerminalPane'
import { DiffPane } from './DiffPane'
import { FilePane } from './FilePane'
import { documentKey, type DocumentDraft } from './documents'
import type { PaneLayoutOptions } from '../shared/api'
import { sessionOf } from '../shared/work-sessions'
import { reconcileGroups, splitGroup, mergeGroups, moveGroupTab } from './workspace-layout'
import { WorkspaceTabs } from './WorkspaceTabs'
import { loadTerminalLayouts, splitTile, type SplitDirection } from './terminal-layout'

export type TermTab = {
  id: string
  type: 'term'
  projectId: string
  sessionId?: string
  kind: string
  shell: ShellKind
  state: ProcState
  startedAt: number | null
  exitCode: number | null
  inputReady: boolean
  name?: string
  hasRun?: boolean
  agentKind?: string | null
  agentSessionId?: string
  context?: import('../shared/types').TerminalContext | null
}
export type DiffTab = { id: string; type: 'diff'; projectId: string; targetId?: string; path: string; dirty?: boolean; untracked?: boolean }
export type FileTab = { id: string; type: 'file'; projectId: string; targetId?: string; path: string; dirty?: boolean; anchor?: string; location?: SearchLocation }
export type Tab = TermTab | DiffTab | FileTab
export const fileTarget = (tab: Tab): string => tab.type !== 'term' && tab.targetId || tab.projectId

function RetainedFilePane({ visible, ...props }: ComponentProps<typeof FilePane> & { visible: boolean }) {
  const html = /\.html?$/i.test(props.path)
  const [opened, setOpened] = useState(visible)
  useEffect(() => { if (visible && html) setOpened(true) }, [visible, html])
  return visible || (html && opened) ? <FilePane {...props} visible={visible} /> : null
}

export function Workspace({
  project,
  workspaceVisible,
  sessionId,
  tabs,
  active,
  rightOpen,
  diffModes,
  defaultDiffMode,
  theme,
  fontSize,
  fontFamily,
  agents,
  installed,
  diffs,
  baselines,
  onBaseline,
  onBaselineHistory,
  documents,
  onSelect,
  onRenameTerm,
  onSplitTab,
  onNavigateFile,
  onClose,
  onNewTerm,
  onQuick,
  onInterrupt,
  onReconnect,
  onToggleRight,
  onDmode,
  onDiscard,
  onAppKey,
  onEditFile,
  onSaveFile,
  onReloadFile,
  onHistoryFile,
  onComposeFile,
  onPreviewHtml,
  untracked
}: {
  project: Project | null
  workspaceVisible: boolean
  sessionId?: string
  tabs: Tab[]
  active?: Tab
  rightOpen: boolean
  diffModes: Record<string, 'unified' | 'split'>
  defaultDiffMode: 'unified' | 'split'
  theme: ThemeName
  fontSize: number
  fontFamily?: string
  agents: AgentInfo[]
  installed: Record<string, boolean>
  diffs: Record<string, FileDiff>
  baselines: Record<string, DocumentDraft>
  onBaseline: (id: string, text: string) => void
  onBaselineHistory: (id: string, redo: boolean) => void
  documents: Record<string, DocumentDraft>
  onSelect: (id: string) => void
  onRenameTerm: (id: string, name: string) => Promise<void>
  onSplitTab: (id: string) => Promise<string>
  onNavigateFile: (path: string, anchor?: string, targetId?: string) => void
  onClose: (id: string) => void
  onNewTerm: () => void
  onQuick: () => void
  onInterrupt: (id: string) => void
  onReconnect: (id: string) => void
  onToggleRight: () => void
  onDmode: (id: string, mode: 'unified' | 'split') => void
  onDiscard: (id: string) => void
  onAppKey: (key: string) => void
  onEditFile: (id: string, text: string) => void
  onSaveFile: (id: string) => void
  onReloadFile: (id: string) => void
  onHistoryFile: (id: string, redo: boolean) => void
  onComposeFile: (id: string, composing: boolean) => void
  onPreviewHtml: (id: string) => void
  untracked: Record<string, boolean>
}) {
  const [renaming, setRenaming] = useState<string | null>(null)
  const [layouts, setLayouts] = useState(loadTerminalLayouts)
  const [splitting, setSplitting] = useState(false)
  const [layoutError, setLayoutError] = useState('')
  const mine = project ? tabs.filter((tab) => tab.projectId === project.id && (tab.type !== 'term' || sessionOf(tab) === sessionId)) : []
  const shown = mine.find((tab) => tab.id === active?.id) ?? mine[0]
  const tabById = new Map(mine.map((tab) => [tab.id, tab]))
  // Tab content keeps one parent and stable keys when its group changes.
  const terms = tabs.filter((tab): tab is TermTab => tab.type === 'term')
  const htmlTabs = tabs.filter((tab) => tab.type === 'file' && /\.html?$/i.test(tab.path))
  const layoutKey = `${project?.id}:${sessionId}`
  const savedTiles = layouts[layoutKey]
  const lastShown = useRef<Record<string, string | undefined>>({})
  const groups = reconcileGroups(savedTiles, mine.map((tab) => tab.id), shown?.id, lastShown.current[layoutKey])
  const serializedGroups = JSON.stringify(groups)
  useEffect(() => {
    if (!shown) return
    lastShown.current[layoutKey] = shown.id
    const next = JSON.parse(serializedGroups)
    setLayouts((value) => JSON.stringify(value[layoutKey]) === serializedGroups ? value : { ...value, [layoutKey]: next })
  }, [layoutKey, shown?.id, serializedGroups])

  useEffect(() => { localStorage.setItem('awb:terminalLayouts', JSON.stringify(layouts)) }, [layouts])

  function layoutOptions(id: string): PaneLayoutOptions {
    const group = groups.find((group) => group.tabs.includes(id))!
    return { horizontal: !splitting && groups.length < 4 && group.width === 2, vertical: !splitting && groups.length < 4 && group.height === 2, merge: !splitting && groups.length > 1 }
  }
  async function layoutCommand(id: string, command: string | null) {
    if (splitting) return
    const group = groups.find((group) => group.tabs.includes(id))
    if (!group) return
    if (command === 'merge') { setLayouts((value) => ({ ...value, [layoutKey]: mergeGroups(groups, id) })); onSelect(id); return }
    if (!command?.startsWith('split-')) return
    setSplitting(true); setLayoutError('')
    try {
      const direction = command.slice(6) as SplitDirection
      splitTile(groups, group.id, '__validate__', direction)
      const nextId = await onSplitTab(id)
      lastShown.current[layoutKey] = nextId
      setLayouts((value) => ({ ...value, [layoutKey]: splitGroup(groups, id, nextId, direction) }))
    } catch (error) { setLayoutError(String(error)) }
    finally { setSplitting(false) }
  }
  function moveTab(id: string, target: string, before?: string) {
    if (!mine.some((tab) => tab.id === id) || splitting) return
    setLayouts((value) => ({ ...value, [layoutKey]: moveGroupTab(groups, id, target, before) }))
    lastShown.current[layoutKey] = id
    onSelect(id)
  }

  async function paneMenu(id: string) {
    if (splitting) return
    const tab = mine.find((item) => item.id === id)
    if (!tab) return
    const command = await window.awb.paneMenu({ ...layoutOptions(id), terminal: tab.type === 'term', reconnect: tab.type === 'term' && tab.state === 'failed' })
    if (command === 'reconnect') { onReconnect(id); return }
    if (command === 'export-history') {
      try { await window.awb.exportTerminalHistory(id) } catch (error) { setLayoutError(String(error)) }
      return
    }
    if (command === 'rename') { setRenaming(id); return }
    if (command === 'reload') { onReloadFile(id); return }
    await layoutCommand(id, command)
  }

  const agentOf = (id: string) => agents.find((item) => item.id === id) || resolveAgent(id, [], installed)

  return (
    <main className="center" id="center">
      {!project ? (
        <div className="empty">
          <div className="in">
            <div className="glyph">
              <Icon name="folder" />
            </div>
            <h2>{t("创建第一个项目")}</h2>
            <p>{t("项目是某台机器上的一个目录，终端在其中运行 Agent CLI。")}</p>
          </div>
        </div>
      ) : (
        <>
          {!shown ? <WorkspaceTabs groupId="empty" index={0} focused style={{ width: '100%' }} tabs={[]} activeId="" agents={agents} installed={installed}
            rightOpen={rightOpen} onToggleRight={onToggleRight} onSelect={onSelect} onClose={onClose} onPaneMenu={(id) => void paneMenu(id)} onRenameTerm={onRenameTerm}
            renaming={renaming} setRenaming={setRenaming} onMoveTab={(id) => moveTab(id, 'empty')} onNewTerm={onNewTerm} /> : null}
          {!shown ? (
            <div className="empty">
              <div className="in">
                <div className="glyph">
                  <Icon name="terminal" />
                </div>
                <h2>{t("还没有终端")}</h2>
                <p>
                  {t("在 ")}<span className="mono">{project.path}</span> {t(" 打开一个 Agent CLI。")}</p>
                <div className="acts">
                  <button className="btn pri" data-a="quick" onClick={onQuick}>
                    <Mark letter={agentOf(project.agent).letter} color={agentOf(project.agent).color} />
                    {t("启动 ")}{agentOf(project.agent).name}
                  </button>
                  <button className="btn" data-a="newterm" onClick={onNewTerm}>
                    {t("选择其他…")}</button>
                </div>
              </div>
            </div>
          ) : null}
        </>
      )}
            {layoutError ? <div role="alert" className="file-error">{layoutError}<button className="ib" aria-label={t("关闭错误")} onClick={() => setLayoutError('')}><Icon name="x" className="s" /></button></div> : null}
            <div className="panes" data-split={groups.length > 1} hidden={!project || !shown} aria-busy={splitting || undefined}>
              {groups.map((group, index) => <WorkspaceTabs key={`group:${group.id}`} groupId={group.id} index={index} focused={group.tabs.includes(shown?.id || '')}
                style={{ gridColumn: `${group.x + 1} / span ${group.width}`, gridRow: `${group.y + 1} / span ${group.height}` }}
                tabs={group.tabs.map((id) => tabById.get(id)!)} activeId={group.active} agents={agents} installed={installed}
                rightOpen={rightOpen} onToggleRight={onToggleRight} onSelect={onSelect} onClose={onClose} onPaneMenu={(id) => void paneMenu(id)} onRenameTerm={onRenameTerm}
                renaming={renaming} setRenaming={setRenaming} onMoveTab={(id, before) => moveTab(id, group.id, before)}
                onNewTerm={() => { onSelect(group.active); onNewTerm() }} />)}
              {[...terms, ...htmlTabs, ...mine.filter((tab) => tab.type === 'diff' || (tab.type === 'file' && !/\.html?$/i.test(tab.path)))].map((tab) => {
                const tile = groups.find((group) => group.tabs.includes(tab.id))
                const visible = tab.projectId === project?.id && tile?.active === tab.id
                const focus = visible && tab.id === shown?.id
                const key = tab.type === 'term' ? '' : documentKey(fileTarget(tab), tab.path)
                return (
                  <div
                    key={tab.id}
                    className={`pane ${focus ? 'focus' : ''}`}
                    data-a="pane"
                    data-id={tab.id}
                    data-type={tab.type}
                    data-group={tile?.id}
                    data-state={tab.type === 'term' ? tab.state : undefined}
                    hidden={!visible}
                    style={tile ? { gridColumn: `${tile.x + 1} / span ${tile.width}`, gridRow: `${tile.y + 1} / span ${tile.height}` } : undefined}
                    onContextMenu={(event) => { if (tab.type !== 'term' && !event.defaultPrevented) { event.preventDefault(); void paneMenu(tab.id) } }}
                    onKeyDown={(event) => { if (tab.type !== 'term' && !event.defaultPrevented && (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) { event.preventDefault(); void paneMenu(tab.id) } }}
                    onFocusCapture={() => { if (!focus) onSelect(tab.id) }}
                    onMouseDownCapture={() => { if (!focus) onSelect(tab.id) }}
                  >

                    {tab.type === 'term' ? <TerminalPane id={tab.id} groupId={tile?.id} fontSize={fontSize} fontFamily={fontFamily} theme={theme} shell={tab.shell} visible={workspaceVisible && visible} focused={workspaceVisible && focus} onInterrupt={onInterrupt} onAppKey={onAppKey} />
                      : visible && tab.type === 'diff' ? <DiffPane diff={diffs[key] || null} mode={diffModes[tab.id] || defaultDiffMode} onMode={(mode) => onDmode(tab.id, mode)} onDiscard={() => onDiscard(tab.id)} untracked={!!untracked[tab.path]}
                        document={documents[key] || null} baseline={baselines[key]?.draft} onBaseline={(text) => onBaseline(tab.id, text)} onBaselineHistory={(redo) => onBaselineHistory(tab.id, redo)}
                        onEdit={(text) => onEditFile(tab.id, text)} onSave={() => onSaveFile(tab.id)} onReload={() => onReloadFile(tab.id)} onCompose={(value) => onComposeFile(tab.id, value)} onHistory={(redo) => onHistoryFile(tab.id, redo)} />
                      : tab.type === 'file' ? <RetainedFilePane visible={visible} path={tab.path} anchor={tab.anchor} location={tab.location} onNavigate={(path, anchor) => onNavigateFile(path, anchor, fileTarget(tab))} document={documents[key] || null}
                        onEdit={(text) => onEditFile(tab.id, text)} onSave={() => onSaveFile(tab.id)} onReload={() => onReloadFile(tab.id)} onHistory={(redo) => onHistoryFile(tab.id, redo)} onCompose={(value) => onComposeFile(tab.id, value)} onPreviewHtml={() => onPreviewHtml(tab.id)}
                        rightOpen={rightOpen} onToggleRight={onToggleRight} layout={tile ? layoutOptions(tab.id) : { horizontal: false, vertical: false, merge: false }} onLayout={(command) => void layoutCommand(tab.id, command)} /> : null}
                  </div>
                )
              })}
            </div>
    </main>
  )
}
