import fs from 'node:fs'
import path from 'node:path'
import { parse as parseJson, type ParseError } from 'jsonc-parser'
import { parse as parseToml } from 'smol-toml'
import { parse as parseYaml } from 'yaml'

type RecordValue = Record<string, unknown>
export type McpImportEntry = { id: string; name: string; path: string; config?: RecordValue; enabled: boolean; error?: string }
const record = (value: unknown): value is RecordValue => !!value && typeof value === 'object' && !Array.isArray(value)

function normalize(raw: unknown): RecordValue {
  if (!record(raw)) throw new Error('服务器配置必须是对象')
  if (raw.args !== undefined && !Array.isArray(raw.args)) throw new Error('args 必须是字符串数组')
  for (const key of ['enabled', 'disabled']) if (raw[key] !== undefined && typeof raw[key] !== 'boolean') throw new Error(`${key} 必须是布尔值`)
  const supported = new Set(['name', 'description', 'type', 'command', 'args', 'env', 'environment', 'url', 'headers', 'http_headers', 'enabled', 'disabled'])
  const extra = Object.keys(raw).filter((key) => !supported.has(key))
  if (extra.length) throw new Error(`包含需要手动适配的字段：${extra.join('、')}`)
  if (raw.url !== undefined) {
    if (typeof raw.url !== 'string' || !['http:', 'https:'].includes(new URL(raw.url).protocol)) throw new Error('HTTP MCP 需要有效的 http/https URL')
    if (raw.type && !['http', 'remote', 'streamable-http'].includes(String(raw.type))) throw new Error('暂不支持此远程传输类型')
    const headers = raw.headers ?? raw.http_headers
    if (headers !== undefined && (!record(headers) || Object.values(headers).some((value) => typeof value !== 'string'))) throw new Error('headers 必须是字符串键值对象')
    return { url: raw.url, ...(headers ? { headers } : {}) }
  }
  if (raw.type && !['stdio', 'local'].includes(String(raw.type))) throw new Error('暂不支持此传输类型')
  if (raw.headers !== undefined || raw.http_headers !== undefined) throw new Error('stdio MCP 不支持 HTTP headers，请确认源配置')
  const commandObject = record(raw.command) ? raw.command : raw
  const command = record(raw.command) ? raw.command.path : Array.isArray(raw.command) ? raw.command[0] : raw.command
  const args = Array.isArray(raw.command) ? [...raw.command.slice(1), ...(Array.isArray(raw.args) ? raw.args : [])] : commandObject.args || []
  const env = commandObject.env ?? raw.environment
  if (typeof command !== 'string' || !command.trim() || command.includes('\0')) throw new Error('stdio MCP 缺少有效 command')
  if (!Array.isArray(args) || args.some((value) => typeof value !== 'string')) throw new Error('args 必须是字符串数组')
  if (env !== undefined && (!record(env) || Object.values(env).some((value) => typeof value !== 'string'))) throw new Error('env 必须是字符串键值对象')
  return { command, args, ...(env ? { env } : {}) }
}

/** Decode source configuration without returning its credentials to the renderer. */
export function readMcpImport(source: string): McpImportEntry[] {
  if (!path.isAbsolute(source) || fs.statSync(source).size > 32_000_000) throw new Error('请选择 32 MB 以内的 MCP 配置文件')
  const text = fs.readFileSync(source, 'utf8').replace(/^\ufeff/, '')
  let value: unknown
  try {
    if (/\.toml$/i.test(source)) value = parseToml(text)
    else if (/\.ya?ml$/i.test(source)) value = parseYaml(text)
    else {
      const errors: ParseError[] = []
      value = parseJson(text, errors, { allowTrailingComma: true })
      if (errors.length) throw new Error('JSON syntax')
    }
  } catch { throw new Error('配置语法有误，请检查 JSON、JSONC、TOML 或 YAML 格式') }
  if (!record(value)) throw new Error('MCP 配置的根节点必须是对象')
  const entries: McpImportEntry[] = []
  function add(name: string, raw: unknown, location: string) {
    const entry: McpImportEntry = { id: `${location}:${name}`, name, path: location, enabled: !record(raw) || (raw.enabled !== false && raw.disabled !== true) }
    try {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new Error('MCP 名称只能包含字母、数字、下划线和连字符，最多 64 字符')
      entry.config = normalize(raw)
    } catch (error) { entry.error = error instanceof Error ? error.message : '无法识别服务器配置' }
    entries.push(entry)
  }
  function collection(map: unknown, location: string) {
    if (!record(map)) throw new Error(`${location} 必须是服务器对象集合`)
    for (const [name, raw] of Object.entries(map)) add(name, raw, location)
  }
  function walk(node: RecordValue, location: string, depth: number) {
    if (depth > 64) throw new Error('配置嵌套超过 64 层，请选择更小的配置文件')
    for (const [key, child] of Object.entries(node)) {
      const current = `${location}.${key}`
      if (['mcpServers', 'mcp_servers', 'context_servers'].includes(key)) collection(child, current)
      else if (key === 'mcp' && record(child)) collection(record(child.servers) ? child.servers : child, current)
      else if (key === 'servers' && location === '$') collection(child, current)
      else if (record(child)) walk(child, current, depth + 1)
    }
  }
  walk(value, '$', 0)
  if (!entries.length) {
    if ('command' in value || 'url' in value) add(typeof value.name === 'string' ? value.name : path.basename(source, path.extname(source)).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64) || 'imported-mcp', value, '$')
    else if (Object.values(value).length && Object.values(value).every((item) => record(item) && ('command' in item || 'url' in item))) collection(value, '$')
  }
  if (!entries.length) throw new Error('未发现 MCP 服务器。支持 mcpServers、mcp_servers、mcp.servers、servers 和 context_servers')
  return entries
}
