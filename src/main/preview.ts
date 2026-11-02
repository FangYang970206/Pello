import { createServer, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { shell } from 'electron'
import { readAsset, type Target } from './git'

const projects = new Map<string, { token: string; target: Target }>()
let server: Server | null = null
let listening: Promise<number> | null = null
const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2'
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
        const bytes = await readAsset(project.target, rel)
        response.writeHead(200, { 'Content-Type': mime[path.extname(rel).toLowerCase()] || 'application/octet-stream',
          'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' })
        response.end(request.method === 'HEAD' ? undefined : bytes)
      })().catch(() => { if (!response.headersSent) response.writeHead(404); response.end('资源不存在或不可访问') })
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server?.address()
      if (!address || typeof address === 'string') { reject(new Error('无法启动预览')); return }
      server?.unref()
      resolve(address.port)
    })
  }).catch((error) => { listening = null; throw error })
  listening = started
  return started
}

export async function previewUrl(projectId: string, target: Target, rel: string): Promise<string> {
  await readAsset(target, rel)
  const identity = `${projectId}:${target.cwd}:${target.host?.id || 'local'}`
  let entry = projects.get(identity)
  if (!entry) { entry = { token: randomUUID(), target }; projects.set(identity, entry) }
  const number = await port()
  return `http://127.0.0.1:${number}/${entry.token}/${rel.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/')}`
}

export async function openHtmlPreview(projectId: string, target: Target, rel: string): Promise<string> {
  if (!/\.html?$/i.test(rel)) throw new Error('仅支持在浏览器中预览 HTML 文件')
  const url = await previewUrl(projectId, target, rel)
  await shell.openExternal(url)
  return url
}
