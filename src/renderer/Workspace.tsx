import { useEffect, useRef, useState } from 'react'
import type { AgentInfo, FileDiff, ProcState, Project, ShellKind, ThemeName } from '../shared/types'
import { resolveAgent, shellLabel, shellLetter } from '../shared/types'
import { Icon, Mark } from './icons'
import { TerminalPane } from './TerminalPane'
import { DiffPane } from './DiffPane'
import { FilePane } from './FilePane'
import type { DocumentDraft } from './documents'

export type TermTab = {
  id: string
  type: 'term'
  projectId: string
  kind: string
  shell: ShellKind
  state: ProcState
  startedAt: number | null
  exitCode: number | null
  inputReady: boolean
}
export type DiffTab = { id: string; type: 'diff'; projectId: string; path: string }
export type FileTab = { id: string; type: 'file'; projectId: string; path: string; pinned?: boolean; dirty?: boolean }
export type Tab = TermTab | DiffTab | FileTab

function terminalStatus(tab: TermTab) {
  if (tab.state === 'running') return { color: 'busy', label: '正在运行任务' }
  if (tab.inputReady && tab.state !== 'idle') return { color: 'ready', label: '任务已完成，可以继续输入' }
  return { color: 'inactive', label: tab.inputReady ? '尚未运行 CodeAgent' : '终端未运行' }
}

export function Workspace({
  project,
  tabs,
  active,
  rightOpen,
  dmode,
  theme,
  fontSize,
  agents,
  installed,
  diff,
  preview,
  onSelect,
  onClose,
  onNewTerm,
  onNewProject,
  onQuick,
  onInterrupt,
  onToggleRight,
  onDmode,
  onDiscard,
  onAppKey,
  onPinFile,
  onEditFile,
  onSaveFile,
  onReloadFile,
  onHistoryFile,
  onComposeFile,
  onPreviewHtml,
  untracked
}: {
  project: Project | null
  tabs: Tab[]
  active?: Tab
  rightOpen: boolean
  dmode: 'unified' | 'split'
  theme: ThemeName
  fontSize: number
  agents: AgentInfo[]
  installed: Record<string, boolean>
  diff: FileDiff | null
  preview: DocumentDraft | null
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onNewTerm: () => void
  onNewProject: () => void
  onQuick: () => void
  onInterrupt: (id: string) => void
  onToggleRight: () => void
  onDmode: (mode: 'unified' | 'split') => void
  onDiscard: () => void
  onAppKey: (key: string) => void
  onPinFile: (id: string) => void
  onEditFile: (id: string, text: string) => void
  onSaveFile: (id: string) => void
  onReloadFile: (id: string) => void
  onHistoryFile: (id: string, redo: boolean) => void
  onComposeFile: (id: string, composing: boolean) => void
  onPreviewHtml: (id: string) => void
  untracked?: boolean
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const [overflow, setOverflow] = useState(false)
  const [fade, setFade] = useState<'none' | 'left' | 'right' | 'both'>('none')
  const [menu, setMenu] = useState(false)
  const mine = project ? tabs.filter((tab) => tab.projectId === project.id) : []
  const shown = mine.find((tab) => tab.id === active?.id) ?? mine[0]
  const terms = tabs.filter((tab): tab is TermTab => tab.type === 'term')

  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const reveal = () => {
      const node = el.querySelector('.tab.on') as HTMLElement | null
      if (!node) return
      node.scrollIntoView({ inline: 'nearest', block: 'nearest' })
      const pad = 24
      const view = el.getBoundingClientRect()
      const box = node.getBoundingClientRect()
      if (box.width <= 0 || view.width <= 0 || el.scrollWidth <= el.clientWidth + 1) return
      if (box.right > view.right - pad) el.scrollLeft += box.right - (view.right - pad)
      else if (box.left < view.left + pad) el.scrollLeft -= view.left + pad - box.left
    }
    const sync = () => {
      const kids = [...el.children] as HTMLElement[]
      const width = kids.reduce((sum, kid) => sum + kid.offsetWidth, 0) + Math.max(0, kids.length - 1) * 2
      const over = width > el.clientWidth + 1
      setOverflow((prev) => (prev === over ? prev : over))
      if (!over) {
        setFade((prev) => (prev === 'none' ? prev : 'none'))
        return
      }
      const max = el.scrollWidth - el.clientWidth
      const left = el.scrollLeft > 1
      const right = max - el.scrollLeft > 1
      const next = left && right ? 'both' : left ? 'left' : right ? 'right' : 'none'
      setFade((prev) => (prev === next ? prev : next))
    }
    reveal()
    sync()
    const frame = requestAnimationFrame(() => {
      reveal()
      sync()
    })
    const ro = new ResizeObserver(() => {
      reveal()
      sync()
    })
    ro.observe(el)
    if (el.parentElement) ro.observe(el.parentElement)
    const onScroll = () => sync()
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      cancelAnimationFrame(frame)
      ro.disconnect()
      el.removeEventListener('scroll', onScroll)
    }
  }, [shown?.id, mine.length, project?.id, overflow])

  const agentOf = (id: string) => agents.find((item) => item.id === id) || resolveAgent(id, [], installed)

  return (
    <main className="center" id="center">
      {!project ? (
        <div className="empty">
          <div className="in">
            <div className="glyph">
              <Icon name="folder" />
            </div>
            <h2>创建第一个项目</h2>
            <p>项目是某台机器上的一个目录，终端在其中运行 Agent CLI。</p>
            <div className="acts">
              <button className="btn pri" data-a="newproj" onClick={onNewProject}>
                <Icon name="plus" className="s" />
                新建项目
              </button>
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="tabbar" role="tablist">
            <div className={`tabs ${overflow ? 'over' : ''} ${fade === 'both' ? 'fade-l fade-r' : fade === 'left' ? 'fade-l' : fade === 'right' ? 'fade-r' : ''}`} ref={scroller}>
              {mine.map((tab) => {
                const on = tab.id === shown?.id
                if (tab.type !== 'term') {
                  const label = tab.path.split('/').pop() || tab.path
                  const preview = tab.type === 'file' && !tab.pinned
                  return (
                    <div key={tab.id} className={`tab ${on ? 'on' : ''} ${preview ? 'preview' : ''}`} role="tab" aria-selected={on}>
                      <button
                        className="grow"
                        style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}
                        data-a="tab"
                        data-id={tab.id}
                        onClick={() => onSelect(tab.id)}
                        onDoubleClick={() => {
                          if (tab.type === 'file') onPinFile(tab.id)
                        }}
                      >
                        <Icon name="file" className="s" />
                        <span className="lbl" title={tab.path}>{label}</span>
                        {tab.type === 'file' && tab.dirty ? <span className="dot unsaved" role="img" aria-label="有未保存的更改" /> : null}
                      </button>
                      <button className="x" data-a="close" data-id={tab.id} aria-label="关闭" onClick={() => onClose(tab.id)}>
                        <Icon name="x" className="s" />
                      </button>
                    </div>
                  )
                }
                const agent = agentOf(tab.kind)
                const name = tab.kind === 'shell' ? shellLabel(tab.shell) : agent.name
                const letter = tab.kind === 'shell' ? shellLetter(tab.shell) : agent.letter
                const color = tab.kind === 'shell' ? '#8fa3cc' : agent.color
                const status = terminalStatus(tab)
                return (
                  <div key={tab.id} className={`tab ${on ? 'on' : ''}`} role="tab" aria-selected={on}>
                    <button style={{ display: 'flex', alignItems: 'center', gap: 8 }} data-a="tab" data-id={tab.id} data-state={tab.state} title={`${name} · ${status.label}`} onClick={() => onSelect(tab.id)}>
                      <Mark letter={letter} color={color} />
                      <span className="lbl">{name}</span>
                      <span className={`dot terminal-status ${status.color}`} role="img" aria-label={status.label} />
                    </button>
                    <button className="x" data-a="close" data-id={tab.id} aria-label={`关闭 ${name}`} onClick={() => onClose(tab.id)}>
                      <Icon name="x" className="s" />
                    </button>
                  </div>
                )
              })}
            </div>
            <div className="tabtools">
              {overflow ? (
                <button className="addtab" data-a="tabs-menu" aria-label="全部标签" title="全部标签" onClick={() => setMenu((value) => !value)}>
                  <Icon name="chev" className="s chev open" />
                </button>
              ) : null}
              <button className="addtab" data-a="newterm" title="新建终端" aria-label="新建终端" onClick={onNewTerm}>
                <Icon name="plus" />
              </button>
            </div>
            <span className="grow" />
            {!rightOpen ? <button className="ib" data-a="right" title="显示文件面板" aria-label="显示文件面板" onClick={onToggleRight}><Icon name="panel" /></button> : null}
            {menu ? (
              <div className="pop" style={{ left: 8, right: 'auto' }}>
                {mine.map((tab) => {
                  const label = tab.type === 'term' ? (tab.kind === 'shell' ? shellLabel(tab.shell) : agentOf(tab.kind).name) : tab.path.split('/').pop()
                  return (
                    <button
                      key={tab.id}
                      className={`row ${tab.id === shown?.id ? 'on' : ''}`}
                      onClick={() => {
                        onSelect(tab.id)
                        setMenu(false)
                      }}
                    >
                      <span style={{ width: 14, flex: 'none', color: 'var(--muted)' }}>{tab.id === shown?.id ? '✓' : ''}</span>
                      <span className="nm grow">{label}</span>
                      {tab.type === 'term' ? <span className={`dot terminal-status ${terminalStatus(tab).color}`} role="img" aria-label={terminalStatus(tab).label} /> : null}
                    </button>
                  )
                })}
              </div>
            ) : null}
          </div>
          {!shown ? (
            <div className="empty">
              <div className="in">
                <div className="glyph">
                  <Icon name="terminal" />
                </div>
                <h2>还没有终端</h2>
                <p>
                  在 <span className="mono">{project.path}</span> 打开一个 Agent CLI。
                </p>
                <div className="acts">
                  <button className="btn pri" data-a="quick" onClick={onQuick}>
                    <Mark letter={agentOf(project.agent).letter} color={agentOf(project.agent).color} />
                    启动 {agentOf(project.agent).name}
                  </button>
                  <button className="btn" data-a="newterm" onClick={onNewTerm}>
                    选择其他…
                  </button>
                </div>
              </div>
            </div>
          ) : shown.type === 'diff' ? (
            <DiffPane diff={diff && diff.path === shown.path ? diff : null} mode={dmode} rightOpen={rightOpen} onMode={onDmode} onDiscard={onDiscard} onToggleRight={onToggleRight} untracked={untracked} />
          ) : shown.type === 'file' ? (
            <FilePane
              key={`${shown.projectId}:${shown.path}`}
              path={shown.path}
              document={preview?.path === shown.path ? preview : null}
              onEdit={(text) => onEditFile(shown.id, text)}
              onSave={() => onSaveFile(shown.id)}
              onReload={() => onReloadFile(shown.id)}
              onHistory={(redo) => onHistoryFile(shown.id, redo)}
              onCompose={(composing) => onComposeFile(shown.id, composing)}
              onPreviewHtml={() => onPreviewHtml(shown.id)}
              rightOpen={rightOpen}
              onToggleRight={onToggleRight}
            />
          ) : null}
        </>
      )}
            <div className="panes" hidden={!project || shown?.type !== 'term'}>
              {terms.map((tab) => {
                const visible = tab.projectId === project?.id && tab.id === shown?.id && shown?.type === 'term'
                const focus = visible
                return (
                  <div
                    key={tab.id}
                    className={`pane ${focus ? 'focus' : ''}`}
                    data-a="pane"
                    data-id={tab.id}
                    data-state={tab.state}
                    hidden={!visible}
                    onMouseDown={() => {
                      if (!focus) onSelect(tab.id)
                    }}
                  >
                    <TerminalPane id={tab.id} fontSize={fontSize} theme={theme} shell={tab.shell} visible={visible} onInterrupt={onInterrupt} onAppKey={onAppKey} />
                  </div>
                )
              })}
            </div>
    </main>
  )
}
