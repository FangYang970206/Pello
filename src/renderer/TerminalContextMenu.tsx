import { useLayoutEffect, useRef, type CSSProperties } from 'react'
import { t } from '../shared/i18n'

export const HIGHLIGHT_COLORS = [
  { id: 'amber', get name() { return t("黄色") } }, { id: 'green', get name() { return t("绿色") } },
  { id: 'cyan', get name() { return t("青色") } }, { id: 'blue', get name() { return t("蓝色") } },
  { id: 'magenta', get name() { return t("紫色") } }, { id: 'red', get name() { return t("红色") } }
]

export type TerminalMenuState = { x: number; y: number; selection: string }

export function TerminalContextMenu({ state, highlighted, selectedColor, onAction, onClose }: {
  state: TerminalMenuState; highlighted: boolean; selectedColor?: string
  onAction: (action: string) => void; onClose: (restore?: boolean) => void
}) {
  const ref = useRef<HTMLDivElement>(null), dismiss = useRef(onClose)
  dismiss.current = onClose
  useLayoutEffect(() => {
    const menu = ref.current
    if (!menu) return
    menu.showPopover()
    const position = () => {
      const host = menu.closest('.termhost')!.getBoundingClientRect()
      menu.style.maxWidth = `${Math.min(innerWidth - 16, Math.max(216, host.width - 16))}px`
      const box = menu.getBoundingClientRect()
      menu.style.left = `${Math.max(8, Math.min(state.x, innerWidth - box.width - 8))}px`
      menu.style.top = `${Math.max(8, Math.min(state.y, innerHeight - box.height - 8))}px`
    }
    const items = () => [...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    const key = (event: KeyboardEvent) => {
      if (event.isComposing) return
      if (event.key === 'Escape' || event.key === 'Tab') {
        event.preventDefault(); event.stopPropagation(); dismiss.current()
      } else if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); event.stopPropagation()
        const buttons = items(), index = buttons.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 :
          (index + (event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 1) + buttons.length) % buttons.length
        buttons[next]?.focus()
      }
    }
    const outside = (event: PointerEvent) => { if (!menu.contains(event.target as Node)) dismiss.current(false) }
    position(); items()[0]?.focus()
    const resize = new ResizeObserver(position)
    resize.observe(menu); resize.observe(menu.closest('.termhost')!)
    document.addEventListener('keydown', key, true)
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('resize', position)
    return () => {
      if (menu.matches(':popover-open')) menu.hidePopover()
      resize.disconnect()
      document.removeEventListener('keydown', key, true)
      document.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('resize', position)
    }
  }, [state])
  return <div ref={ref} popover="manual" className="pop terminal-context-menu" role="menu" aria-label={t("终端文字操作")}
    onContextMenu={(event) => { event.preventDefault(); event.stopPropagation() }}>
    <button role="menuitem" data-command="copy" disabled={!state.selection} onClick={() => onAction('copy')}>{t("复制")}</button>
    <button role="menuitem" data-command="paste" onClick={() => onAction('paste')}>{t("粘贴")}</button>
    <button role="menuitem" data-command="select-all" onClick={() => onAction('select-all')}>{t("全选")}</button>
    <button role="menuitem" data-command="search" onClick={() => onAction('search')}>{t("搜索")}</button>
    <div role="separator" className="terminal-menu-separator" />
    <div className="terminal-highlight-label">{t("高亮所选文本")}</div>
    <div className="terminal-highlight-colors" role="group" aria-label={t("高亮所选文本")}>
      {HIGHLIGHT_COLORS.map((color) => <button key={color.id} role="menuitemradio" aria-checked={selectedColor === color.id}
        data-command={`highlight-${color.id}`} disabled={!state.selection} aria-label={color.name} title={color.name}
        style={{ '--highlight-color': `var(--${color.id})` } as CSSProperties} onClick={() => onAction(`highlight-${color.id}`)}>
        <span className="terminal-color-ball" />
      </button>)}
    </div>
    <button role="menuitem" data-command="clear-highlight" disabled={!highlighted} onClick={() => onAction('clear-highlight')}>{t("清除高亮")}</button>
  </div>
}
