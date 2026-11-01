import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import type { ShellKind, ThemeName } from '../shared/types'
import { bindTerm, unbindTerm } from './terms'

const FONT = '"Cascadia Mono", "Cascadia Code", "JetBrains Mono", Consolas, "Microsoft YaHei UI", "Microsoft YaHei", "Noto Sans Mono CJK SC", monospace'

function xtermTheme(theme: ThemeName) {
  if (theme === 'light') {
    return {
      background: '#f8f8fa',
      foreground: '#1a1b1e',
      cursor: '#1a1b1e',
      selectionBackground: 'rgba(83,85,209,.22)',
      black: '#1a1b1e',
      red: '#c93c3c',
      green: '#1f8a4c',
      yellow: '#9a6a00',
      blue: '#2c64c4',
      magenta: '#8a45b8',
      cyan: '#137d84',
      white: '#5c6370',
      brightBlack: '#666b75',
      brightRed: '#c93c3c',
      brightGreen: '#1f8a4c',
      brightYellow: '#9a6a00',
      brightBlue: '#2c64c4',
      brightMagenta: '#8a45b8',
      brightCyan: '#137d84',
      brightWhite: '#1a1b1e'
    }
  }
  return {
    background: '#16171a',
    foreground: '#e8e9ec',
    cursor: '#e8e9ec',
    selectionBackground: 'rgba(142,150,255,.28)',
    black: '#1c1d21',
    red: '#f07a7a',
    green: '#6fcf97',
    yellow: '#e3b660',
    blue: '#7fb2ff',
    magenta: '#c99cf0',
    cyan: '#6fd0d6',
    white: '#e8e9ec',
    brightBlack: '#80858f',
    brightRed: '#f07a7a',
    brightGreen: '#6fcf97',
    brightYellow: '#e3b660',
    brightBlue: '#7fb2ff',
    brightMagenta: '#c99cf0',
    brightCyan: '#6fd0d6',
    brightWhite: '#e8e9ec'
  }
}

export function TerminalPane({
  id,
  fontSize,
  theme,
  visible,
  onInterrupt,
  onAppKey
}: {
  id: string
  fontSize: number
  theme: ThemeName
  shell: ShellKind
  visible: boolean
  onInterrupt: (id: string) => void
  onAppKey: (key: string) => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const interruptRef = useRef(onInterrupt)
  const keyRef = useRef(onAppKey)
  interruptRef.current = onInterrupt
  keyRef.current = onAppKey

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const term = new Terminal({
      fontFamily: FONT,
      fontSize,
      lineHeight: 1,
      customGlyphs: true,
      rescaleOverlappingGlyphs: true,
      cursorBlink: true,
      scrollback: 5000,
      theme: xtermTheme(theme),
      allowProposedApi: false
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    // Draw box/block glyphs against cell edges, including at fractional DPI.
    // DOM text layout leaves font-ascent gaps between adjacent terminal rows.
    let webgl: WebglAddon | null = null
    try {
      webgl = new WebglAddon()
      webgl.onContextLoss(() => {
        webgl?.dispose()
        webgl = null
      })
      term.loadAddon(webgl)
      host.dataset.renderer = 'webgl'
    } catch {
      webgl?.dispose()
      webgl = null
      host.dataset.renderer = 'dom'
    }
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown' || !ev.ctrlKey || ev.altKey || ev.metaKey) return true
      const key = ev.key.toLowerCase()
      if (key === 'c' && !ev.shiftKey) {
        if (term.hasSelection()) {
          void navigator.clipboard.writeText(term.getSelection()).catch(() => undefined)
          return false
        }
        interruptRef.current(id)
        return false
      }
      if ((key === 'v' && !ev.shiftKey) || (key === 'v' && ev.shiftKey)) {
        void navigator.clipboard
          .readText()
          .then((text) => {
            if (text) window.awb.ptyWrite(id, text)
          })
          .catch(() => undefined)
        return false
      }
      if (key === 'n' || key === 't' || key === 'b' || key === 'w' || key === ',') {
        keyRef.current(key)
        return false
      }
      return true
    })
    term.onData((data) => window.awb.ptyWrite(id, data))
    termRef.current = term
    fitRef.current = fit
    bindTerm(id, term)
    const redraw = () => {
      if (!host.offsetWidth) return
      fit.fit()
      if (term.rows > 0) term.refresh(0, term.rows - 1)
      window.awb.ptyResize(id, term.cols, term.rows)
    }
    const ro = new ResizeObserver(() => redraw())
    void document.fonts.ready.then(() => {
      if (termRef.current === term) redraw()
    })
    ro.observe(host)
    const io = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) redraw()
    })
    io.observe(host)
    return () => {
      ro.disconnect()
      io.disconnect()
      unbindTerm(id, term)
      term.dispose()
      termRef.current = null
    }
    // The terminal instance is created once per tab id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  useEffect(() => {
    const term = termRef.current
    const host = hostRef.current
    if (!term) return
    const next = xtermTheme(theme)
    if (next.foreground.toLowerCase() === next.background.toLowerCase()) {
      next.foreground = theme === 'light' ? '#1a1b1e' : '#e8e9ec'
    }
    term.options.fontSize = fontSize
    term.options.theme = next
    const redraw = () => {
      if (term.rows > 0) term.refresh(0, term.rows - 1)
    }
    redraw()
    if (!visible || !host || host.offsetWidth < 2) return
    const frame = requestAnimationFrame(() => {
      if (!host.offsetWidth) return
      try {
        fitRef.current?.fit()
      } catch {
        /* host has no layout yet */
      }
      redraw()
      window.awb.ptyResize(id, term.cols, term.rows)
    })
    return () => cancelAnimationFrame(frame)
  }, [fontSize, theme, visible, id])

  return <div className="termhost" ref={hostRef} data-term={id} />
}
