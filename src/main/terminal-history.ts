import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

function directory(): string {
  return path.join(app.getPath('userData'), 'terminal-history')
}

function key(id: string): string {
  return createHash('sha256').update(id).digest('hex')
}

function fileFor(id: string): string {
  return path.join(directory(), `${key(id)}.log`)
}

/** Lossless output journal, independent of renderer snapshots and TUI clears. */
export function recordTerminalOutput(id: string, data: string): void {
  if (!id || !data) return
  fs.mkdirSync(directory(), { recursive: true })
  fs.appendFileSync(path.join(directory(), `${key(id)}.ansi`), data, 'utf8')
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

export function deleteTerminalHistory(id: string): void {
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
