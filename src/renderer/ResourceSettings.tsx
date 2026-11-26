import { t } from '../shared/i18n'
import { useEffect, useRef, useState } from 'react'
import { PRESETS, type ResourcePage, type ResourceTarget, type ResourceItem, type ResourceDetail } from '../shared/types'
import { executorTemplate } from '../shared/executor'
import { ResourceMachineSelect } from './ResourceMachineSelect'
import { ResourceDistribution, type ResourceSettingsState, type ResourceKind } from './ResourceDistribution'
import { ResourceDialog } from './ResourceDialog'
import { ResourceItemMenu } from './ResourceItemMenu'
import { Icon } from './icons'
import { SkillRecommendations } from './SkillRecommendations'
import { SkillReadme } from './SkillReadme'

export function ResourceSettings({ kind, state, hostId, onHost, onManageTemplate }: {
  kind: ResourceKind; state: ResourceSettingsState; hostId: string; onHost: (id: string) => void; onManageTemplate: (agent: string, id?: string) => void
}) {
  const [agent, setAgent] = useState('claude')
  const currentAgent = [...PRESETS, ...state.custom].some((item) => item.id === agent) ? agent : 'claude'
  const template = executorTemplate(state, hostId, currentAgent)
  const host = state.hosts.find((item) => item.id === hostId)
  const key = JSON.stringify([host, currentAgent, template?.id, template?.name, template?.mcpPath, template?.skillPath, template?.skillConfigPath, template?.format, template?.skillAdapter])
  return <ResourceScopeList key={key} kind={kind} state={state} hostId={hostId} agent={currentAgent} onAgent={setAgent} onHost={onHost} onManageTemplate={onManageTemplate} />
}

function ResourceScopeList({ kind, state, hostId, agent, onAgent, onHost, onManageTemplate }: {
  kind: ResourceKind; state: ResourceSettingsState; hostId: string; agent: string; onAgent: (id: string) => void;
  onHost: (id: string) => void; onManageTemplate: (agent: string, id?: string) => void
}) {
  const scope = { hostId, executorId: agent }
  const template = executorTemplate(state, hostId, agent)
  const choices = [...PRESETS, ...state.custom]
  const builtin = PRESETS.some((item) => item.id === agent)
  const [targets, setTargets] = useState<ResourceTarget[]>([])
  const [page, setPage] = useState(1)
  const [query, setQuery] = useState('')
  const [listing, setListing] = useState<ResourcePage | null>(null)
  const [error, setError] = useState('')
  const [adding, setAdding] = useState(false)
  const [recommending, setRecommending] = useState(false)
  const [busy, setBusy] = useState(false)
  const [tick, setTick] = useState(0)
  const [details, setDetails] = useState<ResourceDetail | null>(null)
  const detailOpener = useRef<HTMLButtonElement | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<ResourceItem | null>(null)
  const [deleteError, setDeleteError] = useState('')
  const target = targets.find((item) => item.id === agent)
  const resourcePath = kind === 'mcp' ? target?.mcpPath : target?.skillPath
  const missing = (!builtin && !template) || (!!target && !resourcePath)
  useEffect(() => {
    let stopped = false
    void window.awb.resourceTargets(hostId).then((value) => { if (!stopped) setTargets(value) }).catch((reason) => { if (!stopped) setError(String(reason)) })
    return () => { stopped = true }
  }, [hostId])
  useEffect(() => {
    let stopped = false
    setListing(null); setError('')
    void window.awb.resourceList(kind, agent, page, query).then((value) => { if (!stopped) setListing(value) }).catch((reason) => { if (!stopped) setError(String(reason)) })
    return () => { stopped = true }
  }, [kind, hostId, agent, page, query, tick, missing])
  async function inspect(item: ResourceItem, opener: HTMLButtonElement) {
    detailOpener.current = opener
    setPending(item.path + item.name); setError('')
    try { setDetails(await window.awb.resourceDetail(kind, scope, item)) }
    catch (reason) { setError(String(reason)) } finally { setPending(null) }
  }
  async function toggle(item: ResourceItem) {
    setPending(item.path + item.name); setError('')
    try { await window.awb.resourceToggle(kind, scope, item, item.enabled === false); setTick((value) => value + 1) }
    catch (reason) { setError(String(reason)) } finally { setPending(null) }
  }
  async function openFolder(item: ResourceItem) {
    setPending(item.path + item.name); setError('')
    try { await window.awb.openSkillFolder(scope, item) }
    catch (reason) { setError(String(reason)) } finally { setPending(null) }
  }
  async function removeSkill() {
    if (!deleting || busy) return
    setBusy(true); setDeleteError('')
    try { await window.awb.deleteSkill(scope, deleting); setDeleting(null); setTick((value) => value + 1) }
    catch (reason) { setDeleteError(String(reason)) } finally { setBusy(false) }
  }
  return <div className="group resources">
    {recommending ? <SkillRecommendations onClose={() => setRecommending(false)} /> : null}
    {details ? <ResourceDialog title={details.name} compact={kind === 'skills'} dismissOnBackdrop returnFocus={detailOpener.current} onClose={() => setDetails(null)} footer={<><span className="grow" /><button className="btn" onClick={() => setDetails(null)}>{t("关闭")}</button></>}>
      <dl className="resource-details"><dt>Agent</dt><dd>{target?.name}</dd><dt>{t("状态")}</dt><dd>{details.enabled === false ? t("已停用") : t("已启用")}</dd><dt>{t("位置")}</dt><dd>{details.path}</dd>
      {details.description ? <><dt>{t("说明")}</dt><dd>{details.description}</dd></> : null}</dl>
      {details.notice ? <p className="resource-help">{details.notice}</p> : null}{kind === 'skills' ? <SkillReadme content={details.content} /> : <pre className="resource-content">{details.content}</pre>}
    </ResourceDialog> : null}
    {deleting ? <ResourceDialog title={t("删除 Skill")} onClose={() => setDeleting(null)} busy={busy} footer={<>
      <span className="grow" /><button className="btn" disabled={busy} onClick={() => setDeleting(null)}>{t("取消")}</button><button className="btn dangerf" disabled={busy} onClick={() => void removeSkill()}>{busy ? t("正在删除…") : t("删除")}</button>
    </>}><p>{t("将 ")}<strong>{deleting.name}</strong> {t(" 的文件夹及附属文件移到系统回收站，可从回收站恢复。共享此目录的其他 Agent 也会受影响。")}</p>
      <p className="resource-path">{deleting.path}</p>{deleteError ? <p className="file-error" role="alert">{deleteError}</p> : null}
    </ResourceDialog> : null}
    <div className="resource-toolbar">
      <ResourceMachineSelect hosts={state.hosts} value={hostId} onChange={onHost} />
      <span className="resource-header-actions">{kind === 'skills' ? <button className="btn sm" onClick={() => setRecommending(true)}>{t("推荐")}</button> : null}
        <button className="btn sm pri" onClick={() => setAdding(true)}>{kind === 'mcp' ? t("添加 MCP") : t("添加")}</button></span>
    </div>
    <div className="resource-agents" role="tablist" aria-label="Code Agent">
      {choices.map((item) => <button key={item.id} className={`btn sm ${agent === item.id ? 'on' : ''}`} role="tab" aria-selected={agent === item.id}
        onClick={() => onAgent(item.id)}>{item.name}</button>)}
    </div>
    <div className="resource-location"><Icon name={missing ? 'info' : 'file'} /><div>
      <b>{template?.name || (builtin ? t("原生默认") : t("未选择模板"))}</b>
      {resourcePath ? <div className="mono resource-help">{resourcePath}</div> : missing ? <small>{template ? t("模板尚未填写资源路径") : t("请为当前机器上的执行器选择模板")}</small> : null}
    </div><button className="btn sm ghost" onClick={() => onManageTemplate(agent, missing ? template?.id : undefined)}>{template && missing ? t("编辑模板") : missing ? t("选择模板") : t("管理模板")}</button></div>
    {adding ? <ResourceDistribution kind={kind} state={state} current={scope} currentValid={!missing && !!state.hosts.find((host) => host.id === hostId)?.on} onRefresh={() => setTick((value) => value + 1)} onClose={() => setAdding(false)} /> : null}
    {error ? <p role="alert" className="file-error">{error}</p> : null}
    <label className="fld"><span>{t("搜索")}{kind === 'mcp' ? ' MCP' : ' Skill'}</span><input className="tx" type="search" value={query} onChange={(event) => { setQuery(event.target.value); setPage(1) }} /></label>
    {listing?.errors.map((value) => <p key={value} className="file-error" role="alert">{value}</p>)}
    <div className="card" role="tabpanel" aria-label={`${target?.name || agent} ${kind}`}>
      {!listing ? missing || error ? null : <div className="srow" role="status">{t("正在读取…")}</div> : listing.items.length ? listing.items.map((item) => <div className="srow resource-item" key={item.path + item.name}>
        {kind === 'skills' ? <button className="resource-name resource-open" disabled={!!pending} onClick={(event) => void inspect(item, event.currentTarget)}>{item.name}</button> : <b className="resource-name">{item.name}</b>}<span className="grow" />
        <button className="ib" aria-label={t("查看 {{0}} 详情", item.name)} disabled={!!pending} onClick={(event) => void inspect(item, event.currentTarget)}><Icon name="eye" /></button>
        <button className={`switch ${item.enabled !== false ? 'on' : ''}`} role="switch" aria-checked={item.enabled !== false} aria-label={t("启用 {{0}}", item.name)} disabled={!!pending}
          onClick={() => void toggle(item)} />
        {kind === 'skills' && hostId === 'local' ? <ResourceItemMenu name={item.name} disabled={!!pending || busy} onOpen={() => void openFolder(item)} onDelete={() => { setDeleteError(''); setDeleting(item) }} /> : null}
      </div>) : <div className="srow">{query ? t("没有匹配的结果") : t("尚未发现 {{0}}", kind === 'mcp' ? 'MCP' : 'Skill')}</div>}
    </div>
    {listing ? <div className="resource-pagination"><span>{t('共 {{0}} 项 · 第 {{1}} / {{2}} 页', listing.total, listing.page, listing.pages)}</span><span className="grow" />
      <button className="btn sm" disabled={listing.page <= 1} onClick={() => setPage(listing.page - 1)}>{t("上一页")}</button>
      <button className="btn sm" disabled={listing.page >= listing.pages} onClick={() => setPage(listing.page + 1)}>{t("下一页")}</button>
    </div> : null}
  </div>
}
