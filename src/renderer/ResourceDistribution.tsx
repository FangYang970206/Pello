import { useEffect, useRef, useState } from 'react'
import { executorTemplate } from '../shared/executor'
import { t } from '../shared/i18n'
import { PRESETS, hostDisplayName, type Database, type ResourceResult, type ResourceScope, type ResourceSourceItem } from '../shared/types'
import { DirectoryBrowser } from './DirectoryBrowser'
import { Icon } from './icons'
import { ResourceDialog } from './ResourceDialog'
import { ResourceImportPreview } from './ResourceImportPreview'
import { ResourceMachineSelect } from './ResourceMachineSelect'

export type ResourceSettingsState = Pick<Database, 'hosts' | 'custom' | 'templates' | 'templateBindings'>
export type ResourceKind = 'skills' | 'mcp'
const same = (a: ResourceScope, b: ResourceScope) => a.hostId === b.hostId && a.executorId === b.executorId
type SourceMode = 'manual' | 'local' | 'remote'

export function ResourceDistribution({ kind, state, current, currentValid, onRefresh, onClose }: {
  kind: ResourceKind; state: ResourceSettingsState; current: ResourceScope; currentValid: boolean
  onRefresh: () => void; onClose: () => void
}) {
  const [step, setStep] = useState(1)
  const [busy, setBusy] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<ResourceScope[]>(currentValid ? [current] : [])
  const [expanded, setExpanded] = useState([current.hostId])
  const [name, setName] = useState('')
  const [config, setConfig] = useState('')
  const [sourceMode, setSourceMode] = useState<SourceMode>(kind === 'skills' ? 'local' : 'manual')
  const remoteHosts = state.hosts.filter((host) => host.id !== 'local')
  const [remoteHost, setRemoteHost] = useState(() => remoteHosts.find((host) => host.id === current.hostId)?.id || remoteHosts[0]?.id || '')
  const importMode = sourceMode !== 'manual'
  const sourceHost = sourceMode === 'remote' ? remoteHost : 'local'
  const [source, setSource] = useState('')
  const [browser, setBrowser] = useState(false)
  const [sourceItems, setSourceItems] = useState<ResourceSourceItem[]>([])
  const [selectedItems, setSelectedItems] = useState<string[]>([])
  const [results, setResults] = useState<ResourceResult[]>([])
  const form = useRef<HTMLFormElement>(null)
  const agents = [...PRESETS, ...state.custom]
  const format = kind === 'skills' ? 'Skill' : 'MCP'
  const ready = importMode ? !!source && !!selectedItems.length : !!name.trim() && !!config.trim()
  const clearSource = () => { setSource(''); setSourceItems([]); setSelectedItems([]); setError('') }
  useEffect(() => {
    if (step === 1) return
    const first = form.current?.querySelector<HTMLElement>('input:checked, input:not(:disabled), button:not(:disabled)')
    if (first) first.focus()
    else form.current?.focus()
  }, [step])

  async function scan(file: string, hostId = sourceHost) {
    clearSource(); setSource(file); setBusy(true); setScanning(true)
    try {
      const items = await window.awb.scanResources(kind, file, kind === 'skills' ? 'local' : hostId)
      setSourceItems(items); setSelectedItems(items.filter((item) => !item.error).map((item) => item.id))
    } catch (reason) { setError(String(reason)) }
    finally { setBusy(false); setScanning(false) }
  }
  async function choose(type: 'folder' | 'zip' | 'config') {
    if (type === 'config' && sourceHost !== 'local') { setBrowser(true); return }
    setBusy(true); setError('')
    try {
      const file = await window.awb.pickResource(type)
      if (file) await scan(file)
    } catch (reason) { setError(String(reason)) }
    finally { setBusy(false) }
  }
  function advance() {
    try {
      if (!importMode) {
        const value = JSON.parse(config)
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(t("配置必须是对象"))
      }
      setError(''); setStep(2)
    } catch (reason) { setError(String(reason)) }
  }
  async function distribute(retry?: ResourceResult) {
    if (busy) return
    const targets = retry ? [{ hostId: retry.hostId || 'local', executorId: retry.agent }] : selected
    const items = retry ? [retry.id || retry.name || ''] : selectedItems
    setBusy(true); setError('')
    try {
      const next = kind === 'skills' ? await window.awb.importSkills(source, targets, items) :
        importMode ? await window.awb.importMcpConfig(source, targets, items, sourceHost) :
        await window.awb.addMcp(name.trim(), JSON.parse(config), targets)
      setResults((previous) => retry ? previous.map((row) => row === retry ? next[0] || row : row) : next)
      setStep(3); onRefresh()
    } catch (reason) { setError(String(reason)) }
    finally { setBusy(false) }
  }
  const sourceModes: [SourceMode, string][] = [['manual', t("手动填写")], ['local', t("本机导入")]]
  if (remoteHosts.length) sourceModes.push(['remote', t("SSH 机器导入")])
  return <ResourceDialog className="settings-dialog settings-dialog-wide" title={kind === 'skills' ? t("添加 Skill") : t("添加 MCP")} onClose={onClose} busy={busy} footer={<>
    {step === 2 ? <>
      <span className="resource-distribution-summary">{t("已选 {{0}} 台机器 · {{1}} 个执行器", new Set(selected.map((scope) => scope.hostId)).size, selected.length)}</span>
      <button type="button" className="btn ghost" disabled={busy} onClick={() => { setStep(1); setError('') }}>{t("上一步")}</button>
    </> : null}
    {step === 1 ? <button className="btn ghost" onClick={onClose} disabled={busy}>{t("取消")}</button> : null}
    {step === 1 ? <button className="btn pri" form="resource-add" type="submit" disabled={busy || !ready}>{scanning ? t("正在扫描…") : t("下一步")}</button> :
      step === 2 ? <button className="btn pri" form="resource-add" type="submit" aria-label={t("添加到所选 Agent")} disabled={busy || !selected.length}>{busy ? t("正在添加…") : t("添加")}</button> :
        <button className="btn pri" disabled={busy} onClick={onClose}>{t("完成")}</button>}
  </>}>
    <ol className="resource-steps">
      {[t("添加方式"), t("分发目标"), t("添加结果")].map((label, index) => <li key={label} aria-current={step === index + 1 ? 'step' : undefined}>
        {index ? <Icon name="chev" className="s" /> : null}{label}</li>)}
    </ol>
    <form id="resource-add" ref={form} tabIndex={-1} onSubmit={(event) => { event.preventDefault(); if (step === 1 && ready) advance(); else if (step === 2 && selected.length) void distribute() }}>
      {step === 1 ? <fieldset className="host-fields resource-source" disabled={busy}>
        {kind === 'mcp' ? <div className="fld"><span>{t("添加方式")}</span><div className="resource-source-modes" role="group" aria-label={t("添加方式")}>
          {sourceModes.map(([mode, label]) => <button type="button" key={mode} className="btn" aria-pressed={sourceMode === mode}
            onClick={() => { if (mode !== sourceMode) { setSourceMode(mode); clearSource() } }}>{label}</button>)}
        </div></div> : null}
        {!importMode ? <>
          <label className="fld"><span>{t("MCP 名称")}</span><input className="tx" autoFocus required placeholder={t("例如 github-search")} value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label className="fld"><span>{t("服务器配置 JSON")}</span><textarea className="tx resource-json" required value={config} spellCheck={false} onChange={(event) => setConfig(event.target.value)} placeholder={t("{\"command\":\"可执行命令\",\"args\":[],\"env\":{}}\n或 {\"url\":\"https://服务器/mcp\",\"headers\":{}}")} /></label>
        </> : <>
          {kind === 'skills' ? <div className="resource-actions"><button type="button" className="btn" onClick={() => void choose('folder')}>{t("选择文件夹")}</button>
            <button type="button" className="btn" onClick={() => void choose('zip')}>{t("选择 ZIP 压缩包")}</button></div> :
            <>
              {sourceMode === 'remote' ? <ResourceMachineSelect hosts={remoteHosts} value={remoteHost} label={t("来源机器")} onChange={(id) => { setRemoteHost(id); clearSource() }} /> : null}
              <div className="template-path-field">
                <label className="fld"><span>{t("来源路径")}</span><input className="tx mono" readOnly value={source} placeholder={sourceMode === 'remote' ? t("选择远程配置文件") : t("选择本机配置文件")} /></label>
                <button type="button" className="btn" onClick={() => void choose('config')}><Icon name="folder-open" />{t("浏览")}</button>
              </div>
              <p className="resource-help">{t("请选择 JSON、JSONC、TOML 或 YAML 格式的 MCP 配置文件。")}</p>
            </>}
          {kind === 'skills' ? <>
            <p className={`resource-help${source ? ' mono' : ''}`}>{source || t("请选择文件夹或 ZIP，将递归扫描所有 SKILL.md 所在目录。")}</p>
            <p className="resource-help">{t("保留 scripts、references 等附属文件。同名 Skill 不覆盖。导入上限为 32 MB、10000 个文件。")}</p>
          </> : null}
          {sourceItems.length ? <ResourceImportPreview key={source} items={sourceItems} selected={selectedItems} onChange={setSelectedItems} disabled={busy} /> : null}
        </>}
      </fieldset> : null}
      {step === 2 ? <div className="resource-destinations">
        <p className="resource-help">{t("可同时选择多台机器，并分别勾选每台机器的执行器。")}</p>
        {state.hosts.map((host) => {
          const choices = agents.map((agent) => {
            const scope = { hostId: host.id, executorId: agent.id }, template = executorTemplate(state, host.id, agent.id)
            const native = PRESETS.some((preset) => preset.id === agent.id)
            const available = template ? !!(kind === 'mcp' ? template.mcpPath : template.skillPath) : native
            return { scope, agent, template, native, available }
          })
          const available = choices.filter((choice) => choice.available).map((choice) => choice.scope)
          const amount = selected.filter((scope) => scope.hostId === host.id).length
          const open = expanded.includes(host.id), all = amount > 0 && amount === available.length
          return <section className="resource-machine-targets" key={host.id}>
            <div className="resource-machine-heading">
              <button type="button" className="btn ghost" aria-expanded={open} onClick={() => setExpanded(open ? expanded.filter((id) => id !== host.id) : [...expanded, host.id])}>
                <Icon name="chev" className={open ? 's chev open' : 's chev'} /><Icon name={host.id === 'local' ? 'laptop' : 'server'} />{hostDisplayName(host)}
              </button>
              {!host.on ? <span className="resource-help">{t("未连接")}</span> : null}
              <small>{amount ? t("已选 {{0}} 个执行器", amount) : ''}</small>
              <button type="button" className="btn ghost settings-link" disabled={busy || !available.length} onClick={() => {
                setSelected((old) => [...old.filter((scope) => scope.hostId !== host.id), ...(all ? [] : available)])
                if (!open) setExpanded([...expanded, host.id])
              }}>{all ? t("取消全选") : t("全选")}</button>
            </div>
            {open ? <fieldset className="resource-target-grid host-fields" disabled={busy} aria-label={hostDisplayName(host)}>
              {choices.map(({ scope, agent, template, native, available }) => <label key={agent.id} className="resource-choice resource-destination">
                <input type="checkbox" checked={selected.some((item) => same(item, scope))} disabled={!available} aria-label={agent.name}
                  onChange={(event) => setSelected((old) => event.target.checked ? [...old, scope] : old.filter((it) => !same(it, scope)))} />
                <span>{agent.name}<small>{template?.name || (native ? t("原生默认") : t("未选择模板"))}</small></span>
              </label>)}
            </fieldset> : null}
          </section>
        })}
      </div> : null}
      {step === 3 ? <div className="resource-results" aria-live="polite">
        {results.map((row) => {
          const host = state.hosts.find((entry) => entry.id === row.hostId)
          return <div className="resource-result-row" key={JSON.stringify([row.hostId, row.agent, row.id || row.name])}>
          <Icon name={row.ok || row.skipped ? 'check' : 'info'} />
          <div><b>{host ? hostDisplayName(host) : row.hostId} · {agents.find((agent) => agent.id === row.agent)?.name || row.agent}</b>
            <p className={row.ok || row.skipped ? 'resource-help' : 'file-error'}>{row.name || format} · {row.ok ? t("添加成功") : row.error}</p></div>
          {row.ok || row.skipped ? null : <button type="button" className="btn ghost settings-link" disabled={busy} onClick={() => void distribute(row)}>{t("重试")}</button>}
          </div>
        })}
      </div> : null}
      {error ? <p className="file-error" role="alert">{error}</p> : null}
    </form>
    {browser ? <DirectoryBrowser hostId={sourceHost} initialPath={source.replace(/([\\/])[^\\/]+$/, '$1')} resource mode="file"
      onClose={() => setBrowser(false)} onSelect={(file) => { setBrowser(false); void scan(file) }} /> : null}
  </ResourceDialog>
}
