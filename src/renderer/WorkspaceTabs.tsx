import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { t } from '../shared/i18n'
import { resolveAgent, shellLabel, shellLetter, type AgentInfo } from '../shared/types'
import { Icon, Mark } from './icons'
import { NameEditor } from './ProjectSidebar'
import { terminalStatus } from './terminal-state'
import type { Tab } from './Workspace'

export function WorkspaceTabs({ groupId, index, tabs, activeId, focused, style, agents, installed, rightOpen, onToggleRight, onSelect, onClose, onPaneMenu, onRenameTerm, onNewTerm, renaming, setRenaming, onMoveTab }: {
  groupId: string; index: number; tabs: Tab[]; activeId: string; focused: boolean; style: CSSProperties
  agents: AgentInfo[]; installed: Record<string, boolean>; rightOpen: boolean
  onToggleRight: () => void; onSelect: (id: string) => void; onClose: (id: string) => void
  onPaneMenu: (id: string) => void; onRenameTerm: (id: string, name: string) => Promise<void>
  onNewTerm: () => void; renaming: string | null; setRenaming: (id: string | null) => void
  onMoveTab: (id: string) => void
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const [overflow, setOverflow] = useState(false)
  const [fade, setFade] = useState<'none' | 'left' | 'right' | 'both'>('none')
  const [menu, setMenu] = useState(false)
  const renameFocus = useRef<string | null>(null)
  useEffect(() => {
    if (renaming) { renameFocus.current = renaming; return }
    const id = renameFocus.current
    renameFocus.current = null
    if (id) scroller.current?.querySelector<HTMLElement>(`[data-a="tab"][data-id="${CSS.escape(id)}"]`)?.focus()
  }, [renaming])
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
  }, [activeId, tabs.length, overflow])

  const agentOf = (id: string) => agents.find((item) => item.id === id) || resolveAgent(id, [], installed)
  return (
    <div className="tabbar editor-group-tabs" role="tablist" aria-label={t("编辑器分组 {{0}}", index + 1)} data-a="editor-group" data-group={groupId} data-focused={focused} style={style}
      onDragOver={(event) => { if (event.dataTransfer.types.includes('application/x-pello-tab')) { event.preventDefault(); event.dataTransfer.dropEffect = 'move' } }}
      onDrop={(event) => { event.preventDefault(); const id = event.dataTransfer.getData('application/x-pello-tab'); if (id) onMoveTab(id) }}
    >
      <div className={`tabs ${overflow ? 'over' : ''} ${fade === 'both' ? 'fade-l fade-r' : fade === 'left' ? 'fade-l' : fade === 'right' ? 'fade-r' : ''}`} ref={scroller}>
        {tabs.map((tab) => {
          const on = tab.id === activeId
          if (tab.type !== 'term') {
            const label = tab.path.split('/').pop() || tab.path
            return (
              <div key={tab.id} draggable={renaming !== tab.id} onDragStart={(event) => { event.dataTransfer.setData('application/x-pello-tab', tab.id); event.dataTransfer.effectAllowed = 'move' }} className={`tab ${on ? 'on' : ''}`} role="tab" aria-selected={on} onContextMenu={(event) => { event.preventDefault(); void onPaneMenu(tab.id) }}>
                <button
                  className="grow"
                  style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}
                  data-a="tab"
                  data-id={tab.id}
                  onClick={() => onSelect(tab.id)}
                  onKeyDown={(event) => { if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); void onPaneMenu(tab.id) } }}
                >
                  <Icon name="file" className="s" />
                  <span className="lbl" title={tab.path}>{label}</span>
                  {tab.dirty ? <span className="dot unsaved" role="img" aria-label={t("有未保存的更改")} /> : null}
                </button>
                <button className="x" data-a="close" data-id={tab.id} aria-label={t("关闭")} onClick={() => onClose(tab.id)}>
                  <Icon name="x" className="s" />
                </button>
              </div>
            )
          }
          const agent = agentOf(tab.kind)
          const name = tab.name || (tab.kind === 'shell' ? shellLabel(tab.shell) : agent.name)
          const letter = tab.kind === 'shell' ? shellLetter(tab.shell) : agent.letter
          const color = tab.kind === 'shell' ? '#8fa3cc' : agent.color
          const status = terminalStatus(tab)
          return (
            <div key={tab.id} draggable={renaming !== tab.id} onDragStart={(event) => { event.dataTransfer.setData('application/x-pello-tab', tab.id); event.dataTransfer.effectAllowed = 'move' }} className={`tab ${on ? 'on' : ''}`} role="tab" aria-selected={on} onContextMenu={(event) => { event.preventDefault(); void onPaneMenu(tab.id) }}>
              {renaming === tab.id ? <NameEditor initial={name} onCancel={() => setRenaming(null)} onSave={async (name) => { await onRenameTerm(tab.id, name); setRenaming(null) }} /> : <button style={{ display: 'flex', alignItems: 'center', gap: 8 }} data-a="tab" data-id={tab.id} data-state={tab.state} title={`${name} · ${status.label}`} onClick={() => onSelect(tab.id)} onDoubleClick={() => setRenaming(tab.id)} onKeyDown={(event) => { if (event.key === 'F2') { event.preventDefault(); setRenaming(tab.id) } else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); void onPaneMenu(tab.id) } }}>
                <Mark letter={letter} color={color} />
                <span className="lbl">{name}</span>
                <span className={`dot terminal-status ${status.color}${status.spinning ? ' spinning' : ''}`} role="img" aria-label={status.label} />
              </button>}
              <button className="x" data-a="close" data-id={tab.id} aria-label={t("关闭 {{0}}", name)} onClick={() => onClose(tab.id)}>
                <Icon name="x" className="s" />
              </button>
            </div>
          )
        })}
      </div>
      <div className="tabtools">
        {overflow ? (
          <button className="addtab" data-a="tabs-menu" aria-label={t("全部标签")} title={t("全部标签")} onClick={() => setMenu((value) => !value)}>
            <Icon name="chev" className="s chev open" />
          </button>
        ) : null}
        <button className="addtab" data-a="newterm" title={t("新建终端")} aria-label={t("新建终端")} onClick={onNewTerm}>
          <Icon name="plus" />
        </button>
      </div>
      <span className="grow" />
      {!rightOpen && focused ? <button className="ib" data-a="right" title={t("显示文件面板")} aria-label={t("显示文件面板")} onClick={onToggleRight}><Icon name="panel" /></button> : null}
      {menu ? (
        <div className="pop" style={{ left: 8, right: 'auto' }}>
          {tabs.map((tab) => {
            const label = tab.type === 'term' ? tab.name || (tab.kind === 'shell' ? shellLabel(tab.shell) : agentOf(tab.kind).name) : tab.path.split('/').pop()
            return (
              <button
                key={tab.id}
                className={`row ${tab.id === activeId ? 'on' : ''}`}
                onClick={() => {
                  onSelect(tab.id)
                  setMenu(false)
                }}
              >
                <span style={{ width: 14, flex: 'none', color: 'var(--muted)' }}>{tab.id === activeId ? '✓' : ''}</span>
                <span className="nm grow">{label}</span>
                {tab.type === 'term' ? <span className={`dot terminal-status ${terminalStatus(tab).color}${terminalStatus(tab).spinning ? ' spinning' : ''}`} role="img" aria-label={terminalStatus(tab).label} /> : null}
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
