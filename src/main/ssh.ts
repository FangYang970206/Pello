import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { Client, type ClientChannel } from 'ssh2'
import type { Host } from '../shared/types'
import { hostPassword, rememberPassword } from './credentials'
import { bashQuote } from './platform'

/** Password connections pin the first authenticated server key, like accept-new. */
export function connectPasswordHost(host: Host, signal?: AbortSignal): Promise<Client> {
  if (signal?.aborted) return Promise.reject(new Error('SSH 连接已取消'))
  const password = hostPassword(host)
  if (!password) return Promise.reject(new Error('请填写 SSH 登录密码'))
  const file = path.join(app.getPath('userData'), 'ssh-host-keys.json')
  const identity = JSON.stringify([host.addr, host.port || 22])
  let fingerprint = ''
  const known = (): Record<string, string> => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return {} }
  }
  return new Promise((resolve, reject) => {
    const client = new Client()
    let ready = false
    const abort = () => { client.destroy(); reject(new Error('SSH 连接已取消')) }
    signal?.addEventListener('abort', abort, { once: true })
    client.on('error', (error: Error) => {
      if (!ready) { client.end(); reject(error) }
    })
    client.once('close', () => {
      signal?.removeEventListener('abort', abort)
      if (!ready) reject(new Error('SSH 连接在认证完成前关闭'))
    })
    client.once('ready', () => {
      try {
        const keys = known()
        if (keys[identity] && keys[identity] !== fingerprint) throw new Error('SSH 主机密钥已改变')
        keys[identity] = fingerprint
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, JSON.stringify(keys, null, 2))
        rememberPassword(host)
        ready = true
        resolve(client)
      } catch (error) { client.end(); reject(error) }
    })
    client.connect({
      host: host.addr, port: host.port || 22, username: host.user, password,
      readyTimeout: 12000, keepaliveInterval: 15000, tryKeyboard: true,
      hostHash: 'sha256',
      hostVerifier: (hash: string) => {
        fingerprint = hash
        const previous = known()[identity]
        return !previous || previous === hash
      }
    })
    client.on('keyboard-interactive', (_name, _instructions, _language, prompts, finish) => {
      // Keyboard-interactive password auth is common on PAM-enabled SSH servers.
      if (prompts.length === 1 && !prompts[0].echo && /password/i.test(prompts[0].prompt)) finish([password])
      else finish([])
    })
  })
}

export function remoteCommand(host: Host, args: string[]): string {
  if (host.platform !== 'windows') return args.map(bashQuote).join(' ')
  const scriptAt = args.indexOf('-Command')
  if (args[0] === 'powershell.exe' && scriptAt > 0) {
    return `${args.slice(0, scriptAt).join(' ')} -EncodedCommand ${Buffer.from(args[scriptAt + 1], 'utf16le').toString('base64')}`
  }
  return args.map((arg) => /[\s"]/u.test(arg) ? `"${arg.replaceAll('"', '\\"')}"` : arg).join(' ')
}

export async function runPasswordCommand(host: Host, command: string, input?: string): Promise<string> {
  const client = await connectPasswordHost(host)
  return await new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => { client.destroy(); reject(new Error('远程命令执行超时')) }, 20000)
    const fail = (error: Error) => { clearTimeout(timer); client.end(); reject(error) }
    client.once('error', fail)
    client.exec(command, (error, stream) => {
      if (error) return fail(error)
      stream.on('data', (data: Buffer) => {
        stdout += data.toString()
        if (Buffer.byteLength(stdout) > 12_000_000) fail(new Error('远程输出过大'))
      })
      stream.stderr.on('data', (data: Buffer) => { stderr = (stderr + data.toString()).slice(-16000) })
      stream.on('error', fail)
      stream.on('close', (code: number) => {
        clearTimeout(timer)
        client.end()
        if (code === 0) resolve(stdout)
        else reject(Object.assign(new Error(stderr.trim() || (code == null ? 'SSH 连接在命令结束前关闭' : `远程命令退出码 ${code}`)), { stdout, stderr }))
      })
      if (input !== undefined) stream.end(input)
    })
  })
}

export interface TerminalProcess {
  pid: number | null
  write(data: string | Buffer): void
  resize(cols: number, rows: number): void
  kill(): void
  onData(cb: (data: string) => void): unknown
  onExit(cb: (event: { exitCode: number }) => void): unknown
}

export async function passwordTerminal(host: Host, boot: string[], signal: AbortSignal): Promise<TerminalProcess> {
  const client = await connectPasswordHost(host, signal)
  try {
    const stream = await new Promise<ClientChannel>((resolve, reject) => {
      client.exec(remoteCommand(host, boot), { pty: { term: 'xterm-256color', cols: 80, rows: 24, width: 0, height: 0 } },
        (error, channel) => error ? reject(error) : resolve(channel))
    })
    let code = 1
    stream.on('error', () => { code = 1; client.end(); stream.destroy() })
    client.on('error', () => { code = 1; stream.destroy() })
    stream.on('exit', (exitCode: number) => { code = exitCode ?? 1 })
    stream.once('close', () => client.end())
    return {
      pid: null,
      write: (data) => { stream.write(data) },
      resize: (cols, rows) => stream.setWindow(rows, cols, 0, 0),
      kill: () => { if (!stream.destroyed) { stream.signal('HUP'); stream.close() }; client.end() },
      onData: (cb) => { stream.on('data', (data: Buffer) => cb(data.toString())); stream.stderr.on('data', (data: Buffer) => cb(data.toString())) },
      onExit: (cb) => stream.once('close', () => cb({ exitCode: code }))
    }
  } catch (error) { client.end(); throw error }
}
