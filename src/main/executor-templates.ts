import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { executorTemplate, templateCompatible } from '../shared/executor'
import { t } from '../shared/i18n'
import { PRESETS, type Database, type EnvVar, type ExecutorTemplate, type Host, type ResourcePaths, type ResourceScope } from '../shared/types'
import { validateCustomSession } from './agent-resume'

export function machine(db: Database, id: string, requireConnection = false): Host {
  const host = db.hosts.find((item) => item.id === id)
  if (!host) throw new Error(t("机器不存在"))
  if (requireConnection && !host.on) throw new Error(t("这台机器未连接"))
  return host
}

const hasControl = (input: string) => [...input].some((char) => char.charCodeAt(0) < 32)

export function resourcePath(input: string, platform: Host['platform']): string {
  const windows = platform === 'windows'
  if (typeof input !== 'string' || hasControl(input) ||
      !(windows ? /^(?:[a-z]:[\\/]|[\\/]{2}[^\\/?.][^\\/]*[\\/][^\\/]+)/i.test(input) : input.startsWith('/')) ||
      (windows && /[<>:"|?*]/.test(input.replace(/^[a-z]:/i, '')))) {
    throw new Error(t("资源目录和配置文件必须使用绝对路径"))
  }
  return (windows ? path.win32 : path.posix).normalize(input)
}

export function validateResourcePaths(target: ResourcePaths | undefined, platform: Host['platform']): ResourcePaths | undefined {
  if (!target) return
  if (!['standard', 'codex', 'opencode'].includes(target.format) || !['portable', 'claude', 'codex', 'opencode', 'pi', 'omp'].includes(target.skillAdapter || 'portable')) throw new Error(t("请选择支持的资源格式"))
  const normalize = (input: string) => input === '' ? '' : resourcePath(input, platform)
  return { mcpPath: normalize(target.mcpPath), skillPath: normalize(target.skillPath), format: target.format,
    skillAdapter: target.skillAdapter || 'portable', skillConfigPath: normalize(target.skillConfigPath ?? '') || undefined }
}

export function validateTemplateEnv(env: EnvVar[]): EnvVar[] {
  if (!Array.isArray(env) || env.some((row) => !row || typeof row.k !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(row.k) ||
      typeof row.v !== 'string' || typeof row.secret !== 'boolean' || /[\0\r\n]/.test(row.v))) throw new Error(t("请输入有效的环境变量名称和值"))
  return env.map(({ k, v, secret }) => ({ k, v, secret }))
}

function executorExists(db: Database, id: string) {
  return PRESETS.some((item) => item.id === id) || db.custom.some((item) => item.id === id)
}

function checkCompatibility(template: ResourcePaths, executorId: string) {
  if (!templateCompatible(template, executorId)) throw new Error(t("模板与 {{0}} 的原生格式不兼容，请先更换绑定", PRESETS.find((item) => item.id === executorId)?.name || executorId))
}

export function putTemplate(db: Database, input: ExecutorTemplate): ExecutorTemplate {
  const host = machine(db, input.hostId)
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!name || name.length > 80 || hasControl(name)) throw new Error(t("请输入 1 到 80 字符的模板名称"))
  const existing = db.templates.find((entry) => entry.id === input.id)
  if (input.id && !existing) throw new Error(t("模板不存在"))
  if (existing && existing.hostId !== host.id) throw new Error(t("模板必须属于所选机器"))
  if (db.templates.some((entry) => entry.id !== input.id && entry.hostId === host.id && entry.name === name)) throw new Error(t("这台机器已有同名模板"))
  const resources = validateResourcePaths(input, host.platform)!
  for (const ref of db.templateBindings) if (existing && ref.templateId === existing.id) checkCompatibility(resources, ref.executorId)
  validateCustomSession(input.session)
  const template = { ...resources, id: existing?.id || randomUUID(), hostId: host.id, name, env: validateTemplateEnv(input.env),
    session: input.session ? { startArgs: input.session.startArgs, resumeArgs: input.session.resumeArgs } : undefined }
  db.templates = existing ? db.templates.map((entry) => entry.id === template.id ? template : entry) : [...db.templates, template]
  return template
}

export function bindTemplate(db: Database, { hostId, executorId }: ResourceScope, templateId: string) {
  machine(db, hostId)
  if (!executorExists(db, executorId)) throw new Error(t("执行器不存在"))
  if (templateId) {
    const template = db.templates.find((entry) => entry.id === templateId)
    if (!template || template.hostId !== hostId) throw new Error(t("模板必须属于所选机器"))
    checkCompatibility(template, executorId)
  }
  db.templateBindings = db.templateBindings.filter((entry) => entry.hostId !== hostId || entry.executorId !== executorId)
  if (templateId) db.templateBindings.push({ hostId, executorId, templateId })
}

export function deleteTemplate(db: Database, id: string) {
  if (!db.templates.some((entry) => entry.id === id)) throw new Error(t("模板不存在"))
  db.templates = db.templates.filter((entry) => entry.id !== id)
  db.templateBindings = db.templateBindings.filter((entry) => entry.templateId !== id)
}

export function pruneTemplateBindings(db: Database) {
  db.templates = db.templates.filter((entry) => db.hosts.some((host) => host.id === entry.hostId))
  db.templateBindings = db.templateBindings.filter((entry) => executorExists(db, entry.executorId) &&
    db.templates.some((template) => template.id === entry.templateId && template.hostId === entry.hostId && templateCompatible(template, entry.executorId)))
}

export function migrateExecutorTemplates(db: Database, oldTargets: Record<string, Partial<ResourcePaths>>) {
  for (const executor of db.custom) {
    const old = { mcpPath: '', skillPath: '', format: 'standard' as const, ...oldTargets[executor.id], ...executor.resources }
    if (executorTemplate(db, 'local', executor.id) || !(old.mcpPath || old.skillPath || old.skillConfigPath)) continue
    let resources: ResourcePaths | undefined
    try { resources = validateResourcePaths(old, machine(db, 'local').platform) } catch { continue }
    if (!resources) continue
    const template: ExecutorTemplate = { ...resources, id: randomUUID(), hostId: 'local', name: executor.name,
      env: (executor.env || []).map((entry) => ({ ...entry, secret: !!entry.secret })), session: executor.session }
    db.templates.push(template)
    bindTemplate(db, { hostId: 'local', executorId: executor.id }, template.id)
    delete executor.resources
  }
}
