import { t } from '../shared/i18n'
import type { FileDiff } from '../shared/types'
import { lcs, lineStats, segments, splitLines, type Seg, type SideRow } from '../shared/diff'
import { useMemo, useRef, useState, useEffect } from 'react'
import { SplitDiffEditor } from './SplitDiffEditor'
import { editableText, isDirty, type DocumentDraft } from './documents'
import { Chunk } from '@codemirror/merge'
import { Text } from '@codemirror/state'
import { useContentZoom } from './usePreviewWheel'
import { DocumentSearch, useDocumentSearch } from './DocumentSearch'
import type { SearchAdapter } from './search-types'
import { clearSearchHighlights, domText } from './document-search'

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

function Line({ row, beforeStart, afterStart }: { row: SideRow; beforeStart?: number; afterStart?: number }) {
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
      <span className="diff-line-text" data-before-start={beforeStart} data-after-start={afterStart}>
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
  onMode,
  onDiscard,
  document,
  baseline,
  onBaseline,
  onBaselineHistory,
  onEdit,
  onSave,
  onCompose,
  onHistory,
  onReload,
  untracked
}: {
  diff: FileDiff | null
  mode: 'unified' | 'split'
  onMode: (mode: 'unified' | 'split') => void
  onDiscard: () => void
  document: DocumentDraft | null
  baseline?: string
  onBaseline: (text: string) => void
  onBaselineHistory: (redo: boolean) => void
  onEdit: (text: string) => void
  onSave: () => void
  onCompose: (value: boolean) => void
  onHistory: (redo: boolean) => void
  onReload: () => void
  untracked?: boolean
}) {
  const { ref, zoom } = useContentZoom()
  const [side, setSide] = useState<'before' | 'after'>('after')
  const searchRef = useRef<SearchAdapter | null>(null)
  const base = editableText(baseline ?? diff?.before ?? ''), work = document?.draft ?? editableText(diff?.after ?? '')
  const search = useDocumentSearch({ root: ref, text: side === 'before' ? base : work, revision: `${mode}:${side}`,
    save: onSave,
    enabled: !!diff && !diff.binary && !diff.tooBig,
    replace: document && !document.replacing ? side === 'before' ? onBaseline : onEdit : undefined,
    focus: () => { if (mode === 'split') searchRef.current?.focus(); else ref.current?.focus() },
    reveal: (match, matches, active) => {
      if (mode === 'split') { searchRef.current?.reveal(match, matches, active); return }
      clearSearchHighlights()
      const ranges: Range[] = [], current: Range[] = []
      for (const node of ref.current?.querySelectorAll<HTMLElement>(`.diff-line-text[data-${side}-start]`) || []) {
        const start = Number(node.dataset[side === 'before' ? 'beforeStart' : 'afterStart']), end = start + (node.textContent?.length || 0)
        const map = domText(node)
        const local = matches.filter((item) => item.from < end && item.to > start)
        for (const item of local) {
          const range = map.range({ from: Math.max(0, item.from - start), to: Math.min(end, item.to) - start })
          if (range && ranges.length < 2000) ranges.push(range)
          if (range && item === match) { current.push(range); node.scrollIntoView({ block: 'nearest', inline: 'nearest' }) }
        }
      }
      CSS.highlights.set('document-matches', new Highlight(...ranges)); CSS.highlights.set('document-current', new Highlight(...current))
    }
  })
  useEffect(() => () => clearSearchHighlights(), [])
  const computed: DiffData | null = useMemo(() => {
    if (!diff || diff.binary || diff.tooBig) return null
    const base = editableText(baseline ?? diff.before), work = document?.draft ?? editableText(diff.after)
    const before = splitLines(base)
    const after = splitLines(work)
    if (mode === 'split') {
      const a = base, b = work
      const chunks = Chunk.build(Text.of(a.split('\n')), Text.of(b.split('\n')), { scanLimit: 500, timeout: 50 })
      const adds = chunks.reduce((count, chunk) => count + splitLines(b.slice(chunk.fromB, chunk.toB)).length, 0)
      const dels = chunks.reduce((count, chunk) => count + splitLines(a.slice(chunk.fromA, chunk.toA)).length, 0)
      return { before, after, rows: [], adds, dels, deleted: [], added: [] }
    }
    const rows = lcs(before, after)
    const [adds, dels] = lineStats(rows)
    const deleted = rows.filter((row) => row[0] === 'del').map((row) => row[1])
    const added = rows.filter((row) => row[0] === 'add').map((row) => row[1])
    return { before, after, rows, adds, dels, deleted, added }
  }, [diff, document?.draft, baseline, mode])

  if (!diff) {
    return (
      <div className="empty">
        <div className="in">
          <h2>{t("正在读取差异…")}</h2>
        </div>
      </div>
    )
  }
  if (diff.binary || diff.tooBig) {
    return (
      <div className="empty">
        <div className="in">
          <h2>{diff.binary ? t("无法比较二进制文件") : t("文件较大，已跳过逐行对比")}</h2>
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
    const offsets = (lines: string[]) => { let offset = 0; return lines.map((line) => { const start = offset; offset += line.length + 1; return start }) }
    const beforeOffsets = offsets(before), afterOffsets = offsets(after)
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
              beforeStart={row[0] !== 'add' ? beforeOffsets[row[2]!] : undefined}
              afterStart={row[0] !== 'del' ? afterOffsets[row[3]!] : undefined}
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
    body = (
      document ? <SplitDiffEditor path={diff.path} before={editableText(baseline ?? diff.before)} after={document.draft} onBefore={onBaseline} onAfter={onEdit} onSave={onSave} onCompose={onCompose} onHistory={onHistory} onBeforeHistory={onBaselineHistory} searchRef={searchRef} searchSide={side} onSearchSide={setSide} /> : null
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
        {document && isDirty(document) ? <span className="muted">{t("未保存")}</span> : null}
        <button className="btn sm" aria-label={t("保存文件")} disabled={!document || document.saving || document.replacing} onClick={onSave}>{document?.saving ? t("保存中…") : t("保存")}</button>
        <div className="seg" role="radiogroup" aria-label={t("视图")}>
          {([['unified', t("统一")], ['split', t("并排")]] as const).map(([id, label]) => (
            <button key={id} className={mode === id ? 'on' : ''} role="radio" aria-checked={mode === id} data-a="dmode" data-id={id} onClick={() => onMode(id)}>
              {label}
            </button>
          ))}
        </div>
        <span className="vsep" />
        <button className="btn sm dangero" data-a="discard" onClick={onDiscard}>
          {untracked ? t("删除文件") : t("放弃更改")}
        </button>
      </div>
      {document?.error ? <div className="file-error" role="alert">{document.error}<button className="btn sm" onClick={onReload}>{t("重新读取文件")}</button></div> : null}
      {mode === 'split' ? <div className="diff-headings"><span>{t("比较基准（可编辑）")}</span><span>{t("工作区")}</span></div> : null}
      <div className="editor-surface">
      <DocumentSearch search={search} scope={<label>{t("搜索范围")}<select className="tx" aria-label={t("搜索范围")} value={side} onChange={(event) => setSide(event.target.value as 'before' | 'after')}><option value="after">{t("工作区")}</option><option value="before">{t("比较基准（可编辑）")}</option></select></label>} />
      <div ref={ref} tabIndex={-1} style={{ '--content-zoom': zoom } as React.CSSProperties} className={`diff ${mode === 'unified' ? 'diff-unified' : ''}`}>{body}</div>
      </div>
    </>
  )
}
