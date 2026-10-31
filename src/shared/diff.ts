export type LineKind = '' | 'add' | 'del'
export type DiffLine = [LineKind, string, number | null, number | null]

export interface Seg {
  text: string
  mark?: boolean
  kw?: boolean
}

export interface SideRow {
  kind: '' | 'add' | 'del' | 'pad'
  text?: string
  n?: number
  peers?: string[]
}

const WORD = /\b(public|private|return|if|while|void|long|export|function|throw|new|Feature|Scenario|When|Then)\b/g
const TOK = /([A-Za-z_][A-Za-z0-9_]*|\d+|[^\sA-Za-z0-9_])/g

export function splitLines(text: string): string[] {
  if (!text) return []
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

export function lcs(before: string[], after: string[]): DiffLine[] {
  const n = before.length
  const m = after.length
  const d: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      d[i][j] = before[i] === after[j] ? d[i + 1][j + 1] + 1 : Math.max(d[i + 1][j], d[i][j + 1])
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && before[i] === after[j]) {
      out.push(['', before[i], i, j])
      i++
      j++
    } else if (i < n && (j === m || d[i + 1][j] >= d[i][j + 1])) {
      out.push(['del', before[i], i, null])
      i++
    } else {
      out.push(['add', after[j], null, j])
      j++
    }
  }
  return out
}

export function lineStats(lines: DiffLine[]): [number, number] {
  return [lines.filter((x) => x[0] === 'add').length, lines.filter((x) => x[0] === 'del').length]
}

function highlight(text: string): Seg[] {
  const segs: Seg[] = []
  let last = 0
  for (const match of text.matchAll(WORD)) {
    const off = match.index ?? 0
    if (off > last) segs.push({ text: text.slice(last, off) })
    segs.push({ text: match[0], kw: true })
    last = off + match[0].length
  }
  if (last < text.length) segs.push({ text: text.slice(last) })
  if (!segs.length) segs.push({ text: '' })
  return segs
}

export function segments(text: string, peers?: string[]): Seg[] {
  if (!peers) return highlight(text)
  const tokens = text.match(TOK) || []
  let best: Set<string> | null = null
  let bestScore = 0
  for (const peer of peers) {
    const peerTokens = peer.match(TOK) || []
    const a = new Set(tokens)
    const b = new Set(peerTokens)
    const inter = [...a].filter((x) => b.has(x)).length
    const score = inter / Math.max(1, new Set([...a, ...b]).size)
    if (score > bestScore) {
      bestScore = score
      best = b
    }
  }
  if (!best || bestScore < 0.5 || bestScore === 1) return highlight(text)
  const segs: Seg[] = []
  let last = 0
  for (const match of text.matchAll(TOK)) {
    const off = match.index ?? 0
    if (off > last) segs.push({ text: text.slice(last, off) })
    const token = match[0]
    if (best.has(token)) segs.push(...highlight(token))
    else segs.push({ text: token, mark: true })
    last = off + token.length
  }
  if (last < text.length) segs.push({ text: text.slice(last) })
  return segs
}

export function splitColumns(lines: DiffLine[]): { left: SideRow[]; right: SideRow[] } {
  const dels = lines.filter((x) => x[0] === 'del').map((x) => x[1])
  const adds = lines.filter((x) => x[0] === 'add').map((x) => x[1])
  const left: SideRow[] = []
  const right: SideRow[] = []
  const pad = (): SideRow => ({ kind: 'pad' })
  for (const [kind, text, i, j] of lines) {
    if (kind === '') {
      left.push({ kind: '', text, n: (i ?? 0) + 1 })
      right.push({ kind: '', text, n: (j ?? 0) + 1 })
    } else if (kind === 'del') {
      left.push({ kind: 'del', text, n: (i ?? 0) + 1, peers: adds })
    } else {
      right.push({ kind: 'add', text, n: (j ?? 0) + 1, peers: dels })
    }
    while (kind === '' && left.length !== right.length) {
      ;(left.length < right.length ? left : right).splice(-1, 0, pad())
    }
  }
  const n = Math.max(left.length, right.length)
  while (left.length < n) left.push(pad())
  while (right.length < n) right.push(pad())
  return { left, right }
}
