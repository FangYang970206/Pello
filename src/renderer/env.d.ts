export {}

declare global {
  interface Window {
    awb: import('../shared/api').WorkbenchApi
  }
}
