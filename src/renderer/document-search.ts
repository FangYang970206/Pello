import type { TextMatch } from '../shared/search'

export function domText(root: HTMLElement) {
  const nodes: Text[] = [], starts: number[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let node: Node | null, text = ''
  while ((node = walker.nextNode())) {
    if (node.parentElement?.closest('script,style,.cm-gutters')) continue
    starts.push(text.length); nodes.push(node as Text); text += node.textContent || ''
  }
  const range = ({ from, to }: TextMatch) => {
    const result = document.createRange()
    let start = 0, end = 0
    while (start < nodes.length - 1 && starts[start + 1] <= from) start++
    while (end < nodes.length - 1 && starts[end] + nodes[end].length < to) end++
    if (!nodes[start] || !nodes[end]) return null
    result.setStart(nodes[start], Math.min(nodes[start].length, from - starts[start]))
    result.setEnd(nodes[end], Math.min(nodes[end].length, to - starts[end]))
    return result
  }
  return { text, range }
}

export function highlightMatches(root: HTMLElement, matches: TextMatch[], active: number) {
  const map = domText(root)
  const ranges = matches.slice(0, 2000).map(map.range).filter((range): range is Range => !!range)
  const current = matches[active] ? map.range(matches[active]) : null
  CSS.highlights.set('document-matches', new Highlight(...ranges))
  CSS.highlights.set('document-current', new Highlight(...(current ? [current] : [])))
  return current
}

export function clearSearchHighlights() {
  CSS.highlights.delete('document-matches'); CSS.highlights.delete('document-current')
}

/** Reveal a match in its own viewport without focusing it or scrolling the app. */
export function revealSearchRect(scroller: HTMLElement, match: { top: number; bottom: number; left: number; right: number }) {
  const viewport = scroller.getBoundingClientRect()
  const widget = scroller.closest('.editor-surface')?.querySelector('.document-search')?.getBoundingClientRect()
  const overlap = widget && match.right > widget.left && match.left < widget.right
  const top = Math.max(viewport.top + 12, overlap ? widget.bottom + 8 : viewport.top + 12)
  const bottom = viewport.bottom - 12
  if (match.top < top || match.bottom > bottom) scroller.scrollTop += match.top - (top + Math.max(0, bottom - top - (match.bottom - match.top)) / 3)
  if (match.left < viewport.left + 12 || match.right > viewport.right - 12) scroller.scrollLeft += match.left - viewport.left - 24
}

