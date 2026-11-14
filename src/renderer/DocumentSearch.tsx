import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { t } from '../shared/i18n'
import { replaceMatches, textMatches, type TextMatch } from '../shared/search'
import { Icon } from './icons'

export function useDocumentSearch({ root, text, replace, replaceRanges, reveal, focus, enabled = true, revision, save }: {
  root: RefObject<HTMLElement | null>; text: string
  replace?: (text: string) => void; reveal: (match: TextMatch | null, matches: TextMatch[], index: number) => void
  replaceRanges?: (matches: TextMatch[], value: string) => void
  focus: () => void; enabled?: boolean
  revision?: unknown
  save?: () => void
}) {
  const [open, setOpen] = useState(false), [expanded, setExpanded] = useState(false)
  const [query, setQuery] = useState(''), [replacement, setReplacement] = useState('')
  const [sensitive, setSensitive] = useState(false), [index, setIndex] = useState(0)
  const [navigation, setNavigation] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  useLayoutEffect(() => { if (open) { input.current?.focus(); input.current?.select() } }, [open])
  const matches = useMemo(() => textMatches(text, query, sensitive), [text, query, sensitive])
  const active = matches.length ? Math.min(index, matches.length - 1) : -1
  const callbacks = useRef({ reveal, focus })
  const wasOpen = useRef(false)
  callbacks.current = { reveal, focus }
  useEffect(() => {
    if (!open && !wasOpen.current) return
    wasOpen.current = open
    callbacks.current.reveal(open && active >= 0 ? matches[active] : null, open ? matches : [], active)
  }, [open, active, matches, revision, navigation])
  const show = (withReplace = false) => {
    setOpen(true)
    setNavigation((value) => value + 1)
    if (withReplace && (replace || replaceRanges)) setExpanded(true)
    // Refocusing an already-open search is synchronous; a delayed focus could
    // steal input after the user has moved on to the replacement field.
    if (open) { input.current?.focus(); input.current?.select() }
  }
  const close = () => { setOpen(false); setExpanded(false); callbacks.current.focus() }
  const move = (direction: number) => {
    setIndex(matches.length ? (active + direction + matches.length) % matches.length : 0)
    setNavigation((value) => value + 1)
  }
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (!enabled || !root.current || root.current.closest('[inert]') || document.querySelector('dialog[open],[role=dialog][aria-modal=true]') || event.isComposing || event.defaultPrevented) return
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest('.xterm,.settings')) return
      const modifier = (event.ctrlKey || event.metaKey) && !event.altKey
      const key = event.key.toLowerCase()
      if (modifier && (key === 'f' || key === 'h') && !event.shiftKey) {
        event.preventDefault(); event.stopPropagation(); show(key === 'h')
      } else if (modifier && key === 's' && save && target?.closest('.document-search')) {
        event.preventDefault(); event.stopPropagation(); save()
      } else if (open && (event.key === 'F3' || (event.key === 'Enter' && target === input.current))) {
        event.preventDefault(); event.stopPropagation(); move(event.shiftKey ? -1 : 1)
      } else if (open && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
    }
    window.addEventListener('keydown', keydown, true)
    return () => window.removeEventListener('keydown', keydown, true)
  })
  const apply = (all: boolean) => {
    if ((!replace && !replaceRanges) || active < 0) return
    const current = matches[active]
    const next = replaceMatches(text, all ? matches : [current], replacement)
    if (next === text) { move(1); return }
    const nextMatches = textMatches(next, query, sensitive)
    const nextIndex = all ? 0 : nextMatches.findIndex((match) => match.from >= current.from + replacement.length)
    setIndex(Math.max(0, nextIndex))
    if (replaceRanges) replaceRanges(all ? matches : [current], replacement)
    else replace?.(next)
  }
  return { open, expanded, query, replacement, sensitive, matches, active, input, show, close, move, apply,
    canReplace: !!(replace || replaceRanges), canExpand: !!(replace || replaceRanges),
    toggleReplace: () => setExpanded(!expanded),
    setQuery: (value: string) => { setQuery(value); setIndex(0) },
    setReplacement, setSensitive: (value: boolean) => { setSensitive(value); setIndex(0) } }
}

export type DocumentSearchState = ReturnType<typeof useDocumentSearch>

export function DocumentSearch({ search, scope }: { search: DocumentSearchState; scope?: React.ReactNode }) {
  if (!search.open) return null
  const count = search.query ? search.matches.length ? `${search.active + 1} / ${search.matches.length}` : t("无匹配") : '0 / 0'
  return <div className="document-search" data-replaceable={search.canExpand} role="search" aria-label={t("文档搜索")} onKeyDown={(event) => event.stopPropagation()} onCompositionStart={(event) => event.stopPropagation()} onCompositionEnd={(event) => event.stopPropagation()}>
    {search.canExpand ? <button className="ib search-expand" aria-label={search.expanded ? t("收起替换") : t("展开替换")} title={search.expanded ? t("收起替换") : t("展开替换")} aria-expanded={search.expanded} onClick={search.toggleReplace}><Icon name="chev" /></button> : null}
    <div className="document-search-row">
      <div className="search-input">
      <input ref={search.input} className="tx search-query" aria-label={t("查找内容")} placeholder={t("查找内容")} value={search.query} onChange={(event) => search.setQuery(event.target.value)} />
      <button className={`ib search-case${search.sensitive ? ' on' : ''}`} aria-label={t("区分大小写")} title={t("区分大小写")} aria-pressed={search.sensitive} onClick={() => search.setSensitive(!search.sensitive)}>Aa</button>
      </div>
      <span className="search-count" role="status" aria-live="polite" title={count}>{count}</span>
      <button className="ib" aria-label={t("上一个匹配")} title={t("上一个匹配")} disabled={!search.matches.length} onClick={() => search.move(-1)}><Icon name="up" /></button>
      <button className="ib search-next" aria-label={t("下一个匹配")} title={t("下一个匹配")} disabled={!search.matches.length} onClick={() => search.move(1)}><Icon name="up" /></button>
      <button className="ib" aria-label={t("关闭搜索")} title={t("关闭搜索")} onClick={search.close}><Icon name="x" /></button>
    </div>
    {search.expanded && search.canReplace ? <div className="document-search-row replace-row">
      <div className="search-input">
      <input className="tx search-replacement" aria-label={t("替换为")} placeholder={t("替换为")} value={search.replacement} onChange={(event) => search.setReplacement(event.target.value)} />
      </div>
      <button className="ib" aria-label={t("替换")} title={t("替换")} disabled={!search.matches.length} onClick={() => search.apply(false)}><Icon name="replace" /></button>
      <button className="ib" aria-label={t("全部替换")} title={t("全部替换")} disabled={!search.matches.length} onClick={() => search.apply(true)}><Icon name="replace-all" /></button>
    </div> : null}
    {scope ? <div className="document-search-scope">{scope}</div> : null}
  </div>
}
