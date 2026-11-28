import { t } from './i18n'

export const SKILL_REPOSITORIES = [
  { id: 'mattpocock', repository: 'mattpocock/skills', get description() { return t('工程设计、调试、测试与代码审查') } },
  { id: 'anthropics', repository: 'anthropics/skills', get description() { return t('文档、设计与开发工具') } },
  { id: 'superpowers', repository: 'obra/superpowers', get description() { return t('从需求梳理到实现和验证的开发流程') } },
  { id: 'answer-html', repository: 'QingYunA/answer-me-with-html', get description() { return t('用可阅读的 HTML 页面回答复杂问题') } },
  { id: 'impeccable', repository: 'pbakaus/impeccable', get description() { return t('界面设计、审查与细节打磨') } }
] as const
