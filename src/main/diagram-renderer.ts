import { t } from '../shared/i18n'
import { BrowserWindow } from 'electron'
import { createHash } from 'node:crypto'
import path from 'node:path'

let renderer: BrowserWindow | null = null
let ready: Promise<BrowserWindow> | null = null
let queue: Promise<unknown> = Promise.resolve()
const pending = new Map<string, Promise<string>>()
const cache = new Map<string, string>()
let cacheSize = 0
let generation = 0

export class DiagramCancelled extends Error {}

export function disposeDiagramRenderer(): void {
  cancelDiagramRenderer()
  cache.clear()
  cacheSize = 0
}

export function cancelDiagramRenderer(): void {
  generation++
  pending.clear()
  resetRenderer()
}

function resetRenderer(): void {
  const window = renderer
  renderer = null
  ready = null
  if (window && !window.isDestroyed()) window.destroy()
}

function windowForRendering(): Promise<BrowserWindow> {
  if (ready) return ready
  const window = new BrowserWindow({ show: false, width: 1440, height: 900, title: 'Pello diagram renderer', skipTaskbar: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, partition: 'pello-diagrams' } })
  renderer = window
  const development = process.env.ELECTRON_RENDERER_URL
  const origin = development ? new URL(development).origin : null
  window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => callback({ cancel: !origin || new URL(details.url).origin !== origin }))
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.once('render-process-gone', () => { if (renderer === window) resetRenderer() })
  window.once('closed', () => { if (renderer === window) { renderer = null; ready = null } })
  const loading = development ? window.loadURL(new URL('diagram-renderer.html', development.endsWith('/') ? development : `${development}/`).href) : window.loadFile(path.join(__dirname, '../renderer/diagram-renderer.html'))
  ready = loading.then(() => window).catch((error) => { if (renderer === window) resetRenderer(); throw error })
  return ready
}

/** Diagram layout runs in its own sandboxed renderer, without the workbench preload. */
export function renderMermaid(owner: BrowserWindow, source: string): Promise<string> {
  if (typeof source !== 'string' || !source.trim() || source.length > 100_000) return Promise.reject(new Error(t("Mermaid 内容为空或超过 100000 字符")))
  if (owner.isDestroyed()) return Promise.reject(new Error(t("工作台已关闭")))
  const key = createHash('sha256').update(source).digest('hex')
  const existing = cache.get(key)
  if (existing) { cache.delete(key); cache.set(key, existing); return Promise.resolve(existing) }
  const running = pending.get(key)
  if (running) return running
  if (pending.size >= 24) return Promise.reject(new Error(t("图表渲染繁忙，请稍后重试")))
  const requestedGeneration = generation
  const task: Promise<string> = queue.then(async () => {
    if (requestedGeneration !== generation) throw new DiagramCancelled(t("图表渲染已取消"))
    if (owner.isDestroyed()) throw new Error(t("工作台已关闭"))
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const svg = await Promise.race([
        windowForRendering().then((window) => window.webContents.executeJavaScript(`window.renderMermaid(${JSON.stringify(source)}, ${JSON.stringify(`diagram-${key.slice(0, 16)}`)})`) as Promise<string>),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { resetRenderer(); reject(new Error(t("图表渲染超时，请简化图表后重试"))) }, 15000) })
      ])
      if (requestedGeneration !== generation) throw new DiagramCancelled(t("图表渲染已取消"))
      if (owner.isDestroyed()) throw new Error(t("工作台已关闭"))
      if (typeof svg !== 'string' || !svg.includes('<svg')) throw new Error(t("图表渲染未返回 SVG"))
      if (svg.length * 2 <= 8_000_000) {
        cache.set(key, svg); cacheSize += svg.length * 2
        while (cache.size > 32 || cacheSize > 8_000_000) { const oldest = cache.keys().next().value!; cacheSize -= cache.get(oldest)!.length * 2; cache.delete(oldest) }
      }
      return svg
    } catch (error) {
      if (requestedGeneration !== generation) throw new DiagramCancelled(t("图表渲染已取消"))
      throw error
    } finally { clearTimeout(timer) }
  }).finally(() => { if (pending.get(key) === task) pending.delete(key) })
  pending.set(key, task)
  queue = task.catch(() => {})
  return task
}
