import { useId, useLayoutEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './icons'

export function ResourceDialog({ title, onClose, children, footer, busy = false, compact = false, dismissOnBackdrop = false, returnFocus }: { title: string; onClose: () => void; children: ReactNode; footer: ReactNode; busy?: boolean; compact?: boolean; dismissOnBackdrop?: boolean; returnFocus?: HTMLElement | null }) {
  const ref = useRef<HTMLDialogElement>(null), heading = useId()
  const pressedOutside = useRef(false)
  useLayoutEffect(() => {
    const dialog = ref.current!, opener = returnFocus || document.activeElement as HTMLElement | null
    const content = document.querySelector('.settings .scontent'), column = content?.querySelector('.scol')
    const position = () => {
      const area = content?.getBoundingClientRect(), col = column?.getBoundingClientRect()
      const top = Math.max(0, area?.top || 0), bottom = Math.min(innerHeight, area?.bottom ?? innerHeight)
      const height = Math.max(0, bottom - top)
      dialog.style.left = `${col ? col.left + col.width / 2 : innerWidth / 2}px`
      dialog.style.top = `${top + height / 2}px`
      dialog.style.maxWidth = `${Math.min(col?.width ?? innerWidth - 48, innerWidth - 48)}px`
      dialog.style.setProperty('--resource-max-height', `${Math.max(0, height - 48)}px`)
      dialog.style.setProperty('--resource-detail-height', `${height * .6}px`)
    }
    position()
    const observer = new ResizeObserver(position)
    if (content) observer.observe(content)
    if (column) observer.observe(column)
    window.addEventListener('resize', position)
    dialog.showModal()
    return () => { observer.disconnect(); window.removeEventListener('resize', position); dialog.close(); if (opener?.isConnected) opener.focus() }
  }, [returnFocus])
  const outside = (x: number, y: number) => { const box = ref.current!.getBoundingClientRect(); return x < box.left || x > box.right || y < box.top || y > box.bottom }
  return createPortal(<dialog ref={ref} className={`dlg lg resource-dialog${compact ? ' resource-dialog-compact' : ''}`} aria-labelledby={heading}
    onCancel={(event) => { event.preventDefault(); if (!busy) onClose() }}
    onPointerDown={(event) => { pressedOutside.current = event.target === event.currentTarget && outside(event.clientX, event.clientY) }}
    onPointerUp={(event) => { if (dismissOnBackdrop && !busy && pressedOutside.current && event.target === event.currentTarget && outside(event.clientX, event.clientY)) onClose(); pressedOutside.current = false }}
    onKeyDown={(event) => event.stopPropagation()}>
    <header><h2 id={heading}>{title}</h2><button className="ib" data-a="mclose" aria-label="关闭" disabled={busy} onClick={onClose}><Icon name="x" /></button></header>
    <div className="bdy">{children}</div><footer>{footer}</footer>
  </dialog>, document.body)
}
