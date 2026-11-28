import { useState } from 'react'
import { t } from '../shared/i18n'
import { SKILL_REPOSITORIES } from '../shared/skill-catalog'
import { Icon } from './icons'
import { ResourceDialog } from './ResourceDialog'

export function SkillRecommendations({ onClose }: { onClose: () => void }) {
  const [error, setError] = useState('')

  async function open(id: string) {
    setError('')
    try { await window.awb.openSkillRecommendation(id) }
    catch (reason) { setError(String(reason)) }
  }

  return <ResourceDialog title={t('推荐 Skill')} className="skill-recommendations-dialog" onClose={onClose}
    footer={<><span className="grow" /><button className="btn" onClick={onClose}>{t('关闭')}</button></>}>
    {error ? <p role="alert" className="file-error">{error}</p> : null}
    <div className="skill-repositories">{SKILL_REPOSITORIES.map((item) => {
      const [owner, name] = item.repository.split('/')
      return <button className="skill-repository" key={item.id} aria-label={t('在浏览器中打开 {{0}}', item.repository)} onClick={() => void open(item.id)}>
        <span className="skill-repository-top"><Icon name="github" /><span>{owner}</span></span>
        <b>{name}</b><span>{item.description}</span>
      </button>
    })}</div>
  </ResourceDialog>
}
