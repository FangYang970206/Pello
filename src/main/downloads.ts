import { t } from '../shared/i18n'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { TransferSnapshot } from '../shared/types'
import type { Target } from './git'
import { downloadRemoteDirectory, downloadRemoteFile } from './remote-file'

type Entry = { source: string; destination: string; kind: 'file' | 'directory' | 'tree' }
type Context = { target: Target; identity: string }
type History = { projectId: string; identity: string; anchor: string; failed: Entry[]; finished: boolean; controller: AbortController }

/** Keeps retry inputs in the main process and revalidates both endpoints before every retry. */
export class DownloadManager {
  private histories = new Map<string, History>()
  private pending = new Set<Promise<void>>()
  constructor(private context: (projectId: string) => Context, private update: (snapshot: TransferSnapshot) => void) {}

  async start(projectId: string, source: string, destination: string, directory: boolean): Promise<string> {
    const anchor = await fs.realpath(directory ? destination : path.dirname(destination))
    const entry: Entry = { source, destination: directory ? anchor : path.join(anchor, path.basename(destination)), kind: directory ? 'tree' : 'file' }
    return this.run(projectId, anchor, [entry])
  }
  cancel(id: string): void { this.histories.get(id)?.controller.abort() }
  dismiss(id: string): void { if (this.histories.get(id)?.finished) this.histories.delete(id) }
  has(id: string): boolean { return this.histories.has(id) }
  async shutdown(): Promise<void> {
    for (const history of this.histories.values()) history.controller.abort()
    await Promise.allSettled([...this.pending])
  }
  retry(id: string): string {
    const history = this.histories.get(id)
    if (!history?.finished || !history.failed.length) throw new Error(t("没有可重试的失败项"))
    if (this.context(history.projectId).identity !== history.identity) throw new Error(t("项目环境已更改"))
    return this.run(history.projectId, history.anchor, history.failed)
  }

  private run(projectId: string, anchor: string, entries: Entry[]): string {
    const { target, identity } = this.context(projectId)
    for (const [id, record] of this.histories) if (this.histories.size >= 50 && record.finished) this.histories.delete(id)
    const id = randomUUID(), controller = new AbortController()
    const history: History = { projectId, identity, anchor, controller, failed: [], finished: false }
    this.histories.set(id, history)
    const snapshot: TransferSnapshot = { id, projectId, state: 'running', current: '', destination: entries[0].destination, bytes: 0, total: 0, items: [], direction: 'download' }
    const emit = () => this.update({ ...snapshot, items: snapshot.items.map((item) => ({ ...item })) })
    let last = 0
    const progress = (source: string, bytes: number) => { snapshot.current = source; snapshot.bytes = bytes; if (Date.now() - last > 100) { last = Date.now(); emit() } }
    const result = (entry: Entry, error?: string) => {
      if (error) history.failed.push(entry)
      snapshot.items.push({ source: entry.source, destination: entry.destination, status: error ? 'failed' : 'done', ...(error ? { error } : {}) }); emit()
    }
    const check = async (entry: Entry) => {
      if (controller.signal.aborted) throw new Error(t("传输已取消"))
      if (this.context(projectId).identity !== identity) throw new Error(t("项目环境已更改"))
      const parent = entry.kind === 'tree' ? entry.destination : path.dirname(entry.destination)
      const relative = path.relative(anchor, parent)
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(t("下载位置超出所选目录"))
      const real = await fs.realpath(parent)
      if (process.platform === 'win32' ? real.toLowerCase() !== parent.toLowerCase() : real !== parent) throw new Error(t("下载位置已更改或包含链接"))
    }
    const completion = new Promise<void>((done) => setImmediate(() => {
      emit()
      void (async () => {
        for (const entry of entries) {
          if (controller.signal.aborted) break
          snapshot.current = entry.source; snapshot.destination = entry.destination; snapshot.bytes = 0; emit()
          try {
            await check(entry)
            if (entry.kind === 'tree') {
              await downloadRemoteDirectory(target, entry.source, entry.destination, controller.signal, progress, (source, destination, error, directory) => result({ source, destination, kind: directory ? 'directory' : 'file' }, error))
            } else {
              if (entry.kind === 'directory') await fs.mkdir(entry.destination)
              else await downloadRemoteFile(target, entry.source, entry.destination, controller.signal, (bytes) => progress(entry.source, bytes))
              result(entry)
            }
          } catch (error) {
            if (!controller.signal.aborted) result(entry, (error as NodeJS.ErrnoException).code === 'EEXIST' ? t("目标已存在，请选择新的文件名或目录") : error instanceof Error ? error.message : t("下载失败"))
          }
        }
      })().finally(() => { snapshot.state = controller.signal.aborted ? 'cancelled' : 'completed'; history.finished = true; emit(); done() })
    }))
    this.pending.add(completion)
    void completion.then(() => this.pending.delete(completion))
    return id
  }
}
