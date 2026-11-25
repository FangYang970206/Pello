import type { Host, TerminalRoute } from '../shared/types'
import { t } from '../shared/i18n'
import { openRemoteStream, remoteCommand, type RemoteStream } from './ssh'
import { remoteReadProgram, remoteReadRelay } from './remote-read-program'
import { onTerminalRouteClosed } from './terminal-context'

export type ReadTarget = { cwd: string; host: Host | null; platform: 'linux' | 'windows' }
export const readTargetKey = (target: ReadTarget) => JSON.stringify([target.cwd, target.platform, target.host?.id, target.host?.addr, target.host?.port, target.host?.user, target.host?.auth, target.host?.terminalRoute])
type Job = { root: string; path: string; limit: number; resolve: (bytes: Buffer) => void; reject: (error: Error) => void }
const readers = new Map<string, RemoteReader>()
const pending = new Map<string, Promise<Buffer>>()

/** One framed binary command per target, shared by all reads and authentication types. */
class RemoteReader {
  private controller = new AbortController()
  private stream?: RemoteStream
  private jobs: Job[] = []
  private current?: Job
  private header = Buffer.alloc(0)
  private body?: Buffer
  private received = 0
  private status = ''
  private timer?: ReturnType<typeof setTimeout>
  private idle?: ReturnType<typeof setTimeout>
  private closed = false
  constructor(readonly target: ReadTarget, private key: string) {
    void this.start()
  }
  private async start(): Promise<void> {
    try {
      const host = this.target.host!, routed = !!host.terminalRoute?.length
      const program = remoteReadProgram(this.target.platform)
      const args = routed ? remoteReadRelay(remoteCommand(host, program)) : program
      const stream = await openRemoteStream(routed ? { ...host, terminalRoute: undefined } : host, args, this.controller.signal)
      if (this.closed) { stream.close(); void stream.completion.catch(() => {}); return }
      this.stream = stream
      stream.stdin.on('error', (error) => this.close(error))
      stream.stdout.on('error', (error) => this.close(error))
      stream.stdout.on('data', (chunk: Buffer) => this.receive(chunk))
      void stream.completion.then(() => this.close(new Error(t('SSH 连接中断'))), (error) => this.close(error))
      this.next()
    } catch (error) { this.close(error instanceof Error ? error : new Error(String(error))) }
  }
  read(root: string, path: string, limit: number): Promise<Buffer> {
    if (this.closed) return Promise.reject(new Error(t('SSH 连接中断')))
    return new Promise((resolve, reject) => {
      this.jobs.push({ root, path, limit, resolve, reject })
      this.next()
    })
  }
  private next(): void {
    if (this.closed || this.current || !this.jobs.length) return
    clearTimeout(this.idle)
    // Include authentication/startup in the first read's deadline.
    this.timer ??= setTimeout(() => this.close(new Error(t('远程命令执行超时'))), 20000)
    if (!this.stream) return
    this.current = this.jobs.shift()!
    const { root, path, limit } = this.current
    this.stream.stdin.write(JSON.stringify({ root, path, limit }) + '\n')
  }
  private receive(chunk: Buffer): void {
    if (this.closed) return
    if (!this.current) { this.close(new Error(t('SSH 连接中断'))); return }
    if (!this.body) {
      const end = chunk.indexOf(10)
      if (this.header.length + (end < 0 ? chunk.length : end) > 128) { this.close(new Error(t('远程输出过大'))); return }
      this.header = Buffer.concat([this.header, end < 0 ? chunk : chunk.subarray(0, end)])
      if (end < 0) return
      const match = /^PELLO1 (OK|MISSING|LARGE|CHANGED|ERROR) (\d+)$/.exec(this.header.toString('ascii'))
      if (!match || Number(match[2]) > this.current.limit || (match[1] !== 'OK' && Number(match[2]) !== 0)) { this.close(new Error(t('远程输出过大'))); return }
      this.status = match[1]; this.body = Buffer.alloc(Number(match[2]))
      chunk = chunk.subarray(end + 1)
    }
    if (this.received + chunk.length > this.body.length) { this.close(new Error(t('远程输出过大'))); return }
    chunk.copy(this.body, this.received); this.received += chunk.length
    if (this.received !== this.body.length) return
    const job = this.current, bytes = this.body, status = this.status
    this.current = undefined; this.body = undefined; this.header = Buffer.alloc(0); this.received = 0
    clearTimeout(this.timer); this.timer = undefined
    if (status === 'OK') job.resolve(bytes)
    else if (status === 'MISSING') job.reject(Object.assign(new Error(t('文件不存在')), { code: 'ENOENT' }))
    else if (status === 'LARGE') job.reject(Object.assign(new Error(t('远程输出过大')), { code: 'EFBIG' }))
    else job.reject(new Error(status === 'CHANGED' ? t('文件已被其他程序修改，请重新读取后合并更改') : t('资源不存在或不可访问')))
    if (this.jobs.length) this.next()
    else { this.idle = setTimeout(() => this.close(), 60000); this.idle.unref() }
  }
  close(error = new Error(t('SSH 连接中断'))): void {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.timer); clearTimeout(this.idle)
    if (readers.get(this.key) === this) readers.delete(this.key)
    for (const key of pending.keys()) if (JSON.parse(key)[0] === this.key) pending.delete(key)
    this.current?.reject(error)
    for (const job of this.jobs) job.reject(error)
    this.jobs = []; this.current = undefined; this.body = undefined
    this.controller.abort()
  }
}

export function readRemoteBytes(target: ReadTarget, path: string, limit = 12_000_000): Promise<Buffer> {
  const identity = readTargetKey(target), key = JSON.stringify([identity, path, limit])
  const previous = pending.get(key)
  if (previous) return previous
  let reader = readers.get(identity)
  if (!reader) { reader = new RemoteReader(target, identity); readers.set(identity, reader) }
  const request = reader.read(target.cwd, path, limit).finally(() => { if (pending.get(key) === request) pending.delete(key) })
  pending.set(key, request)
  return request
}

/** Config changes, SSH-layer exit and application shutdown invalidate live transports. */
export function closeRemoteReaders(hostId?: string, route?: TerminalRoute[]): void {
  for (const reader of readers.values()) {
    if (hostId && reader.target.host?.id !== hostId) continue
    if (route && !route.every((hop, index) => JSON.stringify(hop) === JSON.stringify(reader.target.host?.terminalRoute?.[index]))) continue
    reader.close()
  }
}
onTerminalRouteClosed(closeRemoteReaders)
