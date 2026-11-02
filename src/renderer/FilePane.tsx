import { lazy, Suspense, useRef, useState } from 'react'
import { Icon } from './icons'
import { isDirty, type DocumentDraft } from './documents'

const MarkdownEditor = lazy(() => import('./MarkdownEditor'))

export function FilePane({ path, document, rightOpen, onEdit, onSave, onReload, onHistory, onCompose, onPreviewHtml, onToggleRight }: {
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
  const [visual, setVisual] = useState(true)
  const markdown = /\.(md|markdown|mdown)$/i.test(path)
  const html = /\.html?$/i.test(path)
  const dirty = !!document && isDirty(document)
  const readonly = !document || document.binary || document.missing || document.tooBig
  return <>
    <div className="diffbar filebar">
      <Icon name="file" className="s" />
      <span className="path">{path}</span>
      <span className="grow" />
      {markdown && !readonly ? <div className="seg" role="radiogroup" aria-label="Markdown 编辑模式">
        <button role="radio" aria-checked={visual} className={visual ? 'on' : ''} onClick={() => setVisual(true)}>所见即所得</button>
        <button role="radio" aria-checked={!visual} className={!visual ? 'on' : ''} onClick={() => setVisual(false)}>源码</button>
      </div> : null}
      <span className="tag" role="status">{document?.error ? '自动保存暂停' : document?.saving ? '正在保存…' : dirty ? '等待自动保存' : readonly ? '只读' : '已保存'}</span>
      {!readonly ? <>
        <button className="ib" aria-label="撤销编辑" title="撤销编辑" disabled={!document.past?.length} onClick={() => onHistory(false)}><Icon name="back" /></button>
        <button className="ib redo" aria-label="重做编辑" title="重做编辑" disabled={!document.future?.length} onClick={() => onHistory(true)}><Icon name="back" /></button>
      </> : null}
      {html ? <button className="btn sm" data-a="preview-html" disabled={readonly || document?.saving} onClick={onPreviewHtml}>浏览器预览</button> : null}
      <button className="btn sm" data-a="reload-file" disabled={document?.saving} onClick={onReload}>重新读取</button>
      <button className="btn sm pri" data-a="save-file" disabled={readonly || !dirty || document?.saving} onClick={onSave}>保存</button>
      <button className="ib" data-a="right" aria-label={rightOpen ? '收起文件面板' : '显示文件面板'} onClick={onToggleRight}><Icon name="panel" /></button>
    </div>
    {document?.error ? <div className="file-error" role="alert">{document.error}</div> : null}
    <div className="file-content"
      onCompositionStartCapture={() => onCompose(true)} onCompositionEndCapture={() => onCompose(false)}
      onKeyDownCapture={(event) => {
        if (event.nativeEvent.isComposing || !(event.ctrlKey || event.metaKey) || event.altKey) return
        const key = event.key.toLowerCase()
        if (key === 's' || key === 'z' || key === 'y') {
          event.preventDefault(); event.stopPropagation()
          if (key === 's') onSave()
          else onHistory(key === 'y' || event.shiftKey)
        }
      }}>
      {readonly ? <div className="empty"><div className="in"><h2>{!document ? '正在读取文件…' : document.missing ? '文件不存在' : document.binary ? '无法编辑二进制或非 UTF-8 文件' : '文件超过 2 MB，请使用外部编辑器'}</h2></div></div>
        : markdown && visual ? <Suspense fallback={<div className="rmeta">正在加载 Markdown 编辑器…</div>}>
          <MarkdownEditor value={document.draft} projectId={document.projectId} path={path} onChange={onEdit} />
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
