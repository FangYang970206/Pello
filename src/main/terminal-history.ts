import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { FileHandle } from 'node:fs/promises'
import { t } from '../shared/i18n'

function directory(): string {
  return path.join(app.getPath('userData'), 'terminal-history')
}

function key(id: string): string {
  return createHash('sha256').update(id).digest('hex')
}

function fileFor(id: string): string {
  return path.join(directory(), `${key(id)}.log`)
}

type Journal = { chunks: Buffer[]; head: number; timer?: NodeJS.Immediate; writing?: Promise<void> }
const journals = new Map<string, Journal>()

/** Lossless output journal, independent of renderer snapshots and TUI clears. */
export function recordTerminalOutput(id: string, data: string): void {
  if (!id || !data) return
  let journal = journals.get(id)
  if (!journal) { journal = { chunks: [], head: 0 }; journals.set(id, journal) }
  journal.chunks.push(Buffer.from(data, 'utf8'))
  if (!journal.timer && !journal.writing) journal.timer = setImmediate(() => {
    void flushTerminalRecording(id).catch((error) => console.error('Unable to persist terminal output', error))
  })
}

/** Coalesce packets off the main thread; export, close and quit await this fence. */
export async function flushTerminalRecording(id?: string): Promise<void> {
  if (id === undefined) { await Promise.all([...journals.keys()].map((key) => flushTerminalRecording(key))); return }
  const journal = journals.get(id)
  if (!journal) return
  if (journal.timer) { clearImmediate(journal.timer); journal.timer = undefined }
  if (!journal.writing) {
    journal.writing = (async () => {
      await fs.promises.mkdir(directory(), { recursive: true })
      const destination = terminalRecording(id)
      while (journal.head < journal.chunks.length) {
        const start = journal.head
        let bytes = 0
        while (journal.head < journal.chunks.length && bytes < 256 * 1024) bytes += journal.chunks[journal.head++].length
        const batch = Buffer.concat(journal.chunks.slice(start, journal.head), bytes)
        let handle: FileHandle | undefined, written = 0
        try {
          handle = await fs.promises.open(destination, 'a')
          while (written < batch.length) {
            const { bytesWritten } = await handle.write(batch, written, batch.length - written, null)
            if (!bytesWritten) throw new Error(t("保存失败"))
            written += bytesWritten
          }
        } catch (error) {
          // A short write can precede a disk error. Retain only the bytes that
          // have not reached the file, even when the split is inside UTF-8.
          journal.head = start
          while (written) {
            const chunk = journal.chunks[journal.head]
            if (written < chunk.length) { journal.chunks[journal.head] = chunk.subarray(written); written = 0 }
            else { written -= chunk.length; journal.head++ }
          }
          throw error
        } finally { await handle?.close() }
        if (journal.head >= 1024) { journal.chunks = journal.chunks.slice(journal.head); journal.head = 0 }
      }
      journals.delete(id)
    })().finally(() => { journal.writing = undefined })
  }
  await journal.writing
}

export function terminalRecording(id: string): string {
  return path.join(directory(), `${key(id)}.ansi`)
}

export function saveTerminalHistory(id: string, text: string): void {
  if (!id || typeof text !== 'string' || !text) return
  const dir = directory()
  fs.mkdirSync(dir, { recursive: true })
  const destination = fileFor(id)
  const temporary = destination + '.tmp'
  fs.writeFileSync(temporary, text)
  fs.renameSync(temporary, destination)
}

export function loadTerminalHistory(id: string): string {
  try {
    return fs.readFileSync(fileFor(id), 'utf8')
  } catch {
    return ''
  }
}

export async function deleteTerminalHistory(id: string): Promise<void> {
  await flushTerminalRecording(id)
  for (const file of [fileFor(id), terminalRecording(id)]) {
    try { fs.unlinkSync(file) } catch { /* The terminal may never have produced output. */ }
  }
}

/** Drop stale files left by a crash or by sessions the user removed. */
export function pruneTerminalHistory(ids: Iterable<string>): void {
  const keep = new Set([...ids].map(key))
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(directory(), { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isFile() || !/\.(log|ansi)$/.test(entry.name)) continue
    if (keep.has(entry.name.replace(/\.(log|ansi)$/, ''))) continue
    try {
      fs.unlinkSync(path.join(directory(), entry.name))
    } catch {
      /* Ignore files that are already gone. */
    }
  }
}
