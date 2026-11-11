import { createHash, randomUUID } from 'node:crypto'

export function validAgentSession(value?: string | null): string | null {
  return typeof value === 'string' && /^[\w:./@+-]{1,512}$/.test(value) ? value : null
}

/** Resume only a terminal's own conversation, never the latest one in its project. */
export function agentResumeCommand(kind: string, command: string, session: string | undefined, directory: string, quote: (text: string) => string): { command: string; session?: string } {
  const id = validAgentSession(session)
  if (kind === 'claude') {
    const next = id || randomUUID()
    return { command: `${command} ${id ? '--resume' : '--session-id'} ${quote(next)}`, session: next }
  }
  if (kind === 'codex' && id) return { command: `${command} resume ${quote(id)} --no-daemon`, session: id }
  if (kind === 'opencode') {
    const next = id || `ses_${randomUUID().replaceAll('-', '')}`
    return { command: `${command} --session ${quote(next)}`, session: next }
  }
  if (kind === 'pi' || kind === 'omp') {
    if (id && !id.startsWith('pello:')) return { command: `${command} ${kind === 'pi' ? '--session' : '--resume'} ${quote(id)}`, session: id }
    // These CLIs don't consistently publish an ID. Each terminal gets its own
    // native session directory, including /new and /resume within that terminal.
    return { command: `${command} --session-dir ${directory} --continue`, session: id || 'pello:directory' }
  }
  return { command, ...(id ? { session: id } : {}) }
}

export function terminalSessionKey(id: string): string {
  return createHash('sha256').update(id).digest('hex')
}
