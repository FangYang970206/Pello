import type { WorkSession } from './types'

export const legacySessionId = (projectId: string) => `session:${projectId}`
export const sessionOf = (term: { projectId: string; sessionId?: string }) => term.sessionId || legacySessionId(term.projectId)
export function cleanSessions(value: unknown): WorkSession[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  return value.flatMap((item) => {
    if (!item || typeof item.id !== 'string' || !item.id || typeof item.name !== 'string') return []
    const id = item.id.slice(0, 160)
    const name = [...item.name.trim()].filter((char) => char.codePointAt(0)! >= 32).join('').slice(0, 80)
    if (!name || seen.has(id)) return []
    seen.add(id)
    return [{ id, name, ...(typeof item.activeTab === 'string' ? { activeTab: item.activeTab } : {}) }]
  })
}
