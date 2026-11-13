/** Serialized into the opaque-origin preview. Keep this function self-contained. */
export function htmlPreviewBridge() {
  const send = (data: object) => parent.postMessage(data, '*')
  let searchOpen = false
  addEventListener('wheel', (event) => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.deltaY) {
      event.preventDefault(); event.stopPropagation(); send({ type: 'pello-preview-zoom', deltaY: event.deltaY })
    }
  }, { passive: false, capture: true })
  addEventListener('keydown', (event) => {
    if (event.isComposing) return
    if (((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && ['f', 'h'].includes(event.key.toLowerCase())) || (searchOpen && (event.key === 'F3' || event.key === 'Escape'))) {
      event.preventDefault(); event.stopPropagation(); send({ type: 'pello-preview-key', key: event.key.toLowerCase(), shift: event.shiftKey })
    }
  }, true)
  let text = '', nodes: Text[] = [], starts: number[] = []
  const collect = () => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    let node: Node | null, value = ''
    nodes = []; starts = []
    while ((node = walker.nextNode())) {
      const element = node.parentElement
      if (!element || element.closest('script,style,noscript,[hidden],[aria-hidden=true]') || !element.getClientRects().length || getComputedStyle(element).visibility === 'hidden') continue
      starts.push(value.length); nodes.push(node as Text); value += node.textContent || ''
    }
    if (text !== value) { text = value; send({ type: 'pello-preview-text', text }) }
  }
  addEventListener('message', (event) => {
    if (event.source !== parent || event.data?.type !== 'pello-preview-search') return
    searchOpen = !!event.data.open
    collect()
    const ranges: Range[] = []
    const range = (from: number, to: number) => {
      let a = 0, b = 0
      while (a < nodes.length - 1 && starts[a + 1] <= from) a++
      while (b < nodes.length - 1 && starts[b] + nodes[b].length < to) b++
      if (!nodes[a] || !nodes[b] || from < 0 || to > text.length) return null
      const result = document.createRange()
      result.setStart(nodes[a], from - starts[a]); result.setEnd(nodes[b], to - starts[b]); return result
    }
    const matches = Array.isArray(event.data.matches) ? event.data.matches : []
    for (const match of matches.slice(0, 2000)) { const item = range(match.from, match.to); if (item) ranges.push(item) }
    const current = event.data.current ? range(event.data.current.from, event.data.current.to) : null
    CSS.highlights.set('document-matches', new Highlight(...ranges))
    CSS.highlights.set('document-current', new Highlight(...(current ? [current] : [])))
    if (current) {
      const box = current.getBoundingClientRect()
      if (box.top < 24 || box.bottom > innerHeight - 24) scrollBy(0, box.top - innerHeight / 3)
    }
  })
  addEventListener('DOMContentLoaded', () => {
    const style = document.createElement('style')
    style.textContent = '::highlight(document-matches){background:#fff0a6;color:#211d00}::highlight(document-current){background:#d6bbff;color:#201138}'
    document.head.append(style)
    collect()
    let timer: ReturnType<typeof setTimeout>
    new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(collect, 100) }).observe(document.body, { childList: true, characterData: true, subtree: true })
  })
}
