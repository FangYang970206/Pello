import { Worker } from 'node:worker_threads'
import type { ContentSearchMatch } from '../shared/types'
import { scanContent } from '../shared/content-matches'
import { t } from '../shared/i18n'

export class SearchPatternError extends Error {}

/** User regular expressions never execute on Electron's main thread. */
export class SearchMatcher {
  private worker: Worker | null = null
  constructor(private pattern: RegExp, private regex: boolean, private signal: AbortSignal) {}
  async scan(text: string, remaining: number): Promise<ContentSearchMatch[]> {
    if (!this.regex) return scanContent(text, this.pattern.source, this.pattern.flags, remaining)
    this.worker ||= new Worker(`const { parentPort } = require('node:worker_threads'); const scan = ${scanContent.toString()}; parentPort.on('message', ({text,source,flags,remaining}) => parentPort.postMessage(scan(text,source,flags,remaining)));`, { eval: true })
    const worker = this.worker
    return new Promise((resolve, reject) => {
      const finish = (error?: Error, matches?: ContentSearchMatch[]) => {
        clearTimeout(timer)
        this.signal.removeEventListener('abort', abort)
        worker.removeAllListeners('message'); worker.removeAllListeners('error'); worker.removeAllListeners('exit')
        if (error) reject(error); else resolve(matches!)
      }
      const abort = () => { finish(new SearchPatternError(t("搜索已停止"))); this.dispose() }
      const timer = setTimeout(() => { finish(new SearchPatternError(t("正则表达式执行超时，请简化表达式"))); this.dispose() }, 500)
      this.signal.addEventListener('abort', abort, { once: true })
      worker.once('message', (matches: ContentSearchMatch[]) => finish(undefined, matches))
      worker.once('error', (error) => finish(new SearchPatternError(error.message)))
      worker.once('exit', () => finish(new SearchPatternError(t("搜索已停止"))))
      if (this.signal.aborted) { abort(); return }
      worker.postMessage({ text, source: this.pattern.source, flags: this.pattern.flags, remaining })
    })
  }
  dispose(): void { if (this.worker) { void this.worker.terminate(); this.worker = null } }
}
