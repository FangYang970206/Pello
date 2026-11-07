import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

/** Explorer caches icons by path, even after the ICO at that path changes. */
export function windowsTaskbarIcon(source: string, userData: string): string {
  const bytes = fs.readFileSync(source)
  const digest = createHash('sha256').update(bytes).digest('hex')
  const directory = path.join(userData, 'icons')
  const icon = path.join(directory, `pello-${digest}.ico`)
  fs.mkdirSync(directory, { recursive: true })
  try { fs.writeFileSync(icon, bytes, { flag: 'wx' }) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    // Repair a damaged local cache rather than showing a stale or missing icon.
    if (!fs.readFileSync(icon).equals(bytes)) fs.writeFileSync(icon, bytes)
  }
  return icon
}
