import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { AgentInfo, FileDiff, ProcState, Project, ShellKind, ThemeName } from '../shared/types'
import { STATE_LABEL, fmtElapsed, resolveAgent, shellLabel, shellLetter } from '../shared/types'
import { Icon, Mark } from './icons'
import { TerminalPane } from './TerminalPane'
import { DiffPane, FilePane } from './DiffPane'

export type TermTab = {
  id: string
  type: 'term'
  projectId: string
  kind: string
  shell: ShellKind
  state: ProcState
  startedAt: number | null
  exitCode: number | null
}
export type DiffTab = { id: string; type: 'diff'; projectId: string; path: string }
export type FileTab = { id: string; type: 'file'; projectId: string; path: string }
export type Tab = TermTab | DiffTab | FileTab

function Elapsed({ start }: { start: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return <span className="t">{fmtElapsed(now - start)}</span>
}

export function Workspace({
  project,
  tabs,
  active,
  split,
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
  onKill,
  onRestart,
  onSplit,
  onToggleRight,
  onDmode,
  onDiscard,
  onAppKey
}: {
  project: Project | null
  tabs: Tab[]
  active?: Tab
  split: boolean
  rightOpen: boolean
  dmode: 'unified' | 'split'
  theme: ThemeName
  fontSize: number
  agents: AgentInfo[]
  installed: Record<string, boolean>
  diff: FileDiff | null
  preview: { path: string; text: string; binary: boolean; missing: boolean } | null
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onNewTerm: () => void
  onNewProject: () => void
  onQuick: () => void
  onInterrupt: (id: string) => void
  onKill: () => void
  onRestart: () => void
  onSplit: () => void
  onToggleRight: () => void
  onDmode: (mode: 'unified' | 'split') => void
  onDiscard: () => void
  onAppKey: (key: string) => void
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const [overflow, setOverflow] = useState(false)
  const [menu, setMenu] = useState(false)
  const mine = project ? tabs.filter((tab) => tab.projectId === project.id) : []
  const terms = mine.filter((tab): tab is TermTab => tab.type === 'term')
  const other = split && active?.type === 'term' ? terms.find((tab) => tab.id !== active.id) : undefined

  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const measure = () => setOverflow(el.scrollWidth > el.clientWidth + 2)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [mine.length, project?.id])

  const agentOf = (id: string) => agents.find((item) => item.id === id) || resolveAgent(id, [], installed)

  let proc: ReactNode = null
  if (!project) proc = null
  else if (active?.type === 'term') {
    const running = active.state === 'running'
    proc = (
      <div className="proc">
        <div className={`pstate ${active.state}`}>
          <span className={`dot ${active.state}`} />
          <b>{STATE_LABEL[active.state]}</b>
          {running && active.startedAt ? <Elapsed start={active.startedAt} /> : active.exitCode != null ? <span className="t">退出码 {active.exitCode}</span> : null}
        </div>
        <button className="ib w" data-a="ctrlc" title="发送 Ctrl+C" aria-label="发送 Ctrl+C" onClick={() => onInterrupt(active.id)}>
          <span className="mono" style={{ fontSize: 11 }}>
            ^C
          </span>
        </button>
        <button className="ib danger" data-a="kill" disabled={!running} title="结束进程" aria-label="结束进程" onClick={onKill}>
          <Icon name="stop" />
        </button>
        <button
          className="ib"
          data-a="restart"
          disabled={active.kind === 'shell' && active.state !== 'failed' && active.state !== 'exited'}
          title="重新启动同一命令"
          aria-label="重新启动"
          onClick={onRestart}
        >
          <Icon name="refresh" />
        </button>
        <span className="vsep" />
        <button className={`ib ${split ? 'on' : ''}`} data-a="split" aria-pressed={split} title="分屏" aria-label="分屏" onClick={onSplit}>
          <Icon name="split" />
        </button>
        {rightOpen ? null : (
          <button className="ib" data-a="right" title="显示文件面板" aria-label="显示文件面板" onClick={onToggleRight}>
            <Icon name="panel" />
          </button>
        )}
      </div>
    )
  } else {
    proc = <div className="proc">{rightOpen ? null : <button className="ib" data-a="right" title="显示文件面板" aria-label="显示文件面板" onClick={onToggleRight}><Icon name="panel" /></button>}</div>
  }

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
            <div className="hint">
              <span>
                <kbd>Ctrl N</kbd>新建项目
              </span>
              <span>
                <kbd>Ctrl T</kbd>新建终端
              </span>
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="tabbar" role="tablist">
            <div className="tabs" ref={scroller}>
              {mine.map((tab) => {
                const on = tab.id === active?.id
                if (tab.type !== 'term') {
                  const label = tab.path.split('/').pop() || tab.path
                  return (
                    <div key={tab.id} className={`tab ${on ? 'on' : ''}`} role="tab" aria-selected={on}>
                      <button className="grow" style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }} data-a="tab" data-id={tab.id} onClick={() => onSelect(tab.id)}>
                        <Icon name="file" className="s" />
                        <span className="lbl">{label}</span>
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
                return (
                  <div key={tab.id} className={`tab ${on ? 'on' : ''}`} role="tab" aria-selected={on}>
                    <button style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }} data-a="tab" data-id={tab.id} title={`${name} · ${STATE_LABEL[tab.state]}`} onClick={() => onSelect(tab.id)}>
                      <Mark letter={letter} color={color} />
                      <span className="lbl">{name}</span>
                      <span className={`dot ${tab.state}`} role="img" aria-label={STATE_LABEL[tab.state]} />
                    </button>
                    <button className="x" data-a="close" data-id={tab.id} aria-label={`关闭 ${name}`} onClick={() => onClose(tab.id)}>
                      <Icon name="x" className="s" />
                    </button>
                  </div>
                )
              })}
            </div>
            {overflow ? (
              <button className="addtab" data-a="tabs-menu" aria-label="全部标签" title="全部标签" onClick={() => setMenu((value) => !value)}>
                <Icon name="chev" className="s chev open" />
              </button>
            ) : null}
            <button className="addtab" data-a="newterm" title="新建终端 (Ctrl T)" aria-label="新建终端" onClick={onNewTerm}>
              <Icon name="plus" />
            </button>
            <span className="grow" />
            {proc}
            {menu ? (
              <div className="pop" style={{ left: 8, right: 'auto' }}>
                {mine.map((tab) => {
                  const label = tab.type === 'term' ? (tab.kind === 'shell' ? shellLabel(tab.shell) : agentOf(tab.kind).name) : tab.path.split('/').pop()
                  return (
                    <button
                      key={tab.id}
                      className={`row ${tab.id === active?.id ? 'on' : ''}`}
                      onClick={() => {
                        onSelect(tab.id)
                        setMenu(false)
                      }}
                    >
                      <span className="nm grow">{label}</span>
                      {tab.type === 'term' ? <span className={`dot ${tab.state}`} /> : null}
                    </button>
                  )
                })}
              </div>
            ) : null}
          </div>
          {!active ? (
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
          ) : active.type === 'diff' ? (
            <DiffPane diff={diff && diff.path === active.path ? diff : null} mode={dmode} rightOpen={rightOpen} onMode={onDmode} onDiscard={onDiscard} onToggleRight={onToggleRight} />
          ) : active.type === 'file' ? (
            <FilePane path={active.path} text={preview?.path === active.path ? preview.text : ''} binary={!!preview && preview.path === active.path && preview.binary} missing={!preview || preview.path !== active.path ? false : preview.missing} theme={theme} />
          ) : (
            <div className="panes">
              {terms.map((tab) => {
                const visible = tab.id === active.id || tab.id === other?.id
                const focus = tab.id === active.id
                const agent = agentOf(tab.kind)
                return (
                  <div
                    key={tab.id}
                    className={`pane ${focus ? 'focus' : ''}`}
                    hidden={!visible}
                    style={{ order: focus ? 0 : 1 }}
                    onMouseDown={() => {
                      if (!focus) onSelect(tab.id)
                    }}
                  >
                    {other ? (
                      <div className="ph">
                        <Mark letter={tab.kind === 'shell' ? shellLetter(tab.shell) : agent.letter} color={tab.kind === 'shell' ? '#8fa3cc' : agent.color} />
                        {tab.kind === 'shell' ? shellLabel(tab.shell) : agent.name}
                        <span className={`dot ${tab.state}`} />
                      </div>
                    ) : null}
                    <TerminalPane id={tab.id} fontSize={fontSize} theme={theme} shell={tab.shell} visible={visible} onInterrupt={onInterrupt} onAppKey={onAppKey} />
                  </div>
                )
              })}
            </div>
          )}
        </>
      )}
    </main>
  )
}
