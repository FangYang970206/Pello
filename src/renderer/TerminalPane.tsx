import { codeFont } from '../shared/fonts'
import { workbenchTheme } from '../shared/themes'
import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import type { ShellKind, ThemeName } from '../shared/types'
import { bindTerm, unbindTerm } from './terms'


function xtermTheme(theme: ThemeName) {
  const { colors, mode } = workbenchTheme(theme)
  return { background: colors.panel, foreground: colors.text, cursor: colors.text, selectionBackground: `${colors.accent}38`,
    black: mode === 'light' ? colors.text : colors.elev, red: colors.red, green: colors.green, yellow: colors.amber, blue: colors.blue, magenta: colors.magenta, cyan: colors.cyan, white: colors.text,
    brightBlack: colors.faint, brightRed: colors.red, brightGreen: colors.green, brightYellow: colors.amber, brightBlue: colors.blue, brightMagenta: colors.magenta, brightCyan: colors.cyan, brightWhite: colors.text }
}

export function TerminalPane({
  id,
  fontSize,
  fontFamily,
  theme,
  visible,
  onInterrupt,
  onAppKey
}: {
  id: string
  fontSize: number
  fontFamily?: string
  theme: ThemeName
  shell: ShellKind
  visible: boolean
  onInterrupt: (id: string) => void
  onAppKey: (key: string) => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const scheduleFit = useRef<() => void>(() => {})
  const interruptRef = useRef(onInterrupt)
  const keyRef = useRef(onAppKey)
  interruptRef.current = onInterrupt
  keyRef.current = onAppKey

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const term = new Terminal({
      fontFamily: codeFont(fontFamily),
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
    term.onBinary((data) => window.awb.ptyWrite(id, data, true))
    term.onResize(({ cols, rows }) => window.awb.ptyResize(id, cols, rows))
    termRef.current = term
    bindTerm(id, term)
    let frame = 0
    const redraw = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (!host.clientWidth || !host.clientHeight || termRef.current !== term) return
        fit.fit()
        if (term.rows > 0) term.refresh(0, term.rows - 1)
      })
    }
    scheduleFit.current = redraw
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
      cancelAnimationFrame(frame)
      scheduleFit.current = () => {}
      unbindTerm(id, term)
      term.dispose()
      termRef.current = null
    }
    // The terminal instance is created once per tab id.
  }, [id])

  useEffect(() => {
    const term = termRef.current
    const host = hostRef.current
    if (!term) return
    const next = xtermTheme(theme)
    if (next.foreground.toLowerCase() === next.background.toLowerCase()) {
      next.foreground = workbenchTheme(theme).colors.text
    }
    term.options.fontSize = fontSize
    term.options.theme = next
    let stopped = false
    const applyFont = () => {
      if (stopped || termRef.current !== term) return
      term.options.fontFamily = codeFont(fontFamily)
      if (term.rows > 0) term.refresh(0, term.rows - 1)
      if (!visible || !host || host.offsetWidth < 2) return
      scheduleFit.current()
      term.focus()
    }
    const font = `${fontSize}px "${fontFamily || 'Cascadia Mono'}"`
    if (document.fonts.check(font)) applyFont()
    else void document.fonts.load(font).then(applyFont, applyFont)
    return () => { stopped = true }
  }, [fontSize, fontFamily, theme, visible, id])

  return <div className="termhost" data-term={id}><div className="termframe" ref={hostRef} /></div>
}
