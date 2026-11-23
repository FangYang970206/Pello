import { t } from './i18n'

export const SKILL_REPOSITORIES = [
  { id: 'mattpocock', repository: 'mattpocock/skills', root: 'skills', get description() { return t('工程设计、调试、测试与代码审查') } },
  { id: 'anthropics', repository: 'anthropics/skills', root: 'skills', get description() { return t('文档、设计与开发工具') } },
  { id: 'superpowers', repository: 'obra/superpowers', root: 'skills', get description() { return t('从需求梳理到实现和验证的开发流程') } },
  { id: 'answer-html', repository: 'QingYunA/answer-me-with-html', root: 'skills', get description() { return t('用可阅读的 HTML 页面回答复杂问题') } },
  { id: 'impeccable', repository: 'pbakaus/impeccable', root: '.agents/skills', get description() { return t('界面设计、审查与细节打磨') } }
] as const

export interface DiscoveredSkills {
  id: string
  repository: string
  revision: string
  items: import('./types').ResourceSourceItem[]
}
export type SkillRepository = { id: string; repository: string; root: string; description: string; ref?: string; custom?: boolean }

export function githubSkillRepository(input: string): SkillRepository {
  const url = new URL(input)
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash) throw new Error('Invalid GitHub repository URL')
  const parts = url.pathname.replace(/\/+$/, '').split('/').slice(1).map(decodeURIComponent)
  const owner = parts[0], name = parts[1]?.replace(/\.git$/, '')
  if (!owner || !name || !/^[\w-]+$/.test(owner) || !/^[\w.-]+$/.test(name) || name === '.' || name === '..') throw new Error('Invalid GitHub repository URL')
  if (parts.length > 2 && (parts[2] !== 'tree' || !parts[3])) throw new Error('Invalid GitHub repository URL')
  const root = parts.slice(4).join('/')
  if (parts.slice(3).some((part) => !part || part === '..' || part === '.' || /[\\\0]/.test(part))) throw new Error('Invalid GitHub repository URL')
  const repository = `${owner}/${name}`
  const known = SKILL_REPOSITORIES.find((item) => item.repository.toLowerCase() === repository.toLowerCase())
  return parts.length === 2 && known ? known : { id: `github:${repository}${parts.length > 2 ? `/tree/${parts.slice(3).join('/')}` : ''}`, repository, root, ref: parts[3], description: '', custom: true }
}
