import { getLanguage, subscribeLanguage, t } from '../shared/i18n'
import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { Crepe } from '@milkdown/crepe'
import { editorViewCtx, serializerCtx } from '@milkdown/kit/core'
import { toggleStrongCommand, toggleEmphasisCommand, toggleInlineCodeCommand, wrapInHeadingCommand, wrapInBlockquoteCommand, wrapInBulletListCommand, wrapInOrderedListCommand, createCodeBlockCommand } from '@milkdown/kit/preset/commonmark'
import { insertTableCommand } from '@milkdown/kit/preset/gfm'
import { Plugin } from '@milkdown/kit/prose/state'
import type { EditorView as ProseMirrorView } from '@milkdown/kit/prose/view'
import { $prose, callCommand, replaceAll } from '@milkdown/kit/utils'
import { languages } from '@codemirror/language-data'
import { EditorView } from '@codemirror/view'
import { codeBlockConfig } from '@milkdown/kit/component/code-block'
import type { NodeViewConstructor } from '@milkdown/kit/prose/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { diagramPreview } from './diagram-preview'
import { preserveCodeLayout } from './markdown-code-layout'
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

type Heading = { text: string; level: number; id: string }
type HeadingTarget = Heading & { nativeId: string; position: number; element: HTMLElement | null }

export default function MarkdownEditor({ value, projectId, path, anchor, onNavigate, onChange, formatRef }: {
  value: string; projectId: string; path: string; onChange: (markdown: string) => void
  anchor?: string; onNavigate: (path: string, anchor?: string) => void
  formatRef: { current: ((command: string) => void) | null }
}) {
  const language = useSyncExternalStore(subscribeLanguage, getLanguage)
  const localizeEditor = useRef<(() => void) | null>(null)
  useEffect(() => { localizeEditor.current?.() }, [language])
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
  const headingTargets = useRef<HeadingTarget[]>([])
  requestedAnchor.current = anchor
  const scrollTo = (id: string) => {
    const entry = headingTargets.current.find((heading) => heading.id === id || heading.nativeId === id)
    const target = entry?.element
    const scroller = host.current?.closest<HTMLElement>('.markdown-editor')
    if (!target || !scroller) return
    scroller.scrollTop += target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 24
    setActiveHeading(id)
  }
  const [headings, setHeadings] = useState<Heading[]>([])
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
        const entries = headingTargets.current
        let low = 0, high = entries.length - 1, active = 0
        while (low <= high) {
          const middle = (low + high) >>> 1
          const node = entries[middle].element
          if (node && node.getBoundingClientRect().top <= top) { active = middle; low = middle + 1 }
          else high = middle - 1
        }
        if (entries[active]) setActiveHeading(entries[active].id)
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
    let started = false
    let releaseCodeLayout = () => {}
    const initial = metadata(current.current)
    let codeLanguage = getLanguage()
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
        previewOnlyByDefault: true, previewLabel: t("图表预览"), previewLoading: t("正在渲染图表…"), copyText: t("复制"), searchPlaceholder: t("搜索语言"), noResultText: t("没有匹配语言"), previewToggleText: (preview) => preview ? t('编辑') : t('收起')
      }, [Crepe.Feature.ImageBlock]: {
        proxyDomURL: (url) => imageSource(url, assetBase.current),
        onUpload: (file) => new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result))
          reader.onerror = () => reject(new Error(t("无法读取图片")))
          reader.readAsDataURL(file)
        })
      } }
    })
    // A synchronous document transaction listener avoids losing the last edit
    // when a file tab closes before a library's debounced change event fires.
    const syncHeadings = (view: ProseMirrorView) => {
      const seen = new Map<string, number>()
      const entries: HeadingTarget[] = []
      view.state.doc.descendants((node, position) => {
        if (node.type.name !== 'heading') return
        const text = node.textContent || ''
        const slug = text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-') || 'section'
        const count = seen.get(slug) || 0
        seen.set(slug, count + 1)
        const element = view.nodeDOM(position)
        entries.push({ text, level: node.attrs.level, id: count ? `${slug}-${count}` : slug, nativeId: node.attrs.id, position, element: element instanceof HTMLElement ? element : null })
      })
      // Milkdown owns heading IDs in its document model. Writing DOM IDs here
      // fights its synchronizer, reparses the document and invalidates anchors.
      headingTargets.current = entries
      setHeadings((previous) => previous.length === entries.length && previous.every((entry, index) => entry.id === entries[index].id && entry.text === entries[index].text && entry.level === entries[index].level) ? previous : entries)
    }
    crepe.editor.use($prose((ctx) => new Plugin({ view: () => ({ update: (view, previous) => {
      if (!view.state.doc.eq(previous.doc)) queueMicrotask(() => { if (!disposed) syncHeadings(view) })
      if (!ready.current || applying.current || !interacted.current || view.state.doc.eq(previous.doc)) return
      const markdown = ctx.get(serializerCtx)(view.state.doc)
      if (markdown === serialized.current) return
      serialized.current = markdown
      change.current(metadata(current.current).prefix + markdown)
    } }) })))
    editor.current = crepe
    const created = window.awb.previewUrl(projectId, path).then((base) => {
      assetBase.current = base
    }).catch(() => {}).then(() => { if (disposed) return; started = true; return crepe.create() }).then(() => {
      if (disposed) return
      // Undo or a source edit may arrive while remote assets/editor setup load.
      const latest = metadata(current.current).body
      if (latest !== initial.body) crepe.editor.action(replaceAll(latest))
      ready.current = true
      releaseCodeLayout = preserveCodeLayout(root)
      crepe.editor.action((ctx) => syncHeadings(ctx.get(editorViewCtx)))
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
      view?.setAttribute('aria-multiline', 'true')
      let codeView: NodeViewConstructor | undefined
      localizeEditor.current = () => {
        view?.setAttribute('aria-label', t('Markdown 内容'))
        if (codeLanguage === getLanguage()) return
        codeLanguage = getLanguage()
        crepe.editor.action((ctx) => {
          ctx.update(codeBlockConfig.key, (config) => ({ ...config, previewLabel: t('图表预览'), previewLoading: t('正在渲染图表…'), copyText: t('复制'), searchPlaceholder: t('搜索语言'), noResultText: t('没有匹配语言') }))
          const editorView = ctx.get(editorViewCtx)
          if (!codeView) editorView.someProp('nodeViews', (views) => { codeView ||= views.code_block; return false })
          const factory = codeView
          // Refresh code block controls against the new configuration while
          // preserving the ProseMirror document, selection and undo state.
          if (factory) editorView.setProps({ nodeViews: { ...editorView.props.nodeViews, code_block: (...args) => factory(...args) } })
        })
      }
      localizeEditor.current()
    }).catch((reason) => { if (!disposed) setError(String(reason)) })
    return () => {
      disposed = true
      releaseCodeLayout()
      void window.awb.cancelDiagrams().catch(() => {})
      ready.current = false
      editor.current = null
      localizeEditor.current = null
      formatRef.current = null
      void created.then(() => { if (started) return crepe.destroy() }).catch(() => {})
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
    {headings.length ? <aside className="markdown-outline" aria-label={t("文档导航")} onKeyDown={(event) => {
      if (event.key === 'Escape' && outlineOpen) { event.preventDefault(); event.stopPropagation(); setOutlineOpen(false); outlineToggle.current?.focus() }
    }}>
      <button ref={outlineToggle} className="markdown-outline-toggle" aria-label={outlineOpen ? t("收起文档目录") : t("展开文档目录")} title={outlineOpen ? t("收起文档目录") : t("文档目录")} aria-expanded={outlineOpen} aria-controls={outlineId} onClick={() => setOutlineOpen((open) => !open)}><Icon name="panel" className="s" />{outlineOpen ? <><span>{t("文档目录")}</span><Icon name="chev" className="s" /></> : null}</button>
      <nav id={outlineId} aria-label={t("文档目录")} hidden={!outlineOpen}>{headings.map((heading) => <button key={heading.id} title={heading.text} aria-current={heading.id === activeHeading ? 'location' : undefined} style={{ paddingLeft: (heading.level - 1) * 10 + 12 }} onClick={() => {
        if (compact) { setOutlineOpen(false); outlineToggle.current?.focus(); requestAnimationFrame(() => scrollTo(heading.id)) }
        else scrollTo(heading.id)
      }}>{heading.text || t("无标题")}</button>)}</nav>
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
      if (href.startsWith('#')) { try { scrollTo(decodeURIComponent(href.slice(1))) } catch { setLinkError(t("无效的文档锚点")) } }
      else void window.awb.documentLink(projectId, path, href).then((target) => { if (target) onNavigate(target.path, target.anchor) }).catch((error) => setLinkError(String(error)))
    }}>
    {parts.prefix ? <details className="markdown-metadata"><summary>{t("文档属性")}</summary>
      <textarea aria-label={t("Markdown 文档属性")} value={parts.prefix} spellCheck={false}
        onChange={(event) => onChange(event.target.value + parts.body)} />
    </details> : null}
    {error ? <p className="file-error" role="alert">{t("编辑器加载失败，请切换到源码编辑。")}{error}</p> : null}
    {linkError ? <p className="file-error" role="alert">{linkError}</p> : null}
    <div ref={host} />
    </div>
  </div>
}
