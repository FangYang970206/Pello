import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'

type Activity = 'working' | 'waiting' | 'clear'
type LifecycleReport = { state: Activity; sessionId?: string }
const listeners = new Map<string, (report: LifecycleReport) => void>()
let endpoint: Promise<number> | undefined

function listen(): Promise<number> {
  endpoint ??= new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      const match = /^\/([a-f0-9]{48})\/(working|waiting|clear)$/.exec(request.url || '')
      const callback = match && listeners.get(match[1])
      if (request.method !== 'POST' || !callback) { response.writeHead(404).end(); return }
      // Hook bodies can contain prompts. Discard them without retaining or logging.
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => {
        if (body.length < 1024) body += chunk
      })
      request.on('end', () => {
        let sessionId: string | undefined
        try {
          const parsed = JSON.parse(body) as { session_id?: unknown }
          if (typeof parsed.session_id === 'string' && parsed.session_id) sessionId = parsed.session_id
        } catch {
          // Hooks may send an empty body.
        }
        callback(sessionId ? { state: match![2] as Activity, sessionId } : { state: match![2] as Activity })
        response.writeHead(200, { 'Content-Type': 'application/json' }).end('{}')
      })
    })
    server.requestTimeout = 5000
    server.keepAliveTimeout = 1000
    server.once('error', (error) => { endpoint = undefined; reject(error) })
    server.listen(0, '127.0.0.1', () => { server.unref(); resolve((server.address() as { port: number }).port) })
  })
  return endpoint
}

/** Per-launch hooks supplement native OSC without changing the user's Claude settings. */
export async function claudeLifecycle(callback: (report: LifecycleReport) => void) {
  const port = await listen(), token = randomBytes(24).toString('hex')
  listeners.set(token, callback)
  const hook = (state: Activity) => [{ hooks: [{ type: 'http', url: `http://127.0.0.1:${port}/${token}/${state}`, timeout: 2 }] }]
  const settings = { hooks: {
    SessionStart: hook('waiting'), UserPromptSubmit: hook('working'), PreToolUse: hook('working'), PostToolUse: hook('working'),
    Stop: hook('waiting'), StopFailure: hook('waiting'), PermissionRequest: hook('waiting'),
    Notification: [{ matcher: 'idle_prompt|permission_prompt|elicitation_dialog|auth_success', ...hook('waiting')[0] }], SessionEnd: hook('clear')
  } }
  return { settings, dispose: () => { listeners.delete(token) } }
}

export function nativeAgent(app?: string): string | undefined {
  return ({ claude: 'claude', 'claude-code': 'claude', codex: 'codex', opencode: 'opencode', pi: 'pi', omp: 'omp', 'oh-my-pi': 'omp' } as Record<string, string>)[app || '']
}

export function submittedAgent(command: string): string | undefined {
  if (/[\r\n;|`]/.test(command) || command.includes('&&')) return
  const match = /^\s*(?:&\s*)?(?:"([^"]+)"|'([^']+)'|([^\s&]+))/.exec(command)
  const executable = (match?.[1] || match?.[2] || match?.[3] || '').split(/[\\/]/).pop()?.replace(/\.(exe|cmd|ps1|bat)$/i, '').toLowerCase()
  return nativeAgent(executable)
}
