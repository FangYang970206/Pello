import { t } from '../shared/i18n'
import { useEffect, useRef, useState } from 'react'
import { MergeView } from '@codemirror/merge'
import { EditorView, keymap, lineNumbers, drawSelection } from '@codemirror/view'
import { history, historyKeymap, defaultKeymap, indentWithTab } from '@codemirror/commands'
import { Compartment, Prec } from '@codemirror/state'
import { languages } from '@codemirror/language-data'
import { LanguageDescription, HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'

/** Both documents stay editable; MergeView aligns unchanged lines as chunks change. */
export function SplitDiffEditor({ before, after, path, onBefore, onAfter, onSave, onCompose, onHistory, onBeforeHistory }: {
  before: string; after: string; path: string
  onBefore: (text: string) => void; onAfter: (text: string) => void
  onSave: () => void; onCompose: (value: boolean) => void; onHistory: (redo: boolean) => void
  onBeforeHistory: (redo: boolean) => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const merge = useRef<MergeView | null>(null)
  const replaceDocs = useRef<(before: string, after: string) => void>(() => {})
  const callbacks = useRef({ onBefore, onAfter, onSave, onCompose, onHistory, onBeforeHistory })
  callbacks.current = { onBefore, onAfter, onSave, onCompose, onHistory, onBeforeHistory }
  const [ratio, setRatio] = useState(0.5)
  const texts = useRef({ before, after })
  texts.current = { before, after }
  const sizeHorizontalRanges = useRef<() => void>(() => {})

  useEffect(() => {
    if (!host.current) return
    let stopped = false
    const language = new Compartment()
    const extensions = [lineNumbers(), drawSelection(), history(), language.of([]),
      syntaxHighlighting(HighlightStyle.define([
        { tag: [tags.keyword, tags.bool, tags.null], color: 'var(--magenta)' },
        { tag: [tags.string, tags.regexp], color: 'var(--green)' },
        { tag: [tags.number, tags.atom], color: 'var(--amber)' },
        { tag: [tags.propertyName, tags.typeName, tags.function(tags.variableName)], color: 'var(--blue)' },
        { tag: tags.comment, color: 'var(--faint)' }
      ])), keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
      Prec.highest(EditorView.domEventHandlers({
        compositionstart: () => { callbacks.current.onCompose(true) },
        compositionend: () => { callbacks.current.onCompose(false) },
        keydown: (event, view) => {
          if (event.isComposing || !(event.ctrlKey || event.metaKey) || event.altKey) return false
          const key = event.key.toLowerCase()
          if (key === 's') { event.preventDefault(); callbacks.current.onSave(); return true }
          if (['z', 'y'].includes(key)) {
            event.preventDefault()
            const redo = key === 'y' || event.shiftKey
            if (view === merge.current?.b) callbacks.current.onHistory(redo)
            else callbacks.current.onBeforeHistory(redo)
            return true
          }
          return false
        }
      }))]
    let updating = false
    const changed = (side: 'a' | 'b') => EditorView.updateListener.of((update) => {
      if (!update.docChanged || updating) return
      const value = update.state.doc.toString()
      if (side === 'a') callbacks.current.onBefore(value)
      else callbacks.current.onAfter(value)
    })
    const view = new MergeView({ parent: host.current,
      a: { doc: before, extensions: [...extensions, changed('a'), EditorView.contentAttributes.of({ 'aria-label': t("变更前内容") })] },
      b: { doc: after, extensions: [...extensions, changed('b'), EditorView.contentAttributes.of({ 'aria-label': t("工作区内容") })] },
      revertControls: 'a-to-b',
      renderRevertControl: () => {
        const button = document.createElement('button')
        button.type = 'button'
        button.title = t("还原此处更改")
        button.setAttribute('aria-label', button.title)
        // Match the workbench's 16px stroked icons.
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
        svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '16'); svg.setAttribute('height', '16')
        svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.6')
        const line = document.createElementNS(svg.namespaceURI, 'path')
        line.setAttribute('d', 'm5 5 7 7-7 7m7-14 7 7-7 7')
        svg.append(line); button.append(svg)
        button.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault(); button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
        })
        return button
      }
    })
    merge.current = view
    let sizing = 0
    const resizeRanges = () => {
      cancelAnimationFrame(sizing)
      sizing = requestAnimationFrame(() => {
        const context = document.createElement('canvas').getContext('2d')
        if (!context) return
        const style = getComputedStyle(view.a.contentDOM)
        context.font = `${style.fontSize} ${style.fontFamily}`
        let widest = 0
        for (const line of `${texts.current.before}\n${texts.current.after}`.split('\n')) widest = Math.max(widest, context.measureText(line.replaceAll('\t', '        ')).width + 16)
        const editors = [view.a, view.b]
        // Remove the previous floor before measuring intrinsic lines. Styled text can
        // be wider than canvas estimates; both panes must accommodate that width.
        for (const editor of editors) editor.contentDOM.style.minWidth = '0px'
        const widths = editors.map((editor) => editor.scrollDOM.clientWidth - (editor.dom.querySelector('.cm-gutters')?.getBoundingClientRect().width || 0))
        const overflow = Math.max(0, widest - Math.min(...widths), ...editors.map((editor) => editor.scrollDOM.scrollWidth - editor.scrollDOM.clientWidth))
        for (const [index, editor] of [view.a, view.b].entries()) editor.contentDOM.style.minWidth = overflow ? `${Math.max(0, Math.floor(widths[index] + overflow) - 1)}px` : '0px'
      })
    }
    sizeHorizontalRanges.current = resizeRanges
    const observer = new ResizeObserver(resizeRanges)
    observer.observe(host.current)
    // CodeMirror and font loading can update intrinsic widths after the host
    // layout settles, including when a long virtualized line enters view.
    observer.observe(view.a.contentDOM); observer.observe(view.b.contentDOM)
    void document.fonts.ready.then(() => { if (!stopped) resizeRanges() })
    resizeRanges()
    // Programmatic synchronization is flagged so it cannot echo back into drafts.
    const replace = (side: EditorView, text: string) => {
      if (side.state.doc.toString() === text) return
      updating = true
      try { side.dispatch({ changes: { from: 0, to: side.state.doc.length, insert: text } }) }
      finally { updating = false }
    }
    replaceDocs.current = (a, b) => { replace(view.a, a); replace(view.b, b) }
    let syncing = false
    const sync = (source: EditorView, target: EditorView) => {
      if (syncing) return
      syncing = true
      target.scrollDOM.scrollTop = source.scrollDOM.scrollTop
      target.scrollDOM.scrollLeft = source.scrollDOM.scrollLeft
      view.dom.style.setProperty('--diff-scroll-top', `${source.scrollDOM.scrollTop}px`)
      syncing = false
    }
    const aScroll = () => sync(view.a, view.b), bScroll = () => sync(view.b, view.a)
    view.a.scrollDOM.addEventListener('scroll', aScroll)
    view.b.scrollDOM.addEventListener('scroll', bScroll)
    const support = LanguageDescription.matchFilename(languages, path)
    void support?.load().then((extension) => {
      if (stopped) return
      for (const editor of [view.a, view.b]) editor.dispatch({ effects: language.reconfigure(extension) })
    })
    return () => {
      stopped = true
      observer.disconnect(); cancelAnimationFrame(sizing)
      view.a.scrollDOM.removeEventListener('scroll', aScroll); view.b.scrollDOM.removeEventListener('scroll', bScroll)
      view.destroy(); merge.current = null
    }
    // Document updates are dispatched below without rebuilding editors or selection.
  }, [path])

  useEffect(() => { replaceDocs.current(before, after) }, [before, after])
  useEffect(() => { sizeHorizontalRanges.current() }, [before, after, ratio])

  const resize = (value: number) => setRatio(Math.max(0.2, Math.min(0.8, value)))
  return <div className="diff-split" ref={host} style={{ '--diff-ratio': ratio } as React.CSSProperties}>
    <div className="diff-resize" role="separator" aria-label={t("调整差异分栏")} aria-orientation="vertical" aria-valuemin={20} aria-valuemax={80} aria-valuenow={Math.round(ratio * 100)} tabIndex={0}
      style={{ left: `calc((100% - 32px) * ${ratio} + 13px)` }}
      onKeyDown={(event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return
        event.preventDefault(); resize(event.key === 'Home' ? 0.5 : ratio + (event.key === 'ArrowLeft' ? -0.05 : 0.05))
      }}
      onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault() }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId) || !host.current) return
        const box = host.current.getBoundingClientRect()
        resize((event.clientX - box.left - 16) / (box.width - 32))
      }}
      onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)} />
  </div>
}
