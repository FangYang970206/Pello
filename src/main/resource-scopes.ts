import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { executorTemplate } from '../shared/executor'
import { t } from '../shared/i18n'
import { PRESETS, type Database, type Host, type ResourceItem, type ResourceResult, type ResourceScope, type ResourceTarget } from '../shared/types'
import { machine, resourcePath } from './executor-templates'
import { ResourceDuplicate, ResourceManager, nativeResourceTargets } from './resources'
import { readMcpImport, parseMcpImport } from './mcp-import'
import { remoteResource, remoteSnapshot, type RemoteProfile } from './remote-resources'
import { createTreeEntry, renameTreeEntry, targetFor } from './git'
import { publishRemoteStage, removeRemoteStage, treeEntryVersion } from './remote-replace'
import { uploadRemoteSources } from './remote-file'

export type ResourceKind = 'mcp' | 'skills'
type ResolvedScope = { host: Host; target: ResourceTarget; home: string; guard: () => void }
const emptyPaths = { mcpPath: '', skillPath: '', format: 'standard' as const }
const rows = (db: Database) => [...PRESETS, ...db.custom]
export const scopeOf = (scope: ResourceScope | string): ResourceScope => typeof scope === 'string' ? { hostId: 'local', executorId: scope } : scope

function localCanonical(input: string): string {
  try { return fs.realpathSync.native(input) }
  catch (error) {
    const parent = path.dirname(input)
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === input) throw error
    return path.join(localCanonical(parent), path.basename(input))
  }
}

export class ScopedResources {
  private local: ResourceManager
  private distributing = false
  constructor(private data: string, private database: () => Database) { this.local = new ResourceManager(data) }

  private guard(scope: ResourceScope) {
    const material = () => {
      const db = this.database(), host = machine(db, scope.hostId, true)
      if (!rows(db).some((item) => item.id === scope.executorId)) throw new Error(t("执行器不存在"))
      return JSON.stringify([host.id, host.addr, host.user, host.port, host.platform, host.auth, executorTemplate(db, host.id, scope.executorId)])
    }
    const before = material()
    return () => { if (material() !== before) throw new Error(t("资源目标已改变，请刷新后重试")) }
  }
  private async native(host: Host, signal?: AbortSignal) {
    if (host.id === 'local') return { targets: this.local.nativeTargets(), home: '' }
    const profile = await remoteResource<RemoteProfile>(host, { op: 'profile' }, undefined, signal)
    const paths = host.platform === 'windows' ? path.win32 : path.posix
    return { targets: nativeResourceTargets(profile.home, profile.env, paths, (file) => file === profile.jsonc), home: profile.home }
  }
  private describe(db: Database, scope: ResourceScope, defaults: ResourceTarget[]): ResourceTarget {
    const id = scope.executorId
    const executor = rows(db).find((item) => item.id === id)
    if (!executor) throw new Error(t("执行器不存在"))
    const template = executorTemplate(db, scope.hostId, id)
    const resources = template ? { mcpPath: template.mcpPath, skillPath: template.skillPath, skillConfigPath: template.skillConfigPath,
      format: template.format, skillAdapter: template.skillAdapter } : defaults.find((item) => item.id === id) || emptyPaths
    return { ...resources, id, name: executor.name, hostId: scope.hostId, templateName: template?.name }
  }
  async targets(hostId: string): Promise<ResourceTarget[]> {
    const db = this.database(), host = machine(db, hostId, true)
    const { targets } = await this.native(host)
    const current = this.database()
    const updatedHost = machine(current, hostId, true)
    if (['addr', 'user', 'port', 'platform', 'auth'].some((key) => host[key as keyof Host] !== updatedHost[key as keyof Host])) throw new Error(t("资源目标已改变，请刷新后重试"))
    return rows(current).map((executor) => this.describe(current, { hostId, executorId: executor.id }, targets))
  }
  private async resolve(scope: ResourceScope, profiles = new Map<string, ReturnType<ScopedResources['native']>>(), guard = this.guard(scope), signal?: AbortSignal): Promise<ResolvedScope> {
    guard()
    const db = this.database(), host = machine(db, scope.hostId, true)
    // An explicit template needs no profile lookup. Native targets share one per host and distribution.
    let profile = profiles.get(host.id)
    if (!profile && !executorTemplate(db, host.id, scope.executorId) && PRESETS.some((item) => item.id === scope.executorId)) {
      profile = this.native(host, signal)
      profiles.set(host.id, profile)
    }
    const { targets, home } = profile ? await profile : { targets: [], home: '' }
    guard()
    return { host, target: this.describe(db, scope, targets), home, guard }
  }
  private async manager(context: ResolvedScope, kind: ResourceKind, signal?: AbortSignal) {
    const { host, target, home, guard } = context
    if (host.id === 'local') return { manager: this.local, publish: () => Promise.resolve() }
    const paths = host.platform === 'windows' ? path.win32 : path.posix
    const layout = new ResourceManager(this.data, home, undefined, paths)
    const files = kind === 'mcp' ? [target.mcpPath] : [layout.settingsFile(target)]
    const snapshot = await remoteSnapshot(host, files, kind === 'skills' ? layout.skillRoots(target) : [], guard, signal)
    guard()
    return { manager: new ResourceManager(this.data, home, snapshot, paths), publish: () => snapshot.publish(host, guard) }
  }
  async list(kind: ResourceKind, scope: ResourceScope, page: number, query: string, signal: AbortSignal) {
    const resolved = await this.resolve(scope, undefined, undefined, signal)
    const { target, guard } = resolved, { manager } = await this.manager(resolved, kind, signal)
    const result = await manager.listAsync([target], kind, target.id, page, query, false, signal)
    guard()
    return result
  }
  async detail(kind: ResourceKind, scope: ResourceScope, item: ResourceItem) {
    const resolved = await this.resolve(scope), { target, guard } = resolved
    const { manager } = await this.manager(resolved, kind)
    guard()
    return manager.detail([target], kind, target.id, item)
  }
  async toggle(kind: ResourceKind, scope: ResourceScope, item: ResourceItem, enabled: boolean) {
    const resolved = await this.resolve(scope), { target, guard } = resolved
    const { manager, publish } = await this.manager(resolved, kind)
    guard()
    manager.toggle([target], kind, target.id, item, enabled)
    await publish()
  }
  async skillDirectory(scope: ResourceScope, item: ResourceItem, removing = false) {
    const { host, target, guard } = await this.resolve(scope)
    if (host.id !== 'local') throw new Error(t("此操作仅适用于本机 Skill"))
    guard()
    return this.local.skillDirectory([target], target.id, item, removing)
  }
  private async sourceMcp(source: string, hostId: string) {
    const host = machine(this.database(), hostId, true)
    if (host.id === 'local') return readMcpImport(source)
    const file = resourcePath(source, host.platform)
    const snapshot = await remoteSnapshot(host, [file], [])
    const current = machine(this.database(), hostId, true)
    if (['addr', 'user', 'port', 'platform', 'auth'].some((key) => host[key as keyof Host] !== current[key as keyof Host])) throw new Error(t("资源目标已改变，请刷新后重试"))
    const content = snapshot.read(file)
    if (!snapshot.exists(file)) throw new Error(t("文件不存在"))
    return parseMcpImport(file, content)
  }
  async scan(kind: ResourceKind, source: string, hostId = 'local') {
    if (kind === 'skills') {
      if (hostId !== 'local') throw new Error(t("请选择本机 Skill 文件夹或 ZIP 压缩包"))
      return this.local.scanSkills(source).map((item) => ({ ...item, id: item.name }))
    }
    return (await this.sourceMcp(source, hostId)).map(({ config: _config, ...item }) => item)
  }
  private async distribute<T extends { name: string; id?: string }>(kind: ResourceKind, entries: T[], scopes: ResourceScope[],
    run: (item: T, scope: ResolvedScope, canonical: string) => Promise<void>): Promise<ResourceResult[]> {
    if (this.distributing) throw new Error(t("正在分发资源，请稍候"))
    if (!scopes.length) throw new Error(t("请选择至少一个 Code Agent"))
    const results: ResourceResult[] = [], completed = new Map<string, Pick<ResourceResult, 'ok' | 'error' | 'skipped'>>()
    const unique = new Map(scopes.map((scope) => [JSON.stringify([scope.hostId, scope.executorId]), scope]))
    const targets = [...unique.values()].map((scope) => {
      try { return { scope, guard: this.guard(scope) } }
      catch (error) { return { scope, error } }
    })
    const profiles = new Map<string, ReturnType<ScopedResources['native']>>()
    this.distributing = true
    try {
      for (const { scope, guard, error: scopeError } of targets) {
        const result = (item: T, outcome: Pick<ResourceResult, 'ok' | 'error' | 'skipped'>): ResourceResult =>
          ({ agent: scope.executorId, hostId: scope.hostId, name: item.name, id: item.id, ...outcome })
        const failed = (error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : String(error), skipped: error instanceof ResourceDuplicate })
        let context: ResolvedScope, canonical: string, key: string
        try {
          if (scopeError) throw scopeError
          context = await this.resolve(scope, profiles, guard)
          const file = kind === 'skills' ? context.target.skillPath : context.target.mcpPath
          if (!file) throw new Error(t("请先设置执行器的资源路径"))
          canonical = context.host.id === 'local' ? localCanonical(file) : await remoteResource<string>(context.host, { op: 'canonical', path: file }, context.guard)
          const identity = context.host.platform === 'windows' ? canonical.toLowerCase() : canonical
          key = JSON.stringify([context.host.id, identity])
          context.guard()
        } catch (error) {
          for (const item of entries) results.push(result(item, failed(error)))
          continue
        }
        for (const item of entries) {
          const itemKey = JSON.stringify([key, item.id || item.name])
          try {
            context.guard()
            if (!completed.has(itemKey)) {
              try { await run(item, context, canonical); completed.set(itemKey, { ok: true }) }
              catch (error) { completed.set(itemKey, failed(error)) }
            }
            results.push(result(item, completed.get(itemKey)!))
          } catch (error) { results.push(result(item, failed(error))) }
        }
      }
      return results
    } finally { this.distributing = false }
  }
  addMcp(name: string, config: Record<string, unknown>, scopes: ResourceScope[]) {
    return this.writeMcp([{ name, config, enabled: true }], scopes)
  }
  private writeMcp(entries: { id?: string; name: string; config?: Record<string, unknown>; enabled: boolean; error?: string }[], scopes: ResourceScope[]) {
    return this.distribute('mcp', entries, scopes, async (entry, scope) => {
      if (!entry.config || entry.error) throw new Error(entry.error || t("无效配置"))
      const { manager, publish } = await this.manager(scope, 'mcp')
      scope.guard()
      const result = manager.addMcp([scope.target], entry.name, entry.config, [scope.target.id], entry.enabled)[0]
      if (result.skipped) throw new ResourceDuplicate(result.error)
      if (!result.ok) throw new Error(result.error)
      await publish()
    })
  }
  async importMcp(source: string, scopes: ResourceScope[], ids: string[], hostId = 'local') {
    const entries = await this.sourceMcp(source, hostId)
    if (!ids.length || ids.some((id) => !entries.some((entry) => entry.id === id))) throw new Error(t("请选择扫描结果中的 MCP"))
    return this.writeMcp(entries.filter((entry) => ids.includes(entry.id)), scopes)
  }
  importSkills(source: string, scopes: ResourceScope[], names?: string[]) {
    return this.local.withSkills(source, (discovered) => {
      const skills = names ? discovered.filter((skill) => names.includes(skill.name)) : discovered
      if (!skills.length || (names && names.some((name) => !skills.some((skill) => skill.name === name)))) throw new Error(t("请选择扫描结果中的 Skill"))
      return this.distribute('skills', skills, scopes, async ({ folder, name }, scope, canonical) => {
        if (scope.host.id === 'local') {
          await this.local.installSkill(canonical, folder, name, (root, stage, basename) => {
            scope.guard()
            return renameTreeEntry(targetFor(root, null), stage, basename, true)
          })
          return
        }
        await this.uploadSkill(scope, canonical, folder, name)
      })
    })
  }
  private async uploadSkill({ host, guard }: ResolvedScope, root: string, folder: string, name: string) {
    await remoteResource(host, { op: 'mkdir', path: root }, guard)
    const target = targetFor(root, host), stage = '.awb-upload-tree-' + randomUUID()
    if (await treeEntryVersion(target, name, AbortSignal.timeout(20000)) !== 'absent') throw new ResourceDuplicate(t("已存在 {{0}}，保留原文件", name))
    guard()
    await createTreeEntry(target, '', stage, true)
    try {
      let failure = ''
      await uploadRemoteSources(target, stage, fs.readdirSync(folder).map((file) => path.join(folder, file)),
        AbortSignal.timeout(60000), () => {}, (_source, _destination, error) => { failure ||= error || '' },
        async () => 'skip', undefined, { file: guard })
      if (failure) throw new Error(failure)
      guard()
      const warning = await publishRemoteStage(target, name, stage, 'absent')
      if (warning) throw new Error(warning)
    } catch (error) {
      await removeRemoteStage(target, stage).catch(() => undefined)
      throw error
    }
  }
}
