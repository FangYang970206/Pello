import { t } from '../shared/i18n'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

export interface NativeConversation { id: string; file: string; messages: string[] }
const normalize = (text: string) => text.replace(/\s+/gu, '')
const exec = promisify(execFile)

export async function openCodeConversations(cwd: string, environment: NodeJS.ProcessEnv, run?: (args: string[]) => Promise<string>): Promise<NativeConversation[]> {
  const invoke = run || (async (args: string[]) => {
    if (args.some((arg) => !/^[\w-]+$/.test(arg))) throw new Error(t("OpenCode 会话参数无效"))
    const command = `opencode session ${args.join(' ')}`
    const windows = process.platform === 'win32'
    const result = await exec(windows ? 'powershell.exe' : 'bash', windows ? ['-NoProfile', '-Command', command] : ['-lc', `[ ! -f ~/.bashrc ] || source ~/.bashrc; ${command}`], { cwd, env: environment, windowsHide: true, timeout: 20000, maxBuffer: 32_000_000 })
    return result.stdout
  })
  const rows = JSON.parse(await invoke(['list', '--format', 'json', '--max-count', '2147483647'])) as { id: string; directory?: string }[]
  const conversations: NativeConversation[] = []
  for (const row of rows) {
    const actual = row.directory ? path.resolve(row.directory) : '', expected = path.resolve(cwd)
    if (!actual || (process.platform === 'win32' ? actual.toLowerCase() !== expected.toLowerCase() : actual !== expected)) continue
    const exported = JSON.parse(await invoke(['export', row.id])) as { messages?: { info?: { role?: string }; parts?: { type?: string; text?: string }[] }[] }
    const messages = (exported.messages || []).filter((message) => ['user', 'assistant'].includes(message.info?.role || '')).map((message) => (message.parts || []).filter((part) => part.type === 'text').map((part) => part.text || '').join('\n'))
    conversations.push({ id: row.id, file: '', messages })
  }
  return conversations
}

/** Require a unique content match; recency is not evidence of terminal ownership. */
export function matchLegacyConversation(history: string, candidates: NativeConversation[]): NativeConversation | null {
  const visible = normalize(history)
  const normalized = candidates.map((candidate) => ({ candidate, messages: candidate.messages.map(normalize) }))
  const matches = normalized.filter(({ candidate, messages }) => {
    for (const value of messages) {
      if (value.length < 8) continue
      const size = Math.min(32, value.length)
      for (const start of new Set([0, Math.floor((value.length - size) / 2), value.length - size])) {
        const snippet = value.slice(start, start + size)
        if (visible.includes(snippet) && !normalized.some((other) => other.candidate.id !== candidate.id && other.messages.some((message) => message.includes(snippet)))) return true
      }
    }
    return false
  })
  return new Set(matches.map((entry) => entry.candidate.id)).size === 1 ? matches[0].candidate : null
}

async function* nativeFiles(directory: string): AsyncGenerator<string> {
  let entries: fs.Dirent[]
  try { entries = await fs.promises.readdir(directory, { withFileTypes: true }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  for (const entry of entries) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) yield* nativeFiles(file)
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) yield file
  }
}

function messageText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.map((block) => block && typeof block === 'object' && 'text' in block && typeof block.text === 'string' ? block.text : '').join('\n')
}

export async function legacyConversations(kind: string, cwd: string, environment: NodeJS.ProcessEnv = process.env): Promise<NativeConversation[]> {
  if (kind === 'opencode') return openCodeConversations(cwd, environment)
  const home = environment.USERPROFILE || environment.HOME || os.homedir()
  const roots: Record<string, string> = {
    claude: path.join(environment.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'projects'),
    codex: path.join(environment.CODEX_HOME || path.join(home, '.codex'), 'sessions'),
    pi: environment.PI_CODING_AGENT_SESSION_DIR || path.join(environment.PI_CODING_AGENT_DIR || path.join(home, '.pi', 'agent'), 'sessions'),
    omp: path.join(environment.PI_CODING_AGENT_DIR || path.join(home, '.omp', 'agent'), 'sessions')
  }
  const root = roots[kind]
  if (!root) return []
  const samePath = (value: string) => {
    const a = path.resolve(value), b = path.resolve(cwd)
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
  }
  const results: NativeConversation[] = []
  for await (const file of nativeFiles(root)) {
    const stream = fs.createReadStream(file, 'utf8'), lines = createInterface({ input: stream, crlfDelay: Infinity })
    let id = '', belongs = false
    const messages: string[] = []
    try {
      for await (const line of lines) {
        let row: { type?: string; id?: string; cwd?: string; sessionId?: string; isSidechain?: boolean; message?: { role?: string; content?: unknown }; payload?: { cwd?: string; id?: string; session_id?: string; source?: unknown; role?: string; content?: unknown; type?: string; message?: string } }
        try { row = JSON.parse(line) } catch { continue }
        if (row.isSidechain || (row.type === 'session_meta' && typeof row.payload?.source === 'object')) break
        const directory = row.cwd || row.payload?.cwd
        if (directory) {
          if (!samePath(directory)) break
          belongs = true
          id ||= row.sessionId || row.payload?.session_id || row.payload?.id || (row.type === 'session' ? row.id : '') || path.basename(file, '.jsonl')
        }
        if (!belongs) continue
        const message = row.message || row.payload
        if (message && ['user', 'assistant'].includes(message.role || '')) {
          const text = messageText(message.content)
          if (text) messages.push(text)
        }
        if (row.type === 'event_msg' && ['user_message', 'agent_message'].includes(row.payload?.type || '') && row.payload?.message) messages.push(row.payload.message)
      }
    } finally { lines.close(); stream.destroy() }
    if (belongs && id && messages.length) results.push({ id, file, messages })
  }
  return results
}
