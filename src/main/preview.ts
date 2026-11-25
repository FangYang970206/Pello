import { t } from '../shared/i18n'
import { MAX_DOCUMENT_BYTES } from '../shared/types'
import { createServer, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { shell } from 'electron'
import { readAsset, type Target } from './git'
import { htmlPreviewBridge } from '../shared/preview-bridge'
import { clearAssetSnapshots, stageAsset, takeAsset } from './asset-snapshots'
import { terminalTarget } from './terminal-context'
import { db } from './store'
import { readTargetKey } from './remote-read'

const projects = new Map<string, { token: string; projectId: string; target: Target; drafts: Map<string, { token: string; text: string }> }>()
export function invalidatePreview(projectId: string, rel: string): void {
  for (const [identity, entry] of projects) {
    if (!identity.startsWith(`${projectId}:`)) continue
    clearAssetSnapshots(entry.target, rel)
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
        if (project.projectId.startsWith('terminal:') && !terminalTarget(project.projectId)) { response.writeHead(404).end(); return }
        const host = project.target.host
        if (host && host.id !== 'local') {
          const current = db().hosts.find((item) => item.id === host.id)
          if (!current?.on || ['addr', 'port', 'user', 'auth'].some((key) => current[key as keyof typeof current] !== host[key as keyof typeof host])) { response.writeHead(404).end(); return }
        }
        const rel = parts.map(decodeURIComponent).join('/')
        const draft = project.drafts.get(rel)
        let bytes = draft && url.searchParams.get('draft') === draft.token ? Buffer.from(draft.text, 'utf8') :
          takeAsset(project.target, rel, url.searchParams.get('asset') || undefined, request.method !== 'HEAD') || await readAsset(project.target, rel)
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

export async function previewUrl(projectId: string, target: Target, rel: string, draft?: string, assetToken?: string): Promise<string> {
  rel = rel.replace(/\\/g, '/')
  const bytes = takeAsset(target, rel, assetToken) || await readAsset(target, rel)
  if (draft !== undefined && (!/\.html?$/i.test(rel) || typeof draft !== 'string' || Buffer.byteLength(draft) > MAX_DOCUMENT_BYTES)) throw new Error(t("预览草稿必须为 10 MB 以内的 HTML"))
  const identity = `${projectId}:${readTargetKey(target)}`
  let entry = projects.get(identity)
  if (!entry) { entry = { token: randomUUID(), projectId, target, drafts: new Map() }; projects.set(identity, entry) }
  const number = await port()
  const normalized = rel.replace(/\\/g, '/')
  let query = draft === undefined ? `?asset=${stageAsset(target, rel, bytes)}` : ''
  if (draft !== undefined) {
    const previous = entry.drafts.get(normalized)
    const token = previous?.text === draft ? previous.token : randomUUID()
    entry.drafts.set(normalized, { token, text: draft })
    query = `?draft=${token}`
  }
  return `http://127.0.0.1:${number}/${entry.token}/${normalized.split('/').map(encodeURIComponent).join('/')}${query}`
}

export async function openHtmlPreview(projectId: string, target: Target, rel: string): Promise<string> {
  if (!/\.html?$/i.test(rel)) throw new Error(t("仅支持在浏览器中预览 HTML 文件"))
  const url = await previewUrl(projectId, target, rel)
  await shell.openExternal(url)
  return url
}
