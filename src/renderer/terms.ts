import type { Terminal } from '@xterm/xterm'
import type { ThemeName } from '../shared/types'

const terms = new Map<string, Terminal>()
const buffers = new Map<string, string>()

export function bindTerm(id: string, term: Terminal): void {
  const pending = buffers.get(id)
  if (pending) {
    term.write(pending)
    buffers.delete(id)
  }
  terms.set(id, term)
}

export function unbindTerm(id: string, term: Terminal): void {
  if (terms.get(id) === term) terms.delete(id)
}

export function writeTerm(id: string, data: string): void {
  const term = terms.get(id)
  if (term) term.write(data)
  else buffers.set(id, ((buffers.get(id) || '') + data).slice(-500_000))
}

export function dropTerm(id: string): void {
  terms.delete(id)
  buffers.delete(id)
}

export function termPlain(id: string): string {
  const term = terms.get(id)
  if (!term) return ''
  const buffer = term.buffer.active
  const lines: string[] = []
  for (let i = 0; i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) ?? '')
  return lines.join('\n')
}

if (typeof window !== 'undefined') {
  window.__awbBuffer = termPlain
}

const INK = {
  dark: { faint: '128;133;143', amber: '227;182;96', red: '240;122;122' },
  light: { faint: '102;107;117', amber: '154;106;0', red: '201;60;60' }
}

export function paint(theme: ThemeName, tone: 'faint' | 'amber' | 'red', text: string): string {
  return `\r\n\x1b[38;2;${INK[theme][tone]}m${text}\x1b[0m\r\n`
}

/** Exit notice. Skip a leading break when the cursor is already at column 0, so the prompt can follow on the next line. */
export function writeNotice(id: string, theme: ThemeName, tone: 'faint' | 'amber' | 'red', text: string): void {
  const term = terms.get(id)
  const atStart = term ? term.buffer.active.cursorX === 0 : true
  const body = `\x1b[38;2;${INK[theme][tone]}m${text}\x1b[0m\r\n`
  writeTerm(id, (atStart ? '' : '\r\n') + body)
}
