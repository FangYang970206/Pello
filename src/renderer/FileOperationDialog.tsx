import { t } from '../shared/i18n'
import { useId, useLayoutEffect, useRef, type FormEvent, type ReactNode } from 'react'
import { Icon } from './icons'

export function FileOperationDialog({ title, busy = false, onClose, onSubmit, children, footer }: { title: string; busy?: boolean; onClose: () => void; onSubmit: (event: FormEvent) => void; children: ReactNode; footer: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null), heading = useId()
  useLayoutEffect(() => {
    const element = dialog.current!, opener = document.activeElement as HTMLElement | null
    element.showModal()
    element.querySelector<HTMLElement>('input:not([disabled]), select:not([disabled])')?.focus()
    return () => { element.close(); if (opener?.isConnected) opener.focus() }
  }, [])
  return <dialog ref={dialog} className="dlg file-operation-dialog" aria-labelledby={heading} onCancel={(event) => { event.preventDefault(); if (!busy) onClose() }} onKeyDown={(event) => event.stopPropagation()}>
    <form onSubmit={onSubmit}>
      <header><h2 id={heading}>{title}</h2><button type="button" className="ib" aria-label={t("关闭")} disabled={busy} onClick={onClose}><Icon name="x" /></button></header>
      <div className="bdy">{children}</div><footer>{footer}</footer>
    </form>
  </dialog>
}
