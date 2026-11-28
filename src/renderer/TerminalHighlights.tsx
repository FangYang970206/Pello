import { useEffect, useState, type CSSProperties, type RefObject } from 'react'
import type { Terminal } from '@xterm/xterm'
import { terminalMatches, type TerminalHighlight } from './terminal-matches'

type Hit = { x: number; y: number; width: number; height: number; active: boolean; color: string; pinned: boolean }

/** Paint visible normal and alternate buffer cells without selecting text. */
export function TerminalHighlights({ terminal, query, pinned, sensitive, visible }: {
  terminal: RefObject<Terminal | null>; query: string; pinned: TerminalHighlight[]; sensitive: boolean; visible: boolean
}) {
  const [hits, setHits] = useState<Hit[]>([])
  useEffect(() => {
    const term = terminal.current
    if (!term || !visible || (!query && !pinned.length)) { setHits([]); return }
    let frame = 0
    const paint = () => {
      const buffer = term.buffer.active, screen = term.element?.querySelector('.xterm-screen')
      if (!screen || (!query && !pinned.length)) { setHits([]); return }
      const rect = screen.getBoundingClientRect(), parent = term.element!.closest('.termhost')!.getBoundingClientRect()
      const cellWidth = rect.width / term.cols, cellHeight = rect.height / term.rows
      const selection = term.getSelectionPosition()
      const next: Hit[] = []
      for (const item of [...pinned, ...(query ? [{ text: query, color: 'amber' }] : [])]) {
        const isPinned = pinned.includes(item)
        for (const match of terminalMatches(term, item.text, isPinned ? false : sensitive, true)) {
          const active = !isPinned && selection?.start.x === match.col && selection.start.y === match.row
          for (const span of match.spans) {
            if (span.row < buffer.viewportY || span.row >= buffer.viewportY + term.rows) continue
            next.push({ x: rect.x - parent.x + span.col * cellWidth, y: rect.y - parent.y + (span.row - buffer.viewportY) * cellHeight,
              width: span.width * cellWidth, height: cellHeight, active, color: item.color, pinned: isPinned })
          }
        }
      }
      setHits(next)
    }
    const queue = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; paint() }) }
    const events = [term.onRender(queue), term.onScroll(queue), term.onSelectionChange(queue), term.onWriteParsed(queue), term.buffer.onBufferChange(queue)]
    queue()
    return () => { cancelAnimationFrame(frame); events.forEach((event) => event.dispose()) }
  }, [terminal, query, pinned, sensitive, visible])
  return <div className="terminal-highlights" aria-hidden="true">{hits.map((hit, index) => <span key={index} className={`terminal-hit${hit.active ? ' active' : ''}`} data-pinned={hit.pinned} data-color={hit.color}
    style={{ left: hit.x, top: hit.y, width: hit.width, height: hit.height, '--highlight-color': `var(--${hit.color})` } as CSSProperties} />)}</div>
}
