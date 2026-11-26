import path from 'node:path'
import { t } from '../shared/i18n'
import type { DirListing, Host } from '../shared/types'
import { openRemoteStream } from './ssh'
import { remoteResourceProgram } from './remote-resource-program'
import type { ResourceFiles } from './resources'

const LIMIT = 48 * 1024 * 1024
export type RemoteResourceRequest = { op: 'profile' } | { op: 'browse'; path: string } |
  { op: 'snapshot'; files: string[]; roots: string[] } | { op: 'canonical' | 'mkdir'; path: string } |
  { op: 'write'; path: string; stamp: string; content: string } |
  { op: 'rename'; root: string; path: string; dest: string; stamp: string }

export async function remoteResource<T>(host: Host, request: RemoteResourceRequest, guard?: () => void, cancel?: AbortSignal): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 25000)
  const commit = request.op === 'write' || request.op === 'rename' || request.op === 'mkdir'
  try {
    guard?.()
    const signal = cancel ? AbortSignal.any([cancel, controller.signal]) : controller.signal
    const stream = await openRemoteStream(host, remoteResourceProgram(host.platform, request.op), signal)
    const chunks: Buffer[] = []
    let bytes = 0, ready = !commit, failure: unknown
    stream.stdin.on('error', (error) => { failure ??= error })
    stream.stdout.on('data', (value: Buffer) => {
      try {
        bytes += value.length
        if (bytes > LIMIT) throw new Error(t("远程输出过大"))
        chunks.push(value)
        if (!ready && bytes >= 3) {
          if (Buffer.concat(chunks).toString('utf8').trim() !== 'OK') throw new Error(t("远程资源写入准备失败"))
          chunks.length = 0; bytes = 0; ready = true
          guard?.()
          stream.stdin.end('1\n')
        }
      } catch (error) { failure = error; stream.close() }
    })
    const payload = JSON.stringify(request) + '\n'
    if (commit) stream.stdin.write(payload)
    else stream.stdin.end(payload)
    await stream.completion.catch((error) => { throw failure || error })
    if (failure) throw failure
    const output = Buffer.concat(chunks).toString('utf8').trim()
    return (output ? JSON.parse(output) : undefined) as T
  } finally { clearTimeout(timeout) }
}

export type RemoteProfile = { home: string; env: Record<string, string>; jsonc: string }
type FileEntry = { path: string; content?: string; stamp?: string; error?: string }
type Snapshot = { files: FileEntry[]; skills: string[]; errors: string[] }

export class RemoteResourceSnapshot implements ResourceFiles {
  private files: Map<string, FileEntry>
  private change?: RemoteResourceRequest
  constructor(private snapshot: Snapshot) {
    this.files = new Map(snapshot.files.map((entry) => [entry.path, entry]))
  }
  read = (file: string) => {
    const entry = this.files.get(file)
    if (entry?.error) throw new Error(entry.error)
    return entry?.content ?? ''
  }
  exists = (file: string) => this.files.get(file)?.content !== undefined || !!this.files.get(file)?.error
  write(file: string, _before: string, next: string) {
    this.change = { op: 'write', path: file, stamp: this.files.get(file)?.stamp || '', content: next }
  }
  skills(_roots: string[], errors: string[]) {
    errors.push(...this.snapshot.errors)
    return this.snapshot.skills
  }
  renameSkill(root: string, source: string, dest: string) {
    this.change = { op: 'rename', root, path: source, dest, stamp: this.files.get(source)?.stamp || '' }
  }
  async publish(host: Host, guard: () => void) {
    if (this.change) await remoteResource(host, this.change, guard)
  }
}

export async function remoteSnapshot(host: Host, files: string[], roots: string[], guard?: () => void, signal?: AbortSignal) {
  return new RemoteResourceSnapshot(await remoteResource<Snapshot>(host, { op: 'snapshot', files: files.filter(Boolean), roots }, guard, signal))
}

export async function browseRemoteResources(host: Host, input: string, files: boolean): Promise<DirListing> {
  const result = await remoteResource<{ path: string; parent: string | null; dirs: string[]; files: string[] }>(host, { op: 'browse', path: input })
  const paths = host.platform === 'windows' ? path.win32 : path.posix
  const entries = (names: string[]) => names.sort((a, b) => a.localeCompare(b)).map((name) => ({ name, path: paths.join(result.path, name) }))
  return { path: result.path, parent: result.parent, dirs: entries(result.dirs), files: files ? entries(result.files) : undefined }
}
