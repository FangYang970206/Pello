import { useLayoutEffect, useRef, type RefObject } from 'react'
import { EditorView, Decoration, drawSelection, keymap, lineNumbers } from '@codemirror/view'
import { codeFolding, foldGutter, foldKeymap, foldedRanges, unfoldEffect, HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { indentWithTab, defaultKeymap } from '@codemirror/commands'
import { json } from '@codemirror/lang-json'
import { yaml } from '@codemirror/lang-yaml'
import { Annotation, Compartment } from '@codemirror/state'
import { tags } from '@lezer/highlight'
import { t } from '../shared/i18n'
import { CHEVRON_PATH } from './icons'
import type { SearchAdapter } from './search-types'

const highlight = syntaxHighlighting(HighlightStyle.define([
  { tag: [tags.keyword, tags.bool, tags.null], color: 'var(--magenta)' },
  { tag: tags.string, color: 'var(--green)' },
  { tag: tags.number, color: 'var(--amber)' },
  { tag: tags.propertyName, color: 'var(--blue)' },
  { tag: tags.comment, color: 'var(--faint)' }
]))

export function StructuredSource({ language, value, onEdit, searchRef, visible }: {
  language: 'json' | 'yaml'
  value: string
  onEdit: (value: string) => void
  searchRef: RefObject<SearchAdapter | null>
  visible: boolean
}) {
  const field = useRef<HTMLDivElement>(null)
  const instance = useRef<EditorView>(null)
  const latest = useRef({ value, onEdit })
  latest.current = { value, onEdit }
  const label = t("文件内容")
  const fold = t("折叠区块")
  const expand = t("展开区块")
  const localization = useRef({ label, fold, expand })
  localization.current = { label, fold, expand }
  const controls = useRef(new Compartment())

  useLayoutEffect(() => {
    if (!field.current) return
    const marks = new Compartment()
    const { label, fold, expand } = localization.current
    const view = new EditorView({
      parent: field.current,
      doc: latest.current.value,
      extensions: [
        language === 'json' ? json() : yaml(),
        lineNumbers(), controls.current.of(foldingControls(label, fold, expand)),
        drawSelection(), highlight, marks.of([]),
        keymap.of([...foldKeymap, indentWithTab, ...defaultKeymap]),
        codeFolding({
          preparePlaceholder: (state, range) => {
            const first = state.doc.lineAt(range.from)
            const start = state.doc.sliceString(range.from, Math.min(first.to, range.to)).trim() ? range.from : first.to + 1
            if (start >= range.to) return ''
            const line = state.doc.lineAt(start)
            const preview = state.doc.sliceString(start, Math.min(line.to, range.to)).trim()
            return Array.from(preview.slice(0, 97)).slice(0, 48).join('')
          },
          placeholderDOM: (_view, unfold, preview: string) => {
            const button = document.createElement('button')
            button.type = 'button'
            button.className = 'structured-fold-preview'
            const text = document.createElement('span')
            text.className = 'structured-fold-preview-text'
            text.textContent = preview ? `${preview} …` : '…'
            button.append(text)
            const title = localization.current.expand
            button.title = title
            button.setAttribute('aria-label', title)
            button.addEventListener('click', unfold)
            return button
          }
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !update.transactions.some((transaction) => transaction.annotation(externalChange))) latest.current.onEdit(update.state.doc.toString())
        })
      ]
    })
    instance.current = view
    searchRef.current = {
      focus: () => view.focus(),
      reveal: (current, matches, index) => {
        const length = view.state.doc.length
        const ranges = matches.slice(0, 2000).filter((match) => match.to <= length).map((match, i) =>
          Decoration.mark({ class: i === index ? 'search-hit search-active' : 'search-hit' }).range(match.from, match.to))
        if (current && index >= 2000 && current.to <= length) ranges.push(Decoration.mark({ class: 'search-hit search-active' }).range(current.from, current.to))
        view.dispatch({ effects: marks.reconfigure(EditorView.decorations.of(Decoration.set(ranges, true))) })
        if (!current || current.to > length) return
        const effects = [EditorView.scrollIntoView(current.from, { y: 'center', x: 'nearest' })]
        foldedRanges(view.state).between(current.from, current.to, (from, to) => {
          if (from < current.to && to > current.from) effects.push(unfoldEffect.of({ from, to }))
        })
        view.dispatch({ selection: { anchor: current.from, head: current.to }, effects })
      }
    }
    return () => { searchRef.current = null; instance.current = null; view.destroy() }
  }, [language, searchRef])

  useLayoutEffect(() => {
    const view = instance.current
    if (!view) return
    const before = view.state.doc.toString()
    if (before === value) return
    let from = 0, oldEnd = before.length, newEnd = value.length
    while (from < oldEnd && from < newEnd && before[from] === value[from]) from++
    while (oldEnd > from && newEnd > from && before[oldEnd - 1] === value[newEnd - 1]) { oldEnd--; newEnd-- }
    view.dispatch({ changes: { from, to: oldEnd, insert: value.slice(from, newEnd) }, annotations: externalChange.of(true) })
  }, [value, language])

  useLayoutEffect(() => {
    instance.current?.dispatch({ effects: controls.current.reconfigure(foldingControls(label, fold, expand)) })
  }, [label, fold, expand])
  useLayoutEffect(() => { if (visible) instance.current?.requestMeasure() }, [visible])

  return <div className="file-editor structured-source" ref={field} />
}

const externalChange = Annotation.define<boolean>()

function foldingControls(label: string, fold: string, expand: string) {
  return [
    EditorView.contentAttributes.of({ 'aria-label': label }),
    foldGutter({
      markerDOM: (open) => {
        const marker = document.createElement('span')
        marker.className = 'structured-fold-toggle'
        marker.dataset.expanded = String(open)
        marker.title = open ? fold : expand
        const ns = 'http://www.w3.org/2000/svg'
        const icon = document.createElementNS(ns, 'svg')
        icon.setAttribute('viewBox', '0 0 24 24')
        icon.setAttribute('class', 'i s')
        icon.setAttribute('aria-hidden', 'true')
        const path = document.createElementNS(ns, 'path')
        path.setAttribute('d', CHEVRON_PATH)
        icon.append(path)
        marker.append(icon)
        return marker
      }
    })
  ]
}
