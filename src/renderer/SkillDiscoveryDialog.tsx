import { useEffect, useRef, useState } from 'react'
import { t } from '../shared/i18n'
import { SKILL_REPOSITORIES, type DiscoveredSkills, type SkillRepository } from '../shared/skill-catalog'
import type { ResourceResult, ResourceTarget } from '../shared/types'
import { ResourceDialog } from './ResourceDialog'
import { SkillBrowser } from './SkillBrowser'
import { Icon } from './icons'

export function SkillDiscoveryDialog({ targets, agent, onClose, onInstalled }: {
  targets: ResourceTarget[]; agent: string; onClose: () => void; onInstalled: (results: ResourceResult[]) => void
}) {
  const [repository, setRepository] = useState('')
  const [repositories, setRepositories] = useState<SkillRepository[]>([...SKILL_REPOSITORIES])
  const [github, setGithub] = useState('')
  const [snapshot, setSnapshot] = useState<DiscoveredSkills | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [agents, setAgents] = useState([agent])
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false)
  const [error, setError] = useState(''), [results, setResults] = useState<ResourceResult[]>([])
  const request = useRef(''), installing = useRef(false)
  useEffect(() => () => { if (request.current) void window.awb.closeSkillDiscovery(request.current); request.current = '' }, [])
  useEffect(() => { let stopped = false; void window.awb.skillRepositories().then((items) => { if (!stopped) setRepositories(items) }).catch((error) => { if (!stopped) setError(String(error)) }); return () => { stopped = true } }, [])

  async function scan(id: string) {
    if (installing.current) return
    if (request.current) void window.awb.closeSkillDiscovery(request.current)
    const token = crypto.randomUUID(); request.current = token
    setRepository(id); setSnapshot(null); setSelected([]); setResults([]); setError(''); setLoading(true)
    try {
      const value = await window.awb.discoverSkills(id, token)
      if (request.current !== token) return
      setSnapshot(value); setSelected(value.items.map((item) => item.id))
      const repositories = await window.awb.skillRepositories()
      if (request.current === token) setRepositories(repositories)
    } catch (reason) { if (request.current === token) setError(String(reason)) }
    finally { if (request.current === token) setLoading(false) }
  }
  function back() {
    if (request.current) void window.awb.closeSkillDiscovery(request.current)
    request.current = ''; setRepository(''); setSnapshot(null); setLoading(false); setError(''); setResults([])
  }
  async function install() {
    if (!snapshot || installing.current || !agents.length || !selected.length) return
    installing.current = true; setBusy(true); setError(''); setResults([])
    try {
      const results = await window.awb.installDiscoveredSkills(snapshot.id, agents, selected)
      onInstalled(results)
      if (results.every((item) => item.ok)) onClose()
      else { setResults(results); setAgents([...new Set(results.filter((item) => !item.ok).map((item) => item.agent))]) }
    } catch (reason) { setError(String(reason)) }
    finally { installing.current = false; setBusy(false) }
  }
  const current = repositories.find((item) => item.id === repository)
  return <ResourceDialog title={t('发现 Skill')} className="skill-discovery-dialog" onClose={onClose} busy={busy} footer={<>
    {snapshot ? <span className="skill-install-summary">{t('已选择 {{0}} 个 Skill', selected.length)}</span> : null}
    <span className="grow" /><button className="btn" disabled={busy} onClick={onClose}>{t('取消')}</button>
    <button className="btn pri" disabled={busy || loading || !snapshot || !selected.length || !agents.length} onClick={() => void install()}>{busy ? t('正在安装…') : t('安装所选 Skill')}</button>
  </>}>
    {repository ? <>
      <div className="skill-repository-heading"><button className="ib" aria-label={t('返回仓库')} disabled={busy} onClick={back}><Icon name="back" /></button><div><h3>{snapshot?.repository || current?.repository || repository}</h3><p>{current?.description || t('选择需要的 Skill，点击名称查看完整说明。')}</p></div></div>
      {loading ? <p role="status">{t('正在获取仓库中的 Skill…')}</p> : null}
      {snapshot ? <>
        <SkillBrowser key={snapshot.id} snapshot={snapshot} selected={selected} onChange={setSelected} disabled={busy} />
        <fieldset disabled={busy}><legend>{t('分发到 Code Agent')}</legend><div className="resource-agents">
          {targets.map((item) => <label key={item.id} className="resource-choice"><input type="checkbox" checked={agents.includes(item.id)} onChange={(event) => setAgents(event.target.checked ? [...agents, item.id] : agents.filter((id) => id !== item.id))} />{item.name}</label>)}
        </div></fieldset></> : null}
      {error ? <><p className="file-error" role="alert">{error}</p><button className="btn sm" disabled={busy || loading} onClick={() => void (snapshot ? install() : scan(repository))}>{t('重试')}</button></> : null}
      {results.filter((item) => !item.ok).map((item) => <p className="file-error" role="alert" key={`${item.agent}:${item.name || ''}`}>{targets.find((target) => target.id === item.agent)?.name || item.agent} · {item.name} · {item.error}</p>)}
    </> : <>
      <form className="skill-github-import" onSubmit={(event) => { event.preventDefault(); if (github.trim()) void scan(github.trim()) }}><label htmlFor="skill-github-url">{t('从 GitHub 导入仓库')}</label><div><input id="skill-github-url" className="tx" type="url" required placeholder="https://github.com/owner/repository" value={github} onChange={(event) => setGithub(event.target.value)} /><button className="btn" type="submit" disabled={!github.trim()}>{t('导入')}</button></div></form>
      {error ? <p role="alert" className="file-error">{error}</p> : null}
      <div className="skill-repositories">{repositories.map((item) => <button className="skill-repository" key={item.id} aria-label={t('打开 {{0}}', item.repository)} onClick={() => void scan(item.id)}>
        <span className="skill-repository-top"><Icon name="github" /><span>{item.repository.split('/')[0]}</span><Icon name="chev" /></span>
        <b>{item.repository.split('/')[1]}</b><span>{item.description || t('手动导入的 Skill 仓库')}</span><span className="skill-repository-action">{t('浏览 Skill')}</span>
      </button>)}</div>
    </>}
  </ResourceDialog>
}
