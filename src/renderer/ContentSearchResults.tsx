import { useEffect, useRef, useState } from 'react'
import { t } from '../shared/i18n'
import type { ContentSearchBatch, SearchLocation } from '../shared/types'
import { Icon } from './icons'

export function ContentSearchResults({ projectId, query, sensitive, regex, whole, onOpen }: {
  projectId: string; query: string; sensitive: boolean; regex: boolean; whole: boolean; onOpen: (path: string, location: SearchLocation) => void
}) {
  const [revision, setRevision] = useState(0)
  const [state, setState] = useState<ContentSearchBatch & { key: string; loading: boolean; error: string; stopped: boolean }>({ items: [], done: false, limited: false, skipped: 0, errors: 0, key: '', loading: true, error: '', stopped: false })
  const stop = useRef<() => void>(() => {})
  const key = JSON.stringify([projectId, query, sensitive, regex, whole, revision])
  useEffect(() => {
    let cancelled = false
    const id = crypto.randomUUID()
    const cancel = () => { cancelled = true; void window.awb.contentSearchCancel(id) }
    stop.current = () => { cancel(); setState((current) => ({ ...current, loading: false, stopped: true })) }
    setState({ key, items: [], done: false, limited: false, skipped: 0, errors: 0, loading: true, error: '', stopped: false })
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          await window.awb.contentSearchStart(projectId, id, query, sensitive, regex, whole)
          if (cancelled) { await window.awb.contentSearchCancel(id); return }
          while (!cancelled) {
            const batch = await window.awb.contentSearchNext(id)
            if (cancelled) return
            if (batch.items.length || batch.done || batch.limited || batch.errors) setState((current) => ({ ...current, ...batch, items: [...current.items, ...batch.items], loading: !batch.done }))
            if (batch.done) break
          }
        } catch (error) {
          if (!cancelled) setState((current) => ({ ...current, loading: false, error: error instanceof Error ? error.message : t("搜索失败") }))
        }
      })()
    }, 250)
    return () => { window.clearTimeout(timer); cancel() }
  }, [projectId, query, sensitive, regex, whole, key])
  const current = state.key === key
  const items = current ? state.items : []
  const loading = !current || state.loading
  const count = items.reduce((total, item) => total + item.matches.length, 0)
  return <div className="content-search-results rlist" role="group" aria-label={t("内容搜索结果")} aria-busy={loading}>
    <div className="content-search-summary">
      <span role="status">{loading ? t("正在搜索…") : state.stopped ? t("搜索已停止") : t("{{0}} 个结果", count)}</span>
      {loading ? <button className="ib" aria-label={t("停止搜索")} title={t("停止搜索")} onClick={() => stop.current()}><Icon name="x" /></button>
        : <button className="ib" aria-label={t("重新搜索")} title={t("重新搜索")} onClick={() => setRevision((value) => value + 1)}><Icon name="refresh" /></button>}
    </div>
    {current && state.error ? <p role="alert" className="repository-help bad">{state.error}</p> : null}
    {current && state.limited ? <p role="status" className="repository-help">{t("已显示前 2000 个匹配，请缩小搜索范围")}</p> : null}
    {current && state.errors ? <p role="alert" className="repository-help bad">{t("{{0}} 个文件或目录无法读取，可重新搜索", state.errors)}</p> : null}
    {current && !loading && !state.error && !state.stopped && !count ? <p className="repository-help">{t("没有匹配的内容")}</p> : null}
    {items.map((file) => <details className="content-search-file" key={file.path} open>
      <summary title={file.path}><Icon name="file" className="s" /><span className="nm">{file.path}</span></summary>
      {file.matches.map((match) => <button key={`${match.line}:${match.column}`} className="content-search-hit" data-a="content-hit" data-id={file.path} data-line={match.line} data-column={match.column}
        title={`${file.path}\n${match.before}${match.match}${match.after}`}
        aria-label={t("{{0}}，第 {{1}} 行，第 {{2}} 列", file.path, match.line, match.column)}
        onClick={() => onOpen(file.path, { line: match.line, column: match.column, query: match.match, sensitive: true, id: crypto.randomUUID() })}>
        <span className="content-search-snippet"><span className="content-search-before">{match.before}</span><mark>{match.match}</mark><span className="content-search-after">{match.after}</span></span>
      </button>)}
    </details>)}
  </div>
}
