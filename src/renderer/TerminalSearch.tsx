import { useEffect, useRef, useState, type RefObject } from 'react'
import type { Terminal } from '@xterm/xterm'
import { SearchAddon } from '@xterm/addon-search'
import { t } from '../shared/i18n'
import { workbenchTheme } from '../shared/themes'
import type { ThemeName } from '../shared/types'
import { Icon } from './icons'
import { TerminalHighlights } from './TerminalHighlights'

export function useTerminalSearch({ root, terminal, id, visible, focused, theme }: {
  root: RefObject<HTMLDivElement | null>; terminal: RefObject<Terminal | null>
  id: string; visible: boolean; focused: boolean; theme: ThemeName
}) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState(''), [sensitive, setSensitive] = useState(false)
  const [highlighted, setHighlighted] = useState(''), [error, setError] = useState('')
  const [result, setResult] = useState({ resultIndex: -1, resultCount: 0 })
  const input = useRef<HTMLInputElement>(null)
  const finder = useRef<SearchAddon | null>(null), highlighter = useRef<SearchAddon | null>(null)
  const pending = useRef(0)
  const colors = workbenchTheme(theme).colors
  const decorations = { matchBackground: colors.elev, matchBorder: colors.amber, matchOverviewRuler: colors.amber,
    activeMatchBackground: colors.elev, activeMatchBorder: colors.accent, activeMatchColorOverviewRuler: colors.accent }
  const options = { caseSensitive: sensitive, decorations }
  const available = () => visible && focused && !root.current?.closest('[inert]') && !document.querySelector('dialog[open],[role=dialog][aria-modal=true]')
  const show = (selection = terminal.current?.getSelection() || '') => {
    if (selection && !/[\r\n]/.test(selection)) setQuery(selection)
    setOpen(true)
    input.current?.focus(); input.current?.select()
  }
  const close = () => { setOpen(false); finder.current?.clearDecorations(); terminal.current?.focus() }
  const move = (previous = false) => {
    if (!query) return
    if (previous) finder.current?.findPrevious(query, options)
    else finder.current?.findNext(query, options)
  }

  useEffect(() => {
    const term = terminal.current, host = root.current
    if (!term || !host) return
    const search = new SearchAddon(), highlight = new SearchAddon()
    term.loadAddon(search); term.loadAddon(highlight)
    finder.current = search; highlighter.current = highlight
    const results = search.onDidChangeResults(setResult)
    // xterm's public Shift-selection path also works while a TUI owns the mouse.
    // Forward Alt-clicks unchanged so TUI mouse controls remain accessible.
    const select = (event: MouseEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest('.xterm')) return
      if (event.button === 2) { event.preventDefault(); event.stopImmediatePropagation(); return }
      if (event.button !== 0 || event.shiftKey || event.altKey || term.modes.mouseTrackingMode === 'none') return
      event.preventDefault(); event.stopImmediatePropagation()
      event.target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window,
        clientX: event.clientX, clientY: event.clientY, button: 0, buttons: event.buttons, detail: event.detail,
        shiftKey: true, altKey: true, ctrlKey: event.ctrlKey, metaKey: event.metaKey }))
    }
    host.addEventListener('mousedown', select, true)
    return () => {
      pending.current++
      host.removeEventListener('mousedown', select, true)
      results.dispose(); search.dispose(); highlight.dispose()
      finder.current = null; highlighter.current = null
    }
  }, [id, root, terminal])

  useEffect(() => {
    if (open && visible) { finder.current?.findNext(query, { ...options, incremental: true }) }
    else finder.current?.clearDecorations()
  // Decorations must be repainted when the theme changes, without recreating xterm.
  }, [query, sensitive, open, visible, theme])

  useEffect(() => {
    const term = terminal.current
    if (!term) return
    if (!highlighted) { highlighter.current?.clearDecorations(); return }
    const viewport = term.buffer.active.viewportY
    const selection = term.getSelectionPosition()
    highlighter.current?.findNext(highlighted, { decorations })
    highlighter.current?.clearActiveDecoration()
    term.clearSelection()
    if (selection) term.select(selection.start.x, selection.start.y, (selection.end.y - selection.start.y) * term.cols + selection.end.x - selection.start.x)
    term.scrollToLine(viewport)
  }, [highlighted, theme])
  useEffect(() => { if (open && visible && focused) { input.current?.focus(); input.current?.select() } }, [open, visible, focused])
  useEffect(() => { pending.current++ }, [visible, focused])
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (!available() || event.isComposing || event.defaultPrevented || !root.current?.contains(event.target as Node)) return
      const modifier = (event.ctrlKey || event.metaKey) && !event.altKey
      if (modifier && event.key.toLowerCase() === 'f' && !event.shiftKey) {
        event.preventDefault(); event.stopPropagation(); show()
      } else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
        event.preventDefault(); event.stopPropagation(); void menu()
      } else if (open && (event.key === 'F3' || (event.key === 'Enter' && event.target === input.current))) {
        event.preventDefault(); event.stopPropagation(); move(event.shiftKey)
      } else if (open && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
    }
    window.addEventListener('keydown', keydown, true)
    return () => window.removeEventListener('keydown', keydown, true)
  })
  async function menu() {
    const term = terminal.current
    if (!term || !available()) return
    const selection = term.getSelection(), operation = ++pending.current
    try {
      const command = await window.awb.terminalMenu({ selection: !!selection, highlighted: !!highlighted })
      if (operation !== pending.current || terminal.current !== term) return
      setError('')
      if (command === 'copy') await navigator.clipboard.writeText(selection)
      if (command === 'paste') {
        const text = await navigator.clipboard.readText()
        if (operation === pending.current && terminal.current === term) term.paste(text)
      }
      if (command === 'select-all') term.selectAll()
      if (command === 'search') { show(selection); return }
      if (command === 'highlight') setHighlighted(selection)
      if (command === 'clear-highlight') setHighlighted('')
      term.focus()
    } catch (reason) { if (operation === pending.current) setError(String(reason)) }
  }
  const count = !query ? '0 / 0' : result.resultCount ? result.resultIndex < 0 ? t("匹配过多，请缩小范围") : `${result.resultIndex + 1} / ${result.resultCount}${result.resultCount >= 1000 ? '+' : ''}` : t("无匹配")
  return { menu, panel: <>
    <TerminalHighlights terminal={terminal} query={open ? query : ''} pinned={highlighted} sensitive={sensitive} visible={visible} />
    {open ? <div className="document-search terminal-search" role="search" aria-label={t("终端搜索")} onContextMenu={(event) => event.stopPropagation()}>
      <div className="document-search-row">
        <div className="search-input"><input ref={input} className="tx search-query" aria-label={t("查找内容")} placeholder={t("查找内容")} value={query} onChange={(event) => setQuery(event.target.value)} />
          <button className={`ib search-case${sensitive ? ' on' : ''}`} aria-label={t("区分大小写")} title={t("区分大小写")} aria-pressed={sensitive} onClick={() => setSensitive(!sensitive)}>Aa</button></div>
        <span className="search-count" role="status" title={count}>{count}</span>
        <button className="ib" aria-label={t("上一个匹配")} title={t("上一个匹配")} disabled={!result.resultCount} onClick={() => move(true)}><Icon name="up" /></button>
        <button className="ib search-next" aria-label={t("下一个匹配")} title={t("下一个匹配")} disabled={!result.resultCount} onClick={() => move()}><Icon name="up" /></button>
        <button className="ib" aria-label={t("关闭搜索")} title={t("关闭搜索")} onClick={close}><Icon name="x" /></button>
      </div>
    </div> : null}
    {error ? <div className="file-error terminal-error" role="alert">{error}<button className="ib" aria-label={t("关闭错误")} onClick={() => setError('')}><Icon name="x" /></button></div> : null}
  </> }
}
