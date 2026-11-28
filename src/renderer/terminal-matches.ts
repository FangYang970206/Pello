import type { Terminal } from '@xterm/xterm'
import { textMatches } from '../shared/search'

export type TerminalMatch = { col: number; row: number; spans: { col: number; row: number; width: number }[] }
export type TerminalHighlight = { text: string; color: string }

/** Read public buffer cells without changing selection, cursor or viewport. */
export function terminalMatches(term: Terminal, query: string, sensitive = false, viewportOnly = false): TerminalMatch[] {
  if (!query) return []
  query = query.replaceAll('\r\n', '\n')
  const extraRows = query.split('\n').length - 1
  const buffer = term.buffer.active, matches: TerminalMatch[] = []
  let from = viewportOnly ? Math.max(0, buffer.viewportY - extraRows) : 0
  let to = viewportOnly ? Math.min(buffer.length, buffer.viewportY + term.rows + extraRows) : buffer.length
  // Include complete logical lines when a wrapped match crosses a viewport edge.
  while (from > 0 && buffer.getLine(from)?.isWrapped) from--
  while (to < buffer.length && buffer.getLine(to)?.isWrapped) to++
  let text = '', cells: { col: number; row: number; width: number }[] = []
  const flush = () => {
    for (const match of textMatches(text, query, sensitive)) {
      const first = cells.slice(match.from, match.to).find((cell) => cell.width)
      if (!first) continue
      const spans: TerminalMatch['spans'] = []
      for (let index = match.from; index < match.to;) {
        if (!cells[index].width) { index++; continue }
        const start = cells[index]
        let end = index + 1
        while (end < match.to && cells[end].row === start.row && cells[end].width) end++
        const finish = cells[end - 1]
        spans.push({ col: start.col, row: start.row, width: finish.col + finish.width - start.col })
        index = end
      }
      matches.push({ col: first.col, row: first.row, spans })
    }
    text = ''; cells = []
  }
  for (let row = from; row < to; row++) {
    const line = buffer.getLine(row)
    if (!line) continue
    if (!line.isWrapped) {
      if (!extraRows) flush()
      else if (row > from) { text += '\n'; cells.push({ col: 0, row, width: 0 }) }
    }
    const nextLine = buffer.getLine(row + 1), wrapped = nextLine?.isWrapped
    let length = line.translateToString(!wrapped).length
    // xterm pads the final cell when a wide character wraps to the next row.
    // That cell is layout space rather than part of the selected text.
    const lastCell = line.getCell(term.cols - 1)
    if (wrapped && lastCell?.getCode() === 0 && lastCell.getWidth() === 1 && nextLine.getCell(0)?.getWidth() === 2) length--
    let read = 0
    for (let col = 0; col < term.cols && read < length; col++) {
      const cell = line.getCell(col), width = cell?.getWidth() || 0
      if (!width) continue
      const chars = cell?.getChars() || ' '
      text += chars; read += chars.length
      for (let index = 0; index < chars.length; index++) cells.push({ col, row, width })
    }
  }
  flush()
  return matches
}
