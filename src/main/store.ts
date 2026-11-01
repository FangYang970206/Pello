import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { Database, Executor, Host, Plugin, Project, SavedTerm, Settings, ShellKind } from '../shared/types'
import { DEFAULT_PLUGINS, uid } from '../shared/types'
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
    auth: 'key'
  }
  return {
    settings: {
      theme: 'dark',
      fontSize: 13,
      defShell: hostPlatform() === 'linux' ? 'bash' : 'pwsh',
      defAgent: 'claude',
      restore: true,
      confirmKill: true
    },
    custom: [],
    hosts: [local],
    plugins: DEFAULT_PLUGINS.map((p) => ({ ...p })),
    projects: [],
    sessions: {},
    activeTab: {}
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
    theme: settings.theme === 'light' ? 'light' : 'dark',
    fontSize: [12, 13, 14, 15].includes(Number(settings.fontSize)) ? Number(settings.fontSize) : 13,
    defShell: asShell(settings.defShell),
    defAgent: typeof settings.defAgent === 'string' && settings.defAgent ? settings.defAgent : 'claude',
    restore: asBool(settings.restore, true),
    confirmKill: asBool(settings.confirmKill, true)
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
  if (Array.isArray(raw.plugins) && raw.plugins.length) base.plugins = raw.plugins.filter(isPlugin)
  if (Array.isArray(raw.projects)) base.projects = raw.projects.filter(isProject)
  const sessions: Database['sessions'] = {}
  const activeTab: Record<string, string> = {}
  if (raw.sessions && typeof raw.sessions === 'object') {
    for (const [id, list] of Object.entries(raw.sessions)) {
      if (!Array.isArray(list)) continue
      const terms = normalizeTerms(list)
      if (terms.length) sessions[id] = terms
    }
  }
  for (const [id, terms] of Object.entries(sessions)) {
    const wanted = wantedActive(raw.activeTab, id)
    activeTab[id] = terms.some((term) => term.id === wanted) ? wanted : terms[0].id
  }
  base.sessions = sessions
  base.activeTab = activeTab
  return base
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
    terms.push({ id, kind: item.kind, shell: item.shell })
  }
  return terms
}

export function writeSessions(draft: Database, projectId: string, terms: unknown, activeId?: string | null): void {
  const clean = Array.isArray(terms) ? normalizeTerms(terms) : []
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

function isPlugin(v: unknown): v is Plugin {
  const p = v as Plugin
  return !!p && typeof p.id === 'string' && typeof p.name === 'string'
}

function isProject(v: unknown): v is Project {
  const p = v as Project
  return !!p && typeof p.id === 'string' && typeof p.name === 'string' && typeof p.path === 'string'
}

function isSaved(v: unknown): v is { id?: string; kind: string; shell: ShellKind } {
  const s = v as { id?: string; kind?: unknown; shell?: unknown }
  return !!s && typeof s.kind === 'string' && (s.shell === 'pwsh' || s.shell === 'cmd' || s.shell === 'bash' || s.shell === 'zsh')
}

function sessionsNeedSave(raw: Partial<Database>, next: Database): boolean {
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
    if (sessionsNeedSave(raw, next)) saveDb(next)
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

let cache: Database | null = null

export function db(): Database {
  if (!cache) cache = loadDb()
  return cache
}

export function mutate(fn: (draft: Database) => void): Database {
  const draft = db()
  fn(draft)
  saveDb(draft)
  return draft
}
