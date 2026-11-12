import { t } from '../shared/i18n'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import { parse as parseJson, modify, applyEdits, type ParseError } from 'jsonc-parser'
import { parse as parseYaml, parseDocument } from 'yaml'
import { unzipSync } from 'fflate'
import type { Executor, ResourceTarget, ResourceItem, ResourcePage, ResourceResult, ResourceDetail } from '../shared/types'
import { setTomlValue } from './resource-config'
import { readMcpImport } from './mcp-import'

type ObjectValue = Record<string, unknown>
export function validateResourcePaths(target: Executor['resources']) {
  if (!target) return
  if (![target.mcpPath, target.skillPath, target.skillConfigPath || ''].every((value) => typeof value === 'string' && (!value || path.isAbsolute(value)))) throw new Error(t("资源目录和配置文件必须使用绝对路径"))
  if (!['standard', 'codex', 'opencode'].includes(target.format) || !['portable', 'claude', 'codex', 'opencode', 'pi', 'omp'].includes(target.skillAdapter || 'portable')) throw new Error(t("请选择支持的资源格式"))
}
const object = (value: unknown): ObjectValue => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(t("配置必须是对象"))
  return value as ObjectValue
}
const namePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MAX_BYTES = 32 * 1024 * 1024
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
function mcpDescription(value: ObjectValue): string {
  if (typeof value.url === 'string') {
    try { const url = new URL(value.url); return `${url.protocol}//${url.host}${url.pathname}` } catch { return t("无效 URL") }
  }
  return Array.isArray(value.command) ? String(value.command[0] || '') : typeof value.command === 'string' ? value.command : ''
}
function removeInside(root: string, target: string) {
  const absolute = path.resolve(target), relative = path.relative(path.resolve(root), absolute)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(t("临时清理路径超出预期目录"))
  fs.rmSync(absolute, { recursive: true, force: true })
}

function readText(file: string): string {
  try {
    if (fs.statSync(file).size > MAX_BYTES) throw new Error(t("配置文件超过 32 MB"))
    return fs.readFileSync(file, 'utf8')
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error }
}
function json(text: string): ObjectValue {
  const errors: ParseError[] = []
  const value: unknown = parseJson(text.replace(/^\ufeff/, '') || '{}', errors, { allowTrailingComma: true })
  if (errors.length) throw new Error(t("JSON 配置存在语法错误，请修复后重试"))
  return object(value)
}
function parseConfig(target: ResourceTarget, text: string) {
  return target.format === 'codex' ? parseToml(text.replace(/^\ufeff/, '')) : json(text)
}
function opencodeV2(config: ObjectValue): boolean {
  const servers = object(config.mcp || {}).servers
  return Array.isArray(config.permissions) || !!config.providers || Array.isArray(config.skills) ||
    (!!servers && typeof servers === 'object' && !Array.isArray(servers) && !['type', 'command', 'url'].some(key => Object.hasOwn(servers, key)))
}
function mcpRoot(target: ResourceTarget, config: ObjectValue) {
  const v2 = target.format === 'opencode' && opencodeV2(config)
  const keys = target.format === 'codex' ? ['mcp_servers'] : target.format === 'opencode' ? v2 ? ['mcp', 'servers'] : ['mcp'] : ['mcpServers']
  let value: unknown = config
  for (const key of keys) value = object(value || {})[key]
  return { keys, servers: object(value || {}), v2 }
}
function wildcardMatches(pattern: string, value: string): boolean {
  const regex = pattern.split(/([*?])/).map(part => part === '*' ? '.*' : part === '?' ? '.' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('')
  return new RegExp('^' + regex + '$').test(value)
}
function atomicText(file: string, before: string, next: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error(t("配置是符号链接，请选择真实配置文件"))
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temp, next, { mode: 0o600, flag: 'wx' })
    if (readText(file) !== before) throw new Error(t("配置已被其他程序修改，请刷新后重试"))
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.awb-backup`)
    fs.renameSync(temp, file)
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp) }
}
function skillInfo(file: string): { name: string; description: string; enabled: boolean } {
  const text = readText(file).replace(/^\ufeff/, '')
  const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  if (!front) throw new Error(t("SKILL.md 缺少 YAML 文档属性"))
  const value = object(parseYaml(front[1]))
  if (typeof value.name !== 'string' || value.name.length > 64 || !namePattern.test(value.name)) throw new Error(t("Skill 名称须为小写字母、数字和单连字符，最多 64 字符"))
  if (typeof value.description !== 'string' || !value.description.trim() || value.description.length > 1024) throw new Error(t("Skill 需要 1 到 1024 字符的 description"))
  return { name: value.name, description: value.description.trim(), enabled: value.enabled !== false }
}
function safeRelative(value: string) {
  const normalized = value.replace(/\\/g, '/')
  if (!normalized || /^[/]|^[a-z]:/i.test(normalized) || normalized.includes('\0') || normalized.split('/').some((p) => p === '..' || p.includes(':') || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw new Error(t("导入包包含不安全路径"))
  return normalized
}

/** Reads native agent configuration; never launches imported commands or scripts. */
export class ResourceManager {
  private busy = false
  constructor(private data: string, private home = process.env.AWB_RESOURCE_HOME || os.homedir()) {}
  targets(custom: Executor[] = []): ResourceTarget[] {
    const join = (...parts: string[]) => path.join(this.home, ...parts)
    const codex = process.env.AWB_RESOURCE_HOME ? join('.codex') : process.env.CODEX_HOME || join('.codex')
    const config = process.env.AWB_RESOURCE_HOME ? join('.config') : process.env.XDG_CONFIG_HOME || join('.config')
    const claude = process.env.AWB_RESOURCE_HOME ? join('.claude') : process.env.CLAUDE_CONFIG_DIR || join('.claude')
    const pi = process.env.AWB_RESOURCE_HOME ? join('.pi', 'agent') : process.env.PI_CODING_AGENT_DIR || join('.pi', 'agent')
    const builtins: ResourceTarget[] = [
      { id: 'claude', name: 'Claude Code', mcpPath: join('.claude.json'), skillPath: path.join(claude, 'skills'), format: 'standard' },
      { id: 'codex', name: 'Codex CLI', mcpPath: path.join(codex, 'config.toml'), skillPath: join('.agents', 'skills'), format: 'codex' },
      { id: 'opencode', name: 'OpenCode', mcpPath: path.join(config, 'opencode', fs.existsSync(path.join(config, 'opencode', 'opencode.jsonc')) ? 'opencode.jsonc' : 'opencode.json'), skillPath: path.join(config, 'opencode', 'skills'), format: 'opencode' },
      { id: 'pi', name: 'Pi', mcpPath: path.join(pi, 'mcp.json'), skillPath: path.join(pi, 'skills'), format: 'standard' },
      { id: 'omp', name: 'Oh My Pi', mcpPath: join('.omp', 'agent', 'mcp.json'), skillPath: join('.omp', 'agent', 'skills'), skillConfigPath: join('.omp', 'agent', 'config.yml'), format: 'standard' }
    ]
    const saved = json(readText(path.join(this.data, 'resource-targets.json')))
    return [...builtins.map((item): ResourceTarget => ({ ...item, skillAdapter: item.id as ResourceTarget['skillAdapter'] })), ...custom.map((item): ResourceTarget => ({ mcpPath: '', skillPath: '', format: 'standard', ...(saved[item.id] as Partial<ResourceTarget> || {}), ...item.resources, id: item.id, name: item.name }))]
  }
  saveTarget(target: ResourceTarget, custom: Executor[]) {
    if (!custom.some((item) => item.id === target.id)) throw new Error(t("仅自定义 Agent 可设置资源路径"))
    if (![target.mcpPath, target.skillPath].every((p) => !p || path.isAbsolute(p))) throw new Error(t("请选择绝对路径"))
    if (!['standard', 'codex', 'opencode'].includes(target.format)) throw new Error(t("不支持的配置格式"))
    const file = path.join(this.data, 'resource-targets.json'), before = readText(file)
    const saved = json(before)
    saved[target.id] = { mcpPath: target.mcpPath, skillPath: target.skillPath, format: target.format }
    atomicText(file, before, JSON.stringify(saved, null, 2))
  }
  private target(targets: ResourceTarget[], agent: string) {
    const target = targets.find((item) => item.id === agent)
    if (!target) throw new Error(t("Agent 不存在"))
    return target
  }
  private skillRoots(target: ResourceTarget): string[] {
    const roots = [target.skillPath]
    if (['codex', 'opencode', 'pi'].includes(target.id)) roots.push(path.join(this.home, '.agents', 'skills'))
    if (target.id === 'codex') roots.push(path.join(path.dirname(target.mcpPath), 'skills'))
    if (target.id === 'opencode') roots.push(path.join(this.home, '.claude', 'skills'))
    return [...new Set(roots.filter(Boolean))]
  }
  list(targets: ResourceTarget[], kind: 'mcp' | 'skills', agent: string, page = 1, query = '', all = false): ResourcePage {
    const target = this.target(targets, agent), items: ResourceItem[] = [], errors: string[] = []
    if (kind === 'mcp' && target.mcpPath) {
      try {
        const config = parseConfig(target, readText(target.mcpPath))
        const { servers, v2 } = mcpRoot(target, config)
        for (const [name, raw] of Object.entries(object(servers))) {
          const value = object(raw)
          const description = mcpDescription(value)
          items.push({ name, description, path: target.mcpPath, transport: value.url ? String(value.type || 'http') : 'stdio', enabled: v2 ? value.disabled !== true : value.enabled !== false })
        }
        for (const [name, raw] of Object.entries(object(config.awbDisabledMcp || {}))) {
          if (Object.hasOwn(object(servers), name)) continue
          const value = object(raw)
          items.push({ name, description: mcpDescription(value), path: target.mcpPath, transport: value.url ? 'http' : 'stdio', enabled: false })
        }
      } catch (error) { errors.push(`${target.mcpPath}: ${message(error)}`) }
    } else if (kind === 'skills') {
      const seen = new Set<string>()
      const scan = (folder: string) => {
        let real: string
        try { real = fs.realpathSync(folder); if (seen.has(real)) return; seen.add(real) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') errors.push(`${folder}: ${message(error)}`); return }
        try {
          const file = path.join(folder, 'SKILL.md')
          const source = fs.existsSync(file) ? file : file + '.awb-disabled'
          if (fs.existsSync(source)) { items.push({ ...skillInfo(source), path: file, enabled: this.skillEnabled(target, file, skillInfo(source).name) }); return }
          for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
            if (entry.isDirectory() || entry.isSymbolicLink()) scan(path.join(folder, entry.name))
          }
        } catch (error) { errors.push(`${folder}: ${message(error)}`) }
      }
      for (const folder of this.skillRoots(target)) scan(folder)
    }
    const filtered = items.filter((item) => `${item.name} ${item.description}`.toLowerCase().includes(String(query).toLowerCase())).sort((a, b) => a.name.localeCompare(b.name))
    const pages = Math.max(1, Math.ceil(filtered.length / 12)), current = Math.max(1, Math.min(Number(page) || 1, pages))
    return { items: all ? filtered : filtered.slice((current - 1) * 12, current * 12), total: filtered.length, page: current, pages, errors }
  }
  private settingsFile(target: ResourceTarget) {
    if (target.skillConfigPath) return target.skillConfigPath
    if (target.skillAdapter === 'codex' || target.skillAdapter === 'opencode') return target.mcpPath
    if (target.skillAdapter === 'claude') return path.join(path.dirname(target.skillPath), 'settings.json')
    if (target.skillAdapter === 'omp') return target.skillPath ? path.join(path.dirname(target.skillPath), 'config.yml') : ''
    return target.skillPath ? path.join(path.dirname(target.skillPath), 'settings.json') : ''
  }
  private skillEnabled(target: ResourceTarget, file: string, name: string): boolean {
    if (fs.existsSync(file + '.awb-disabled') && !fs.existsSync(file)) return false
    if (!target.skillAdapter || target.skillAdapter === 'portable') return true
    const settings = this.settingsFile(target)
    if (!settings) return true
    const raw = readText(settings)
    if (target.skillAdapter === 'codex') {
      const entries = (parseToml(raw.replace(/^\ufeff/, '')).skills as { config?: { path?: string; name?: string; enabled?: boolean }[] } | undefined)?.config || []
      return entries.filter((item) => item.path === file || item.name === name).at(-1)?.enabled !== false
    }
    const config = target.skillAdapter === 'omp' ? object(parseYaml(raw) || {}) : json(raw)
    if (target.skillAdapter === 'omp') {
      const skills = object(config.skills || {}), include = (skills.includeSkills || []) as string[]
      return skillInfo(file).enabled && skills.enabled !== false && !((config.disabledExtensions || []) as string[]).includes(`skill:${name}`) &&
        !((skills.ignoredSkills || []) as string[]).some((pattern) => wildcardMatches(pattern, name)) && (!include.length || include.some((pattern) => wildcardMatches(pattern, name)))
    }
    if (target.skillAdapter === 'claude') return object(config.skillOverrides || {})[name] !== 'off'
    if (target.skillAdapter === 'opencode') {
      const permission = object(config.permission || {}).skill
      let enabled = typeof permission === 'string' ? permission !== 'deny' : true
      for (const [pattern, policy] of Object.entries(typeof permission === 'string' ? {} : object(permission || {}))) {
        if (wildcardMatches(pattern, name)) enabled = policy !== 'deny'
      }
      if (config.permissions !== undefined && !Array.isArray(config.permissions)) throw new Error(t("OpenCode V2 permissions 必须是数组"))
      for (const raw of config.permissions as unknown[] || []) {
        const rule = object(raw)
        if (typeof rule.action === 'string' && typeof rule.resource === 'string' && wildcardMatches(rule.action, 'skill') && wildcardMatches(rule.resource, name)) enabled = rule.effect !== 'deny'
      }
      return enabled
    }
    if (target.skillAdapter === 'pi') return !(config.skills as unknown[] || []).includes('-' + file)
    return true
  }
  private listed(targets: ResourceTarget[], kind: 'mcp' | 'skills', agent: string, item: ResourceItem) {
    const found = this.list(targets, kind, agent, 1, '', true).items.find((entry) => entry.name === item.name && entry.path === item.path)
    if (!found) throw new Error(t("资源已改变或不属于当前 Agent，请刷新后重试"))
    return found
  }
  skillDirectory(targets: ResourceTarget[], agent: string, raw: ResourceItem, removing = false): string {
    const item = this.listed(targets, 'skills', agent, raw), target = this.target(targets, agent)
    const folder = path.dirname(item.path), real = fs.realpathSync(folder)
    const roots = this.skillRoots(target).filter((root) => fs.existsSync(root))
    if (!roots.some((root) => { const rel = path.relative(path.resolve(root), folder); return !rel.startsWith('..') && !path.isAbsolute(rel) })) throw new Error(t("Skill 路径不属于当前 Agent"))
    if (!removing) return folder
    const inside = roots.some((root) => {
      const relative = path.relative(fs.realpathSync(root), real)
      return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    })
    if (!inside) throw new Error(t("Skill 目录超出 Agent 资源范围，不能执行此操作"))
    const root = roots.find((root) => { const rel = path.relative(path.resolve(root), folder); return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel) })
    if (!root) throw new Error(t("不能删除整个 Skill 发现目录"))
    for (let current = folder; path.relative(path.resolve(root), current); current = path.dirname(current)) {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error(t("不能删除通过符号链接发现的 Skill，请在资源管理器中管理该链接"))
    }
    return folder
  }
  private patchJson(file: string, keys: (string | number)[], value: unknown) {
    const before = readText(file), bom = before.startsWith('\ufeff') ? '\ufeff' : ''
    json(before)
    const source = before.replace(/^\ufeff/, '') || '{}'
    const next = bom + applyEdits(source, modify(source, keys, value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: before.includes('\r\n') ? '\r\n' : '\n' } }))
    json(next); atomicText(file, before, next)
  }
  toggle(targets: ResourceTarget[], kind: 'mcp' | 'skills', agent: string, raw: ResourceItem, enabled: boolean) {
    const item = this.listed(targets, kind, agent, raw), target = this.target(targets, agent)
    if (typeof enabled !== 'boolean') throw new Error(t("无效的开关状态"))
    if (kind === 'mcp') {
      const before = readText(target.mcpPath), config = parseConfig(target, before)
      if (target.format === 'codex') { atomicText(target.mcpPath, before, setTomlValue(before, ['mcp_servers', item.name, 'enabled'], enabled)); return }
      const { keys, v2 } = mcpRoot(target, config), key = keys[0]
      if (target.id === 'claude' || (target.format === 'standard' && target.id !== 'pi' && target.id !== 'omp')) {
        // Claude has project-scoped toggles. For a user-level switch, park the
        // entry outside mcpServers so every new project stops discovering it.
        const active = object(config[key] || {}), parked = object(config.awbDisabledMcp || {})
        if (enabled && Object.hasOwn(active, item.name)) throw new Error(t("已有同名 MCP，未覆盖当前配置"))
        if (!enabled && Object.hasOwn(parked, item.name)) throw new Error(t("已有同名停用配置，未覆盖原配置"))
        const source = enabled ? parked[item.name] : active[item.name]
        if (!source) throw new Error(t("MCP 配置已改变"))
        const bom = before.startsWith('\ufeff') ? '\ufeff' : ''
        let next = before.replace(/^\ufeff/, '') || '{}'
        for (const [keys, value] of [[[enabled ? key : 'awbDisabledMcp', item.name], source], [[enabled ? 'awbDisabledMcp' : key, item.name], undefined]] as [(string | number)[], unknown][]) next = applyEdits(next, modify(next, keys, value, { formattingOptions: { insertSpaces: true, tabSize: 2 } }))
        atomicText(target.mcpPath, before, bom + next)
      } else this.patchJson(target.mcpPath, [...keys, item.name, v2 ? 'disabled' : 'enabled'], v2 ? !enabled : enabled)
    } else {
      const settings = this.settingsFile(target)
      if (target.skillAdapter && target.skillAdapter !== 'portable' && !settings) throw new Error(t("请先在执行器高级属性中设置 Skill 配置文件或 MCP 配置文件"))
      if (target.skillAdapter === 'codex') {
        const before = readText(settings), config = parseToml(before.replace(/^\ufeff/, ''))
        const entries = (config.skills as { config?: { path?: string; enabled?: boolean }[] } | undefined)?.config || []
        const index = entries.reduce((last, entry, index) => entry.path === item.path ? index : last, -1)
        const next = index < 0 ? before + '\n' + stringifyToml({ skills: { config: [{ path: item.path, enabled }] } }) : setTomlValue(before, ['skills', 'config', index, 'enabled'], enabled)
        parseToml(next.replace(/^\ufeff/, '')); atomicText(settings, before, next)
      } else if (target.skillAdapter === 'claude') this.patchJson(settings, ['skillOverrides', item.name], enabled ? 'on' : 'off')
      else if (target.skillAdapter === 'opencode') {
        const config = json(readText(settings))
        if (opencodeV2(config)) {
          if (config.permissions !== undefined && !Array.isArray(config.permissions)) throw new Error(t("OpenCode V2 permissions 必须是数组"))
          const rules = (config.permissions || []) as ObjectValue[], last = rules.at(-1)
          if (last?.action === 'skill' && last.resource === item.name) this.patchJson(settings, ['permissions', rules.length - 1, 'effect'], enabled ? 'allow' : 'deny')
          else this.patchJson(settings, ['permissions', rules.length], { action: 'skill', resource: item.name, effect: enabled ? 'allow' : 'deny' })
        } else {
          const skill = object(config.permission || {}).skill
          if (typeof skill === 'string') this.patchJson(settings, ['permission', 'skill'], { '*': skill, [item.name]: enabled ? 'allow' : 'deny' })
          else this.patchJson(settings, ['permission', 'skill', item.name], enabled ? 'allow' : 'deny')
        }
      }
      else if (target.skillAdapter === 'omp') {
        const before = readText(settings), document = parseDocument(before || '{}')
        if (document.errors.length) throw new Error(t("Oh My Pi YAML 配置存在语法错误"))
        if (enabled) {
          const config = object(document.toJS() || {}), skills = object(config.skills || {}), include = (skills.includeSkills || []) as string[]
          if (!skillInfo(item.path).enabled || skills.enabled === false || ((skills.ignoredSkills || []) as string[]).some((pattern) => wildcardMatches(pattern, item.name)) || (include.length && !include.some((pattern) => wildcardMatches(pattern, item.name)))) throw new Error(t("此 Skill 受 Oh My Pi 全局筛选或 SKILL.md 停用限制，请先修改对应设置"))
        }
        const entries = ((document.toJS()?.disabledExtensions || []) as string[]).filter((entry) => entry !== `skill:${item.name}`)
        if (!enabled) entries.push(`skill:${item.name}`)
        document.set('disabledExtensions', entries)
        atomicText(settings, before, document.toString())
      }
      else if (target.skillAdapter === 'pi') {
        const config = json(readText(settings)), entries = (config.skills as unknown[] || []).filter((entry) => entry !== '-' + item.path)
        if (!enabled) entries.push('-' + item.path)
        this.patchJson(settings, ['skills'], entries)
      } else {
        const source = item.path + (enabled ? '.awb-disabled' : ''), dest = item.path + (enabled ? '' : '.awb-disabled')
        const real = fs.realpathSync(source)
        const root = fs.realpathSync(target.skillPath), relative = path.relative(root, real)
        if (relative.startsWith('..') || path.isAbsolute(relative) || fs.lstatSync(source).isSymbolicLink()) throw new Error(t("不能切换指向其他目录的 Skill 链接"))
        if (fs.existsSync(dest)) throw new Error(t("目标文件已存在，未覆盖"))
        fs.renameSync(source, dest)
      }
    }
  }
  detail(targets: ResourceTarget[], kind: 'mcp' | 'skills', agent: string, raw: ResourceItem): ResourceDetail {
    const item = this.listed(targets, kind, agent, raw), target = this.target(targets, agent)
    if (kind === 'skills') return { ...item, content: readText(fs.existsSync(item.path) ? item.path : item.path + '.awb-disabled') }
    const config = parseConfig(target, readText(target.mcpPath)), { servers } = mcpRoot(target, config)
    const value = object(servers[item.name] || object(config.awbDisabledMcp || {})[item.name])
    const clean = { ...value }
    for (const field of ['env', 'environment', 'headers', 'http_headers']) if (clean[field]) clean[field] = Object.fromEntries(Object.keys(object(clean[field])).map((key) => [key, '********']))
    for (const field of Object.keys(clean)) if (/token|password|secret/i.test(field)) clean[field] = '********'
    if (typeof clean.url === 'string') { const url = new URL(clean.url); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; clean.url = url.href }
    for (const field of ['args', 'command']) if (Array.isArray(clean[field])) { let secret = false; clean[field] = clean[field].map((arg) => { const hidden = secret; secret = /token|password|secret|api[-_]?key/i.test(String(arg)); return hidden || secret ? '********' : arg }) }
    return { ...item, content: JSON.stringify(clean, null, 2), notice: t("环境变量、请求头和认证信息已隐藏。") }
  }
  private distribute(targets: ResourceTarget[], agents: string[], run: (target: ResourceTarget) => void): ResourceResult[] {
    if (this.busy) throw new Error(t("正在分发资源，请稍候"))
    if (!Array.isArray(agents) || !agents.length) throw new Error(t("请选择至少一个 Code Agent"))
    this.busy = true
    try { return [...new Set(agents)].map((agent) => {
      try { run(this.target(targets, agent)); return { agent, ok: true } }
      catch (error) { return { agent, ok: false, error: message(error) } }
    }) } finally { this.busy = false }
  }
  scanMcp(source: string) {
    return readMcpImport(source).map(({ config: _config, ...item }) => item)
  }
  importMcpConfig(targets: ResourceTarget[], source: string, agents: string[], ids: string[]): ResourceResult[] {
    const entries = readMcpImport(source)
    if (!Array.isArray(ids) || !ids.length || ids.some((id) => !entries.some((entry) => entry.id === id))) throw new Error(t("请选择扫描结果中的 MCP"))
    return entries.filter((entry) => ids.includes(entry.id)).flatMap<ResourceResult>((entry) => {
      if (!entry.config || entry.error) return agents.map((agent) => ({ agent, name: entry.name, id: entry.id, ok: false, error: entry.error || t("无效配置") }))
      return this.addMcp(targets, entry.name, entry.config, agents, entry.enabled).map((result) => ({ ...result, name: entry.name, id: entry.id }))
    })
  }
  addMcp(targets: ResourceTarget[], name: string, raw: ObjectValue, agents: string[], enabled = true): ResourceResult[] {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new Error(t("MCP 名称只能包含字母、数字、下划线、连字符，最多 64 字符"))
    const config = object(raw)
    const remote = typeof config.url === 'string'
    if (remote) {
      const url = new URL(config.url as string)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error(t("请使用不含账号密码的 HTTP / HTTPS URL"))
      if (config.command !== undefined || (config.type && config.type !== 'http')) throw new Error(t("HTTP MCP 请仅配置 url，type 使用 http"))
      if (config.args !== undefined || config.env !== undefined) throw new Error(t("HTTP MCP 使用 headers；args、env 仅用于 stdio"))
    } else if (typeof config.command !== 'string' || !config.command.trim() || config.command.includes('\0')) throw new Error(t("stdio MCP 需要 command"))
    if (!remote && (config.headers !== undefined || (config.type && config.type !== 'stdio'))) throw new Error(t("stdio MCP 使用 command、args、env；不支持 headers 或其他 type"))
    if (config.args !== undefined && (!Array.isArray(config.args) || !config.args.every((item) => typeof item === 'string'))) throw new Error(t("args 必须是字符串数组"))
    for (const key of ['env', 'headers']) if (config[key] !== undefined && Object.values(object(config[key])).some((v) => typeof v !== 'string')) throw new Error(t("{{0}} 必须是字符串键值对象", key))
    const allowed = new Set(['type', 'command', 'args', 'env', 'url', 'headers'])
    if (Object.keys(config).some((key) => !allowed.has(key))) throw new Error(t("支持的字段为 type、command、args、env、url、headers"))
    return this.distribute(targets, agents, (target) => {
      if (!target.mcpPath) throw new Error(t("请先设置这个 Agent 的 MCP 配置路径"))
      const before = readText(target.mcpPath), parsed = parseConfig(target, before)
      const { keys: activeKeys, servers, v2 } = mcpRoot(target, parsed)
      const parked = !enabled && target.format === 'standard' && target.id !== 'pi' && target.id !== 'omp'
      const keys = parked ? ['awbDisabledMcp'] : activeKeys
      if (Object.hasOwn(servers, name) || Object.hasOwn(object(parsed.awbDisabledMcp || {}), name)) throw new Error(t("已存在同名 MCP，保留原配置"))
      let value: ObjectValue
      if (target.format === 'codex') value = { ...(remote ? { url: config.url, ...(config.headers ? { http_headers: config.headers } : {}) } : { command: config.command, args: config.args || [], ...(config.env ? { env: config.env } : {}) }), ...(!enabled ? { enabled: false } : {}) }
      else if (target.format === 'opencode') value = { ...(remote ? { type: 'remote', url: config.url, ...(config.headers ? { headers: config.headers } : {}) } : { type: 'local', command: [config.command, ...(config.args as string[] || [])], ...(config.env ? { environment: config.env } : {}) }), ...(v2 ? { disabled: !enabled } : { enabled }) }
      else value = remote ? { type: 'http', url: config.url, ...(config.headers ? { headers: config.headers } : {}) } : { command: config.command, args: config.args || [], ...(config.env ? { env: config.env } : {}) }
      if (!enabled && !parked && target.format === 'standard') value.enabled = false
      let next: string
      if (target.format === 'codex') {
        // Append a new table to preserve comments, ordering and unrelated settings.
        next = before + '\n' + stringifyToml({ mcp_servers: { [name]: value } })
        parseToml(next.replace(/^\ufeff/, ''))
      } else {
        const bom = before.startsWith('\ufeff') ? '\ufeff' : ''
        const source = before.replace(/^\ufeff/, '') || '{}'
        next = bom + applyEdits(source, modify(source, [...keys, name], value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: before.includes('\r\n') ? '\r\n' : '\n' } }))
        json(next)
      }
      atomicText(target.mcpPath, before, next)
    })
  }
  scanSkills(source: string): { name: string; description: string; path: string }[] {
    return this.withSkills(source, (skills, staging) => skills.map((skill) => ({ name: skill.name, description: skillInfo(path.join(skill.folder, 'SKILL.md')).description, path: path.relative(staging, skill.folder) || '.' })))
  }
  importSkills(targets: ResourceTarget[], source: string, agents: string[], names?: string[]): ResourceResult[] {
    return this.withSkills(source, (discovered) => {
      const skills = names ? discovered.filter((skill) => names.includes(skill.name)) : discovered
      if (!skills.length || (names && names.some((name) => !discovered.some((skill) => skill.name === name)))) throw new Error(t("请选择扫描结果中的 Skill"))
      const results = this.distribute(targets, agents, (target) => {
        if (!target.skillPath) throw new Error(t("请先设置这个 Agent 的 Skill 目录"))
        fs.mkdirSync(target.skillPath, { recursive: true })
        const root = fs.realpathSync(target.skillPath)
        for (const skill of skills) if (fs.existsSync(path.join(root, skill.name))) throw new Error(t("已存在 {{0}}，保留原文件", skill.name))
        const prepared: { temp: string; dest: string }[] = [], installed: string[] = []
        try {
          for (const skill of skills) {
            const temp = path.join(root, `.awb-${randomUUID()}`), dest = path.join(root, skill.name)
            prepared.push({ temp, dest }); fs.cpSync(skill.folder, temp, { recursive: true, errorOnExist: true, force: false })
          }
          for (const item of prepared) {
            if (fs.existsSync(item.dest)) throw new Error(t("目标目录已变化，请刷新后重试"))
            fs.renameSync(item.temp, item.dest); installed.push(item.dest)
          }
        } catch (error) { for (const dest of installed) removeInside(root, dest); throw error }
        finally { for (const { temp } of prepared) removeInside(root, temp) }
      })
      return skills.length === 1 ? results : results.flatMap((result) => skills.map((skill) => ({ ...result, name: skill.name })))
    })
  }
  private withSkills<T>(source: string, operation: (skills: { folder: string; name: string }[], staging: string) => T): T {
    if (!path.isAbsolute(source)) throw new Error(t("请选择 Skill 文件夹或 ZIP 压缩包"))
    if (fs.lstatSync(source).isSymbolicLink()) throw new Error(t("导入文件夹包含符号链接，请选择真实目录"))
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-skills-'))
    let bytes = 0, count = 0
    try {
      const put = (rel: string, content: Uint8Array) => {
        const safe = safeRelative(rel)
        if (++count > 10000 || (bytes += content.length) > MAX_BYTES) throw new Error(t("Skill 包超过 10000 个文件或 32 MB"))
        const dest = path.join(staging, safe)
        fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, content, { flag: 'wx' })
      }
      if (fs.statSync(source).isDirectory()) {
        const copy = (folder: string, prefix = '') => {
          for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
            const file = path.join(folder, entry.name), rel = prefix + entry.name
            if (entry.isSymbolicLink()) throw new Error(t("导入文件夹包含符号链接，请先移除链接"))
            if (entry.isDirectory()) copy(file, rel + '/')
            else if (entry.isFile()) { if (fs.statSync(file).size > MAX_BYTES - bytes) throw new Error(t("Skill 包超过 32 MB")); put(rel, fs.readFileSync(file)) }
            else throw new Error(t("Skill 包包含不支持的文件类型"))
          }
        }
        copy(source)
      } else {
        if (!/\.zip$/i.test(source) || fs.statSync(source).size > MAX_BYTES) throw new Error(t("请选择 32 MB 以内的 ZIP 文件"))
        let expanded = 0, entries = 0
        const files = unzipSync(fs.readFileSync(source), { filter: (entry) => {
          safeRelative(entry.name.replace(/\/$/, ''))
          if (++entries > 10000 || (expanded += entry.originalSize) > MAX_BYTES) throw new Error(t("ZIP 解压后超过 10000 个文件或 32 MB"))
          return !entry.name.endsWith('/')
        } })
        for (const [rel, content] of Object.entries(files)) put(rel, content)
      }
      const skills: { folder: string; name: string }[] = []
      const discover = (folder: string) => {
        if (fs.existsSync(path.join(folder, 'SKILL.md'))) { skills.push({ folder, name: skillInfo(path.join(folder, 'SKILL.md')).name }) }
        for (const entry of fs.readdirSync(folder, { withFileTypes: true })) if (entry.isDirectory()) discover(path.join(folder, entry.name))
      }
      discover(staging)
      if (!skills.length) throw new Error(t("未找到包含有效 SKILL.md 的目录"))
      if (new Set(skills.map((item) => item.name)).size !== skills.length) throw new Error(t("导入包包含同名 Skill"))
      return operation(skills, staging)
    } finally { removeInside(os.tmpdir(), staging) }
  }
}
