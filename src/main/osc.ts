const MARK = '\x1b]777;awb;prompt;'

/** Pull AWB prompt markers out of a pty chunk without holding unrelated escapes. */
export class OscStrip {
  private pending = ''

  push(chunk: string): { text: string; tail: string; codes: number[] } {
    this.pending += chunk
    let text = ''
    let tail = ''
    const codes: number[] = []
    const take = (value: string) => {
      if (!value) return
      if (codes.length) tail += value
      else text += value
    }
    while (this.pending.length) {
      const at = this.pending.indexOf(MARK)
      if (at === -1) {
        const esc = this.pending.lastIndexOf('\x1b')
        // Only keep a tail that is still a prefix of the marker. A CSI such as
        // ESC[?2004h (bracketed paste) must pass through, or the prompt after
        // "Killed" stays buffered forever.
        if (esc >= 0 && MARK.startsWith(this.pending.slice(esc))) {
          take(this.pending.slice(0, esc))
          this.pending = this.pending.slice(esc)
        } else {
          take(this.pending)
          this.pending = ''
        }
        break
      }
      take(this.pending.slice(0, at))
      const rest = this.pending.slice(at + MARK.length)
      const bel = rest.indexOf('\x07')
      const st = rest.indexOf('\x1b\\')
      let end = -1
      let skip = 0
      if (bel !== -1 && (st === -1 || bel < st)) {
        end = bel
        skip = 1
      } else if (st !== -1) {
        end = st
        skip = 2
      }
      if (end === -1) {
        this.pending = this.pending.slice(at)
        break
      }
      const num = Number(rest.slice(0, end).trim())
      if (!Number.isNaN(num)) codes.push(num)
      // A later marker means the previous "tail" was still command output.
      if (codes.length > 1) {
        text += tail
        tail = ''
      }
      this.pending = rest.slice(end + skip)
    }
    return { text, tail, codes }
  }
}
