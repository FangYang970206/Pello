export function positionSettingsDialog(dialog: HTMLElement) {
  const content = document.querySelector('.settings .scontent')
  const column = content?.querySelector('.scol')
  const position = () => {
    const area = content?.getBoundingClientRect()
    const col = column?.getBoundingClientRect()
    const top = Math.max(0, area?.top ?? 0)
    const bottom = Math.min(innerHeight, area?.bottom ?? innerHeight)
    const height = Math.max(0, bottom - top)
    dialog.style.left = `${col ? col.left + col.width / 2 : innerWidth / 2}px`
    dialog.style.top = `${top + height / 2}px`
    dialog.style.maxWidth = `${Math.min(col?.width ?? innerWidth - 48, innerWidth - 48)}px`
    dialog.style.setProperty('--settings-dialog-max-height', `${Math.max(0, height - 48)}px`)
    dialog.style.setProperty('--resource-detail-height', `${height * .6}px`)
  }
  position()
  const observer = new ResizeObserver(position)
  if (content) observer.observe(content)
  if (column) observer.observe(column)
  window.addEventListener('resize', position)
  return () => {
    observer.disconnect()
    window.removeEventListener('resize', position)
  }
}
