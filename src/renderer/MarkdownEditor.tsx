import { useEffect, useId, useRef, useState } from 'react'
import { Crepe } from '@milkdown/crepe'
import { editorViewCtx, serializerCtx } from '@milkdown/kit/core'
import { toggleStrongCommand, toggleEmphasisCommand, toggleInlineCodeCommand, wrapInHeadingCommand, wrapInBlockquoteCommand, wrapInBulletListCommand, wrapInOrderedListCommand, createCodeBlockCommand } from '@milkdown/kit/preset/commonmark'
import { insertTableCommand } from '@milkdown/kit/preset/gfm'
import { Plugin } from '@milkdown/kit/prose/state'
import { $prose, callCommand, replaceAll } from '@milkdown/kit/utils'
import { languages } from '@codemirror/language-data'
import { EditorView } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { diagramPreview } from './diagram-preview'
import { Icon } from './icons'
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

export default function MarkdownEditor({ value, projectId, path, anchor, onNavigate, onChange, formatRef }: {
  value: string; projectId: string; path: string; onChange: (markdown: string) => void
  anchor?: string; onNavigate: (path: string, anchor?: string) => void
  formatRef: { current: ((command: string) => void) | null }
}) {
  const host = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLDivElement>(null)
  const outlineToggle = useRef<HTMLButtonElement>(null)
  const outlineId = useId()
  const [outlineOpen, setOutlineOpen] = useState(true)
  const [compact, setCompact] = useState(false)
  const [activeHeading, setActiveHeading] = useState('')
  const editor = useRef<Crepe | null>(null)
  const ready = useRef(false)
  const applying = useRef(false)
  const interacted = useRef(false)
  const serialized = useRef('')
  const current = useRef(value)
  const change = useRef(onChange)
  const assetBase = useRef('')
  const [error, setError] = useState('')
  const [linkError, setLinkError] = useState('')
  const requestedAnchor = useRef(anchor)
  requestedAnchor.current = anchor
  const scrollTo = (id: string) => {
    const target = host.current?.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`)
    const scroller = host.current?.closest<HTMLElement>('.markdown-editor')
    if (!target || !scroller) return
    scroller.scrollTop += target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 24
    setActiveHeading(id)
  }
  const [headings, setHeadings] = useState<{ text: string; level: number; id: string }[]>([])
  current.current = value
  change.current = onChange
  const parts = metadata(value)

  useEffect(() => {
    const root = frame.current
    if (!root) return
    let previous: boolean | undefined
    const observer = new ResizeObserver(() => {
      const narrow = root.clientWidth < 720
      if (narrow === previous) return
      previous = narrow
      setCompact(narrow)
      setOutlineOpen(!narrow)
    })
    observer.observe(root)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const scroller = host.current?.closest<HTMLElement>('.markdown-editor')
    if (!scroller || !headings.length) return
    let pending = 0
    const update = () => {
      cancelAnimationFrame(pending)
      pending = requestAnimationFrame(() => {
        const top = scroller.getBoundingClientRect().top + 48
        let current = headings[0].id
        for (const heading of headings) {
          const node = host.current?.querySelector<HTMLElement>(`[id="${CSS.escape(heading.id)}"]`)
          if (node && node.getBoundingClientRect().top <= top) current = heading.id
        }
        setActiveHeading(current)
      })
    }
    scroller.addEventListener('scroll', update, { passive: true })
    update()
    return () => { cancelAnimationFrame(pending); scroller.removeEventListener('scroll', update) }
  }, [headings])

  useEffect(() => {
    const root = host.current
    if (!root) return
    let disposed = false
    const initial = metadata(current.current)
    const crepe = new Crepe({ root, defaultValue: initial.body,
      features: { [Crepe.Feature.AI]: false },
      featureConfigs: { [Crepe.Feature.CodeMirror]: {
        languages,
        extensions: [syntaxHighlighting(HighlightStyle.define([
          { tag: [tags.keyword, tags.bool, tags.null], color: 'var(--magenta)' },
          { tag: [tags.string, tags.regexp], color: 'var(--green)' },
          { tag: [tags.number, tags.atom], color: 'var(--amber)' },
          { tag: [tags.propertyName, tags.typeName, tags.tagName, tags.function(tags.variableName)], color: 'var(--blue)' },
          { tag: tags.comment, color: 'var(--faint)' }, { tag: tags.variableName, color: 'var(--text)' }
        ]))],
        theme: EditorView.theme({ '&': { color: 'var(--text)', backgroundColor: 'var(--elev2)' }, '.cm-gutters': { backgroundColor: 'var(--elev2)', color: 'var(--muted)', border: 'none' }, '.cm-activeLineGutter': { backgroundColor: 'var(--elev2)' } }),
        renderPreview: diagramPreview,
        previewOnlyByDefault: true, previewLabel: '图表预览', previewLoading: '正在渲染图表…', copyText: '复制', searchPlaceholder: '搜索语言', noResultText: '没有匹配语言'
      }, [Crepe.Feature.ImageBlock]: {
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
    const syncHeadings = () => {
      const seen = new Map<string, number>()
      const entries = [...root.querySelectorAll<HTMLElement>('.ProseMirror h1,.ProseMirror h2,.ProseMirror h3,.ProseMirror h4,.ProseMirror h5,.ProseMirror h6')].map((node) => {
        const text = node.textContent || ''
        const slug = text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-')
        const count = seen.get(slug) || 0
        seen.set(slug, count + 1)
        node.id = count ? `${slug}-${count}` : slug
        return { text, level: Number(node.tagName.slice(1)), id: node.id }
      })
      setHeadings(entries)
    }
    crepe.editor.use($prose((ctx) => new Plugin({ view: () => ({ update: (view, previous) => {
      if (!view.state.doc.eq(previous.doc)) queueMicrotask(() => { if (!disposed) syncHeadings() })
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
      syncHeadings()
      if (requestedAnchor.current) requestAnimationFrame(() => { if (!disposed) scrollTo(requestedAnchor.current!) })
      serialized.current = crepe.getMarkdown()
      formatRef.current = (command) => {
        interacted.current = true
        crepe.editor.action((ctx) => ctx.get(editorViewCtx).focus())
        const commands = { bold: toggleStrongCommand, italic: toggleEmphasisCommand, code: toggleInlineCodeCommand,
          quote: wrapInBlockquoteCommand, bullet: wrapInBulletListCommand, ordered: wrapInOrderedListCommand, codeblock: createCodeBlockCommand }
        if (command === 'heading') crepe.editor.action(callCommand(wrapInHeadingCommand.key, 1))
        else if (command === 'table') crepe.editor.action(callCommand(insertTableCommand.key, { row: 3, col: 2 }))
        else if (command in commands) crepe.editor.action(callCommand(commands[command as keyof typeof commands].key))
      }
      const view = root.querySelector<HTMLElement>('.ProseMirror')
      view?.setAttribute('role', 'textbox')
      view?.setAttribute('aria-label', 'Markdown 内容')
      view?.setAttribute('aria-multiline', 'true')
    }).catch((reason) => { if (!disposed) setError(String(reason)) })
    return () => {
      disposed = true
      ready.current = false
      editor.current = null
      formatRef.current = null
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

  useEffect(() => { if (anchor && ready.current) scrollTo(anchor) }, [anchor])

  return <div ref={frame} className="markdown-view" data-has-outline={headings.length > 0} data-outline-open={headings.length > 0 && outlineOpen} data-compact={compact}>
    {headings.length ? <aside className="markdown-outline" aria-label="文档导航" onKeyDown={(event) => {
      if (event.key === 'Escape' && outlineOpen) { event.preventDefault(); event.stopPropagation(); setOutlineOpen(false); outlineToggle.current?.focus() }
    }}>
      <button ref={outlineToggle} className="markdown-outline-toggle" aria-label={outlineOpen ? '收起文档目录' : '展开文档目录'} title={outlineOpen ? '收起文档目录' : '文档目录'} aria-expanded={outlineOpen} aria-controls={outlineId} onClick={() => setOutlineOpen((open) => !open)}><Icon name="panel" className="s" />{outlineOpen ? <><span>文档目录</span><Icon name="chev" className="s" /></> : null}</button>
      <nav id={outlineId} aria-label="文档目录" hidden={!outlineOpen}>{headings.map((heading) => <button key={heading.id} title={heading.text} aria-current={heading.id === activeHeading ? 'location' : undefined} style={{ paddingLeft: (heading.level - 1) * 10 + 12 }} onClick={() => {
        if (compact) { setOutlineOpen(false); outlineToggle.current?.focus(); requestAnimationFrame(() => scrollTo(heading.id)) }
        else scrollTo(heading.id)
      }}>{heading.text || '无标题'}</button>)}</nav>
    </aside> : null}
    <div className="markdown-editor"
    onBeforeInputCapture={() => { interacted.current = true }}
    onKeyDownCapture={() => { interacted.current = true }}
    onPointerDownCapture={() => { interacted.current = true }}
    onClickCapture={(event) => {
      const link = (event.target as Element).closest('a[href]')
      if (!link) return
      event.preventDefault()
      const href = link.getAttribute('href') || ''
      setLinkError('')
      if (href.startsWith('#')) { try { scrollTo(decodeURIComponent(href.slice(1))) } catch { setLinkError('无效的文档锚点') } }
      else void window.awb.documentLink(projectId, path, href).then((target) => { if (target) onNavigate(target.path, target.anchor) }).catch((error) => setLinkError(String(error)))
    }}>
    {parts.prefix ? <details className="markdown-metadata"><summary>文档属性</summary>
      <textarea aria-label="Markdown 文档属性" value={parts.prefix} spellCheck={false}
        onChange={(event) => onChange(event.target.value + parts.body)} />
    </details> : null}
    {error ? <p className="file-error" role="alert">编辑器加载失败，请切换到源码编辑。{error}</p> : null}
    {linkError ? <p className="file-error" role="alert">{linkError}</p> : null}
    <div ref={host} />
    </div>
  </div>
}
