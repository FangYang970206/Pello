import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { AgentInfo, Host, Project, WorkSession } from '../shared/types'
import { hostColor } from '../shared/host-colors'
import { sessionOf } from '../shared/work-sessions'
import { shellLabel } from '../shared/types'
import type { TermTab } from './Workspace'
import { terminalStatus } from './terminal-state'
import { Icon } from './icons'
import { useAnchoredMenu } from './useAnchoredMenu'

function SidebarMenu({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const ref = useAnchoredMenu(true, onClose, { minWidth: 180, itemRole: 'menuitem' })
  return <div ref={ref} className="pmenu" role="menu" popover="manual">{children}</div>
}

function NameEditor({ initial, onSave, onCancel }: { initial: string; onSave: (value: string) => Promise<void>; onCancel: () => void }) {
  const [value, setValue] = useState(initial), [busy, setBusy] = useState(false), [error, setError] = useState('')
  return <form className="sidebar-name-editor" onSubmit={(event) => {
    event.preventDefault()
    if (!value.trim()) { setError('名称不能为空'); return }
    setBusy(true); setError('')
    void onSave(value.trim()).catch((error) => setError(String(error))).finally(() => setBusy(false))
  }}>
    <div className="inrow"><input className="tx" aria-label="新名称" autoFocus maxLength={80} value={value} disabled={busy} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel() } }} />
      <button className="ib" type="submit" aria-label="保存名称" disabled={busy}><Icon name="check" className="s" /></button>
      <button className="ib" type="button" aria-label="取消重命名" disabled={busy} onClick={onCancel}><Icon name="x" className="s" /></button></div>
    {error ? <small className="bad" role="alert">{error}</small> : null}
  </form>
}

type Props = {
  projects: Project[]; hosts: Host[]; terms: TermTab[]; agents: AgentInfo[]
  sessions: Record<string, WorkSession[]>; selectedSession?: string
  projectId: string | null; activeId?: string; menuId: string | null
  onMenu: (id: string | null) => void; onProject: (id: string) => void; onTerm: (id: string) => void
  onSession: (project: string, id: string) => void
  onRenameProject: (id: string, name: string) => Promise<void>; onRenameTerm: (id: string, name: string) => Promise<void>
  onRenameSession: (project: string, id: string, name: string) => Promise<void>
  onRemoveSession: (project: string, id: string) => void
  onRemoveProject: (id: string) => void; onCloseTerm: (id: string) => void; onNewSession: (id: string) => void
  onCreateEntry: (id: string, directory: boolean) => void
}
const FILTERS = [{ id: 'running', name: '运行中' }, { id: 'waiting', name: '等待指令' }, { id: 'failed', name: '执行失败' }, { id: 'closed', name: '已退出' }, { id: 'starting', name: '正在启动' }]

export function ProjectSidebar(props: Props) {
  const { projects, hosts, terms, agents, sessions, selectedSession, projectId, activeId, menuId, onMenu, onProject, onTerm, onSession, onRenameProject, onRenameTerm, onRenameSession, onRemoveSession, onRemoveProject, onCloseTerm, onNewSession, onCreateEntry } = props
  const [editing, setEditing] = useState<{ kind: 'project' | 'session' | 'term'; id: string } | null>(null)
  const pendingFocus = useRef<{ action: string; id: string } | null>(null)
  useLayoutEffect(() => {
    const target = pendingFocus.current
    if (editing || !target) return
    pendingFocus.current = null
    document.querySelector<HTMLElement>(`[data-a="${target.action}"][data-id="${CSS.escape(target.id)}"]`)?.focus()
  }, [editing])
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [projectsOpen, setProjectsOpen] = useState(true)
  const [agentsOpen, setAgentsOpen] = useState(false)
  const [filters, setFilters] = useState(['running', 'waiting'])
  const beginRename = (kind: 'project' | 'session' | 'term', id: string) => { onMenu(null); setEditing({ kind, id }) }
  const finishRename = () => {
    const previous = editing
    const action = previous?.kind === 'project' ? 'proj' : previous?.kind === 'session' ? 'side-session' : 'side-term'
    if (previous) pendingFocus.current = { action, id: previous.id }
    setEditing(null)
  }
  const toggle = (id: string) => setCollapsed((value) => ({ ...value, [id]: !value[id] }))
  const termName = (term: TermTab) => term.name || (term.kind === 'shell' ? shellLabel(term.shell) : agents.find((agent) => agent.id === term.kind)?.name || term.kind)
  const visible = terms.filter((term) => filters.includes(terminalStatus(term).activity))
  return <>
    <div className="sidebar-section-heading"><button data-a="projects-toggle" aria-expanded={projectsOpen} onClick={() => setProjectsOpen(!projectsOpen)}><Icon name="chev" className={`s chev${projectsOpen ? ' open' : ''}`} />项目</button></div>
    {projectsOpen ? <div className="sidebar-projects">{projects.map((project) => {
      const host = hosts.find((item) => item.id === project.host)
      const on = projectId === project.id, open = menuId === project.id
      return <section className="project-group" key={project.id} aria-label={project.name}>
        <div className={`proj ${on ? 'on' : ''} ${open ? 'menu' : ''}`} data-id={project.id} onContextMenu={(event) => { event.preventDefault(); onMenu(project.id) }}>
          {editing?.kind === 'project' && editing.id === project.id ? <NameEditor initial={project.name} onCancel={finishRename} onSave={async (name) => { await onRenameProject(project.id, name); finishRename() }} /> : <>
            <button className="project-open" data-a="proj" data-id={project.id} aria-label={`打开项目 ${project.name}`} aria-current={on ? 'true' : undefined} aria-expanded={!collapsed[project.id]} title={`${project.name}\n${project.path}\n双击收起或展开会话`} onClick={() => onProject(project.id)} onDoubleClick={() => toggle(project.id)} onKeyDown={(event) => {
              if (event.key === 'F2') { event.preventDefault(); beginRename('project', project.id) }
              if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setCollapsed((value) => ({ ...value, [project.id]: event.key === 'ArrowLeft' })) }
            }}><span className="project-folder" data-color={hostColor(host?.color)}><Icon name="folder" /></span><span className="n grow">{project.name}</span></button>
            <button className="more" data-a="proj-more" data-id={project.id} aria-label={`项目菜单 ${project.name}`} aria-haspopup="menu" aria-expanded={open} onClick={() => onMenu(open ? null : project.id)}><Icon name="more" className="s" /></button>
            {open ? <SidebarMenu onClose={() => onMenu(null)}><button role="menuitem" onClick={() => { onMenu(null); onCreateEntry(project.id, false) }}>新建文件</button><button role="menuitem" onClick={() => { onMenu(null); onCreateEntry(project.id, true) }}>新建文件夹</button><button role="menuitem" onClick={() => beginRename('project', project.id)}>重命名项目</button><button role="menuitem" data-a="proj-remove" onClick={() => { onMenu(null); onRemoveProject(project.id) }}>移除项目</button></SidebarMenu> : null}
            <button className="project-add" data-a="new-session" data-id={project.id} aria-label={`为 ${project.name} 新建会话`} onClick={() => { setCollapsed((value) => ({ ...value, [project.id]: false })); onNewSession(project.id) }}><Icon name="plus" className="s" /></button>
          </>}
        </div>
        {!collapsed[project.id] ? <div className="sidebar-sessions">{(sessions[project.id] || []).map((session) => {
          const open = menuId === `session:${session.id}`
          return <div className={`sidebar-session ${on && selectedSession === session.id ? 'on' : ''}`} key={session.id} onContextMenu={(event) => { event.preventDefault(); onMenu(`session:${session.id}`) }}>
            {editing?.kind === 'session' && editing.id === session.id ? <NameEditor initial={session.name} onCancel={finishRename} onSave={async (name) => { await onRenameSession(project.id, session.id, name); finishRename() }} /> : <>
              <button className="sidebar-session-open" data-a="side-session" data-id={session.id} aria-current={on && selectedSession === session.id ? 'true' : undefined} title={session.name} onClick={() => onSession(project.id, session.id)} onKeyDown={(event) => { if (event.key === 'F2') { event.preventDefault(); beginRename('session', session.id) } }}><span className="grow">{session.name}</span></button>
              <button className="more" aria-label={`会话菜单 ${session.name}`} aria-haspopup="menu" aria-expanded={open} onClick={() => onMenu(open ? null : `session:${session.id}`)}><Icon name="more" className="s" /></button>
              {open ? <SidebarMenu onClose={() => onMenu(null)}><button role="menuitem" onClick={() => beginRename('session', session.id)}>重命名会话</button><button role="menuitem" onClick={() => { onMenu(null); onRemoveSession(project.id, session.id) }}>删除会话</button></SidebarMenu> : null}
            </>}
          </div>
        })}</div> : null}
      </section>
    })}{!projects.length ? <p className="sidebar-empty">暂无项目</p> : null}</div> : null}
    <div className="sidebar-section-heading agents-heading"><button data-a="agents-toggle" aria-expanded={agentsOpen} onClick={() => setAgentsOpen(!agentsOpen)}><Icon name="chev" className={`s chev${agentsOpen ? ' open' : ''}`} />Agents</button>
      <button className="more" aria-label="筛选 Agents" aria-haspopup="menu" aria-expanded={menuId === 'agents-filter'} onClick={() => onMenu(menuId === 'agents-filter' ? null : 'agents-filter')}><Icon name="more" className="s" /></button>
      {menuId === 'agents-filter' ? <SidebarMenu onClose={() => onMenu(null)}>{FILTERS.map((filter) => <button key={filter.id} role="menuitemcheckbox" aria-checked={filters.includes(filter.id)} onClick={() => setFilters((value) => value.includes(filter.id) ? value.filter((item) => item !== filter.id) : [...value, filter.id])}><span className="filter-check">{filters.includes(filter.id) ? <Icon name="check" className="s" /> : null}</span>{filter.name}</button>)}</SidebarMenu> : null}
    </div>
    {agentsOpen ? <div className="sidebar-agents">{visible.map((term) => {
      const project = projects.find((item) => item.id === term.projectId)
      const session = sessions[term.projectId]?.find((item) => item.id === sessionOf(term))
      const name = termName(term), status = terminalStatus(term), open = menuId === `term:${term.id}`
      return <div className={`sidebar-term ${activeId === term.id ? 'on' : ''}`} key={term.id} onContextMenu={(event) => { event.preventDefault(); onMenu(`term:${term.id}`) }}>
        {editing?.kind === 'term' && editing.id === term.id ? <NameEditor initial={name} onCancel={finishRename} onSave={async (value) => { await onRenameTerm(term.id, value); finishRename() }} /> : <>
          <button className="sidebar-term-open" data-a="side-term" data-id={term.id} data-status={status.activity} title={`${name} · ${status.label}\n${project?.name} / ${session?.name}`} aria-label={`${name} · ${status.label} · ${project?.name} / ${session?.name}`} onClick={() => onTerm(term.id)} onKeyDown={(event) => { if (event.key === 'F2') { event.preventDefault(); beginRename('term', term.id) } }}><span className={`dot terminal-status ${status.color}${status.spinning ? ' spinning' : ''}`} role="img" aria-label={status.label} /><span className="grow"><span className="agent-terminal-name">{name}</span><small>{project?.name} / {session?.name}</small></span></button>
          <button className="more" aria-label={`终端菜单 ${name}`} aria-haspopup="menu" aria-expanded={open} onClick={() => onMenu(open ? null : `term:${term.id}`)}><Icon name="more" className="s" /></button>
          {open ? <SidebarMenu onClose={() => onMenu(null)}><button role="menuitem" onClick={() => beginRename('term', term.id)}>重命名终端</button><button role="menuitem" onClick={() => { onMenu(null); onCloseTerm(term.id) }}>删除终端</button></SidebarMenu> : null}
        </>}
      </div>
    })}{!visible.length ? <p className="sidebar-empty">没有符合筛选条件的终端</p> : null}</div> : null}
  </>
}
