import { useEffect, useRef, useState } from 'react'
import { t } from '../shared/i18n'
import { mediaKind } from '../shared/media'
import { Icon } from './icons'
import { isZoomWheel, usePreviewWheel } from './usePreviewWheel'

export default function MediaPreview({ projectId, path, version }: { projectId: string; path: string; version: string | null }) {
  const [source, setSource] = useState<{ url?: string; error?: string }>({})
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let stopped = false
    void window.awb.previewUrl(projectId, path).then((url) => { if (!stopped) setSource({ url }) })
      .catch((error) => { if (!stopped) setSource({ error: String(error) }) })
    return () => { stopped = true }
  }, [projectId, path, version, attempt])
  const retry = () => { setSource({}); setAttempt((value) => value + 1) }
  return <section className="media-preview" aria-label={mediaKind(path) === 'pdf' ? t("PDF 预览") : t("图片预览")}>
    {source.error ? <PreviewError error={source.error} retry={retry} /> : source.url ? mediaKind(path) === 'pdf' ?
      <PdfPreview key={`${source.url}:${version}:${attempt}`} url={source.url} retry={retry} /> : <ImagePreview key={`${source.url}:${version}:${attempt}`} url={source.url} path={path} retry={retry} /> : <p className="rmeta" role="status">{t("正在加载预览…")}</p>}
  </section>
}

function PreviewError({ error, retry }: { error: string; retry: () => void }) {
  return <div className="media-error" role="alert"><p>{t("无法预览此文件")}</p><p className="rmeta">{error}</p><button className="btn" onClick={retry}>{t("重试")}</button></div>
}

function ZoomControls({ zoom, scale, setZoom }: { zoom: number | null; scale: number; setZoom: (value: number | null) => void }) {
  return <div className="media-zoom">
    <button className="ib" title={t("缩小")} aria-label={t("缩小")} disabled={zoom !== null && zoom <= .25} onClick={() => setZoom(Math.max(.25, scale - .25))}><Icon name="minus" /></button>
    <span className="media-scale">{Math.round(scale * 100)}%</span>
    <button className="ib" title={t("放大")} aria-label={t("放大")} disabled={zoom !== null && zoom >= 4} onClick={() => setZoom(Math.min(4, scale + .25))}><Icon name="plus" /></button>
    <button className="btn sm ghost" onClick={() => setZoom(null)}>{t("适应窗口")}</button>
    <button className="btn sm ghost" onClick={() => setZoom(1)}>{t("实际大小")}</button>
  </div>
}

function ImagePreview({ url, path, retry }: { url: string; path: string; retry: () => void }) {
  const [zoom, setZoom] = useState<number | null>(null)
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  const [error, setError] = useState(false)
  const viewport = useRef<HTMLDivElement>(null)
  const [bounds, setBounds] = useState({ width: 0, height: 0 })
  useEffect(() => {
    if (!viewport.current) return
    const observer = new ResizeObserver(([entry]) => setBounds({ width: entry.contentRect.width, height: entry.contentRect.height }))
    observer.observe(viewport.current)
    return () => observer.disconnect()
  }, [])
  const scale = zoom ?? (size ? Math.min(1, bounds.width / size.width, bounds.height / size.height) : 1)
  usePreviewWheel(viewport, (event) => {
    if (!isZoomWheel(event) || !size) return
    event.preventDefault(); event.stopPropagation()
    setZoom((value) => Math.max(.25, Math.min(4, (value ?? scale) + (event.deltaY < 0 ? .1 : -.1))))
  })
  return error ? <PreviewError error={t("图片格式不受支持或文件已损坏")} retry={retry} /> : <>
    <div className="media-toolbar" role="toolbar" aria-label={t("图片预览")}><ZoomControls zoom={zoom} scale={scale} setZoom={setZoom} />
      <span className="grow" /><span className="rmeta">{size ? `${size.width} × ${size.height}` : t("正在加载预览…")}</span>
    </div>
    <div ref={viewport} className={`media-viewport image-viewport${zoom === null ? ' fit' : ''}`} tabIndex={0} aria-label={t("图片预览")}>
      <img src={url} alt={path.split(/[\\/]/).pop() || path} draggable={false}
        style={zoom !== null && size ? { width: size.width * zoom, height: size.height * zoom } : undefined}
        onLoad={(event) => setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} onError={() => setError(true)} />
    </div>
  </>
}

function PdfPreview({ url, retry }: { url: string; retry: () => void }) {
  const [pdf, setPdf] = useState<import('pdfjs-dist').PDFDocumentProxy | null>(null)
  const [error, setError] = useState('')
  const [page, setPage] = useState(1), [input, setInput] = useState('1')
  const [zoom, setZoom] = useState<number | null>(null)
  const [scale, setScale] = useState(1)
  const [bounds, setBounds] = useState({ width: 0, height: 0 })
  const [rendered, setRendered] = useState(false)
  const canvas = useRef<HTMLCanvasElement>(null), viewport = useRef<HTMLDivElement>(null)
  const gesture = useRef({ delta: 0, time: 0, flipped: 0, direction: 0 })
  const pageEntry = useRef<'top' | 'bottom' | null>(null)
  useEffect(() => {
    let stopped = false, task: import('pdfjs-dist').PDFDocumentLoadingTask | undefined
    void (async () => {
      const { getDocument, GlobalWorkerOptions } = await import('pdfjs-dist/legacy/build/pdf.mjs')
      const { default: worker } = await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')
      if (stopped) return
      GlobalWorkerOptions.workerSrc = worker
      // The project asset server checks the real project boundary. PDF scripts,
      // attachments and external links never execute inside the workbench.
      const assets = new URL('./pdfjs/', window.location.href).href
      task = getDocument({ url, useSystemFonts: true, cMapUrl: assets + 'cmaps/', cMapPacked: true,
        standardFontDataUrl: assets + 'standard_fonts/', wasmUrl: assets + 'wasm/', iccUrl: assets + 'iccs/' })
      const doc = await task.promise
      if (!stopped) setPdf(doc)
    })().catch((reason) => { if (!stopped) setError(String(reason)) })
    return () => { stopped = true; void task?.destroy().catch(() => {}) }
  }, [url])
  useEffect(() => {
    if (!viewport.current) return
    const observer = new ResizeObserver(([entry]) => setBounds({ width: entry.contentRect.width, height: entry.contentRect.height }))
    observer.observe(viewport.current)
    return () => observer.disconnect()
  }, [pdf])
  useEffect(() => {
    if (!pdf || !canvas.current || !bounds.width || !bounds.height) return
    let stopped = false, task: import('pdfjs-dist').RenderTask | undefined
    setRendered(false)
    void (async () => {
      const current = await pdf.getPage(page)
      if (stopped) return
      const base = current.getViewport({ scale: 1 })
      const scale = zoom ?? Math.max(.1, Math.min(bounds.width / base.width, bounds.height / base.height))
      setScale(scale)
      const view = current.getViewport({ scale })
      // Bound backing-store memory even for large pages and high DPI displays.
      const ratio = Math.min(devicePixelRatio || 1, 2, 8192 / Math.max(view.width, view.height), Math.sqrt(16_000_000 / (view.width * view.height)))
      const target = canvas.current!
      target.width = Math.ceil(view.width * ratio); target.height = Math.ceil(view.height * ratio)
      target.style.width = `${view.width}px`; target.style.height = `${view.height}px`
      task = current.render({ canvas: target, viewport: view, transform: [ratio, 0, 0, ratio, 0, 0] })
      await task.promise
      if (!stopped) setRendered(true)
    })().catch((reason) => { if (!stopped) setError(String(reason)) })
    return () => { stopped = true; task?.cancel() }
  }, [pdf, page, zoom, bounds])
  const go = (value: number, fromBottom = false) => {
    const next = Math.max(1, Math.min(pdf?.numPages || 1, Number.isFinite(value) ? Math.trunc(value) : page))
    if (next !== page) {
      setRendered(false)
      if (viewport.current) viewport.current.scrollTop = fromBottom ? viewport.current.scrollHeight : 0
      pageEntry.current = fromBottom ? 'bottom' : 'top'
    }
    setPage(next); setInput(String(next))
  }
  useEffect(() => {
    if (!rendered || !viewport.current || !pageEntry.current) return
    viewport.current.scrollTop = pageEntry.current === 'bottom' ? viewport.current.scrollHeight : 0
    pageEntry.current = null
  }, [rendered])
  usePreviewWheel(viewport, (event) => {
    if (isZoomWheel(event)) {
      event.preventDefault(); event.stopPropagation()
      setZoom((value) => Math.max(.25, Math.min(4, (value ?? scale) + (event.deltaY < 0 ? .1 : -.1))))
      gesture.current.delta = 0
      return
    }
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || !event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return
    const target = event.currentTarget as HTMLDivElement
    const direction = Math.sign(event.deltaY)
    const atEdge = direction > 0 ? target.scrollTop + target.clientHeight >= target.scrollHeight - 1 : target.scrollTop <= 1
    if (!atEdge) { gesture.current.delta = 0; return }
    event.preventDefault(); event.stopPropagation()
    if (!pdf || !rendered) return
    const now = performance.now(), state = gesture.current
    if (now - state.time > 180 || direction !== state.direction) state.delta = 0
    state.delta += event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? target.clientHeight : 1)
    const reversed = direction !== state.direction
    state.time = now; state.direction = direction
    if (Math.abs(state.delta) < 60 || (!reversed && now - state.flipped < 180)) return
    state.delta = 0; state.flipped = now
    go(page + direction, direction < 0)
  })
  return error ? <PreviewError error={error} retry={retry} /> : <>
    <div className="media-toolbar" role="toolbar" aria-label={t("PDF 预览")}>
      <div className="media-paging">
      <button className="ib" title={t("上一页")} aria-label={t("上一页")} disabled={page <= 1} onClick={() => go(page - 1)}><Icon name="back" /></button>
      <input className="tx media-page-input" aria-label={t("PDF 页码")} type="number" min={1} max={pdf?.numPages || 1} value={input} disabled={!pdf}
        onChange={(event) => setInput(event.target.value)} onBlur={() => go(Number(input))} onKeyDown={(event) => { if (event.key === 'Enter') go(Number(input)) }} />
      <span className="media-page-count">/ {pdf?.numPages || '–'}</span>
      <button className="ib" title={t("下一页")} aria-label={t("下一页")} disabled={!pdf || page >= pdf.numPages} onClick={() => go(page + 1)}><Icon name="chev" /></button>
      </div>
      <span className="media-toolbar-divider" /><ZoomControls zoom={zoom} scale={scale} setZoom={setZoom} />
    </div>
    <div className="media-viewport" ref={viewport} tabIndex={0} aria-label={t("PDF 页面")} onKeyDown={(event) => {
      if (event.key === 'PageDown' || event.key === 'PageUp') { event.preventDefault(); go(page + (event.key === 'PageDown' ? 1 : -1)) }
    }}>
      {!rendered ? <p className="media-loading" role="status">{t("正在加载预览…")}</p> : null}
      <canvas ref={canvas} className="pdf-page" data-page={page} data-rendered={rendered} style={{ visibility: rendered ? 'visible' : 'hidden' }} role="img" aria-label={t("第 {{0}} 页，共 {{1}} 页", page, pdf?.numPages || 0)} />
    </div>
  </>
}
