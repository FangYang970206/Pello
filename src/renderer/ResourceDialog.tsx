import { useId, useLayoutEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './icons'

export function ResourceDialog({ title, onClose, children, footer, busy = false }: { title: string; onClose: () => void; children: ReactNode; footer: ReactNode; busy?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null), heading = useId()
  useLayoutEffect(() => {
    const dialog = ref.current!, opener = document.activeElement as HTMLElement | null
    dialog.showModal()
    return () => { dialog.close(); if (opener?.isConnected) opener.focus() }
  }, [])
  return createPortal(<dialog ref={ref} className="dlg lg resource-dialog" aria-labelledby={heading}
    onCancel={(event) => { event.preventDefault(); if (!busy) onClose() }}
    onKeyDown={(event) => event.stopPropagation()}>
    <header><h2 id={heading}>{title}</h2><button className="ib" data-a="mclose" aria-label="关闭" disabled={busy} onClick={onClose}><Icon name="x" /></button></header>
    <div className="bdy">{children}</div><footer>{footer}</footer>
  </dialog>, document.body)
}
