import { spawn } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import type { Host } from '../shared/types'
import { bashQuote, psQuote, sshBatchArgs } from './platform'
import { connectPasswordHost, remoteCommand } from './ssh'

/** Allocate a durable native thread without a model request, then attach the CLI by ID. */
export async function createCodexThread(cwd: string, host?: Host, signal?: AbortSignal): Promise<string> {
  let input: Writable, output: Readable, dispose: () => void
  const remote = host && host.id !== 'local'
  const boot = host?.platform === 'windows'
    ? ['powershell.exe', '-NoProfile', '-Command', `Set-Location -LiteralPath ${psQuote(cwd)}; codex --no-daemon app-server`]
    : ['bash', '-lc', `[ ! -f ~/.bashrc ] || source ~/.bashrc; cd -- ${bashQuote(cwd)} && codex --no-daemon app-server`]
  if (remote && host.auth === 'password') {
    const client = await connectPasswordHost(host)
    const stream = await new Promise<import('ssh2').ClientChannel>((resolve, reject) => client.exec(remoteCommand(host, boot), (error, stream) => error ? reject(error) : resolve(stream)))
    input = output = stream
    stream.stderr.resume()
    dispose = () => { stream.destroy(); client.end() }
  } else {
    const proc = remote
      ? spawn('ssh', sshBatchArgs(host, [remoteCommand(host, boot)]), { windowsHide: true })
      : spawn(process.platform === 'win32' ? 'codex.exe' : 'codex', ['--no-daemon', 'app-server'], { cwd, windowsHide: true, env: { ...process.env, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'pello' } })
    input = proc.stdin; output = proc.stdout
    proc.stderr.resume()
    // Some CLI launchers inherit pipe handles into a shared daemon. Close our
    // streams explicitly; never terminate that daemon or unrelated CLI sessions.
    dispose = () => { proc.stdin.destroy(); proc.stdout.destroy(); proc.stderr.destroy(); proc.kill(); proc.unref() }
    proc.on('error', (error) => output.destroy(error))
  }
  return new Promise<string>((resolve, reject) => {
    let pending = '', settled = false, threadId = ''
    const finish = (error?: Error, id?: string) => {
      if (settled) return
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort)
      dispose()
      if (error) reject(error)
      else resolve(id!)
    }
    const abort = () => finish(new Error('会话启动已取消'))
    const timer = setTimeout(() => finish(new Error('无法创建 Codex 原生会话，请检查 CLI 版本与连接')), 20000)
    signal?.addEventListener('abort', abort, { once: true })
    input.on('error', (error) => finish(error))
    output.on('error', (error) => finish(error))
    output.on('end', () => finish(new Error('Codex 在创建会话前退出')))
    output.setEncoding('utf8')
    const send = (message: object) => input.write(JSON.stringify(message) + '\n')
    output.on('data', (data: string) => {
      pending += data
      if (pending.length > 2_000_000) { finish(new Error('Codex 会话响应过大')); return }
      let end: number
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1)
        let response: { id?: number; error?: { message?: string }; result?: { thread?: { id?: string } } }
        try { response = JSON.parse(line) } catch { continue }
        if (![1, 2, 3].includes(response.id!)) continue
        if (response.error) { finish(new Error(response.error.message || 'Codex 会话初始化失败')); return }
        if (response.id === 1) {
          send({ method: 'initialized' })
          send({ id: 2, method: 'thread/start', params: { cwd, persistExtendedHistory: true } })
        } else if (response.id === 2) {
          const id = response.result?.thread?.id
          if (!id || !/^[\w-]{1,160}$/.test(id)) finish(new Error('Codex 未返回有效会话 ID'))
          else { threadId = id; send({ id: 3, method: 'thread/name/set', params: { threadId: id, name: 'Pello' } }) }
        } else finish(undefined, threadId)
      }
    })
    if (signal?.aborted) { abort(); return }
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'pello', version: '0.1' } } })
  })
}
