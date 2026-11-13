import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

/** Native, non-passive listeners keep Ctrl+wheel local to the preview. */
export function usePreviewWheel<T extends HTMLElement>(ref: RefObject<T | null>, handle: (event: WheelEvent) => void) {
  const handler = useRef(handle)
  handler.current = handle
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const wheel = (event: WheelEvent) => handler.current(event)
    element.addEventListener('wheel', wheel, { passive: false, capture: true })
    return () => element.removeEventListener('wheel', wheel, { capture: true })
  })
}

export function isZoomWheel(event: WheelEvent): boolean {
  return (event.ctrlKey || event.metaKey) && !event.altKey && event.deltaY !== 0
}

export function useContentZoom() {
  const ref = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState(1)
  const changeZoom = useCallback((delta: number) => setZoom((value) => Math.max(.5, Math.min(3, Math.round((value + (delta < 0 ? .1 : -.1)) * 10) / 10))), [])
  usePreviewWheel(ref, (event) => {
    if (event.target instanceof Element && event.target.closest('.media-preview')) return
    if (!isZoomWheel(event)) return
    event.preventDefault(); event.stopPropagation()
    changeZoom(event.deltaY)
  })
  return { ref, zoom, changeZoom }
}
