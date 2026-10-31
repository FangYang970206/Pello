export {}

declare global {
  interface Window {
    awb: import('../shared/api').WorkbenchApi
    __awbBuffer?: (id: string) => string
  }
}
