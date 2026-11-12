import { t } from '../shared/i18n'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { TransferItem, TransferSnapshot } from '../shared/types'

import { ConflictPolicy, type ConflictChoice as Choice } from '../shared/file-conflicts'
type Task = { controller: AbortController; snapshot: TransferSnapshot; root: string; keepBoth: boolean; decide?: (choice: Choice, applyToBatch: boolean) => void; completion?: Promise<void> }
type Entry = { source: string; destination: string }

/** Tracks local imports. The caller is responsible for authorizing sources and validating the project destination. */
export class TransferManager {
  private tasks = new Map<string, Task>()
  private update: (snapshot: TransferSnapshot) => void
  constructor(update: (snapshot: TransferSnapshot) => void, private replace?: (projectId: string, destination: string, operation: () => Promise<void>, signal: AbortSignal) => Promise<void>) { this.update = update }

  start(sources: string[], destination: string, projectId = ''): string {
    if (!sources.length) throw new Error(t("请选择文件或文件夹"))
    return this.startEntries(sources.map((source) => ({ source, destination: path.join(destination, path.basename(source)) })), destination, projectId)
  }

  private startEntries(entries: Entry[], destination: string, projectId: string, keepBoth = false): string {
    for (const [key, task] of this.tasks) if (this.tasks.size >= 50 && (task.snapshot.state === 'completed' || task.snapshot.state === 'cancelled')) this.tasks.delete(key)
    const id = randomUUID()
    const task: Task = { controller: new AbortController(), root: destination, keepBoth, snapshot: { id, projectId, state: 'running', current: '', destination, bytes: 0, total: 0, items: [] } }
    this.tasks.set(id, task)
    task.completion = this.execute(task, entries, destination)
    return id
  }

  cancel(id: string): void { const task = this.tasks.get(id); task?.controller.abort(); task?.decide?.('cancel', false) }
  async shutdown(): Promise<void> {
    for (const id of this.tasks.keys()) this.cancel(id)
    await Promise.allSettled([...this.tasks.values()].map((task) => task.completion))
  }
  decide(id: string, choice: Choice, applyToBatch = false): void {
    const task = this.tasks.get(id)
    if (!task?.decide || !['skip', 'keep', 'cancel', 'merge', 'overwrite'].includes(choice)) throw new Error(t("没有等待处理的冲突"))
    new ConflictPolicy().validate(task.snapshot.items[0], choice)
    task.decide(choice, applyToBatch)
  }
  dismiss(id: string): void { const task = this.tasks.get(id); if (task && (task.snapshot.state === 'completed' || task.snapshot.state === 'cancelled')) this.tasks.delete(id) }
  context(id: string): { projectId: string; root: string } {
    const task = this.tasks.get(id)
    if (!task) throw new Error(t("传输任务不存在"))
    return { projectId: task.snapshot.projectId, root: task.root }
  }
  retry(id: string): string {
    const task = this.tasks.get(id)
    if (!task || (task.snapshot.state !== 'completed' && task.snapshot.state !== 'cancelled')) throw new Error(t("传输任务不存在或尚未结束"))
    const entries = task.snapshot.items.filter((item) => item.status === 'failed' && item.source && item.error !== '部分内容未能复制').map(({ source, destination }) => ({ source, destination }))
    if (!entries.length) throw new Error(t("没有可重试的失败项"))
    return this.startEntries(entries, task.root, task.snapshot.projectId)
  }
  keepBoth(id: string): string {
    const task = this.tasks.get(id)
    if (!task || (task.snapshot.state !== 'completed' && task.snapshot.state !== 'cancelled')) throw new Error(t("传输任务不存在或尚未结束"))
    const entries = task.snapshot.items.filter((item) => item.status === 'conflict').map(({ source, destination }) => ({ source, destination }))
    if (!entries.length) throw new Error(t("没有同名冲突项"))
    return this.startEntries(entries, task.root, task.snapshot.projectId, true)
  }
  private emit(task: Task): void { this.update({ ...task.snapshot, items: task.snapshot.items.map((item) => ({ ...item })) }) }

  private async execute(task: Task, entries: Entry[], destination: string): Promise<void> {
    const { signal } = task.controller
    let root = ''
    const merges = new Map<string, { dev: number; ino: number }>()
    const replacements = new Map<string, fs.Stats>()
    const observed = new Map<string, fs.Stats>()
    const skipped = new Set<string>()
    const kept = new Set<string>()
    const policy = new ConflictPolicy()
    const entryKey = (source: string, target: string) => `${path.resolve(source)}\0${path.resolve(target)}`
    const checkParent = async (target: string) => {
      const parent = path.dirname(target)
      const relative = path.relative(root, parent)
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(t("目标超出项目目录"))
      const resolved = await fsp.realpath(parent)
      const same = process.platform === 'win32' ? resolved.toLowerCase() === parent.toLowerCase() : resolved === parent
      if (!same) throw new Error(t("目标目录已变更或包含链接"))
    }
    const result = (source: string, target: string, status: TransferItem['status'], error?: string) => {
      task.snapshot.items.push({ source, destination: target, status, ...(error ? { error } : {}) })
      this.emit(task)
    }
    const alternate = (original: string, index: number, directory: boolean) => {
      const extension = directory ? '' : path.extname(original)
      const base = path.basename(original, extension)
      return path.join(path.dirname(original), `${base} (${index})${extension}`)
    }
    const copy = async (source: string, target: string): Promise<void> => {
      if (signal.aborted) return
      if (skipped.has(entryKey(source, target))) { result(source, target, 'conflict', t("已跳过同名对象")); return }
      const keepBoth = task.keepBoth || kept.has(entryKey(source, target))
      try {
        await checkParent(target)
        const info = await fsp.lstat(source)
        if (info.isSymbolicLink()) throw new Error(t("不导入符号链接"))
        if (path.resolve(source) === path.resolve(target)) throw new Error(t("不能覆盖来源文件自身"))
        if (info.isDirectory()) {
          const original = target
          for (let index = 0; ; index++) {
            const approved = merges.get(entryKey(source, target))
            if (approved) {
              const current = await fsp.lstat(target)
              if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== approved.dev || current.ino !== approved.ino) throw new Error(t("目标目录已变更，请重新检查"))
              await checkParent(path.join(target, '_'))
              break
            }
            try { await fsp.mkdir(target); break } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
              if (!keepBoth) { result(source, target, 'conflict'); return }
              if (index >= 10000) throw new Error(t("无法找到可用名称"), { cause: error })
              target = alternate(original, index + 1, true)
            }
          }
          const children = await fsp.readdir(source)
          const resultStart = task.snapshot.items.length
          for (const child of children) { if (signal.aborted) break; await copy(path.join(source, child), path.join(target, child)) }
          if (!signal.aborted) {
            const failed = task.snapshot.items.slice(resultStart).some((item) => item.status !== 'done')
            result(source, target, failed ? 'failed' : 'done', failed ? t("部分内容未能复制") : undefined)
          }
          return
        }
        if (!info.isFile()) throw new Error(t("不支持此文件类型"))
        task.snapshot.current = source; task.snapshot.destination = path.dirname(target); task.snapshot.bytes = 0; task.snapshot.total = info.size; this.emit(task)
        const temp = path.join(path.dirname(target), `.awb-transfer-${randomUUID()}.tmp`)
        let reserved = false
        try {
          const handle = await fsp.open(temp, 'wx'); reserved = true; await handle.close()
          const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) { task.snapshot.bytes += chunk.length; callback(null, chunk) } })
          meter.on('data', () => this.emit(task))
          await pipeline(fs.createReadStream(source), meter, fs.createWriteStream(temp), { signal })
          if (signal.aborted) return
          await checkParent(target)
          const expected = replacements.get(entryKey(source, target))
          if (expected) {
            if (!this.replace) throw new Error(t("覆盖保护不可用"))
            await this.replace(task.snapshot.projectId, target, async () => {
              if (signal.aborted) throw new Error(t("传输已取消"))
              await checkParent(target)
              const current = await fsp.lstat(target)
              if (!current.isFile() || current.isSymbolicLink() || current.dev !== expected.dev || current.ino !== expected.ino || current.size !== expected.size || current.mtimeMs !== expected.mtimeMs || current.ctimeMs !== expected.ctimeMs) throw new Error(t("目标文件已更改，请重新检查冲突"))
              await fsp.rename(temp, target)
            }, signal)
            result(source, target, 'done')
            return
          }
          const original = target
          for (let index = 0; ; index++) {
            try { await fsp.link(temp, target); break } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
              if (!keepBoth) { result(source, target, 'conflict'); return }
              if (index >= 10000) throw new Error(t("无法找到可用名称"), { cause: error })
              target = alternate(original, index + 1, false)
            }
          }
          result(source, target, 'done')
        } finally { if (reserved) await fsp.unlink(temp).catch(() => undefined) }
      } catch (error) {
        if (!signal.aborted) result(source, target, 'failed', error instanceof Error ? error.message : t("传输失败"))
      }
    }
    try {
      const realDestination = await fsp.realpath(destination)
      root = realDestination
      const chosen = entries
      if (!task.keepBoth) {
        const select = (item: TransferItem, choice: Choice) => {
          policy.validate(item, choice)
          const key = entryKey(item.source, item.destination)
          if (choice === 'skip') skipped.add(key)
          else if (choice === 'keep') kept.add(key)
          else if (choice === 'overwrite') replacements.set(key, observed.get(item.destination)!)
          else if (choice === 'merge') { const info = observed.get(item.destination)!; merges.set(key, { dev: info.dev, ino: info.ino }) }
        }
        const scan = async (): Promise<TransferItem[]> => {
          const found: TransferItem[] = [], seen = new Set<string>()
          const visit = async (source: string, output: string): Promise<void> => {
            if (signal.aborted) return
            const entry = entryKey(source, output)
            if (skipped.has(entry) || kept.has(entry) || replacements.has(entry)) return
            await checkParent(output)
            const key = process.platform === 'win32' ? output.toLowerCase() : output
            const duplicate = seen.has(key); seen.add(key)
            let targetInfo: Awaited<ReturnType<typeof fsp.lstat>> | null = null
            try { targetInfo = await fsp.lstat(output) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
            if (!targetInfo && !duplicate) return
            let sourceInfo: Awaited<ReturnType<typeof fsp.lstat>> | null = null
            try { sourceInfo = await fsp.lstat(source) } catch { /* Copy phase reports unavailable sources. */ }
            const mergeable = !!targetInfo?.isDirectory() && !targetInfo.isSymbolicLink() && !!sourceInfo?.isDirectory() && !sourceInfo.isSymbolicLink() && !duplicate
            const replaceable = !!this.replace && !!targetInfo?.isFile() && !targetInfo.isSymbolicLink() && !!sourceInfo?.isFile() && !sourceInfo.isSymbolicLink() && !duplicate
            const item: TransferItem = { source: path.resolve(source), destination: output, status: 'conflict', mergeable, replaceable }
            if (targetInfo) observed.set(output, targetInfo)
            const approved = merges.get(entry)
            if (approved && (!mergeable || targetInfo!.dev !== approved.dev || targetInfo!.ino !== approved.ino)) throw new Error(t("目标目录已更改，请重新检查"))
            if (!approved) {
              const remembered = policy.get(item)
              if (remembered) select(item, remembered)
              else { found.push(item); return }
            }
            if (merges.has(entry)) {
              await checkParent(path.join(output, '_'))
              for (const child of await fsp.readdir(source)) await visit(path.join(source, child), path.join(output, child))
            }
          }
          for (const entry of entries) await visit(path.resolve(entry.source), path.resolve(realDestination, path.relative(path.resolve(destination), path.resolve(entry.destination))))
          return found
        }
        const ask = async (conflicts: TransferItem[]): Promise<{ choice: Choice; apply: boolean }> => await new Promise((resolve) => {
          task.decide = (choice, apply) => { task.decide = undefined; resolve({ choice, apply }) }
          task.snapshot.items = [conflicts[0]]; task.snapshot.pendingConflicts = conflicts.length; task.snapshot.state = 'conflicts'; this.emit(task)
        })
        let conflicts = await scan()
        while (conflicts.length && !signal.aborted) {
          const { choice, apply } = await ask(conflicts)
          if (choice === 'cancel') { task.controller.abort(); break }
          if (apply) policy.remember(conflicts[0], choice)
          select(conflicts[0], choice)
          conflicts = await scan()
        }
        task.snapshot.items = []; task.snapshot.pendingConflicts = undefined
        if (!signal.aborted) { task.snapshot.state = 'running'; this.emit(task) }
      }
      for (const entry of chosen) {
        if (signal.aborted) break
        const absolute = path.resolve(entry.source)
        const output = path.resolve(realDestination, path.relative(path.resolve(destination), path.resolve(entry.destination)))
        try {
          const realSource = await fsp.realpath(absolute)
          const relative = path.relative(realSource, realDestination)
          if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) throw new Error(t("不能导入到来源目录自身或其子目录"))
          await copy(absolute, output)
        } catch (error) { if (!signal.aborted) result(absolute, output, 'failed', error instanceof Error ? error.message : t("传输失败")) }
      }
    } catch (error) { result('', destination, 'failed', error instanceof Error ? error.message : t("无法访问目标目录")) }
    task.snapshot.current = ''
    task.snapshot.state = signal.aborted ? 'cancelled' : 'completed'
    this.emit(task)
  }
}
