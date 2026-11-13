import { t } from '../shared/i18n'
import { createServer, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { shell } from 'electron'
import { readAsset, type Target } from './git'
import { htmlPreviewBridge } from '../shared/preview-bridge'

const projects = new Map<string, { token: string; target: Target; drafts: Map<string, { token: string; text: string }> }>()
export function invalidatePreview(projectId: string, rel: string): void {
  for (const [identity, entry] of projects) {
    if (!identity.startsWith(`${projectId}:`)) continue
    for (const key of entry.drafts.keys()) if (!rel || key === rel || key.startsWith(`${rel}/`)) entry.drafts.delete(key)
  }
}
let server: Server | null = null
let listening: Promise<number> | null = null
export function isPreviewUrl(value: string): boolean {
  try {
    const url = new URL(value), address = server?.address()
    return !!address && typeof address !== 'string' && url.origin === `http://127.0.0.1:${address.port}` &&
      [...projects.values()].some((entry) => url.pathname.startsWith(`/${entry.token}/`))
  } catch { return false }
}
const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.pdf': 'application/pdf', '.bmp': 'image/bmp', '.avif': 'image/avif'
}

async function port(): Promise<number> {
  if (listening) return listening
  const started = new Promise<number>((resolve, reject) => {
    server = createServer((request, response) => {
      void (async () => {
        if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405).end(); return }
        const url = new URL(request.url || '/', 'http://127.0.0.1')
        const [token, ...parts] = url.pathname.slice(1).split('/')
        const project = [...projects.values()].find((entry) => entry.token === token)
        if (!project) { response.writeHead(404).end(); return }
        const rel = parts.map(decodeURIComponent).join('/')
        const draft = project.drafts.get(rel)
        let bytes = draft && url.searchParams.get('draft') === draft.token ? Buffer.from(draft.text, 'utf8') : await readAsset(project.target, rel)
        if (/\.html?$/i.test(rel) && url.searchParams.get('workbenchWheel') === '1') {
          // Only report a zoom gesture to the owning sandbox iframe; no workbench API is exposed.
          const bridge = `<script>(${htmlPreviewBridge.toString()})()</script>`
          const html = bytes.toString('utf8')
          const start = html.match(/<head(?:\s[^>]*)?>/i) || html.match(/<!doctype[^>]*>/i)
          const offset = start ? start.index! + start[0].length : 0
          bytes = Buffer.from(html.slice(0, offset) + bridge + html.slice(offset), 'utf8')
        }
        response.writeHead(200, { 'Content-Type': mime[path.extname(rel).toLowerCase()] || 'application/octet-stream',
          'Content-Length': bytes.length,
          'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
          // Sandboxed documents have an opaque origin. Permit their module and
          // font requests while keeping the project token and path checks.
          ...(request.headers.origin === 'null' ? { 'Access-Control-Allow-Origin': 'null', Vary: 'Origin' } : {}) })
        response.end(request.method === 'HEAD' ? undefined : bytes)
      })().catch(() => { if (!response.headersSent) response.writeHead(404); response.end(t("资源不存在或不可访问")) })
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server?.address()
      if (!address || typeof address === 'string') { reject(new Error(t("无法启动预览"))); return }
      server?.unref()
      resolve(address.port)
    })
  }).catch((error) => { listening = null; throw error })
  listening = started
  return started
}

export async function previewUrl(projectId: string, target: Target, rel: string, draft?: string): Promise<string> {
  await readAsset(target, rel)
  if (draft !== undefined && (!/\.html?$/i.test(rel) || typeof draft !== 'string' || Buffer.byteLength(draft) > 2 * 1024 * 1024)) throw new Error(t("预览草稿必须为 2 MB 以内的 HTML"))
  const identity = `${projectId}:${target.cwd}:${target.host?.id || 'local'}`
  let entry = projects.get(identity)
  if (!entry) { entry = { token: randomUUID(), target, drafts: new Map() }; projects.set(identity, entry) }
  const number = await port()
  const normalized = rel.replace(/\\/g, '/')
  let query = ''
  if (draft !== undefined) { const token = randomUUID(); entry.drafts.set(normalized, { token, text: draft }); query = `?draft=${token}` }
  return `http://127.0.0.1:${number}/${entry.token}/${normalized.split('/').map(encodeURIComponent).join('/')}${query}`
}

export async function openHtmlPreview(projectId: string, target: Target, rel: string): Promise<string> {
  if (!/\.html?$/i.test(rel)) throw new Error(t("仅支持在浏览器中预览 HTML 文件"))
  const url = await previewUrl(projectId, target, rel)
  await shell.openExternal(url)
  return url
}
