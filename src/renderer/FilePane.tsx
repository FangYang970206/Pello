import { t } from '../shared/i18n'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import type { DocumentDraft } from './documents'
import { SourceHighlight } from './SourceHighlight'
import { mediaKind } from '../shared/media'
import { useContentZoom } from './usePreviewWheel'
import { DocumentSearch, useDocumentSearch } from './DocumentSearch'
import { clearSearchHighlights, highlightMatches } from './document-search'
import type { SearchAdapter } from './search-types'

const MarkdownEditor = lazy(() => import('./MarkdownEditor'))
const MediaPreview = lazy(() => import('./MediaPreview'))

export function FilePane({ path, anchor, onNavigate, document, onEdit, onSave, onReload, onHistory, onCompose, onToggleRight }: {
  path: string
  anchor?: string
  onNavigate: (path: string, anchor?: string) => void
  document: DocumentDraft | null
  rightOpen: boolean
  onEdit: (text: string) => void
  onSave: () => void
  onReload: () => void
  onHistory: (redo: boolean) => void
  onCompose: (composing: boolean) => void
  onPreviewHtml: () => void
  onToggleRight: () => void
}) {
  const gutter = useRef<HTMLDivElement>(null)
  const highlight = useRef<HTMLPreElement>(null)
  const format = useRef<((command: string) => void) | null>(null)
  const [visual, setVisual] = useState(true)
  const [preview, setPreview] = useState<{ url?: string; error?: string; content?: string; replacementId?: string }>({})
  const markdown = /\.(md|markdown|mdown)$/i.test(path)
  const html = /\.html?$/i.test(path)
  const media = mediaKind(path)
  const readonly = !document || !!media || document.binary || document.missing || document.tooBig
  const projectId = document?.projectId
  const { ref: content, zoom, changeZoom } = useContentZoom()
  const frame = useRef<HTMLIFrameElement>(null)
  const source = useRef<HTMLTextAreaElement>(null)
  const richSearch = useRef<SearchAdapter | null>(null)
  const [renderedText, setRenderedText] = useState('')
  const search = useDocumentSearch({ root: content, text: (markdown || html) && visual ? renderedText : document?.draft || '',
    revision: `${visual}:${preview.url || ''}`,
    enabled: !readonly,
    save: onSave,
    replace: !readonly && (!(markdown || html) || !visual) && !document?.replacing ? onEdit : undefined,
    replaceRanges: !readonly && markdown && visual && !document?.replacing ? (matches, value) => richSearch.current?.replace?.(matches, value) : undefined,
    focus: () => { if (markdown && visual) richSearch.current?.focus(); else if (html && visual) frame.current?.focus(); else source.current?.focus() },
    reveal: (match, matches, index) => {
      if (markdown && visual) { richSearch.current?.reveal(match, matches, index); return }
      if (html && visual) { frame.current?.contentWindow?.postMessage({ type: 'pello-preview-search', matches, current: match, open: search.open }, '*'); return }
      clearSearchHighlights()
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
  useEffect(() => () => clearSearchHighlights(), [])
  useEffect(() => {
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
  useEffect(() => window.awb.onPreviewSource(() => { if (html) { setPreview({}); setVisual(false) } }), [html])
  useEffect(() => {
    if (!html || !visual || !projectId) return
    if (document?.replacing) { setPreview({}); return }
    let stopped = false
    void window.awb.previewUrl(projectId, path, document?.draft).then((url) => {
      if (!stopped) setPreview({ url, content: document?.draft, replacementId: document?.replacementId })
    }).catch((error) => { if (!stopped) setPreview({ error: String(error) }) })
    return () => { stopped = true }
  }, [html, visual, projectId, path, document?.version, document?.draft, document?.replacing, document?.replacementId])
  async function contextMenu() {
    const command = await window.awb.documentMenu({ markdown, visual: (markdown || html) && visual,
      undo: !!document?.past?.length, redo: !!document?.future?.length, editable: !readonly })
    if (command === 'mode') { setPreview({}); setVisual((value) => !value) }
    else if (command === 'save') onSave()
    else if (command === 'reload') onReload()
    else if (command === 'panel') onToggleRight()
    else if (command === 'undo' || command === 'redo') onHistory(command === 'redo')
    else if (command) format.current?.(command)
  }
  return <>
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
      <DocumentSearch search={search} scope={html && visual ? t("HTML 预览仅支持查找，切换到源码后可替换") : undefined} />
      {document?.replacing ? <p className="rmeta" role="status">{t("正在处理文件覆盖…")}</p> : media && document ? <Suspense fallback={null}>
        <MediaPreview key={`${document.projectId}:${path}:${document.replacementId || ''}`} projectId={document.projectId} path={path} version={document.version} />
      </Suspense> : readonly ? <div className="empty"><div className="in"><h2>{!document ? t("正在读取文件…") : document.missing ? t("文件不存在") : document.binary ? t("无法编辑二进制或非 UTF-8 文件") : t("文件超过 2 MB，请使用外部编辑器")}</h2></div></div>
        : html && visual ? preview.error ? <p className="file-error" role="alert">{preview.error}</p> : preview.url && preview.content === document.draft && preview.replacementId === document.replacementId ?
          <div className="html-preview-viewport"><iframe ref={frame} key={preview.url} className="html-preview" title={t("HTML 预览")} sandbox="allow-scripts" src={`${preview.url}${preview.url.includes('?') ? '&' : '?'}workbenchWheel=1`} onLoad={() => frame.current?.contentWindow?.postMessage({ type: 'pello-preview-search', matches: search.open ? search.matches : [], current: search.open ? search.matches[search.active] : null, open: search.open }, '*')} style={{ zoom, width: `${100 / zoom}%`, height: `${100 / zoom}%` }} /></div> : null
        : markdown && visual ? <Suspense fallback={null}>
          <MarkdownEditor value={document.draft} projectId={document.projectId} path={path} anchor={anchor} onNavigate={onNavigate} onChange={onEdit} formatRef={format} searchRef={richSearch} onSearchText={setRenderedText} />
        </Suspense> : <div className="file-editor">
          <div className="editor-gutter" ref={gutter} aria-hidden="true">{document.draft.split('\n').map((_, i) => <div key={i}>{i + 1}</div>)}</div>
          <div className="source-editor">
          <pre ref={highlight} className="source-highlight" aria-hidden="true"><SourceHighlight value={document.draft} path={path} /></pre>
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
