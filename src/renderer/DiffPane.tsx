import type { FileDiff } from '../shared/types'
import { lcs, lineStats, segments, splitColumns, splitLines, type Seg, type SideRow } from '../shared/diff'
import { Icon } from './icons'
import { useMemo } from 'react'

function Rich({ text, peers }: { text: string; peers?: string[] }) {
  const segs: Seg[] = segments(text, peers)
  return (
    <>
      {segs.map((seg, i) =>
        seg.mark ? (
          <mark key={i}>{seg.text}</mark>
        ) : seg.kw ? (
          <span className="kw" key={i}>
            {seg.text}
          </span>
        ) : (
          <span key={i}>{seg.text}</span>
        )
      )}
    </>
  )
}

function Line({ row }: { row: SideRow }) {
  if (row.kind === 'pad') {
    return (
      <div className="cl pad">
        <span className="ln" />
        <span />
        <span> </span>
      </div>
    )
  }
  const sign = row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ''
  return (
    <div className={`cl ${row.kind}`}>
      <span className="ln">{row.n ?? ''}</span>
      <span className="sg">{sign}</span>
      <span>
        <Rich text={row.text || ''} peers={row.kind ? row.peers : undefined} />
      </span>
    </div>
  )
}

interface DiffData {
  before: string[]
  after: string[]
  rows: ReturnType<typeof lcs>
  adds: number
  dels: number
  deleted: string[]
  added: string[]
}

export function DiffPane({
  diff,
  mode,
  rightOpen,
  onMode,
  onDiscard,
  onToggleRight,
  untracked
}: {
  diff: FileDiff | null
  mode: 'unified' | 'split'
  rightOpen: boolean
  onMode: (mode: 'unified' | 'split') => void
  onDiscard: () => void
  onToggleRight: () => void
  untracked?: boolean
}) {
  const computed: DiffData | null = useMemo(() => {
    if (!diff || diff.binary || diff.tooBig) return null
    const before = splitLines(diff.before)
    const after = splitLines(diff.after)
    const rows = lcs(before, after)
    const [adds, dels] = lineStats(rows)
    const deleted = rows.filter((row) => row[0] === 'del').map((row) => row[1])
    const added = rows.filter((row) => row[0] === 'add').map((row) => row[1])
    return { before, after, rows, adds, dels, deleted, added }
  }, [diff])

  if (!diff) {
    return (
      <div className="empty">
        <div className="in">
          <h2>正在读取差异…</h2>
        </div>
      </div>
    )
  }
  if (diff.binary || diff.tooBig) {
    return (
      <div className="empty">
        <div className="in">
          <h2>{diff.binary ? '无法比较二进制文件' : '文件较大，已跳过逐行对比'}</h2>
          <p className="mono">{diff.path}</p>
        </div>
      </div>
    )
  }
  const data = computed
  if (!data) return null
  const { before, after, rows, adds, dels, deleted, added } = data
  let body
  if (mode === 'unified') {
    let delIndex = 0
    let addIndex = 0
    body = (
      <>
        <div className="hunk">
          @@ -1,{before.length} +1,{after.length} @@
        </div>
        {rows.map((row, index) => {
          const peers = row[0] === 'add'
            ? deleted.slice(Math.max(0, delIndex - 8), delIndex + 8)
            : row[0] === 'del'
              ? added.slice(Math.max(0, addIndex - 8), addIndex + 8)
              : undefined
          if (row[0] === 'del') delIndex++
          if (row[0] === 'add') addIndex++
          return (
            <Line
              key={index}
              row={{
                kind: row[0] || '',
                text: row[1],
                n: (row[0] === 'del' ? row[2] : row[3])! + 1,
                peers
              }}
            />
          )
        })}
      </>
    )
  } else {
    const cols = splitColumns(rows)
    body = (
      <div className="dgrid">
        <div>
          {cols.left.map((row, i) => (
            <Line key={i} row={row} />
          ))}
        </div>
        <div>
          {cols.right.map((row, i) => (
            <Line key={i} row={row} />
          ))}
        </div>
      </div>
    )
  }
  return (
    <>
      <div className="diffbar">
        <span className={`st ${diff.st}`}>{diff.st}</span>
        <span className="path">{diff.path}</span>
        <span className="num">
          <span className="a">+{adds}</span>
          <span className="d">−{dels}</span>
        </span>
        <span className="grow" />
        <div className="seg" role="radiogroup" aria-label="视图">
          {([['unified', '统一'], ['split', '并排']] as const).map(([id, label]) => (
            <button key={id} className={mode === id ? 'on' : ''} role="radio" aria-checked={mode === id} data-a="dmode" data-id={id} onClick={() => onMode(id)}>
              {label}
            </button>
          ))}
        </div>
        <span className="vsep" />
        <button className="btn sm dangero" data-a="discard" onClick={onDiscard}>
          {untracked ? '删除文件' : '放弃更改'}
        </button>
        {rightOpen ? null : (
          <button className="ib" data-a="right" aria-label="显示文件面板" onClick={onToggleRight}>
            <Icon name="panel" />
          </button>
        )}
      </div>
      <div className="diff">{body}</div>
    </>
  )
}
