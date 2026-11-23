import { useEffect, useRef, useState } from 'react'
import { t } from '../shared/i18n'
import type { DiscoveredSkills } from '../shared/skill-catalog'
import type { ResourceDetail } from '../shared/types'
import { SkillReadme } from './SkillReadme'
import { Icon } from './icons'

export function SkillBrowser({ snapshot, selected, onChange, disabled }: { snapshot: DiscoveredSkills; selected: string[]; onChange: (names: string[]) => void; disabled: boolean }) {
  const [query, setQuery] = useState(''), [focused, setFocused] = useState(snapshot.items[0]?.id || '')
  const [detail, setDetail] = useState<ResourceDetail | null>(null), [error, setError] = useState('')
  const detailHeading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    let stopped = false
    setDetail(null); setError('')
    if (focused) void window.awb.previewDiscoveredSkill(snapshot.id, focused).then((value) => { if (!stopped) setDetail(value) }).catch((error) => { if (!stopped) setError(String(error)) })
    return () => { stopped = true }
  }, [snapshot.id, focused])
  const visible = snapshot.items.filter((item) => `${item.name} ${item.description || ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
  return <div className="skill-browser">
    <div className="skill-browser-tools"><label className="skill-search"><Icon name="search" /><input className="tx" type="search" aria-label={t('搜索 Skill')} placeholder={t('搜索名称或说明')} value={query} disabled={disabled} onChange={(event) => setQuery(event.target.value)} /></label>
      <button className="btn sm" disabled={disabled} onClick={() => onChange(selected.length === snapshot.items.length ? [] : snapshot.items.map((item) => item.id))}>{selected.length === snapshot.items.length ? t('取消全选') : t('全选')}</button>
    </div>
    <p className="skill-selection-count" role="status">{t('发现 {{0}} 项 · 已选择 {{1}} 项', snapshot.items.length, selected.length)}</p>
    <div className="skill-browser-panes"><div className="skill-browser-list" aria-label={t('仓库中的 Skill')}>
      {visible.map((item) => <div key={item.id} className={`skill-option${focused === item.id ? ' active' : ''}`}>
        <input type="checkbox" aria-label={t('选择 {{0}}', item.name)} checked={selected.includes(item.id)} disabled={disabled} onChange={(event) => onChange(event.target.checked ? [...selected, item.id] : selected.filter((name) => name !== item.id))} />
        <button className="skill-preview" aria-pressed={focused === item.id} onClick={(event) => { setFocused(item.id); if ((event.currentTarget.closest('.skill-browser')?.clientWidth || 0) <= 540) requestAnimationFrame(() => detailHeading.current?.scrollIntoView({ block: 'nearest' })) }}><b>{item.name}</b><span>{item.description}</span></button>
      </div>)}
      {!visible.length ? <p className="resource-help">{t('没有匹配的结果')}</p> : null}
    </div><article className="skill-preview-content" aria-busy={!detail && !error}>
      <h3 ref={detailHeading}>{detail?.name || focused}</h3>
      {error ? <p role="alert" className="file-error">{error}</p> : detail ? <><p className="skill-preview-description">{detail.description}</p><SkillReadme content={detail.content} /></> : <p className="resource-help">{t('正在读取…')}</p>}
    </article></div>
  </div>
}
