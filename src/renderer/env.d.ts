export {}

declare global {
  interface Window {
    awb: import('../shared/api').WorkbenchApi
    __awbBuffer?: (id: string) => string
    __awbGeometry?: (id: string) => { cols: number; rows: number; viewportY: number; baseY: number; cursorY: number; visibleText: string; buffer: string; mouse: string } | null
  }
}
