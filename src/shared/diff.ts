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
  const out: DiffLine[] = []
  const n = before.length, m = after.length
  let i = 0, j = 0
  // A shared prefix is always taken by the original deletion-first LCS.
  // Stripping a shared suffix is unsafe when repeated lines create ties.
  while (i < n && j < m && before[i] === after[j]) { out.push(['', before[i], i++, j++]) }
  const from = i, width = m - j
  const positions = new Map<string, number[]>()
  for (let index = j; index < m; index++) {
    const found = positions.get(after[index])
    if (found) found.push(index); else positions.set(after[index], [index])
  }
  let pairs = 0
  for (let index = i; index < n; index++) pairs += positions.get(before[index])?.length || 0
  let remove: (row: number, column: number) => boolean = () => true
  if (pairs) {
    const depth = Math.ceil(Math.log2(Math.max(1, width))) + 1
    if (pairs * depth <= 2_000_000 && pairs * depth < (n - from) * width) {
      // Sparse files need only matching pairs. Persistent suffix maxima let
      // reconstruction ask the exact same scores as the full DP table, so
      // repeated-line ties and original line indices remain unchanged.
      const capacity = pairs * depth + 1
      const left = new Uint32Array(capacity), right = new Uint32Array(capacity), score = new Uint32Array(capacity)
      const roots = new Uint32Array(n - from + 1)
      let used = 0
      const suffix = (node: number, low: number, high: number, start: number): number => {
        if (!node || high <= start) return 0
        if (start <= low) return score[node]
        const middle = (low + high) >>> 1
        return Math.max(suffix(left[node], low, middle, start), suffix(right[node], middle, high, start))
      }
      const update = (node: number, low: number, high: number, column: number, value: number): number => {
        const copy = ++used
        left[copy] = left[node]; right[copy] = right[node]; score[copy] = Math.max(score[node], value)
        if (high - low > 1) {
          const middle = (low + high) >>> 1
          if (column < middle) left[copy] = update(left[node], low, middle, column, value)
          else right[copy] = update(right[node], middle, high, column, value)
        }
        return copy
      }
      for (let row = n - 1; row >= from; row--) {
        const previous = roots[row - from + 1]
        let root = previous
        for (const column of positions.get(before[row]) || []) root = update(root, from, m, column, suffix(previous, from, m, column + 1) + 1)
        roots[row - from] = root
      }
      remove = (row, column) => suffix(roots[row - from + 1], from, m, column) >= suffix(roots[row - from], from, m, column + 1)
    } else {
      // Dense repeated lines use one score row and one bit per decision,
      // instead of a JavaScript number and array slot for every matrix cell.
      const decisions = new Uint8Array(Math.ceil((n - from) * width / 8)), scores = new Uint32Array(width + 1)
      for (let row = n - 1; row >= from; row--) {
        let diagonal = 0
        for (let column = m - 1; column >= from; column--) {
          const offset = column - from, below = scores[offset]
          if (before[row] === after[column]) scores[offset] = diagonal + 1
          else if (below >= scores[offset + 1]) { const bit = (row - from) * width + offset; decisions[Math.floor(bit / 8)] |= 1 << (bit % 8) }
          else scores[offset] = scores[offset + 1]
          diagonal = below
        }
      }
      remove = (row, column) => { const bit = (row - from) * width + column - from; return !!(decisions[Math.floor(bit / 8)] & (1 << (bit % 8))) }
    }
  }
  while (i < n || j < m) {
    if (i < n && j < m && before[i] === after[j]) {
      out.push(['', before[i], i, j])
      i++
      j++
    } else if (i < n && (j === m || remove(i, j))) {
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
  let delIndex = 0
  let addIndex = 0
  for (const [kind, text, i, j] of lines) {
    if (kind === '') {
      left.push({ kind: '', text, n: (i ?? 0) + 1 })
      right.push({ kind: '', text, n: (j ?? 0) + 1 })
    } else if (kind === 'del') {
      left.push({ kind: 'del', text, n: (i ?? 0) + 1, peers: adds.slice(Math.max(0, addIndex - 8), addIndex + 8) })
      delIndex++
    } else {
      right.push({ kind: 'add', text, n: (j ?? 0) + 1, peers: dels.slice(Math.max(0, delIndex - 8), delIndex + 8) })
      addIndex++
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
