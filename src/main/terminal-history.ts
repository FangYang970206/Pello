import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

const MAX_BYTES = 512 * 1024
const MAX_FILES = 100

function directory(): string {
  return path.join(app.getPath('userData'), 'terminal-history')
}

function key(id: string): string {
  return createHash('sha256').update(id).digest('hex')
}

function fileFor(id: string): string {
  return path.join(directory(), `${key(id)}.log`)
}

function trimFiles(): void {
  const entries = fs.readdirSync(directory(), { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith('.log'))
  if (entries.length <= MAX_FILES) return
  const files = entries.map((entry) => {
    const file = path.join(directory(), entry.name)
    try {
      return { file, time: fs.statSync(file).mtimeMs }
    } catch {
      return null
    }
  }).filter((item): item is { file: string; time: number } => !!item).sort((a, b) => a.time - b.time)
  for (const entry of files.slice(0, Math.max(0, files.length - MAX_FILES))) {
    try {
      fs.unlinkSync(entry.file)
    } catch {
      /* Another process may have removed it. */
    }
  }
}

export function saveTerminalHistory(id: string, text: string): void {
  if (!id || typeof text !== 'string' || !text) return
  const bytes = Buffer.from(text, 'utf8')
  const value = bytes.byteLength > MAX_BYTES ? bytes.subarray(bytes.byteLength - MAX_BYTES).toString('utf8') : text
  const dir = directory()
  fs.mkdirSync(dir, { recursive: true })
  const destination = fileFor(id)
  const temporary = destination + '.tmp'
  fs.writeFileSync(temporary, value)
  fs.renameSync(temporary, destination)
  trimFiles()
}

export function loadTerminalHistory(id: string): string {
  try {
    const bytes = fs.readFileSync(fileFor(id))
    return (bytes.byteLength > MAX_BYTES ? bytes.subarray(bytes.byteLength - MAX_BYTES) : bytes).toString('utf8')
  } catch {
    return ''
  }
}

export function deleteTerminalHistory(id: string): void {
  try {
    fs.unlinkSync(fileFor(id))
  } catch {
    /* The terminal may never have produced output. */
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
    if (!entry.isFile() || !entry.name.endsWith('.log')) continue
    if (keep.has(entry.name.slice(0, -4))) continue
    try {
      fs.unlinkSync(path.join(directory(), entry.name))
    } catch {
      /* Ignore files that are already gone. */
    }
  }
  trimFiles()
}
