import { t } from '../shared/i18n'
import { useId, useLayoutEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './icons'
import { positionSettingsDialog } from './settings-dialog-position'

export function ResourceDialog({ title, onClose, children, footer, busy = false, compact = false, dismissOnBackdrop = false, returnFocus, className = '' }: { title: string; onClose: () => void; children: ReactNode; footer: ReactNode; busy?: boolean; compact?: boolean; dismissOnBackdrop?: boolean; returnFocus?: HTMLElement | null; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null), heading = useId()
  const pressedOutside = useRef(false)
  useLayoutEffect(() => {
    const dialog = ref.current!, opener = returnFocus || document.activeElement as HTMLElement | null
    const stopPositioning = positionSettingsDialog(dialog)
    dialog.showModal()
    return () => { stopPositioning(); dialog.close(); if (opener?.isConnected) opener.focus() }
  }, [returnFocus])
  const outside = (x: number, y: number) => { const box = ref.current!.getBoundingClientRect(); return x < box.left || x > box.right || y < box.top || y > box.bottom }
  return createPortal(<dialog ref={ref} className={`dlg lg resource-dialog${compact ? ' resource-dialog-compact' : ''} ${className}`} aria-labelledby={heading}
    onCancel={(event) => {
      event.preventDefault()
      event.stopPropagation()
      if (event.target === event.currentTarget && !busy) onClose()
    }}
    onPointerDown={(event) => { pressedOutside.current = event.target === event.currentTarget && outside(event.clientX, event.clientY) }}
    onPointerUp={(event) => { if (dismissOnBackdrop && !busy && pressedOutside.current && event.target === event.currentTarget && outside(event.clientX, event.clientY)) onClose(); pressedOutside.current = false }}
    onKeyDown={(event) => event.stopPropagation()}>
    <header><h2 id={heading}>{title}</h2><button className="ib" data-a="mclose" aria-label={t("关闭")} disabled={busy} onClick={onClose}><Icon name="x" /></button></header>
    <div className="bdy">{children}</div><footer>{footer}</footer>
  </dialog>, document.body)
}
