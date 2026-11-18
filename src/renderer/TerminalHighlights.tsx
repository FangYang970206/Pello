import { useEffect, useState, type RefObject } from 'react'
import type { Terminal } from '@xterm/xterm'
import { textMatches } from '../shared/search'

type Hit = { x: number; y: number; width: number; height: number; active: boolean }

/** xterm hides native decorations in the alternate buffer. Paint its visible
 * cells using public buffer APIs, including wide and combining characters. */
export function TerminalHighlights({ terminal, query, pinned, sensitive, visible }: {
  terminal: RefObject<Terminal | null>; query: string; pinned: string; sensitive: boolean; visible: boolean
}) {
  const [hits, setHits] = useState<Hit[]>([])
  useEffect(() => {
    const term = terminal.current
    if (!term || !visible) { setHits([]); return }
    let frame = 0
    const paint = () => {
      const buffer = term.buffer.active, screen = term.element?.querySelector('.xterm-screen')
      if (buffer.type !== 'alternate' || !screen || (!query && !pinned)) { setHits([]); return }
      const rect = screen.getBoundingClientRect(), parent = term.element!.closest('.termhost')!.getBoundingClientRect()
      const cellWidth = rect.width / term.cols, cellHeight = rect.height / term.rows
      const selection = term.getSelectionPosition()
      const next: Hit[] = []
      let text = '', cells: { col: number; row: number; width: number }[] = []
      const flush = () => {
        for (const [needle, matchCase] of [[pinned, false], [query, sensitive]] as const) {
          for (const match of textMatches(text, needle, matchCase)) {
            const start = cells[match.from]
            if (!start) continue
            const active = needle === query && selection?.start.x === start.col && selection.start.y === start.row
            for (let index = match.from; index < match.to;) {
              const first = cells[index]
              let end = index + 1
              while (end < match.to && cells[end]?.row === first.row) end++
              const last = cells[end - 1]
              next.push({ x: rect.x - parent.x + first.col * cellWidth, y: rect.y - parent.y + (first.row - buffer.viewportY) * cellHeight,
                width: (last.col + last.width - first.col) * cellWidth, height: cellHeight, active })
              index = end
            }
          }
        }
        text = ''; cells = []
      }
      for (let row = 0; row < buffer.length; row++) {
        const line = buffer.getLine(row)
        if (!line) continue
        if (!line.isWrapped) flush()
        for (let col = 0; col < term.cols; col++) {
          const cell = line.getCell(col), width = cell?.getWidth() || 0
          if (!width) continue
          const chars = cell?.getChars() || ' '
          text += chars
          for (let index = 0; index < chars.length; index++) cells.push({ col, row, width })
        }
      }
      flush(); setHits(next)
    }
    const queue = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(paint) }
    const render = term.onRender(queue), selection = term.onSelectionChange(queue), buffer = term.buffer.onBufferChange(queue)
    queue()
    return () => { cancelAnimationFrame(frame); render.dispose(); selection.dispose(); buffer.dispose() }
  }, [terminal, query, pinned, sensitive, visible])
  return <div className="terminal-alt-highlights" aria-hidden="true">{hits.map((hit, index) => <span key={index} className={`terminal-alt-hit${hit.active ? ' active' : ''}`}
    style={{ left: hit.x, top: hit.y, width: hit.width, height: hit.height }} />)}</div>
}
