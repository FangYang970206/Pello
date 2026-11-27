import { t } from '../shared/i18n'
import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState } from 'react'
import { isDirty, type DocumentDraft } from './documents'
import { SourceHighlight } from './SourceHighlight'
import { mediaKind } from '../shared/media'
import { useContentZoom } from './usePreviewWheel'
import { DocumentSearch, useDocumentSearch } from './DocumentSearch'
import { clearSearchHighlights, highlightMatches, revealSearchRect } from './document-search'
import type { SearchAdapter } from './search-types'
import type { PaneLayoutOptions } from '../shared/api'
import type { SearchLocation } from '../shared/types'
import { textMatches } from '../shared/search'
import { StructuredSource } from './StructuredSource'
import { structuredLanguage, transformJson } from './structured-source'

const MarkdownEditor = lazy(() => import('./MarkdownEditor'))
const MediaPreview = lazy(() => import('./MediaPreview'))

export function FilePane({ path, anchor, location, onNavigate, document, onEdit, onSave, onReload, onHistory, onCompose, onToggleRight, layout, onLayout, visible = true }: {
  path: string
  visible?: boolean
  anchor?: string
  location?: SearchLocation
  onNavigate: (path: string, anchor?: string) => void
  document: DocumentDraft | null
  rightOpen: boolean
  onEdit: (text: string, separateHistory?: boolean) => void
  onSave: () => void
  onReload: () => void
  onHistory: (redo: boolean) => void
  onCompose: (composing: boolean) => void
  onPreviewHtml: () => void
  onToggleRight: () => void
  layout: PaneLayoutOptions
  onLayout: (command: string) => void
}) {
  const gutter = useRef<HTMLDivElement>(null)
  const highlight = useRef<HTMLPreElement>(null)
  const format = useRef<((command: string) => void) | null>(null)
  const [visualMode, setVisual] = useState<boolean>()
  const [invalidJson, setInvalidJson] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ url?: string; error?: string; content?: string; replacementId?: string }>({})
  const markdown = /\.(md|markdown|mdown)$/i.test(path)
  const html = /\.html?$/i.test(path)
  const media = mediaKind(path)
  const visual = visualMode ?? !(markdown && (document?.draft.length || 0) > 2_000_000)
  const plainSource = (document?.draft.length || 0) > 300_000
  const showingSource = !((html || markdown) && visual) && !media
  const readonly = !document || !!media || document.binary || document.missing || document.tooBig
  const structured = structuredLanguage(path)
  const structuredSearch = useRef<SearchAdapter | null>(null)
  const current = useRef({ visible, readonly, document, onEdit })
  current.current = { visible, readonly, document, onEdit }
  const projectId = document?.projectId
  const { ref: content, zoom, changeZoom } = useContentZoom()
  const frame = useRef<HTMLIFrameElement>(null)
  const viewId = useId()
  const source = useRef<HTMLTextAreaElement>(null)
  // Labels depend only on line count. Keep every label in one text node so
  // editing and saving do not reconcile or lay out tens of thousands of divs.
  const lineCount = useMemo(() => {
    if (!showingSource || structured || !document) return 0
    let count = 1
    for (let offset = document.draft.indexOf('\n'); offset >= 0; offset = document.draft.indexOf('\n', offset + 1)) count++
    return count
  }, [showingSource, structured, document?.draft])
  const lineNumbers = useMemo(() => Array.from({ length: lineCount }, (_, index) => String(index + 1)).join('\n'), [lineCount])
  const richSearch = useRef<SearchAdapter | null>(null)
  const [renderedText, setRenderedText] = useState('')
  const located = useRef('')
  const [locationError, setLocationError] = useState('')
  const search = useDocumentSearch({ root: content, text: (markdown || html) && visual ? renderedText : document?.draft || '',
    revision: `${visible}:${visual}:${preview.url || ''}`,
    enabled: visible && !readonly,
    save: onSave,
    replace: !readonly && (!(markdown || html) || !visual) && !document?.replacing ? onEdit : undefined,
    replaceRanges: !readonly && markdown && visual && !document?.replacing ? (matches, value) => richSearch.current?.replace?.(matches, value) : undefined,
    focus: () => { if (markdown && visual) richSearch.current?.focus(); else if (html && visual) frame.current?.focus(); else if (structured) structuredSearch.current?.focus(); else source.current?.focus() },
    reveal: (match, matches, index) => {
      if (!visible) return
      if (markdown && visual) { richSearch.current?.reveal(match, matches, index); return }
      if (html && visual) { frame.current?.contentWindow?.postMessage({ type: 'pello-preview-search', matches, current: match, open: search.open }, '*'); return }
      if (structured) { structuredSearch.current?.reveal(match, matches, index); return }
      clearSearchHighlights(content.current)
      if (highlight.current) highlightMatches(highlight.current, matches, index)
      if (!match || !source.current) return
      const field = source.current, style = getComputedStyle(field)
      field.setSelectionRange(match.from, match.to)
      const prefix = field.value.slice(0, match.from), lines = prefix.split('\n')
      field.scrollTop = Math.max(0, (lines.length - 1) * Number.parseFloat(style.lineHeight) - field.clientHeight / 3)
      const measure = window.document.createElement('canvas').getContext('2d')!
      measure.font = style.font
      field.scrollLeft = Math.max(0, measure.measureText(lines.at(-1)!.replaceAll('\t', '  ')).width - field.clientWidth / 2)
      field.dispatchEvent(new Event('scroll'))
    }
  })
  useEffect(() => {
    if (!visible) return
    if (!location) { setLocationError(''); return }
    if (readonly || located.current === location.id) return
    // Project results refer to source lines, including Markdown/HTML syntax.
    // Use the existing draft and editor; switching mode never writes the file.
    if ((markdown || html) && visual) { setVisual(false); return }
    const field = source.current
    if ((!field && !structuredSearch.current) || !document) return
    located.current = location.id
    const lines = document.draft.split('\n')
    const expected = lines.slice(0, location.line - 1).reduce((total, line) => total + line.length + 1, 0) + location.column - 1
    const matches = textMatches(document.draft, location.query, location.sensitive)
    const match = location.query ? matches.reduce<(typeof matches)[number] | null>((best, value) => !best || Math.abs(value.from - expected) < Math.abs(best.from - expected) ? value : best, null) : { from: Math.min(expected, document.draft.length), to: Math.min(expected, document.draft.length) }
    setLocationError(match ? '' : t("搜索结果已变化，请重新搜索"))
    if (!match) return
    if (!field) { structuredSearch.current?.focus(); structuredSearch.current?.reveal(match, [match], 0); return }
    field.focus({ preventScroll: true })
    field.setSelectionRange(match.from, match.to)
    if (highlight.current) {
      highlight.current.scrollTop = field.scrollTop
      highlight.current.scrollLeft = field.scrollLeft
      const range = highlightMatches(highlight.current, [match], 0)
      if (range) revealSearchRect(field, range.getBoundingClientRect())
      highlight.current.scrollTop = field.scrollTop
      highlight.current.scrollLeft = field.scrollLeft
    }
    field.dispatchEvent(new Event('scroll'))
  }, [location, readonly, markdown, html, visual, document, visible])
  useEffect(() => { const root = content.current; return () => clearSearchHighlights(root) }, [])
  useEffect(() => {
    if (!visible && html) frame.current?.contentWindow?.postMessage({ type: 'pello-preview-search', open: false }, '*')
  }, [html, visible])
  useEffect(() => {
    if (!visible || !html) return
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return
      if (event.data?.type === 'pello-preview-zoom' && Number.isFinite(event.data.deltaY) && event.data.deltaY) changeZoom(event.data.deltaY)
      else if (event.data?.type === 'pello-preview-text' && typeof event.data.text === 'string') setRenderedText(event.data.text)
      else if (event.data?.type === 'pello-preview-key') {
        if (content.current?.closest('[inert]') || window.document.querySelector('dialog[open],[role=dialog][aria-modal=true]')) return
        if (event.data.key === 'f' || event.data.key === 'h') search.show(event.data.key === 'h')
        else if (event.data.key === 'f3' && search.open) search.move(event.data.shift ? -1 : 1)
        else if (event.data.key === 'escape' && search.open) search.close()
      }
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  })
  useEffect(() => {
    if (!html || !visible) return
    return window.awb.onPreviewCommand((url, command) => {
      if (frame.current?.src !== url) return
      if (command === 'reload') onReload()
      else { setPreview({}); setVisual(false) }
    })
  }, [html, visible, onReload])
  useEffect(() => {
    if (!html || !visual || !projectId || readonly) return
    if (document?.replacing) { setPreview({}); return }
    let stopped = false
    const draft = isDirty(document) ? document.draft : undefined
    void window.awb.previewUrl(projectId, path, draft, document.assetToken).then((url) => {
      if (!stopped) setPreview({ url, content: document?.draft, replacementId: document?.replacementId })
    }).catch((error) => { if (!stopped) setPreview({ error: String(error) }) })
    return () => { stopped = true }
  }, [html, visual, projectId, path, readonly, document?.version, document?.text, document?.draft, document?.replacing, document?.replacementId, document?.assetToken])
  async function contextMenu() {
    const command = await window.awb.documentMenu({ markdown, visual: (markdown || html) && visual,
      undo: !!document?.past?.length, redo: !!document?.future?.length, editable: !readonly && !document?.replacing, json: structured === 'json', layout })
    if (command === 'mode') { setPreview({}); setVisual(!visual) }
    else if (command === 'save') onSave()
    else if (command === 'reload') onReload()
    else if (command === 'panel') onToggleRight()
    else if (command === 'undo' || command === 'redo') onHistory(command === 'redo')
    else if (command === 'json-format' || command === 'json-compact') {
      const { visible, readonly, document, onEdit } = current.current
      if (!visible || readonly || !document || document.replacing) return
      let next: string
      try { next = transformJson(document.draft, command === 'json-format') }
      catch { setInvalidJson(document.draft); structuredSearch.current?.focus(); return }
      onEdit(next, true)
      setInvalidJson(null)
      structuredSearch.current?.focus()
    }
    else if (command?.startsWith('split-') || command === 'merge') onLayout(command)
    else if (command) format.current?.(command)
  }
  return <>
    {locationError ? <div className="file-error" role="status">{locationError}</div> : null}
    {invalidJson !== null && invalidJson === document?.draft ? <div className="file-error" role="alert">{t("JSON 无效，请修正语法后重试。")}</div> : null}
    {document?.error ? <div className="file-error" role="alert">{document.error}</div> : null}
    <div className="file-content editor-surface" tabIndex={-1} ref={content} style={{ '--content-zoom': zoom } as React.CSSProperties}
      onContextMenu={(event) => { event.preventDefault(); void contextMenu() }}
      onCompositionStartCapture={(event) => { if (!(event.target as Element).closest('.document-search')) onCompose(true) }} onCompositionEndCapture={(event) => { if (!(event.target as Element).closest('.document-search')) onCompose(false) }}
      onKeyDownCapture={(event) => {
        if ((event.target as Element).closest('.document-search')) return
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); void contextMenu(); return }
        if (event.nativeEvent.isComposing || !(event.ctrlKey || event.metaKey) || event.altKey) return
        const key = event.key.toLowerCase()
        if (key === 's' || key === 'z' || key === 'y') {
          event.preventDefault(); event.stopPropagation()
          if (key === 's') onSave()
          else onHistory(key === 'y' || event.shiftKey)
        }
      }}>
      {visible ? <DocumentSearch search={search} scope={html && visual ? t("HTML 预览仅支持查找，切换到源码后可替换") : undefined} /> : null}
      {document?.replacing ? <p className="rmeta" role="status">{t("正在处理文件覆盖…")}</p> : media && document && !document.missing ? <Suspense fallback={null}>
        <MediaPreview key={`${document.projectId}:${path}:${document.replacementId || ''}`} projectId={document.projectId} path={path} version={document.version}
          assetToken={document.assetToken} tooBig={document.tooBig} onReload={onReload} />
      </Suspense> : readonly ? <div className="empty"><div className="in"><h2>{!document ? t("正在读取文件…") : document.missing ? t("文件不存在") : document.binary ? t("无法编辑二进制或非 UTF-8 文件") : t("文件超过 10 MB，请使用外部编辑器")}</h2></div></div>
        : html && visual ? preview.error ? <p className="file-error" role="alert">{preview.error}</p> : preview.url && preview.content === document.draft && preview.replacementId === document.replacementId ?
          <div className="html-preview-viewport"><iframe ref={frame} key={preview.url} className="html-preview" title={t("HTML 预览")} sandbox="allow-scripts" src={`${preview.url}${preview.url.includes('?') ? '&' : '?'}workbenchWheel=1&workbenchView=${encodeURIComponent(viewId)}`} onLoad={() => frame.current?.contentWindow?.postMessage({ type: 'pello-preview-search', matches: search.open ? search.matches : [], current: search.open ? search.matches[search.active] : null, open: search.open }, '*')} style={{ zoom, width: `${100 / zoom}%`, height: `${100 / zoom}%` }} /></div> : null
        : markdown && visual ? <Suspense fallback={null}>
          <MarkdownEditor value={document.draft} projectId={document.projectId} path={path} anchor={anchor} onNavigate={onNavigate} onChange={onEdit} formatRef={format} searchRef={richSearch} onSearchText={setRenderedText} />
        </Suspense> : structured ? <StructuredSource language={structured} value={document.draft} onEdit={onEdit} searchRef={structuredSearch} visible={visible} /> : <div className="file-editor">
          <div className="editor-gutter" ref={gutter} aria-hidden="true">{lineNumbers}</div>
          <div className={`source-editor${plainSource && !search.open && !location ? ' plain-source' : ''}`}>
          {!plainSource || search.open || location ? <pre ref={highlight} className="source-highlight" aria-hidden="true"><SourceHighlight value={document.draft} path={path} /></pre> : null}
          <textarea ref={source} aria-label={t("文件内容")} value={document.draft} wrap="off" spellCheck={false} autoCorrect="off" autoCapitalize="off"
            onChange={(event) => onEdit(event.target.value)}
            onScroll={(event) => { if (gutter.current) gutter.current.scrollTop = event.currentTarget.scrollTop; if (highlight.current) { highlight.current.scrollTop = event.currentTarget.scrollTop; highlight.current.scrollLeft = event.currentTarget.scrollLeft } }}
            onKeyDown={(event) => {
              if (event.key !== 'Tab' || event.ctrlKey || event.altKey || event.metaKey) return
              event.preventDefault()
              const field = event.currentTarget
              const start = field.selectionStart, end = field.selectionEnd
              onEdit(field.value.slice(0, start) + '  ' + field.value.slice(end))
              requestAnimationFrame(() => field.setSelectionRange(start + 2, start + 2))
            }} />
          </div>
        </div>}
    </div>
  </>
}
