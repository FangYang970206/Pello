import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'

/** Keep every result reachable without mounting thousands of buttons at once. */
export function VirtualFileRows<T extends { path: string }>({ items, render }: { items: T[]; render: (item: T) => ReactNode }) {
  const root = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState({ top: 0, height: 600 })
  const [focused, setFocused] = useState<string | null>(null)
  const virtual = items.length > 300
  useLayoutEffect(() => {
    const node = root.current, owner = node?.closest<HTMLElement>('.rlist')
    if (!virtual || !node || !owner) return
    const update = () => {
      const top = Math.max(0, owner.getBoundingClientRect().top - node.getBoundingClientRect().top)
      const height = owner.clientHeight
      setViewport((old) => old.top === top && old.height === height ? old : { top, height })
    }
    update()
    owner.addEventListener('scroll', update, { passive: true })
    owner.addEventListener('toggle', update, true)
    const observer = new ResizeObserver(update); observer.observe(owner); observer.observe(node)
    return () => { owner.removeEventListener('scroll', update); owner.removeEventListener('toggle', update, true); observer.disconnect() }
  }, [virtual, items.length])
  const start = Math.min(items.length, Math.max(0, Math.floor(viewport.top / 30) - 8))
  const end = Math.min(items.length, Math.ceil((viewport.top + viewport.height) / 30) + 8)
  const indices = virtual ? Array.from({ length: Math.max(0, end - start) }, (_, index) => start + index) : []
  const focusedIndex = focused ? items.findIndex((item) => item.path === focused) : -1
  if (virtual && focusedIndex >= 0 && !indices.includes(focusedIndex)) indices.push(focusedIndex)
  return <div ref={root} data-virtual-count={virtual ? items.length : undefined} style={virtual ? { height: items.length * 30, position: 'relative' } : undefined}
    onFocusCapture={(event) => {
      const row = (event.target as Element).closest<HTMLElement>('[data-virtual-index]')
      if (row) setFocused(items[Number(row.dataset.virtualIndex)]?.path || null)
    }}
    onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(null) }}
    onKeyDown={(event) => {
      if (!virtual || event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return
      const row = (event.target as Element).closest<HTMLElement>('[data-virtual-index]')
      if (!row) return
      const action = row.querySelector('[data-row-action]')
      if (event.key === 'Tab' && action && event.shiftKey === (event.target === action)) return
      const current = Number(row.dataset.virtualIndex)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
        : event.key === 'ArrowDown' || (event.key === 'Tab' && !event.shiftKey) ? current + 1
        : event.key === 'ArrowUp' || (event.key === 'Tab' && event.shiftKey) ? current - 1 : -1
      if (next < 0 || next >= items.length) return
      event.preventDefault()
      setFocused(items[next].path)
      requestAnimationFrame(() => {
        const nextRow = root.current?.querySelector(`[data-virtual-index="${next}"]`)
        const button = (event.key === 'Tab' && event.shiftKey ? nextRow?.querySelector<HTMLButtonElement>('[data-row-action]') : null)
          ?? nextRow?.querySelector<HTMLButtonElement>('button')
        button?.focus({ preventScroll: true }); button?.scrollIntoView({ block: 'nearest' })
      })
    }}>
    {virtual ? indices.map((index) => <div key={items[index].path} data-virtual-index={index} style={{ position: 'absolute', top: index * 30, left: 0, right: 0, height: 30 }}>{render(items[index])}</div>) : items.map(render)}
  </div>
}
