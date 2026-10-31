import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { Database, Executor, Host, Plugin, Project, SavedTerm, Settings } from '../shared/types'
import { DEFAULT_PLUGINS } from '../shared/types'
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
      defShell: 'pwsh',
      defAgent: 'claude',
      restore: true,
      confirmKill: true
    },
    custom: [],
    hosts: [local],
    plugins: DEFAULT_PLUGINS.map((p) => ({ ...p })),
    projects: [],
    sessions: {}
  }
}

function asBool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}

function sanitize(raw: Partial<Database> | null): Database {
  const base = defaultDatabase()
  if (!raw || typeof raw !== 'object') return base
  const settings = (raw.settings || {}) as Partial<Settings>
  base.settings = {
    theme: settings.theme === 'light' ? 'light' : 'dark',
    fontSize: [12, 13, 14, 15].includes(Number(settings.fontSize)) ? Number(settings.fontSize) : 13,
    defShell: settings.defShell === 'cmd' ? 'cmd' : 'pwsh',
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
  if (raw.sessions && typeof raw.sessions === 'object') {
    const sessions: Database['sessions'] = {}
    for (const [id, list] of Object.entries(raw.sessions)) {
      if (!Array.isArray(list)) continue
      sessions[id] = list.filter(isSaved)
    }
    base.sessions = sessions
  }
  return base
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

function isSaved(v: unknown): v is SavedTerm {
  const s = v as SavedTerm
  return !!s && typeof s.kind === 'string' && (s.shell === 'pwsh' || s.shell === 'cmd' || s.shell === 'bash')
}

export function loadDb(): Database {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8')) as Partial<Database>
    return sanitize(raw)
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
