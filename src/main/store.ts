import { CODE_FONTS, UI_FONTS } from '../shared/fonts'
import { setLanguage } from '../shared/i18n'
import { THEMES } from '../shared/themes'
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { Database, Executor, Host, Project, SavedTerm, Settings, ShellKind, WorkSession } from '../shared/types'
import { hostColor, nextHostColor } from '../shared/host-colors'
import { cleanSessions, legacySessionId } from '../shared/work-sessions'
import { PRESETS, uid } from '../shared/types'
import { publicHost } from './credentials'
import { hostPlatform, osLabel } from './platform'

function file(): string {
  return path.join(app.getPath('userData'), 'workbench.json')
}

export function defaultDatabase(): Database {
  const local: Host = {
    id: 'local',
    name: '本机',
    addr: '',
    user: '',
    os: osLabel(),
    on: true,
    port: 22,
    platform: hostPlatform(),
    auth: 'key', color: 'blue'
  }
  return {
    settings: {
      language: 'zh-CN',
      theme: 'dark',
      layout: 'focus',
      fontSize: 13, fontFamily: 'Cascadia Mono', uiFontFamily: 'Geist', uiFontSize: 13, editorFontSize: 14,
      defShell: hostPlatform() === 'linux' ? 'bash' : 'pwsh',
      defAgent: 'claude',
      restore: true,
      confirmKill: true,
      autoCheckUpdates: true
    },
    custom: [],
    hosts: [local],
    projects: [],
    sessions: {},
    activeTab: {}, workSessions: {}, activeSession: {}
  }
}

function asBool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}

function asShell(value: unknown): ShellKind {
  if (value === 'cmd' || value === 'pwsh' || value === 'bash' || value === 'zsh') return value
  return hostPlatform() === 'linux' ? 'bash' : 'pwsh'
}

function sanitize(raw: Partial<Database> | null): Database {
  const base = defaultDatabase()
  if (!raw || typeof raw !== 'object') return base
  const settings = (raw.settings || {}) as Partial<Settings>
  base.settings = {
    language: settings.language === 'en' ? 'en' : 'zh-CN',
    theme: THEMES.some((theme) => theme.id === settings.theme) ? settings.theme! : 'dark',
    layout: ['balanced', 'focus', 'review'].includes(settings.layout || '') ? settings.layout : 'focus',
    panelSide: settings.panelSide === 'left' ? 'left' : 'right',
    density: settings.density === 'compact' ? 'compact' : 'comfortable',
    fontSize: Number.isInteger(settings.fontSize) && Number(settings.fontSize) >= 10 && Number(settings.fontSize) <= 24 ? Number(settings.fontSize) : 13,
    fontFamily: CODE_FONTS.some((family) => family === settings.fontFamily) ? settings.fontFamily : 'Cascadia Mono',
    uiFontFamily: UI_FONTS.some((family) => family === settings.uiFontFamily) ? settings.uiFontFamily : 'Geist',
    uiFontSize: [12, 13, 14, 15, 16].includes(Number(settings.uiFontSize)) ? settings.uiFontSize : 13,
    editorFontSize: Number.isInteger(settings.editorFontSize) && Number(settings.editorFontSize) >= 10 && Number(settings.editorFontSize) <= 24 ? settings.editorFontSize : 14,
    defShell: asShell(settings.defShell),
    defAgent: typeof settings.defAgent === 'string' && settings.defAgent ? settings.defAgent : 'claude',
    restore: asBool(settings.restore, true),
    confirmKill: asBool(settings.confirmKill, true),
    autoCheckUpdates: asBool(settings.autoCheckUpdates, true)
  }
  if (Array.isArray(raw.custom)) base.custom = raw.custom.filter(isExecutor)
  if (Array.isArray(raw.hosts) && raw.hosts.length) {
    const hosts = raw.hosts.filter(isHost)
    if (!hosts.some((h) => h.id === 'local')) hosts.unshift(base.hosts[0])
    else {
      const local = hosts.find((h) => h.id === 'local')!
      local.name = local.name || '本机'
      local.on = true
      local.platform = hostPlatform()
      local.os = local.os || osLabel()
    }
    base.hosts = hosts
  }
  if (Array.isArray(raw.projects)) base.projects = raw.projects.filter(isProject).map((project) => ({ ...project, pinned: project.pinned === true ? true : undefined }))
  if (raw.treeIgnores && typeof raw.treeIgnores === 'object' && !Array.isArray(raw.treeIgnores)) {
    base.treeIgnores = {}
    for (const project of base.projects) {
      const rules = raw.treeIgnores[project.id]
      if (validTreeIgnores(rules)) base.treeIgnores[project.id] = [...new Set(rules)]
    }
  }
  const supported = new Set(['shell', ...PRESETS.map((preset) => preset.id), ...base.custom.map((executor) => executor.id)])
  if (!supported.has(base.settings.defAgent)) base.settings.defAgent = 'claude'
  base.projects = base.projects.map((project) => supported.has(project.agent) ? project : { ...project, agent: 'shell' })
  const coloredHosts: Host[] = []
  for (const host of base.hosts) coloredHosts.push(publicHost({ ...host, color: host.color ? hostColor(host.color) : nextHostColor(coloredHosts) }))
  base.hosts = coloredHosts
  const sessions: Database['sessions'] = {}
  const activeTab: Record<string, string> = {}
  if (raw.sessions && typeof raw.sessions === 'object') {
    for (const [id, list] of Object.entries(raw.sessions)) {
      if (!Array.isArray(list)) continue
      const terms = normalizeTerms(list).map((term) => supported.has(term.kind) ? term : { ...term, kind: 'shell' })
      if (terms.length) sessions[id] = terms
    }
  }
  for (const [id, terms] of Object.entries(sessions)) {
    const wanted = wantedActive(raw.activeTab, id)
    activeTab[id] = terms.some((term) => term.id === wanted) ? wanted : terms[0].id
  }
  base.sessions = sessions
  base.activeTab = activeTab
  for (const project of base.projects) {
    writeSessions(base, project.id, sessions[project.id] || [], activeTab[project.id], raw.workSessions?.[project.id], raw.activeSession?.[project.id])
  }
  return base
}

export function validTreeIgnores(rules: unknown): rules is string[] {
  return Array.isArray(rules) && rules.length <= 100 && rules.every((item) => typeof item === 'string' && !!item && item.length <= 255 && !/[\\/\0]/.test(item) && item !== '.' && item !== '..')
}

function wantedActive(raw: unknown, projectId: string): string {
  if (typeof raw === 'string') return raw
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const value = (raw as Record<string, unknown>)[projectId]
    if (typeof value === 'string') return value
  }
  return ''
}

function normalizeTerms(list: unknown[]): SavedTerm[] {
  const seen = new Set<string>()
  const terms: SavedTerm[] = []
  for (const item of list) {
    if (!isSaved(item)) continue
    let id = typeof item.id === 'string' ? item.id : ''
    if (!id || seen.has(id)) id = uid('t')
    seen.add(id)
    terms.push({ id, kind: item.kind, shell: item.shell, ...(typeof item.sessionId === 'string' && item.sessionId ? { sessionId: item.sessionId.slice(0, 160) } : {}), ...(typeof item.agentSessionId === 'string' && item.agentSessionId ? { agentSessionId: item.agentSessionId.slice(0, 512) } : {}), ...(typeof item.name === 'string' && item.name.trim() ? { name: [...item.name.trim()].filter((char) => char.codePointAt(0)! >= 32).join('').slice(0, 80) } : {}) })
  }
  return terms
}

export function writeSessions(draft: Database, projectId: string, terms: unknown, activeId?: string | null, groups?: WorkSession[], selected?: string): void {
  const clean = Array.isArray(terms) ? normalizeTerms(terms) : []
  const sessions = cleanSessions(groups ?? draft.workSessions?.[projectId])
  if (clean.length && !sessions.length) sessions.push({ id: legacySessionId(projectId), name: '会话一' })
  for (const term of clean) if (!sessions.some((session) => session.id === term.sessionId)) term.sessionId = sessions[0].id
  draft.workSessions ??= {}
  draft.activeSession ??= {}
  draft.workSessions[projectId] = sessions
  const wantedSession = selected ?? draft.activeSession[projectId]
  const activeTerm = clean.find((term) => term.id === activeId)
  const selectedId = sessions.find((session) => session.id === wantedSession)?.id || activeTerm?.sessionId || sessions[0]?.id
  if (selectedId) draft.activeSession[projectId] = selectedId
  else delete draft.activeSession[projectId]
  for (const session of sessions) {
    const mine = clean.filter((term) => term.sessionId === session.id)
    const wanted = activeTerm?.sessionId === session.id ? activeId : session.activeTab
    session.activeTab = mine.find((term) => term.id === wanted)?.id || mine[0]?.id
  }
  if (clean.length) draft.sessions[projectId] = clean
  else delete draft.sessions[projectId]
  if (!clean.length) {
    delete draft.activeTab[projectId]
    return
  }
  const wanted = activeId === undefined ? draft.activeTab[projectId] || '' : activeId || ''
  draft.activeTab[projectId] = clean.some((term) => term.id === wanted) ? wanted : clean[0].id
}

function isExecutor(v: unknown): v is Executor {
  const e = v as Executor
  return !!e && typeof e.id === 'string' && typeof e.name === 'string' && typeof e.cmd === 'string'
}

function isHost(v: unknown): v is Host {
  const h = v as Host
  return !!h && typeof h.id === 'string' && typeof h.name === 'string'
}

function isProject(v: unknown): v is Project {
  const p = v as Project
  return !!p && typeof p.id === 'string' && typeof p.name === 'string' && typeof p.path === 'string'
}

function isSaved(v: unknown): v is { id?: string; kind: string; shell: ShellKind; name?: unknown; sessionId?: unknown; agentSessionId?: unknown } {
  const s = v as { id?: string; kind?: unknown; shell?: unknown }
  return !!s && typeof s.kind === 'string' && (s.shell === 'pwsh' || s.shell === 'cmd' || s.shell === 'bash' || s.shell === 'zsh')
}

function sessionsNeedSave(raw: Partial<Database>, next: Database): boolean {
  if (JSON.stringify(raw.workSessions || {}) !== JSON.stringify(next.workSessions || {}) || JSON.stringify(raw.activeSession || {}) !== JSON.stringify(next.activeSession || {})) return true
  if (typeof raw.activeTab === 'string') return true
  const rawSessions = raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : {}
  const keys = new Set([...Object.keys(rawSessions), ...Object.keys(next.sessions)])
  for (const id of keys) {
    const before = Array.isArray(rawSessions[id]) ? rawSessions[id] : []
    const after = next.sessions[id] || []
    if (before.length !== after.length) return true
    for (let i = 0; i < after.length; i++) {
      const item = before[i] as { id?: unknown; kind?: unknown; shell?: unknown }
      if (item?.id !== after[i].id || item?.kind !== after[i].kind || item?.shell !== after[i].shell) return true
    }
    if (wantedActive(raw.activeTab, id) !== (next.activeTab[id] || '')) return true
  }
  return false
}

export function loadDb(): Database {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8')) as Partial<Database>
    const next = sanitize(raw)
    if (sessionsNeedSave(raw, next) || Object.hasOwn(raw, 'plugins')) saveDb(next)
    return next
  } catch {
    return defaultDatabase()
  }
}

export function saveDb(db: Database): void {
  const dir = app.getPath('userData')
  fs.mkdirSync(dir, { recursive: true })
  const dest = file()
  const tmp = dest + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2))
  fs.renameSync(tmp, dest)
}

export function saveSettings(settings: Settings): Database {
  const next = { ...db(), settings: { ...settings, autoCheckUpdates: asBool(settings.autoCheckUpdates, true), language: settings.language === 'en' ? 'en' as const : 'zh-CN' as const } }
  saveDb(next)
  cache = next
  setLanguage(next.settings.language)
  return next
}

let cache: Database | null = null

export function db(): Database {
  if (!cache) { cache = loadDb(); setLanguage(cache.settings.language) }
  return cache
}

export function mutate(fn: (draft: Database) => void): Database {
  const draft = db()
  fn(draft)
  saveDb(draft)
  setLanguage(draft.settings.language)
  return draft
}
