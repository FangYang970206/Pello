import { useEffect, useRef, useState, type CSSProperties, type DragEvent } from 'react'
import { t } from '../shared/i18n'
import { resolveAgent, shellLabel, shellLetter, type AgentInfo } from '../shared/types'
import { Icon, Mark } from './icons'
import { NameEditor } from './ProjectSidebar'
import { terminalStatus } from './terminal-state'
import type { Tab } from './Workspace'
import { useAnchoredMenu } from './useAnchoredMenu'

export function WorkspaceTabs({ groupId, index, tabs, activeId, focused, style, agents, installed, rightOpen, onToggleRight, onSelect, onClose, onPaneMenu, onRenameTerm, onNewTerm, renaming, setRenaming, onMoveTab }: {
  groupId: string; index: number; tabs: Tab[]; activeId: string; focused: boolean; style: CSSProperties
  agents: AgentInfo[]; installed: Record<string, boolean>; rightOpen: boolean
  onToggleRight: () => void; onSelect: (id: string) => void; onClose: (id: string) => void
  onPaneMenu: (id: string) => void; onRenameTerm: (id: string, name: string) => Promise<void>
  onNewTerm: () => void; renaming: string | null; setRenaming: (id: string | null) => void
  onMoveTab: (id: string, before?: string) => void
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const [overflow, setOverflow] = useState(false)
  const [fade, setFade] = useState<'none' | 'left' | 'right' | 'both'>('none')
  const [drop, setDrop] = useState<{ id: string; after: boolean } | null>(null)
  const [menu, setMenu] = useState(false)
  const menuRef = useAnchoredMenu(menu && overflow, () => setMenu(false), { minWidth: 260 })
  const wheelGesture = useRef({ delta: 0, lastEvent: 0, lastSwitch: 0 })
  const renameFocus = useRef<string | null>(null)
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || renaming || tabs.length < 2) return
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
      if (!delta) return
      event.preventDefault()
      const gesture = wheelGesture.current, now = performance.now()
      if (now - gesture.lastEvent > 200 || Math.sign(delta) !== Math.sign(gesture.delta)) gesture.delta = 0
      gesture.lastEvent = now
      gesture.delta += delta * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? el.clientWidth : 1)
      if (Math.abs(gesture.delta) < 40 || now - gesture.lastSwitch < 120) return
      const index = tabs.findIndex((tab) => tab.id === activeId)
      const next = tabs[index + Math.sign(gesture.delta)]
      gesture.delta = 0
      gesture.lastSwitch = now
      if (next) { setMenu(false); onSelect(next.id) }
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  }, [tabs, activeId, onSelect, renaming])
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
      const first = el.firstElementChild, last = el.lastElementChild
      // Keep fractional pixels: rounding every tab separately can invent an
      // overflow. The arrow and overflow padding then repeatedly undo it.
      const width = first && last ? last.getBoundingClientRect().right - first.getBoundingClientRect().left : 0
      const view = el.getBoundingClientRect()
      const padding = getComputedStyle(el)
      const available = view.width - parseFloat(padding.paddingLeft) - parseFloat(padding.paddingRight)
      const over = width > available + 1
      setOverflow((prev) => (prev === over ? prev : over))
      if (!over) {
        setMenu(false)
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

  const tabDragType = 'application/x-pello-tab'
  function insertion(event: DragEvent<HTMLDivElement>) {
    const tab = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-drag-tab]') : null
    if (!tab?.dataset.dragTab) return null
    const bounds = tab.getBoundingClientRect()
    return { id: tab.dataset.dragTab, after: event.clientX >= bounds.left + bounds.width / 2 }
  }
  function tabDrag(id: string) {
    return {
      'data-drag-tab': id,
      'data-drop-edge': drop?.id === id ? drop.after ? 'after' : 'before' : undefined,
      draggable: renaming !== id,
      onDragStart: (event: DragEvent) => { event.dataTransfer.setData(tabDragType, id); event.dataTransfer.effectAllowed = 'move' },
      onDragEnd: () => setDrop(null)
    }
  }

  const agentOf = (id: string) => agents.find((item) => item.id === id) || resolveAgent(id, [], installed)
  return (
    <div className="tabbar editor-group-tabs" role="tablist" aria-label={t("编辑器分组 {{0}}", index + 1)} data-a="editor-group" data-group={groupId} data-focused={focused} style={style}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes(tabDragType)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        const list = scroller.current
        if (list && overflow) {
          const bounds = list.getBoundingClientRect()
          if (event.clientX >= bounds.left && event.clientX <= bounds.right) {
            if (event.clientX < bounds.left + 16) list.scrollLeft -= 24
            else if (event.clientX > bounds.right - 16) list.scrollLeft += 24
          }
        }
        const next = insertion(event)
        setDrop((current) => current?.id === next?.id && current?.after === next?.after ? current : next)
      }}
      onDragLeave={(event) => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDrop(null) }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes(tabDragType)) return
        event.preventDefault()
        setDrop(null)
        const id = event.dataTransfer.getData(tabDragType), target = insertion(event)
        if (!id || target?.id === id) return
        const index = target ? tabs.findIndex((tab) => tab.id === target.id) + Number(target.after) : tabs.length
        onMoveTab(id, tabs[index]?.id)
      }}
    >
      <div className={`tabs ${overflow ? 'over' : ''} ${fade === 'both' ? 'fade-l fade-r' : fade === 'left' ? 'fade-l' : fade === 'right' ? 'fade-r' : ''}`} ref={scroller}>
        {tabs.map((tab) => {
          const on = tab.id === activeId
          if (tab.type !== 'term') {
            const label = tab.path.split('/').pop() || tab.path
            return (
              <div key={tab.id} {...tabDrag(tab.id)} className={`tab ${on ? 'on' : ''}`} role="tab" aria-selected={on} onContextMenu={(event) => { event.preventDefault(); void onPaneMenu(tab.id) }}>
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
            <div key={tab.id} {...tabDrag(tab.id)} className={`tab ${on ? 'on' : ''}`} role="tab" aria-selected={on} onContextMenu={(event) => { event.preventDefault(); void onPaneMenu(tab.id) }}>
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
          <button className="addtab" data-a="tabs-menu" aria-label={t("全部标签")} title={t("全部标签")} aria-haspopup="listbox" aria-expanded={menu} onClick={() => setMenu((value) => !value)}>
            <Icon name="chev" className="s chev open" />
          </button>
        ) : null}
        {menu && overflow ? (
          <div ref={menuRef} className="pop tabs-popover" popover="manual" role="listbox" aria-label={t("全部标签")}>
            {tabs.map((tab) => {
              const label = tab.type === 'term' ? tab.name || (tab.kind === 'shell' ? shellLabel(tab.shell) : agentOf(tab.kind).name) : tab.path.split('/').pop()
              return <button key={tab.id} role="option" aria-selected={tab.id === activeId} className={`row ${tab.id === activeId ? 'on' : ''}`} title={tab.type === 'term' ? label : tab.path}
                onClick={() => { onSelect(tab.id); setMenu(false) }}>
                <span style={{ width: 14, flex: 'none', color: 'var(--muted)' }}>{tab.id === activeId ? '✓' : ''}</span>
                <span className="nm grow">{label}</span>
                {tab.type === 'term' ? <span className={`dot terminal-status ${terminalStatus(tab).color}${terminalStatus(tab).spinning ? ' spinning' : ''}`} role="img" aria-label={terminalStatus(tab).label} /> : null}
              </button>
            })}
          </div>
        ) : null}
        <button className="addtab" data-a="newterm" title={t("新建终端")} aria-label={t("新建终端")} onClick={onNewTerm}>
          <Icon name="plus" />
        </button>
      </div>
      <span className="grow" />
      {!rightOpen && focused ? <button className="ib" data-a="right" title={t("显示文件面板")} aria-label={t("显示文件面板")} onClick={onToggleRight}><Icon name="panel" /></button> : null}
    </div>
  )
}
