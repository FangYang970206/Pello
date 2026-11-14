import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import { isUtf8 } from 'node:buffer'
import { createInterface } from 'node:readline'
import type { ContentSearchBatch, ContentSearchFile } from '../shared/types'
import { t } from '../shared/i18n'
import { type Target, treePath } from './git'
import { openRemoteStream } from './ssh'
import { bashQuote } from './platform'
import { contentPattern } from '../shared/content-matches'
import { SearchMatcher, SearchPatternError } from './search-matcher'
import { CONTENT_SEARCH_LINUX, CONTENT_SEARCH_WINDOWS } from './content-search-scripts'

type SearchEvent = { file?: ContentSearchFile; skipped?: number; errors?: number; limited?: boolean }
const MAX_MATCHES = 2000
const MAX_BYTES = 2_000_000

async function* localSearch(target: Target, query: string, sensitive: boolean, ignored: Set<string>, signal: AbortSignal, regex: boolean, whole: boolean): AsyncGenerator<SearchEvent> {
  const pending = ['']
  const matcher = new SearchMatcher(contentPattern(query, sensitive, regex, whole), regex, signal)
  try {
    let remaining = MAX_MATCHES
    while (pending.length && !signal.aborted) {
      const relative = pending.pop()!
      let entries
      try { entries = await fs.readdir(treePath(target, relative).full, { withFileTypes: true }) }
      catch (error) { if (!relative) throw error; yield { errors: 1 }; continue }
      yield {}
      for (const entry of entries) {
        if (signal.aborted) return
        const rel = relative ? `${relative}/${entry.name}` : entry.name
        if (entry.isDirectory()) { if (!entry.name.startsWith('.') && !ignored.has(entry.name)) pending.push(rel); continue }
        if (!entry.isFile()) continue
        try {
          const file = await fs.open(treePath(target, rel).full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
          let bytes: Buffer
          try {
            const stat = await file.stat()
            if (!stat.isFile()) continue
            if (stat.size > MAX_BYTES) { yield { skipped: 1 }; continue }
            bytes = Buffer.alloc(Math.min(stat.size + 1, MAX_BYTES + 1))
            let length = 0
            while (length < bytes.length && !signal.aborted) {
              const result = await file.read(bytes, length, bytes.length - length, null)
              if (!result.bytesRead) break
              length += result.bytesRead
            }
            bytes = bytes.subarray(0, length)
          } finally { await file.close() }
          if (signal.aborted) return
          if (bytes.length > MAX_BYTES || bytes.includes(0) || !isUtf8(bytes)) { yield { skipped: 1 }; continue }
          const matches = await matcher.scan(bytes.toString('utf8'), remaining)
          remaining -= matches.length
          yield matches.length ? { file: { path: rel, matches } } : {}
          if (remaining <= 0) { yield { limited: true }; return }
        } catch (error) { if (error instanceof SearchPatternError) throw error; yield { errors: 1 } }
      }
    }
  } finally { matcher.dispose() }
}

async function* remoteSearch(target: Target, query: string, sensitive: boolean, ignored: Set<string>, signal: AbortSignal, regex: boolean, whole: boolean): AsyncGenerator<SearchEvent> {
  const args = target.platform === 'windows'
    ? ['powershell.exe', '-NoProfile', '-EncodedCommand', Buffer.from(CONTENT_SEARCH_WINDOWS, 'utf16le').toString('base64')]
    : ['bash', '-lc', `python3 -u -c ${bashQuote(CONTENT_SEARCH_LINUX)}`]
  const stream = await openRemoteStream(target.host!, args, signal)
  // Attach a handler immediately, even while stdout is paused between batches.
  const completion = stream.completion.then(() => null, (error: unknown) => error)
  stream.stdin.end(JSON.stringify({ root: target.cwd, query, sensitive, regex, whole, ignored: [...ignored] }))
  const lines = createInterface({ input: stream.stdout, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      if (signal.aborted) return
      const event = JSON.parse(line) as SearchEvent & { error?: string }
      if (event.error) throw new SearchPatternError(event.error === 'timeout' ? t("正则表达式执行超时，请简化表达式") : t("正则表达式无效"))
      yield event
    }
    const error = await completion
    if (error) throw error
  } finally { lines.close(); stream.close() }
}

/** Pull-based batches keep scanning cancellable and avoid blocking the main process. */
export class ContentSearch {
  private controller = new AbortController()
  private iterator: AsyncGenerator<SearchEvent>
  private busy = false
  private state = { done: false, limited: false, skipped: 0, errors: 0 }
  constructor(target: Target, query: string, sensitive: boolean, ignored: Set<string>, regex = false, whole = false) {
    if (typeof query !== 'string' || !query.trim() || query.length > 500 || /[\r\n\0]/.test(query) || typeof sensitive !== 'boolean' || typeof regex !== 'boolean' || typeof whole !== 'boolean') throw new Error(t("搜索参数无效"))
    try { contentPattern(query, sensitive, regex, whole) } catch { throw new Error(t("正则表达式无效")) }
    this.iterator = (target.host && target.host.id !== 'local' ? remoteSearch : localSearch)(target, query, sensitive, ignored, this.controller.signal, regex, whole)
  }
  cancel(): void { this.controller.abort(); void this.iterator.return(undefined).catch(() => {}) }
  async next(): Promise<ContentSearchBatch> {
    if (this.busy) throw new Error(t("搜索仍在进行中"))
    this.busy = true
    const items: ContentSearchFile[] = []
    try {
      const start = Date.now()
      for (let count = 0; count < 32 && !this.state.done && !this.controller.signal.aborted; count++) {
        const event = await this.iterator.next()
        if (event.done) { this.state.done = true; break }
        if (event.value.file) items.push(event.value.file)
        this.state.skipped += event.value.skipped || 0
        this.state.errors += event.value.errors || 0
        this.state.limited ||= !!event.value.limited
        if (Date.now() - start >= 40) break
      }
      return this.controller.signal.aborted ? { ...this.state, done: true, items: [] } : { ...this.state, items }
    } catch (error) {
      if (this.controller.signal.aborted) return { ...this.state, done: true, items: [] }
      throw error
    } finally { this.busy = false }
  }
}
