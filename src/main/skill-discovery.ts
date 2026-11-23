import fs from 'node:fs/promises'
import path from 'node:path'
import { unzipSync, zipSync } from 'fflate'
import { t } from '../shared/i18n'
import { SKILL_REPOSITORIES, githubSkillRepository, type DiscoveredSkills, type SkillRepository } from '../shared/skill-catalog'
import { ResourceManager } from './resources'
import type { ResourceTarget } from '../shared/types'

const LIMIT = 32 * 1024 * 1024
type Download = (url: string, init: RequestInit) => Promise<Response>

/** Each preview owns an immutable archive. Installing never redownloads a moving branch. */
export class SkillDiscovery {
  private sessions = new Map<string, { controller: AbortController; source: string; ready: boolean; installing: boolean; finished: Promise<void> }>()
  constructor(private directory: string, private resources: ResourceManager, private download: Download = fetch) {}
  async repositories(): Promise<SkillRepository[]> {
    let custom: SkillRepository[] = []
    try {
      const saved = JSON.parse(await fs.readFile(path.join(this.directory, 'repositories.json'), 'utf8'))
      if (Array.isArray(saved)) custom = saved.map((item) => githubSkillRepository(item)).filter((item) => item.custom)
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    return [...SKILL_REPOSITORIES, ...custom]
  }

  private async bytes(url: string, signal: AbortSignal, limit = LIMIT): Promise<Uint8Array> {
    const response = await this.download(url, { signal, redirect: 'error', headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Pello' } })
    if (!response.ok || !response.body) throw new Error(t('无法下载 Skill 仓库（HTTP {{0}}），请重试。', response.status))
    if (Number(response.headers.get('content-length')) > limit) { await response.body.cancel(); throw new Error(t('Skill 下载超过大小限制。')) }
    const reader = response.body.getReader(), chunks: Uint8Array[] = []
    let bytes = 0
    try {
      while (true) {
        const part = await reader.read()
        if (part.done) break
        if ((bytes += part.value.length) > limit) throw new Error(t('Skill 下载超过大小限制。'))
        chunks.push(part.value)
      }
    } catch (error) { await reader.cancel().catch(() => {}); throw error }
    finally { reader.releaseLock() }
    return Buffer.concat(chunks, bytes)
  }

  async scan(repositoryId: string, id: string): Promise<DiscoveredSkills> {
    if (!/^[a-f0-9-]{36}$/.test(id) || this.sessions.has(id)) throw new Error(t('无效的 Skill 发现请求。'))
    const controller = new AbortController(), source = path.join(this.directory, `${id}.zip`)
    let finish!: () => void
    const finished = new Promise<void>((resolve) => { finish = resolve })
    const session = { controller, source, ready: false, installing: false, finished }
    this.sessions.set(id, session)
    const timer = setTimeout(() => controller.abort(), 60000)
    try {
      let repository = (await this.repositories()).find((item) => item.id === repositoryId)
      if (!repository) {
        try { repository = githubSkillRepository(repositoryId) }
        catch (error) { throw new Error(t('请输入有效的 GitHub 仓库或目录链接。'), { cause: error }) }
      }
      if (controller.signal.aborted) throw new Error(t('Skill 下载已取消或超时，请重试。'))
      const metadata = JSON.parse(Buffer.from(await this.bytes(`https://api.github.com/repos/${repository.repository}/commits/${encodeURIComponent(repository.ref || 'HEAD')}`, controller.signal, 2_000_000)).toString('utf8'))
      const revision = metadata.sha
      if (typeof revision !== 'string' || !/^[a-f0-9]{40}$/.test(revision)) throw new Error(t('Skill 仓库版本无效，请重试。'))
      let root = repository.root
      if (repository.custom && !root) {
        const tree = JSON.parse(Buffer.from(await this.bytes(`https://api.github.com/repos/${repository.repository}/git/trees/${revision}?recursive=1`, controller.signal, 8_000_000)).toString('utf8'))
        if (tree.truncated || !Array.isArray(tree.tree)) throw new Error(t('仓库目录不完整，请导入具体的 Skill 目录链接。'))
        const paths = tree.tree.map((item: { path: string }) => item.path)
        if (!paths.includes('SKILL.md')) root = ['skills', '.agents/skills', '.claude/skills'].find((prefix) => paths.some((file: string) => file.startsWith(prefix + '/') && file.endsWith('/SKILL.md'))) || ''
      }
      const archive = await this.bytes(`https://codeload.github.com/${repository.repository}/zip/${revision}`, controller.signal)
      let count = 0, expanded = 0
      const files = unzipSync(archive, { filter: (entry) => {
        const relative = entry.name.split('/').slice(1).join('/')
        if ((root && !relative.startsWith(`${root}/`)) || (!root && relative.split('/').some((part) => part.startsWith('.') || ['tests', 'test', 'examples', 'node_modules'].includes(part))) || entry.name.endsWith('/')) return false
        if (relative.includes('\\') || relative.includes('\0') || relative.split('/').some((part) => !part || part === '..' || part === '.')) throw new Error(t('Skill 仓库包含非法路径。'))
        if (++count > 10000 || (expanded += entry.originalSize) > LIMIT) throw new Error(t('Skill 包超过 10000 个文件或 32 MB'))
        return true
      } })
      if (controller.signal.aborted) throw new Error(t('Skill 下载已取消或超时，请重试。'))
      await fs.mkdir(this.directory, { recursive: true })
      await fs.writeFile(source, zipSync(files), { flag: 'wx' })
      const items = this.resources.scanSkills(source).map((item) => ({ ...item, id: item.name }))
      if (controller.signal.aborted) throw new Error(t('Skill 下载已取消或超时，请重试。'))
      session.ready = true
      if (repository.custom) {
        const all = await this.repositories()
        const urls = all.filter((item) => item.custom && item.id !== repository!.id).map((item) => `https://github.com/${item.repository}${item.ref ? `/tree/${item.ref}${item.root ? '/' + item.root : ''}` : ''}`)
        urls.push(`https://github.com/${repository.repository}${repository.ref ? `/tree/${repository.ref}${repository.root ? '/' + repository.root : ''}` : ''}`)
        const file = path.join(this.directory, 'repositories.json'), temporary = file + `.${id}.tmp`
        try { await fs.writeFile(temporary, JSON.stringify(urls), { flag: 'wx' }); await fs.rename(temporary, file) }
        finally { await fs.rm(temporary, { force: true }) }
      }
      return { id, repository: repository.repository, revision, items }
    } catch (error) {
      const cancelled = controller.signal.aborted
      controller.abort(); this.sessions.delete(id)
      await fs.rm(source, { force: true })
      if (cancelled) throw new Error(t('Skill 下载已取消或超时，请重试。'), { cause: error })
      throw error
    } finally { clearTimeout(timer); finish() }
  }

  install(id: string, targets: ResourceTarget[], agents: string[], names: string[]) {
    const session = this.sessions.get(id)
    if (!session?.ready || session.installing || !Array.isArray(names) || !names.length) throw new Error(t('请先选择仓库并扫描 Skill。'))
    session.installing = true
    try { return this.resources.importSkills(targets, session.source, agents, names) }
    finally { session.installing = false }
  }
  preview(id: string, name: string) {
    const session = this.sessions.get(id)
    if (!session?.ready) throw new Error(t('请先选择仓库并扫描 Skill。'))
    return this.resources.previewSkill(session.source, name)
  }

  async close(id: string): Promise<void> {
    const session = this.sessions.get(id)
    if (!session || session.installing) return
    session.controller.abort(); this.sessions.delete(id)
    await session.finished
    await fs.rm(session.source, { force: true })
  }
  async dispose(): Promise<void> { await Promise.all([...this.sessions.keys()].map((id) => this.close(id))) }
}
