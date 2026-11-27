import { randomUUID } from 'node:crypto'
import type { Host, TerminalContext, TerminalRoute } from '../shared/types'

type Context = { projectId: string; terminalId: string; cwd: string; host: Host; route: TerminalRoute[] }
const contexts = new Map<string, Context>()
const routeClosed = new Set<(hostId: string, route: TerminalRoute[]) => void>()
export function onTerminalRouteClosed(listener: (hostId: string, route: TerminalRoute[]) => void): void { routeClosed.add(listener) }
function notifyRouteClosed(hostId: string, route: TerminalRoute[]): void { for (const listener of routeClosed) listener(hostId, route) }
export const terminalTarget = (id: string): Context | undefined => contexts.get(id)

/** Strip only this session's private reports; never interpret ordinary prompt text. */
export class TerminalContextTracker {
  private pending = ''
  private signature = ''
  constructor(private token: string, private terminalId: string, private projectId: string, private host: Host, private projectCwd: string) {}
  push(chunk: string): { text: string; context?: TerminalContext | null } {
    const marker = `\x1b]777;pello;context;${this.token};`
    this.pending += chunk
    let text = '', context: TerminalContext | null | undefined
    while (this.pending) {
      const at = this.pending.indexOf(marker)
      if (at < 0) {
        const esc = this.pending.lastIndexOf('\x1b')
        if (esc >= 0 && marker.startsWith(this.pending.slice(esc))) { text += this.pending.slice(0, esc); this.pending = this.pending.slice(esc) }
        else { text += this.pending; this.pending = '' }
        break
      }
      text += this.pending.slice(0, at)
      const end = this.pending.indexOf('\x07', at)
      if (end < 0) { this.pending = this.pending.slice(at); if (this.pending.length > 65536) this.pending = ''; break }
      const payload = this.pending.slice(at + marker.length, end)
      this.pending = this.pending.slice(end + 1)
      try {
        const value = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'))
        if (!Array.isArray(value.route) || value.route.length > 8 || typeof value.cwd !== 'string' || !value.cwd.startsWith('/') || /[\0\r\n]/.test(value.cwd) || typeof value.user !== 'string' || typeof value.hostname !== 'string') continue
        if (!value.route.every((hop: TerminalRoute) => hop && /^\/tmp\/pello-ssh\.[A-Za-z0-9]+\/master$/.test(hop.socket) && typeof hop.destination === 'string' && !!hop.destination && !hop.destination.startsWith('-') && !/[\0\r\n]/.test(hop.destination))) continue
        const signature = value.route.length || value.cwd !== this.projectCwd ? JSON.stringify([value.route, value.cwd]) : ''
        if (signature === this.signature) continue
        this.signature = signature
        for (const [id, item] of contexts) {
          if (item.terminalId === this.terminalId && (item.route.length > value.route.length || item.route.some((hop, index) => JSON.stringify(hop) !== JSON.stringify(value.route[index])))) {
            contexts.delete(id)
            notifyRouteClosed(item.host.id, item.route)
          }
        }
        if (!signature) { context = null; continue }
        const previous = [...contexts].find(([, item]) => item.terminalId === this.terminalId && JSON.stringify([item.route, item.cwd]) === signature)
        const id = previous?.[0] || `terminal:${randomUUID()}`
        contexts.set(id, { projectId: this.projectId, terminalId: this.terminalId, cwd: value.cwd, host: this.host, route: value.route })
        context = { id, cwd: value.cwd, user: value.user, hostname: value.hostname }
      } catch { /* Incomplete or unrelated terminal reports cannot change file targets. */ }
    }
    return { text, ...(context !== undefined ? { context } : {}) }
  }
  dispose(): void {
    for (const [id, value] of contexts) if (value.terminalId === this.terminalId) {
      contexts.delete(id)
      if (value.route.length) notifyRouteClosed(value.host.id, value.route)
    }
  }
}
