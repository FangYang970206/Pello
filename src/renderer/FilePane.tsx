import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import type { DocumentDraft } from './documents'

const MarkdownEditor = lazy(() => import('./MarkdownEditor'))

export function FilePane({ path, document, onEdit, onSave, onReload, onHistory, onCompose, onToggleRight }: {
  path: string
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
  const format = useRef<((command: string) => void) | null>(null)
  const [visual, setVisual] = useState(true)
  const [preview, setPreview] = useState<{ url?: string; error?: string }>({})
  const markdown = /\.(md|markdown|mdown)$/i.test(path)
  const html = /\.html?$/i.test(path)
  const readonly = !document || document.binary || document.missing || document.tooBig
  const projectId = document?.projectId
  useEffect(() => window.awb.onPreviewSource(() => { if (html) setVisual(false) }), [html])
  useEffect(() => {
    if (!html || !visual || !projectId) return
    let stopped = false
    void window.awb.previewUrl(projectId, path, document?.draft).then((url) => {
      if (!stopped) setPreview({ url })
    }).catch((error) => { if (!stopped) setPreview({ error: String(error) }) })
    return () => { stopped = true }
  }, [html, visual, projectId, path, document?.version, document?.draft])
  async function contextMenu() {
    const command = await window.awb.documentMenu({ markdown, visual: (markdown || html) && visual,
      undo: !!document?.past?.length, redo: !!document?.future?.length, editable: !readonly })
    if (command === 'mode') setVisual((value) => !value)
    else if (command === 'save') onSave()
    else if (command === 'reload') onReload()
    else if (command === 'panel') onToggleRight()
    else if (command === 'undo' || command === 'redo') onHistory(command === 'redo')
    else if (command) format.current?.(command)
  }
  return <>
    {document?.error ? <div className="file-error" role="alert">{document.error}</div> : null}
    <div className="file-content" tabIndex={-1}
      onContextMenu={(event) => { event.preventDefault(); void contextMenu() }}
      onCompositionStartCapture={() => onCompose(true)} onCompositionEndCapture={() => onCompose(false)}
      onKeyDownCapture={(event) => {
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); void contextMenu(); return }
        if (event.nativeEvent.isComposing || !(event.ctrlKey || event.metaKey) || event.altKey) return
        const key = event.key.toLowerCase()
        if (key === 's' || key === 'z' || key === 'y') {
          event.preventDefault(); event.stopPropagation()
          if (key === 's') onSave()
          else onHistory(key === 'y' || event.shiftKey)
        }
      }}>
      {readonly ? <div className="empty"><div className="in"><h2>{!document ? '正在读取文件…' : document.missing ? '文件不存在' : document.binary ? '无法编辑二进制或非 UTF-8 文件' : '文件超过 2 MB，请使用外部编辑器'}</h2></div></div>
        : html && visual ? preview.error ? <p className="file-error" role="alert">{preview.error}</p> : preview.url ?
          <iframe className="html-preview" title="HTML 预览" sandbox="allow-scripts" src={preview.url} /> : <p className="rmeta">正在加载预览…</p>
        : markdown && visual ? <Suspense fallback={<div className="rmeta">正在加载 Markdown 编辑器…</div>}>
          <MarkdownEditor value={document.draft} projectId={document.projectId} path={path} onChange={onEdit} formatRef={format} />
        </Suspense> : <div className="file-editor">
          <div className="editor-gutter" ref={gutter} aria-hidden="true">{document.draft.split('\n').map((_, i) => <div key={i}>{i + 1}</div>)}</div>
          <textarea aria-label="文件内容" value={document.draft} wrap="off" spellCheck={false} autoCorrect="off" autoCapitalize="off"
            onChange={(event) => onEdit(event.target.value)}
            onScroll={(event) => { if (gutter.current) gutter.current.scrollTop = event.currentTarget.scrollTop }}
            onKeyDown={(event) => {
              if (event.key !== 'Tab' || event.ctrlKey || event.altKey || event.metaKey) return
              event.preventDefault()
              const field = event.currentTarget
              const start = field.selectionStart, end = field.selectionEnd
              onEdit(field.value.slice(0, start) + '  ' + field.value.slice(end))
              requestAnimationFrame(() => field.setSelectionRange(start + 2, start + 2))
            }} />
        </div>}
    </div>
  </>
}
