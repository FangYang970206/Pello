/** Streaming native CLI status reports; silence is never treated as completion. */
export class ProgramStatus {
  private pending = ''

  push(chunk: string): { text: string; states: ('working' | 'waiting' | 'clear')[]; reports: { state: 'working' | 'waiting' | 'clear'; app?: string; protocol: 'program' | 'progress' }[]; queries: number } {
    this.pending += chunk
    let text = '', queries = 0
    const states: ('working' | 'waiting' | 'clear')[] = []
    const reports: { state: 'working' | 'waiting' | 'clear'; app?: string; protocol: 'program' | 'progress' }[] = []
    const prefixes = ['\x1b]7501;', '\x1b]9;4;']
    while (this.pending) {
      const at = this.pending.indexOf('\x1b]')
      if (at < 0) {
        const hold = this.pending.endsWith('\x1b') ? 1 : 0
        text += this.pending.slice(0, this.pending.length - hold)
        this.pending = hold ? '\x1b' : ''
        break
      }
      text += this.pending.slice(0, at)
      this.pending = this.pending.slice(at)
      if (!prefixes.some((prefix) => this.pending.startsWith(prefix))) {
        if (prefixes.some((prefix) => prefix.startsWith(this.pending))) break
        text += this.pending.slice(0, 2); this.pending = this.pending.slice(2); continue
      }
      const bel = this.pending.indexOf('\x07'), st = this.pending.indexOf('\x1b\\')
      const end = bel < 0 ? st : st < 0 ? bel : Math.min(bel, st)
      if (end < 0) {
        if (this.pending.length > 16384) { text += this.pending; this.pending = '' }
        break
      }
      const sequence = this.pending.slice(0, end)
      this.pending = this.pending.slice(end + (end === bel ? 1 : 2))
      if (sequence.startsWith(prefixes[0])) {
        const payload = sequence.slice(prefixes[0].length)
        if (payload === '?') { queries++; continue }
        const fields = Object.fromEntries(payload.split(':').map((pair) => { const at = pair.indexOf('='); return [pair.slice(0, at), pair.slice(at + 1)] }))
        // Child-agent reports must not replace the foreground agent's state.
        if (fields.id || fields.parent) continue
        const state = fields.state === 'working' ? 'working' : ['idle', 'blocked', 'done', 'error'].includes(fields.state) ? 'waiting' : fields.state === 'clear' ? 'clear' : undefined
        if (state) { states.push(state); reports.push({ state, app: fields.app, protocol: 'program' }) }
      } else {
        const state = sequence.slice(prefixes[1].length).split(';')[0]
        if (['1', '3'].includes(state)) { states.push('working'); reports.push({ state: 'working', protocol: 'progress' }) }
        else if (['0', '2', '4'].includes(state)) { states.push('waiting'); reports.push({ state: 'waiting', protocol: 'progress' }) }
      }
    }
    return { text, states, reports, queries }
  }
}
