import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import { parse as parseJson, modify, applyEdits, type ParseError } from 'jsonc-parser'
import { parse as parseYaml } from 'yaml'
import { unzipSync } from 'fflate'
import type { Executor, ResourceTarget, ResourceItem, ResourcePage, ResourceResult } from '../shared/types'

type ObjectValue = Record<string, unknown>
const object = (value: unknown): ObjectValue => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('配置必须是对象')
  return value as ObjectValue
}
const namePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MAX_BYTES = 32 * 1024 * 1024
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
function removeInside(root: string, target: string) {
  const absolute = path.resolve(target), relative = path.relative(path.resolve(root), absolute)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('临时清理路径超出预期目录')
  fs.rmSync(absolute, { recursive: true, force: true })
}

function readText(file: string): string {
  try {
    if (fs.statSync(file).size > MAX_BYTES) throw new Error('配置文件超过 32 MB')
    return fs.readFileSync(file, 'utf8')
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error }
}
function json(text: string): ObjectValue {
  const errors: ParseError[] = []
  const value: unknown = parseJson(text.replace(/^\ufeff/, '') || '{}', errors, { allowTrailingComma: true })
  if (errors.length) throw new Error('JSON 配置存在语法错误，请修复后重试')
  return object(value)
}
function parseConfig(target: ResourceTarget, text: string) {
  return target.format === 'codex' ? parseToml(text.replace(/^\ufeff/, '')) : json(text)
}
function atomicText(file: string, before: string, next: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('配置是符号链接，请选择真实配置文件')
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temp, next, { mode: 0o600, flag: 'wx' })
    if (readText(file) !== before) throw new Error('配置已被其他程序修改，请刷新后重试')
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.awb-backup`)
    fs.renameSync(temp, file)
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp) }
}
function skillInfo(file: string): { name: string; description: string } {
  const text = readText(file).replace(/^\ufeff/, '')
  const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  if (!front) throw new Error('SKILL.md 缺少 YAML 文档属性')
  const value = object(parseYaml(front[1]))
  if (typeof value.name !== 'string' || value.name.length > 64 || !namePattern.test(value.name)) throw new Error('Skill 名称须为小写字母、数字和单连字符，最多 64 字符')
  if (typeof value.description !== 'string' || !value.description.trim() || value.description.length > 1024) throw new Error('Skill 需要 1 到 1024 字符的 description')
  return { name: value.name, description: value.description.trim() }
}
function safeRelative(value: string) {
  const normalized = value.replace(/\\/g, '/')
  if (!normalized || /^[/]|^[a-z]:/i.test(normalized) || normalized.includes('\0') || normalized.split('/').some((p) => p === '..' || p.includes(':') || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw new Error('导入包包含不安全路径')
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
      { id: 'pi', name: 'Pi', mcpPath: path.join(pi, 'mcp.json'), skillPath: path.join(pi, 'skills'), format: 'standard' }
    ]
    const saved = json(readText(path.join(this.data, 'resource-targets.json')))
    return [...builtins, ...custom.map((item): ResourceTarget => ({ id: item.id, name: item.name, mcpPath: '', skillPath: '', format: 'standard', ...(saved[item.id] as Partial<ResourceTarget> || {}) }))]
  }
  saveTarget(target: ResourceTarget, custom: Executor[]) {
    if (!custom.some((item) => item.id === target.id)) throw new Error('仅自定义 Agent 可设置资源路径')
    if (![target.mcpPath, target.skillPath].every((p) => !p || path.isAbsolute(p))) throw new Error('请选择绝对路径')
    if (!['standard', 'codex', 'opencode'].includes(target.format)) throw new Error('不支持的配置格式')
    const file = path.join(this.data, 'resource-targets.json'), before = readText(file)
    const saved = json(before)
    saved[target.id] = { mcpPath: target.mcpPath, skillPath: target.skillPath, format: target.format }
    atomicText(file, before, JSON.stringify(saved, null, 2))
  }
  private target(targets: ResourceTarget[], agent: string) {
    const target = targets.find((item) => item.id === agent)
    if (!target) throw new Error('Agent 不存在')
    return target
  }
  private skillRoots(target: ResourceTarget): string[] {
    const roots = [target.skillPath]
    if (['codex', 'opencode', 'pi'].includes(target.id)) roots.push(path.join(this.home, '.agents', 'skills'))
    if (target.id === 'codex') roots.push(path.join(path.dirname(target.mcpPath), 'skills'))
    if (target.id === 'opencode') roots.push(path.join(this.home, '.claude', 'skills'))
    return [...new Set(roots.filter(Boolean))]
  }
  list(targets: ResourceTarget[], kind: 'mcp' | 'skills', agent: string, page = 1, query = ''): ResourcePage {
    const target = this.target(targets, agent), items: ResourceItem[] = [], errors: string[] = []
    if (kind === 'mcp' && target.mcpPath) {
      try {
        const config = parseConfig(target, readText(target.mcpPath))
        const servers = config[target.format === 'codex' ? 'mcp_servers' : target.format === 'opencode' ? 'mcp' : 'mcpServers'] || {}
        for (const [name, raw] of Object.entries(object(servers))) {
          const value = object(raw)
          let description = Array.isArray(value.command) ? String(value.command[0] || '') : typeof value.command === 'string' ? value.command : ''
          if (typeof value.url === 'string') { try { const url = new URL(value.url); description = `${url.protocol}//${url.host}${url.pathname}` } catch { description = '无效 URL' } }
          items.push({ name, description, path: target.mcpPath, transport: value.url ? String(value.type || 'http') : 'stdio', enabled: value.enabled !== false })
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
          if (fs.existsSync(file)) { items.push({ ...skillInfo(file), path: file }); return }
          for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
            if (entry.isDirectory() || entry.isSymbolicLink()) scan(path.join(folder, entry.name))
          }
        } catch (error) { errors.push(`${folder}: ${message(error)}`) }
      }
      for (const folder of this.skillRoots(target)) scan(folder)
    }
    const filtered = items.filter((item) => `${item.name} ${item.description}`.toLowerCase().includes(String(query).toLowerCase())).sort((a, b) => a.name.localeCompare(b.name))
    const pages = Math.max(1, Math.ceil(filtered.length / 12)), current = Math.max(1, Math.min(Number(page) || 1, pages))
    return { items: filtered.slice((current - 1) * 12, current * 12), total: filtered.length, page: current, pages, errors }
  }
  private distribute(targets: ResourceTarget[], agents: string[], run: (target: ResourceTarget) => void): ResourceResult[] {
    if (this.busy) throw new Error('正在分发资源，请稍候')
    if (!Array.isArray(agents) || !agents.length) throw new Error('请选择至少一个 Code Agent')
    this.busy = true
    try { return [...new Set(agents)].map((agent) => {
      try { run(this.target(targets, agent)); return { agent, ok: true } }
      catch (error) { return { agent, ok: false, error: message(error) } }
    }) } finally { this.busy = false }
  }
  addMcp(targets: ResourceTarget[], name: string, raw: ObjectValue, agents: string[]): ResourceResult[] {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new Error('MCP 名称只能包含字母、数字、下划线、连字符，最多 64 字符')
    const config = object(raw)
    const remote = typeof config.url === 'string'
    if (remote) {
      const url = new URL(config.url as string)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('请使用不含账号密码的 HTTP / HTTPS URL')
      if (config.command !== undefined || (config.type && config.type !== 'http')) throw new Error('HTTP MCP 请仅配置 url，type 使用 http')
      if (config.args !== undefined || config.env !== undefined) throw new Error('HTTP MCP 使用 headers；args、env 仅用于 stdio')
    } else if (typeof config.command !== 'string' || !config.command.trim() || config.command.includes('\0')) throw new Error('stdio MCP 需要 command')
    if (!remote && (config.headers !== undefined || (config.type && config.type !== 'stdio'))) throw new Error('stdio MCP 使用 command、args、env；不支持 headers 或其他 type')
    if (config.args !== undefined && (!Array.isArray(config.args) || !config.args.every((item) => typeof item === 'string'))) throw new Error('args 必须是字符串数组')
    for (const key of ['env', 'headers']) if (config[key] !== undefined && Object.values(object(config[key])).some((v) => typeof v !== 'string')) throw new Error(`${key} 必须是字符串键值对象`)
    const allowed = new Set(['type', 'command', 'args', 'env', 'url', 'headers'])
    if (Object.keys(config).some((key) => !allowed.has(key))) throw new Error('支持的字段为 type、command、args、env、url、headers')
    return this.distribute(targets, agents, (target) => {
      if (!target.mcpPath) throw new Error('请先设置这个 Agent 的 MCP 配置路径')
      const before = readText(target.mcpPath), parsed = parseConfig(target, before)
      const key = target.format === 'codex' ? 'mcp_servers' : target.format === 'opencode' ? 'mcp' : 'mcpServers'
      if (Object.hasOwn(object(parsed[key] || {}), name)) throw new Error('已存在同名 MCP，保留原配置')
      let value: ObjectValue
      if (target.format === 'codex') value = remote ? { url: config.url, ...(config.headers ? { http_headers: config.headers } : {}) } : { command: config.command, args: config.args || [], ...(config.env ? { env: config.env } : {}) }
      else if (target.format === 'opencode') value = remote ? { type: 'remote', url: config.url, enabled: true, ...(config.headers ? { headers: config.headers } : {}) } : { type: 'local', command: [config.command, ...(config.args as string[] || [])], enabled: true, ...(config.env ? { environment: config.env } : {}) }
      else value = remote ? { type: 'http', url: config.url, ...(config.headers ? { headers: config.headers } : {}) } : { command: config.command, args: config.args || [], ...(config.env ? { env: config.env } : {}) }
      let next: string
      if (target.format === 'codex') {
        // Append a new table to preserve comments, ordering and unrelated settings.
        next = before + '\n' + stringifyToml({ mcp_servers: { [name]: value } })
        parseToml(next.replace(/^\ufeff/, ''))
      } else {
        const bom = before.startsWith('\ufeff') ? '\ufeff' : ''
        const source = before.replace(/^\ufeff/, '') || '{}'
        next = bom + applyEdits(source, modify(source, [key, name], value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: before.includes('\r\n') ? '\r\n' : '\n' } }))
        json(next)
      }
      atomicText(target.mcpPath, before, next)
    })
  }
  importSkills(targets: ResourceTarget[], source: string, agents: string[]): ResourceResult[] {
    if (!path.isAbsolute(source)) throw new Error('请选择 Skill 文件夹或 ZIP 压缩包')
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-skills-'))
    let bytes = 0, count = 0
    try {
      const put = (rel: string, content: Uint8Array) => {
        const safe = safeRelative(rel)
        if (++count > 10000 || (bytes += content.length) > MAX_BYTES) throw new Error('Skill 包超过 10000 个文件或 32 MB')
        const dest = path.join(staging, safe)
        fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, content, { flag: 'wx' })
      }
      if (fs.statSync(source).isDirectory()) {
        const copy = (folder: string, prefix = '') => {
          for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
            const file = path.join(folder, entry.name), rel = prefix + entry.name
            if (entry.isSymbolicLink()) throw new Error('导入文件夹包含符号链接，请先移除链接')
            if (entry.isDirectory()) copy(file, rel + '/')
            else if (entry.isFile()) { if (fs.statSync(file).size > MAX_BYTES - bytes) throw new Error('Skill 包超过 32 MB'); put(rel, fs.readFileSync(file)) }
            else throw new Error('Skill 包包含不支持的文件类型')
          }
        }
        copy(source)
      } else {
        if (!/\.zip$/i.test(source) || fs.statSync(source).size > MAX_BYTES) throw new Error('请选择 32 MB 以内的 ZIP 文件')
        let expanded = 0, entries = 0
        const files = unzipSync(fs.readFileSync(source), { filter: (entry) => {
          safeRelative(entry.name.replace(/\/$/, ''))
          if (++entries > 10000 || (expanded += entry.originalSize) > MAX_BYTES) throw new Error('ZIP 解压后超过 10000 个文件或 32 MB')
          return !entry.name.endsWith('/')
        } })
        for (const [rel, content] of Object.entries(files)) put(rel, content)
      }
      const skills: { folder: string; name: string }[] = []
      const discover = (folder: string) => {
        if (fs.existsSync(path.join(folder, 'SKILL.md'))) { skills.push({ folder, name: skillInfo(path.join(folder, 'SKILL.md')).name }); return }
        for (const entry of fs.readdirSync(folder, { withFileTypes: true })) if (entry.isDirectory()) discover(path.join(folder, entry.name))
      }
      discover(staging)
      if (!skills.length) throw new Error('未找到包含有效 SKILL.md 的目录')
      if (new Set(skills.map((item) => item.name)).size !== skills.length) throw new Error('导入包包含同名 Skill')
      return this.distribute(targets, agents, (target) => {
        if (!target.skillPath) throw new Error('请先设置这个 Agent 的 Skill 目录')
        fs.mkdirSync(target.skillPath, { recursive: true })
        const root = fs.realpathSync(target.skillPath)
        for (const skill of skills) if (fs.existsSync(path.join(root, skill.name))) throw new Error(`已存在 ${skill.name}，保留原文件`)
        const prepared: { temp: string; dest: string }[] = [], installed: string[] = []
        try {
          for (const skill of skills) {
            const temp = path.join(root, `.awb-${randomUUID()}`), dest = path.join(root, skill.name)
            prepared.push({ temp, dest }); fs.cpSync(skill.folder, temp, { recursive: true, errorOnExist: true, force: false })
          }
          for (const item of prepared) {
            if (fs.existsSync(item.dest)) throw new Error('目标目录已变化，请刷新后重试')
            fs.renameSync(item.temp, item.dest); installed.push(item.dest)
          }
        } catch (error) { for (const dest of installed) removeInside(root, dest); throw error }
        finally { for (const { temp } of prepared) removeInside(root, temp) }
      })
    } finally { removeInside(os.tmpdir(), staging) }
  }
}
