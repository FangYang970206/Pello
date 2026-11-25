import { randomUUID } from 'node:crypto'
import { readTargetKey, type ReadTarget } from './remote-read'

const snapshots = new Map<string, { identity: string; path: string; bytes: Buffer; expires: number }>()
const MAX_BYTES = 48_000_000
let size = 0
function remove(token: string): void {
  const value = snapshots.get(token)
  if (value) { size -= value.bytes.length; snapshots.delete(token) }
}
/** Short-lived handoff of the opened media version to its first preview request. */
export function stageAsset(target: ReadTarget, path: string, bytes: Buffer): string {
  for (const [token, value] of snapshots) if (value.expires < Date.now()) remove(token)
  while (snapshots.size && (size + bytes.length > MAX_BYTES || snapshots.size >= 32)) remove(snapshots.keys().next().value!)
  const token = randomUUID()
  snapshots.set(token, { identity: readTargetKey(target), path, bytes, expires: Date.now() + 30000 }); size += bytes.length
  const cleanup = setTimeout(() => remove(token), 30000); cleanup.unref()
  return token
}
export function takeAsset(target: ReadTarget, path: string, token?: string, consume = true): Buffer | undefined {
  const value = token ? snapshots.get(token) : undefined
  if (!value || value.identity !== readTargetKey(target) || value.path !== path || value.expires < Date.now()) return
  if (consume) remove(token!)
  return value.bytes
}
export function clearAssetSnapshots(target?: ReadTarget, path = ''): void {
  for (const [token, value] of snapshots) if (!target || (value.identity === readTargetKey(target) && (!path || value.path === path || value.path.startsWith(path + '/')))) remove(token)
}
