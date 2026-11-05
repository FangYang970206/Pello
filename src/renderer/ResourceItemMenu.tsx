import { useRef, useState } from 'react'
import { Icon } from './icons'
import { useAnchoredMenu } from './useAnchoredMenu'

export function ResourceItemMenu({ name, disabled, onOpen, onDelete }: { name: string; disabled: boolean; onOpen: () => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useAnchoredMenu(open, () => setOpen(false), { minWidth: 180, itemRole: 'menuitem' })
  function act(action: () => void) { setOpen(false); trigger.current?.focus(); action() }
  return <>
    <button ref={trigger} className="ib" aria-label={`Skill 菜单 ${name}`} aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={() => setOpen(!open)}><Icon name="more" /></button>
    {open ? <div ref={menu} className="pmenu resource-menu" role="menu" aria-label={`${name} 操作`} popover="manual">
      <button role="menuitem" onClick={() => act(onOpen)}>在资源管理器打开</button>
      <button role="menuitem" className="danger" onClick={() => act(onDelete)}>删除</button>
    </div> : null}
  </>
}
