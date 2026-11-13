/** Formats decoded by Chromium or the bundled PDF renderer, never as editable text. */
export function mediaKind(path: string): 'pdf' | 'image' | null {
  if (/\.pdf$/i.test(path)) return 'pdf'
  return /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif)$/i.test(path) ? 'image' : null
}
