import { useRef } from 'react'

export function SidebarResize({ width, onResize }: { width: number; onResize: (width: number) => void }) {
  const drag = useRef<{ x: number; width: number } | null>(null)
  return <div className="sidebar-resize" role="separator" aria-label="调整项目侧栏宽度" aria-orientation="vertical" aria-valuenow={width} aria-valuemin={180} aria-valuemax={480} tabIndex={0}
    onPointerDown={(event) => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); drag.current = { x: event.clientX, width } }}
    onPointerMove={(event) => { if (drag.current) onResize(drag.current.width + event.clientX - drag.current.x) }}
    onPointerUp={(event) => { drag.current = null; event.currentTarget.releasePointerCapture(event.pointerId) }}
    onPointerCancel={() => { drag.current = null }} onLostPointerCapture={() => { drag.current = null }}
    onKeyDown={(event) => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); onResize(width + (event.key === 'ArrowRight' ? 20 : -20)) } }} />
}
