import { useLayoutEffect, useRef } from 'react'

/** Native top-layer positioning keeps menus out of scrolling/clipped panels. */
export function useAnchoredMenu(open: boolean, close: () => void, config: { minWidth?: number; itemRole?: 'option' | 'menuitem' } = {}) {
  const minWidth = config.minWidth || 0, itemRole = config.itemRole || 'option'
  const ref = useRef<HTMLDivElement>(null)
  const dismiss = useRef(close)
  dismiss.current = close
  useLayoutEffect(() => {
    const menu = ref.current
    const anchor = menu?.previousElementSibling as HTMLButtonElement | null
    if (!open || !menu || !anchor) return
    menu.showPopover()
    const position = () => {
      const box = anchor.getBoundingClientRect()
      const width = Math.min(Math.max(box.width, minWidth), innerWidth - 24)
      menu.style.width = `${width}px`
      const below = innerHeight - box.bottom - 12, above = box.top - 12
      const height = Math.min(Math.ceil(menu.scrollHeight + menu.offsetHeight - menu.clientHeight), 240, Math.max(below, above))
      Object.assign(menu.style, {
        left: `${Math.max(12, Math.min(box.left, innerWidth - width - 12))}px`,
        top: `${below >= height ? box.bottom + 4 : Math.max(12, box.top - height - 4)}px`,
        width: `${width}px`, maxHeight: `${height}px`
      })
    }
    const options = () => [...menu.querySelectorAll<HTMLButtonElement>(itemRole === 'menuitem' ? '[role=menuitem], [role=menuitemcheckbox]' : '[role=option]')].filter((item) => !item.disabled && item.getAttribute('aria-disabled') !== 'true')
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation()
        dismiss.current(); anchor.focus()
      } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); event.stopPropagation()
        const items = options(), index = items.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length
        items[next]?.focus()
      }
    }
    const outside = (event: PointerEvent) => {
      const target = event.target as Node
      if (!menu.contains(target) && !anchor.contains(target)) dismiss.current()
    }
    position()
    const items = options()
    ;(items.find((item) => item.getAttribute('aria-selected') === 'true') || items[0])?.focus()
    window.addEventListener('resize', position)
    document.addEventListener('scroll', position, true)
    document.addEventListener('keydown', key, true)
    document.addEventListener('pointerdown', outside, true)
    return () => {
      if (menu.matches(':popover-open')) menu.hidePopover()
      if (anchor.isConnected && (document.activeElement === document.body || menu.contains(document.activeElement))) anchor.focus()
      window.removeEventListener('resize', position)
      document.removeEventListener('scroll', position, true)
      document.removeEventListener('keydown', key, true)
      document.removeEventListener('pointerdown', outside, true)
    }
  }, [open, minWidth, itemRole])
  return ref
}
