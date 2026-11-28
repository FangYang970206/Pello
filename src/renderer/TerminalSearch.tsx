import { useEffect, useRef, useState, type RefObject } from 'react'
import type { Terminal } from '@xterm/xterm'
import { SearchAddon } from '@xterm/addon-search'
import { t } from '../shared/i18n'
import { Icon } from './icons'
import { TerminalHighlights } from './TerminalHighlights'
import { terminalMatches, type TerminalHighlight } from './terminal-matches'
import { HIGHLIGHT_COLORS, TerminalContextMenu, type TerminalMenuState } from './TerminalContextMenu'

export function useTerminalSearch({ root, terminal, id, visible, focused }: {
  root: RefObject<HTMLDivElement | null>; terminal: RefObject<Terminal | null>
  id: string; visible: boolean; focused: boolean
}) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState(''), [sensitive, setSensitive] = useState(false)
  const [highlighted, setHighlighted] = useState<TerminalHighlight[]>([]), [error, setError] = useState('')
  const [context, setContext] = useState<TerminalMenuState | null>(null)
  const [result, setResult] = useState({ resultIndex: -1, resultCount: 0 })
  const input = useRef<HTMLInputElement>(null)
  const finder = useRef<SearchAddon | null>(null)
  const pending = useRef(0)
  // SearchAddon decorations refresh by selecting a match on every PTY write.
  // Use it only for explicit navigation; our independent overlay paints matches.
  const options = { caseSensitive: sensitive }
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
    const search = new SearchAddon()
    term.loadAddon(search)
    finder.current = search
    // xterm's public Shift-selection path also works while a TUI owns the mouse.
    // Forward Alt-clicks unchanged so TUI mouse controls remain accessible.
    const select = (event: MouseEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest('.xterm')) return
      if (event.button === 2) { event.preventDefault(); event.stopImmediatePropagation(); return }
      if (event.button !== 0 || event.shiftKey || event.altKey || term.modes.mouseTrackingMode === 'none') return
      event.preventDefault(); event.stopImmediatePropagation()
      event.target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window,
        clientX: event.clientX, clientY: event.clientY, button: 0, buttons: event.buttons, detail: event.detail,
        shiftKey: true, altKey: false, ctrlKey: event.ctrlKey, metaKey: event.metaKey }))
    }
    host.addEventListener('mousedown', select, true)
    return () => {
      pending.current++
      host.removeEventListener('mousedown', select, true)
      search.dispose()
      finder.current = null
    }
  }, [id, root, terminal])

  useEffect(() => {
    if (open && visible) { finder.current?.findNext(query, { ...options, incremental: true }) }
    else finder.current?.clearDecorations()
  }, [query, sensitive, open, visible])

  useEffect(() => {
    const term = terminal.current
    if (!term || !open || !visible) return
    let frame = 0, matches = terminalMatches(term, query, sensitive)
    const update = () => {
      const selection = term.getSelectionPosition()
      setResult({ resultCount: matches.length, resultIndex: matches.findIndex((match) => match.col === selection?.start.x && match.row === selection.start.y) })
    }
    const scan = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; matches = terminalMatches(term, query, sensitive); update() }) }
    const events = [term.onSelectionChange(update), term.onWriteParsed(scan), term.onResize(scan), term.buffer.onBufferChange(scan)]
    update()
    return () => { cancelAnimationFrame(frame); events.forEach((event) => event.dispose()) }
  }, [query, sensitive, open, visible, terminal])
  useEffect(() => { if (open && visible && focused) { input.current?.focus(); input.current?.select() } }, [open, visible, focused])
  useEffect(() => { pending.current++; setContext(null) }, [visible, focused])
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (!available() || event.isComposing || event.defaultPrevented || !root.current?.contains(event.target as Node)) return
      if ((event.target as Element).closest('.terminal-context-menu')) return
      const modifier = (event.ctrlKey || event.metaKey) && !event.altKey
      if (modifier && event.key.toLowerCase() === 'f' && !event.shiftKey) {
        event.preventDefault(); event.stopPropagation(); show()
      } else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
        event.preventDefault(); event.stopPropagation(); menu()
      } else if (open && (event.key === 'F3' || (event.key === 'Enter' && event.target === input.current))) {
        event.preventDefault(); event.stopPropagation(); move(event.shiftKey)
      } else if (open && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
    }
    window.addEventListener('keydown', keydown, true)
    return () => window.removeEventListener('keydown', keydown, true)
  })
  function menu(x?: number, y?: number) {
    const term = terminal.current
    if (!term || !available()) return
    const box = root.current!.getBoundingClientRect()
    setContext({ x: x ?? box.x + 24, y: y ?? box.y + 24, selection: term.getSelection() })
  }
  const dismissMenu = (restore = true) => { setContext(null); if (restore) terminal.current?.focus() }
  async function action(command: string) {
    const term = terminal.current
    if (!term || !context) return
    const selection = context.selection, operation = ++pending.current
    setContext(null)
    try {
      setError('')
      if (command === 'copy') await navigator.clipboard.writeText(selection)
      if (command === 'paste') {
        const text = await navigator.clipboard.readText()
        if (operation === pending.current && terminal.current === term) term.paste(text)
      }
      if (command === 'select-all') term.selectAll()
      if (command === 'search') { show(selection); return }
      const color = HIGHLIGHT_COLORS.find((item) => command === `highlight-${item.id}`)
      if (color && selection) setHighlighted((previous) => [...previous.filter((item) => item.text !== selection), { text: selection, color: color.id }])
      if (command === 'clear-highlight') setHighlighted([])
      term.focus()
    } catch (reason) { if (operation === pending.current) setError(String(reason)) }
  }
  const count = !query ? '0 / 0' : result.resultCount ? `${Math.max(0, result.resultIndex + 1)} / ${result.resultCount}` : t("无匹配")
  return { menu, panel: <>
    <TerminalHighlights terminal={terminal} query={open ? query : ''} pinned={highlighted} sensitive={sensitive} visible={visible} />
    {context ? <TerminalContextMenu state={context} highlighted={!!highlighted.length} selectedColor={highlighted.find((item) => item.text === context.selection)?.color} onAction={(command) => { void action(command) }} onClose={dismissMenu} /> : null}
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
