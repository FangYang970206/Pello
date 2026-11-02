import { useEffect, useRef, useState } from 'react'
import { Crepe } from '@milkdown/crepe'
import { serializerCtx } from '@milkdown/kit/core'
import { Plugin } from '@milkdown/kit/prose/state'
import { $prose, replaceAll } from '@milkdown/kit/utils'
import '@milkdown/crepe/theme/common/style.css'
import '@milkdown/crepe/theme/frame.css'
import './styles/markdown.css'

function metadata(value: string) {
  const match = /^---\n[\s\S]*?\n---(?:\n|$)/.exec(value)
  const prefix = match?.[0] || ''
  return { prefix, body: value.slice(prefix.length) }
}

function imageSource(source: string, base: string): string {
  if (/^https?:\/\//i.test(source) || /^data:image\//i.test(source)) return source
  if (!base || /^[a-z][a-z\d+.-]*:/i.test(source) || source.startsWith('//')) return ''
  const root = new URL(base)
  const scope = `/${root.pathname.split('/')[1]}/`
  const target = new URL(source.startsWith('/') ? scope + source.slice(1) : source, root)
  return target.origin === root.origin && target.pathname.startsWith(scope) ? target.href : ''
}

export default function MarkdownEditor({ value, projectId, path, onChange }: {
  value: string; projectId: string; path: string; onChange: (markdown: string) => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const editor = useRef<Crepe | null>(null)
  const ready = useRef(false)
  const applying = useRef(false)
  const interacted = useRef(false)
  const serialized = useRef('')
  const current = useRef(value)
  const change = useRef(onChange)
  const assetBase = useRef('')
  const [error, setError] = useState('')
  current.current = value
  change.current = onChange
  const parts = metadata(value)

  useEffect(() => {
    const root = host.current
    if (!root) return
    let disposed = false
    const initial = metadata(current.current)
    const crepe = new Crepe({ root, defaultValue: initial.body,
      features: { [Crepe.Feature.AI]: false },
      featureConfigs: { [Crepe.Feature.ImageBlock]: {
        proxyDomURL: (url) => imageSource(url, assetBase.current),
        onUpload: (file) => new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result))
          reader.onerror = () => reject(new Error('无法读取图片'))
          reader.readAsDataURL(file)
        })
      } }
    })
    // A synchronous document transaction listener avoids losing the last edit
    // when a file tab closes before a library's debounced change event fires.
    crepe.editor.use($prose((ctx) => new Plugin({ view: () => ({ update: (view, previous) => {
      if (!ready.current || applying.current || !interacted.current || view.state.doc.eq(previous.doc)) return
      const markdown = ctx.get(serializerCtx)(view.state.doc)
      if (markdown === serialized.current) return
      serialized.current = markdown
      change.current(metadata(current.current).prefix + markdown)
    } }) })))
    editor.current = crepe
    const created = window.awb.previewUrl(projectId, path).then((base) => {
      assetBase.current = base
    }).catch(() => {}).then(() => crepe.create()).then(() => {
      if (disposed) return
      // Undo or a source edit may arrive while remote assets/editor setup load.
      const latest = metadata(current.current).body
      if (latest !== initial.body) crepe.editor.action(replaceAll(latest))
      ready.current = true
      serialized.current = crepe.getMarkdown()
      const view = root.querySelector<HTMLElement>('.ProseMirror')
      view?.setAttribute('role', 'textbox')
      view?.setAttribute('aria-label', 'Markdown 内容')
      view?.setAttribute('aria-multiline', 'true')
    }).catch((reason) => { if (!disposed) setError(String(reason)) })
    return () => {
      disposed = true
      ready.current = false
      editor.current = null
      void created.then(() => crepe.destroy()).catch(() => {})
    }
  }, [projectId, path])

  useEffect(() => {
    const crepe = editor.current
    if (!ready.current || !crepe || parts.body === serialized.current) return
    const canonical = crepe.getMarkdown()
    if (parts.body === canonical) return
    applying.current = true
    try {
      crepe.editor.action(replaceAll(parts.body))
      serialized.current = crepe.getMarkdown()
    } finally { applying.current = false }
  }, [parts.body])

  return <div className="markdown-editor"
    onBeforeInputCapture={() => { interacted.current = true }}
    onKeyDownCapture={() => { interacted.current = true }}
    onPointerDownCapture={() => { interacted.current = true }}
    onClickCapture={(event) => { if ((event.target as Element).closest('a[href]')) event.preventDefault() }}>
    {parts.prefix ? <details className="markdown-metadata"><summary>文档属性</summary>
      <textarea aria-label="Markdown 文档属性" value={parts.prefix} spellCheck={false}
        onChange={(event) => onChange(event.target.value + parts.body)} />
    </details> : null}
    {error ? <p className="file-error" role="alert">编辑器加载失败，请切换到源码编辑。{error}</p> : null}
    <div ref={host} />
  </div>
}
