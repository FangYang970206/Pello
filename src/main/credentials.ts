import fs from 'node:fs'
import path from 'node:path'
import { app, safeStorage } from 'electron'
import type { Host } from '../shared/types'

const memory = new Map<string, string>()
const identity = (host: Host) => JSON.stringify([host.addr, host.port || 22, host.user])
const file = () => path.join(app.getPath('userData'), 'credentials.json')

function stored(): Record<string, string> {
  try { return JSON.parse(fs.readFileSync(file(), 'utf8')) } catch { return {} }
}

export function hostPassword(host: Host): string | undefined {
  if (host.password !== undefined) return host.password || undefined
  const key = identity(host)
  if (memory.has(key)) return memory.get(key)
  const encrypted = stored()[key]
  if (!encrypted || !safeStorage.isEncryptionAvailable()) return undefined
  try { return safeStorage.decryptString(Buffer.from(encrypted, 'base64')) } catch { return undefined }
}

export function rememberPassword(host: Host): void {
  if (host.auth !== 'password' || host.password === undefined) return
  const key = identity(host)
  const records = stored()
  if (host.password) memory.set(key, host.password)
  else memory.delete(key)
  // Never fall back to plaintext storage when OS encryption is unavailable.
  if (host.password && safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== 'basic_text') {
    records[key] = safeStorage.encryptString(host.password).toString('base64')
  } else delete records[key]
  fs.mkdirSync(path.dirname(file()), { recursive: true })
  const temp = file() + '.tmp'
  fs.writeFileSync(temp, JSON.stringify(records), { mode: 0o600 })
  fs.renameSync(temp, file())
}

export function publicHost(host: Host): Host {
  const { password: _password, hasPassword: _hasPassword, ...clean } = host
  return { ...clean, hasPassword: !!hostPassword(clean) }
}
