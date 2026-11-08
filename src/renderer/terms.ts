import type { Terminal } from '@xterm/xterm'
import type { ThemeName } from '../shared/types'
import { workbenchTheme } from '../shared/themes'

const terms = new Map<string, Terminal>()
const buffers = new Map<string, string>()
const historyTimers = new Map<string, ReturnType<typeof setTimeout>>()
const historyHolds = new Set<string>()
let historyEnabled = true

export function setTerminalHistoryEnabled(enabled: boolean): void {
  historyEnabled = enabled
  if (!enabled) {
    for (const timer of historyTimers.values()) clearTimeout(timer)
    historyTimers.clear()
  }
}

export function bindTerm(id: string, term: Terminal): void {
  const pending = buffers.get(id)
  if (pending) {
    term.write(pending)
    buffers.delete(id)
    scheduleSnapshot(id)
  }
  terms.set(id, term)
}

export function unbindTerm(id: string, term: Terminal): void {
  if (terms.get(id) === term) terms.delete(id)
  const timer = historyTimers.get(id)
  if (timer) clearTimeout(timer)
  historyTimers.delete(id)
}

export function syncTermSize(id: string): void {
  const term = terms.get(id)
  if (term) window.awb.ptyResize(id, term.cols, term.rows)
}

export function writeTerm(id: string, data: string): void {
  const term = terms.get(id)
  if (term) {
    term.write(data)
    scheduleSnapshot(id)
  }
  else {
    buffers.set(id, ((buffers.get(id) || '') + data).slice(-500_000))
  }
}

export function dropTerm(id: string): void {
  terms.delete(id)
  buffers.delete(id)
  historyHolds.delete(id)
  const timer = historyTimers.get(id)
  if (timer) clearTimeout(timer)
  historyTimers.delete(id)
}

function bufferText(buffer: Terminal['buffer']['active']): string {
  const lines: string[] = []
  for (let index = 0; index < buffer.length; index++) lines.push(buffer.getLine(index)?.translateToString(true) ?? '')
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
  return lines.join('\n')
}

function termSnapshot(term: Terminal): string {
  // The alternate buffer holds TUI conversations while the normal buffer keeps
  // shell history. Restore both so an Agent screen does not erase earlier work.
  const active = term.buffer.active
  const current = bufferText(active)
  const normal = active.type === 'alternate' ? bufferText(term.buffer.normal) : ''
  const text = [normal, current].filter((part) => part.trim()).join('\n')
  return text.length > 400_000 ? text.slice(-400_000) : text
}

export function snapshotTerm(id: string): void {
  if (!historyEnabled) return
  if (historyHolds.has(id)) return
  const term = terms.get(id)
  if (!term) return
  const text = termSnapshot(term)
  if (!text.trim()) return
  window.awb.saveTerminalHistory(id, text)
}

/** Keep the persisted copy until a restored buffer is visible and repainted. */
export function holdTermHistory(id: string): void {
  historyHolds.add(id)
}

export function releaseTermHistory(id: string): void {
  historyHolds.delete(id)
}

export function snapshotTerms(): void {
  for (const id of terms.keys()) snapshotTerm(id)
}

export function queueSnapshot(id: string): void {
  scheduleSnapshot(id)
}

function scheduleSnapshot(id: string): void {
  if (!historyEnabled || historyTimers.has(id)) return
  const timer = setTimeout(() => {
    historyTimers.delete(id)
    snapshotTerm(id)
  }, 2500)
  historyTimers.set(id, timer)
}

export function restoreHistoryText(text: string): string {
  const normalized = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n').trimEnd()
  if (!normalized) return ''
  const body = (normalized.length > 400_000 ? normalized.slice(-400_000) : normalized).split('\n').join('\r\n')
  return `\x1b[38;5;244m── 上次会话记录 ──\x1b[0m\r\n${body}\r\n\x1b[38;5;244m── 会话已恢复，下面连接新进程 ──\x1b[0m\r\n`
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
  window.__awbGeometry = (id) => {
    const term = terms.get(id)
    if (!term) return null
    const buffer = term.buffer.active
    const visibleText = Array.from({ length: term.rows }, (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) || '').join('\n')
    return { cols: term.cols, rows: term.rows, viewportY: buffer.viewportY, baseY: buffer.baseY, cursorY: buffer.cursorY, visibleText, buffer: buffer.type, mouse: term.modes.mouseTrackingMode }
  }
}

function ink(theme: ThemeName, tone: 'faint' | 'amber' | 'red') {
  const hex = workbenchTheme(theme).colors[tone].slice(1)
  return [0, 2, 4].map((start) => Number.parseInt(hex.slice(start, start + 2), 16)).join(';')
}

export function paint(theme: ThemeName, tone: 'faint' | 'amber' | 'red', text: string): string {
  return `\r\n\x1b[38;2;${ink(theme, tone)}m${text}\x1b[0m\r\n`
}

/** Exit notice. Skip a leading break when the cursor is already at column 0, so the prompt can follow on the next line. */
export function writeNotice(id: string, theme: ThemeName, tone: 'faint' | 'amber' | 'red', text: string): void {
  const term = terms.get(id)
  const atStart = term ? term.buffer.active.cursorX === 0 : true
  const body = `\x1b[38;2;${ink(theme, tone)}m${text}\x1b[0m\r\n`
  writeTerm(id, (atStart ? '' : '\r\n') + body)
}
