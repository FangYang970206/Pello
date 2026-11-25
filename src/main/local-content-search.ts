import { Worker } from 'node:worker_threads'
import type { ContentSearchFile } from '../shared/types'
import { contentPattern, scanContent } from '../shared/content-matches'
import { SearchPatternError } from './search-matcher'
import { t } from '../shared/i18n'
import type { Target } from './git'

type Event = { file?: ContentSearchFile; skipped?: number; errors?: number; limited?: boolean }
type Config = { root: string; source: string; flags: string; regex: boolean; ignored: string[] }

/** Self-contained worker entry point; serialized with the shared matcher in packaged builds. */
function scanFiles(config: Config, scan: typeof scanContent): void {
  const fs = require('node:fs') as typeof import('node:fs')
  const path = require('node:path') as typeof import('node:path')
  const { isUtf8 } = require('node:buffer') as typeof import('node:buffer')
  const { parentPort } = require('node:worker_threads') as typeof import('node:worker_threads')
  const root = fs.realpathSync.native(config.root), ignored = new Set(config.ignored)
  const pattern = new RegExp(config.source, config.flags)
  const directories = [''], pending: string[] = []
  let remaining = 2000, finished = false, pendingIndex = 0, visitedFiles = 0
  const read = async (rel: string, direct: boolean): Promise<{ rel: string; text?: string; skipped?: number; errors?: number }> => {
    const full = path.join(root, rel)
    try {
      if (fs.realpathSync.native(full) !== full) return { rel, errors: 1 }
      const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
      // Opening a file can wait on storage/security filters even with hot data.
      // Keep these opens overlapped within the bounded batch in both modes.
      const handle = await fs.promises.open(full, flags)
      try {
        const stat = direct ? fs.fstatSync(handle.fd) : await handle.stat()
        if (!stat.isFile()) return { rel }
        if (stat.size > 2_000_000) return { rel, skipped: 1 }
        const buffer = Buffer.allocUnsafe(Math.min(stat.size + 1, 2_000_001))
        let length = 0
        while (length < buffer.length) {
          const bytesRead = direct ? fs.readSync(handle.fd, buffer, length, buffer.length - length, null) : (await handle.read(buffer, length, buffer.length - length, null)).bytesRead
          if (!bytesRead) break
          length += bytesRead
        }
        const bytes = buffer.subarray(0, length)
        if (length > 2_000_000 || bytes.includes(0) || !isUtf8(bytes)) return { rel, skipped: 1 }
        return { rel, text: bytes.toString('utf8') }
      } finally { await handle.close() }
    } catch { return { rel, errors: 1 } }
  }
  parentPort!.on('message', async () => {
    const events: Event[] = [], start = Date.now()
    let visited = 0
    try {
      while (!finished && visited++ < 512 && Date.now() - start < 30) {
        const paths: string[] = []
        while (paths.length < 8 && !finished) {
          if (pendingIndex >= pending.length) {
            pending.length = 0; pendingIndex = 0
            const relative = directories.pop()
            if (relative === undefined) { finished = true; break }
            try {
              const folder = path.join(root, relative)
              // Recheck ancestors after each pull; never cache boundary decisions.
              if (fs.realpathSync.native(folder) !== folder) { events.push({ errors: 1 }); continue }
              for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
                const rel = relative ? `${relative}/${entry.name}` : entry.name
                if (entry.isDirectory() && !entry.name.startsWith('.') && !ignored.has(entry.name)) directories.push(rel)
                else if (entry.isFile()) pending.push(rel)
              }
            } catch (error) { if (!relative) throw error; events.push({ errors: 1 }) }
            continue
          }
          paths.push(pending[pendingIndex++])
        }
        // Small scans overlap disk latency. Long scans switch to this dedicated
        // worker's direct reads to avoid queueing every stat/read in the shared
        // libuv pool. File opens remain overlapped. This is not a result limit.
        const direct = visitedFiles >= 4096
        visitedFiles += paths.length
        for (const { rel, text, skipped, errors } of await Promise.all(paths.map((rel) => read(rel, direct)))) {
          if (skipped || errors) events.push({ skipped, errors })
          if (text === undefined) continue
          if (config.regex) parentPort!.postMessage({ type: 'matching' })
          pattern.lastIndex = 0
          // Regex semantics are per-line (including ^/$); only literals may use
          // the whole-file negative fast path.
          const matches = config.regex || pattern.test(text) ? scan(text, config.source, config.flags, remaining) : []
          if (config.regex) parentPort!.postMessage({ type: 'matched' })
          if (matches.length) { events.push({ file: { path: rel, matches } }); remaining -= matches.length }
          if (!remaining) { events.push({ limited: true }); finished = true; break }
        }
      }
      parentPort!.postMessage({ type: 'batch', events, done: finished })
    } catch (error) { parentPort!.postMessage({ type: 'error', message: (error as Error).message }) }
  })
}

/** Disk traversal and matching stay off Electron's event loop, with pull backpressure. */
export async function* localContentSearch(target: Target, query: string, sensitive: boolean, ignored: Set<string>, signal: AbortSignal, regex: boolean, whole: boolean): AsyncGenerator<Event> {
  const pattern = contentPattern(query, sensitive, regex, whole)
  const worker = new Worker(`(${scanFiles.toString()})(require('node:worker_threads').workerData, ${scanContent.toString()})`, {
    eval: true, workerData: { root: target.cwd, source: pattern.source, flags: pattern.flags, regex, ignored: [...ignored] } satisfies Config
  })
  let failure: Error | null = null, rejectPending: ((error: Error) => void) | undefined
  const failed = (error: Error) => { failure = error; rejectPending?.(error) }
  worker.on('error', failed)
  worker.on('exit', () => failed(new Error(t("搜索已停止"))))
  const abort = () => { failed(new Error(t("搜索已停止"))); void worker.terminate() }
  signal.addEventListener('abort', abort, { once: true })
  try {
    while (!signal.aborted) {
      const batch = await new Promise<{ events: Event[]; done: boolean }>((resolve, reject) => {
        if (failure) { reject(failure); return }
        let timer: ReturnType<typeof setTimeout> | undefined
        const clean = () => { clearTimeout(timer); worker.off('message', message); rejectPending = undefined }
        rejectPending = (error) => { clean(); reject(error) }
        const message = (value: { type: string; message?: string; events: Event[]; done: boolean }) => {
          if (value.type === 'matching') { timer = setTimeout(() => { rejectPending?.(new SearchPatternError(t("正则表达式执行超时，请简化表达式"))); void worker.terminate() }, 500); return }
          clearTimeout(timer)
          if (value.type === 'matched') return
          clean()
          if (value.type === 'error') reject(new Error(value.message)); else resolve(value)
        }
        worker.on('message', message)
        worker.postMessage('next')
      })
      for (const event of batch.events) { if (signal.aborted) return; yield event }
      if (batch.done) return
      yield {}
    }
  } finally { signal.removeEventListener('abort', abort); await worker.terminate() }
}
