import { useEffect, useRef, useState } from 'react'
import { executorForHost, executorTemplate, templateCompatible } from '../shared/executor'
import { t } from '../shared/i18n'
import { PRESETS, cmdline, type Database, type EnvVar, type ExecutorTemplate } from '../shared/types'
import { DirectoryBrowser } from './DirectoryBrowser'
import { Icon, Mark } from './icons'
import { ResourceDialog } from './ResourceDialog'
import { ResourceMachineSelect } from './ResourceMachineSelect'

type TemplateState = Pick<Database, 'hosts' | 'custom' | 'templates' | 'templateBindings'>
type PathField = 'skillPath' | 'mcpPath' | 'skillConfigPath'
const formats = { standard: 'JSON · mcpServers', codex: 'TOML · mcp_servers', opencode: 'JSONC · mcp' }

function TemplateEditor({ state, initial, onClose, onSave }: {
  state: TemplateState; initial: ExecutorTemplate; onClose: () => void; onSave: (draft: ExecutorTemplate) => Promise<void>
}) {
  const [draft, setDraft] = useState(initial)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [browser, setBrowser] = useState<PathField | null>(null)
  const patch = (change: Partial<ExecutorTemplate>) => setDraft((old) => ({ ...old, ...change }))
  const env = (index: number, change: Partial<EnvVar>) => patch({ env: draft.env.map((entry, i) => i === index ? { ...entry, ...change } : entry) })
  const fileMode = browser && browser !== 'skillPath'
  const browserPath = browser ? draft[browser] || '' : ''
  const parent = (value: string) => value.replace(/([\\/])[^\\/]+$/, '$1')
  async function pick(field: PathField) {
    if (draft.hostId !== 'local') { setBrowser(field); return }
    try {
      const value = await window.awb.pickResource(field === 'skillPath' ? 'folder' : 'file')
      if (value) patch({ [field]: value })
    } catch (reason) { setError(String(reason)) }
  }
  const pathField = (field: PathField, label: string, placeholder: string) => <div className="template-path-field">
    <label className="fld"><span>{label}</span><input className="tx mono" placeholder={placeholder} value={draft[field] || ''} onChange={(event) => patch({ [field]: event.target.value })} /></label>
    <button className="btn" type="button" onClick={() => void pick(field)} aria-label={t("浏览 {{0}}", label)}><Icon name="folder" className="s" />{t("浏览")}</button>
  </div>
  async function submit() {
    if (busy) return
    setError(''); setBusy(true)
    try { await onSave({ ...draft, skillPath: draft.skillPath.trim(), mcpPath: draft.mcpPath.trim(), skillConfigPath: draft.skillConfigPath?.trim() }) }
    catch (reason) { setError(String(reason)) }
    finally { setBusy(false) }
  }
  const host = state.hosts.find((item) => item.id === draft.hostId)
  const exampleHome = host?.platform === 'windows' ? 'C:/Users/demo' : '/home/demo'
  return <ResourceDialog className="settings-dialog settings-dialog-wide" title={draft.id ? t("编辑模板") : t("新建模板")} onClose={onClose} busy={busy} footer={<>
    <button className="btn ghost" onClick={onClose} disabled={busy}>{t("取消")}</button>
    <button className="btn pri" type="submit" form="executor-template" disabled={busy}>{t("保存")}</button>
  </>}>
    <form id="executor-template" onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <fieldset className="host-fields template-form" disabled={busy}>
        <div className="two">
          <label className="fld"><span>{t("模板名称")}</span><input autoFocus required maxLength={80} className="tx" placeholder={t("例如 团队 Codex 配置")} value={draft.name} onChange={(event) => patch({ name: event.target.value })} /></label>
          <ResourceMachineSelect hosts={state.hosts} value={draft.hostId} disabled={!!draft.id} onChange={(hostId) => patch({ hostId })} />
        </div>
        <section><h3>Skill</h3>{pathField('skillPath', t("Skill 目录"), `${exampleHome}/.agents/skills`)}
          <label className="fld template-skill-adapter"><span>{t("Skill 管理方式")}</span><select className="sel" value={draft.skillAdapter || 'portable'} onChange={(event) => patch({ skillAdapter: event.target.value as ExecutorTemplate['skillAdapter'] })}>
            <option value="portable">{t("通用 · 文件开关")}</option>
            {PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
          </select></label>
          {pathField('skillConfigPath', t("Skill 配置文件（可选）"), t("绝对路径"))}
        </section>
        <section><h3>MCP</h3>{pathField('mcpPath', t("MCP 配置文件"), `${exampleHome}/.codex/config.toml`)}
          <label className="fld"><span>{t("MCP 格式")}</span><select className="sel" value={draft.format} onChange={(event) => patch({ format: event.target.value as ExecutorTemplate['format'] })}>
            {Object.entries(formats).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select></label>
        </section>
        <section>
          <h3>{t("环境变量")}<button className="btn sm" type="button" onClick={() => patch({ env: [...draft.env, { k: '', v: '', secret: false }] })}><Icon name="plus" />{t("添加变量")}</button></h3>
          {draft.env.map((entry, index) => <div className="template-env" key={index}>
            <input className="tx mono" aria-label={t("变量名")} placeholder={t("变量名")} value={entry.k} onChange={(event) => env(index, { k: event.target.value })} />
            <input className="tx mono" aria-label={t("变量值")} placeholder={t("变量值")} type={entry.secret ? 'password' : 'text'} value={entry.v} onChange={(event) => env(index, { v: event.target.value })} />
            <label className="resource-choice"><input type="checkbox" checked={entry.secret} onChange={(event) => env(index, { secret: event.target.checked })} />{t("保密")}</label>
            <button type="button" className="ib" aria-label={t("删除变量")} onClick={() => patch({ env: draft.env.filter((_, i) => i !== index) })}><Icon name="x" /></button>
          </div>)}
        </section>
        <section><h3>{t("原生会话恢复")}</h3>
          <label className="resource-choice"><input type="checkbox" checked={!!draft.session} onChange={(event) => patch({ session: event.target.checked ? { startArgs: '', resumeArgs: '' } : undefined })} />{t("为自定义执行器配置恢复参数")}</label>
          {draft.session ? <div className="two">
            <label className="fld"><span>{t("新建会话参数")}</span><input required className="tx mono" placeholder="--session-id {sessionId}" value={draft.session.startArgs} onChange={(event) => patch({ session: { ...draft.session!, startArgs: event.target.value } })} /></label>
            <label className="fld"><span>{t("恢复会话参数")}</span><input required className="tx mono" placeholder="--resume {sessionId}" value={draft.session.resumeArgs} onChange={(event) => patch({ session: { ...draft.session!, resumeArgs: event.target.value } })} /></label>
          </div> : null}
        </section>
      </fieldset>
      {error ? <p className="file-error" role="alert">{error}</p> : null}
    </form>
    {browser ? <DirectoryBrowser hostId={draft.hostId} initialPath={fileMode ? parent(browserPath) : browserPath} resource mode={fileMode ? 'file' : 'directory'}
      onClose={() => setBrowser(null)} onSelect={(value) => { patch({ [browser]: value }); setBrowser(null) }} /> : null}
  </ResourceDialog>
}

export function ExecutorSettings({ state, hostId, onHost, onDatabase, installed, onInstall, onEditExec, onNewExec, templateId, bindingFocus }: {
  state: TemplateState; hostId: string; onHost: (id: string) => void; onDatabase: (next: Database) => void
  installed: Record<string, boolean>; onInstall: (name: string, cmd: string) => void
  onEditExec: (id: string, hostId: string) => void; onNewExec: (hostId: string) => void; templateId?: string; bindingFocus?: string
}) {
  const [manage, setManage] = useState(!!templateId)
  const [editing, setEditing] = useState(() => state.templates.find((item) => item.id === templateId))
  const [deleting, setDeleting] = useState<ExecutorTemplate>()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const focusedBinding = useRef<HTMLSelectElement>(null)
  useEffect(() => { focusedBinding.current?.focus() }, [bindingFocus])
  const templates = state.templates.filter((item) => item.hostId === hostId)
  const executors = [...PRESETS, ...state.custom]
  const usedBy = (id: string) => executors.filter((agent) => state.templateBindings.some((item) => item.templateId === id && item.executorId === agent.id))
  async function save(operation: () => Promise<Database>, after?: () => void) {
    setPending(true); setError('')
    try { onDatabase(await operation()); after?.() }
    catch (reason) { setError(String(reason)) }
    finally { setPending(false) }
  }
  const binding = (id: string, name: string, builtin: boolean) => <select className="sel executor-binding" aria-label={t("{{0}} 的高级属性模板", name)}
    ref={bindingFocus === id ? focusedBinding : undefined}
    value={executorTemplate(state, hostId, id)?.id || ''} disabled={pending}
    onChange={(event) => { const next = event.target.value; void save(() => window.awb.bindTemplate({ hostId, executorId: id }, next)) }}>
    <option value="">{builtin ? t("原生默认") : t("未选择模板")}</option>
    {templates.filter((item) => templateCompatible(item, id)).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
  </select>
  return <>
    <div className="executor-tabs" role="group" aria-label={t("执行器设置")}>
      <button aria-pressed={!manage} onClick={() => setManage(false)}>{t("执行器列表")}</button>
      <button aria-pressed={manage} onClick={() => setManage(true)}>{t("模板管理")}</button>
    </div>
    <div className="settings-toolbar">
      <ResourceMachineSelect showIcon hosts={state.hosts} value={hostId} onChange={(id) => { onHost(id); setError('') }} disabled={pending} />
      {manage ? <button className="btn pri" onClick={() => setEditing({ id: '', hostId, name: '', skillPath: '', mcpPath: '', format: 'standard', skillAdapter: 'portable', env: [] })}><Icon name="plus" />{t("新建模板")}</button> : null}
    </div>
    {error && !deleting ? <p className="file-error" role="alert">{error}</p> : null}
    {manage ? <section className="group"><div className="card">
      {templates.length ? <>
        <div className="executor-template-heading"><span>{t("模板")}</span><span>{t("使用此模板的执行器")}</span></div>
        {templates.map((item) => <div className="srow executor-template-row" key={item.id}>
          <div className="executor-template-name"><span className="settings-item-icon"><Icon name="file" /></span><div className="lt"><b>{item.name}</b><small>{formats[item.format]}</small></div></div>
          <small className="template-usage">{usedBy(item.id).map((executor) => executor.name).join(t("、")) || t("未使用")}</small>
          <div className="settings-actions">
            <button className="ib" aria-label={t("编辑模板 {{0}}", item.name)} onClick={() => setEditing(item)}><Icon name="sliders" /></button>
            <button className="ib danger-text" aria-label={t("删除模板 {{0}}", item.name)} onClick={() => { setError(''); setDeleting(item) }}><Icon name="trash" /></button>
          </div>
        </div>)}
      </> : <div className="settings-empty"><strong>{t("这台机器还没有模板")}</strong>{t("新建模板后，可在执行器列表中选用。")}</div>}
    </div></section> : <>
      <section className="group"><div className="settings-section-heading"><h2>{t("内置预设")}</h2><small>{t("高级属性模板")}</small></div><div className="card">
        {PRESETS.map((preset) => <div className="srow executor-binding-row" key={preset.id}>
          <Mark letter={preset.id === 'omp' ? 'Ω' : preset.letter} color={preset.id === 'omp' ? '#edbd96' : preset.color} size="md" /><div className="lt"><b>{preset.name}</b><small className="mono">{preset.cmd}</small></div>
          {hostId === 'local' && installed[preset.cmd] === false ? <button className="btn ghost" data-a="install" onClick={() => onInstall(preset.name, preset.cmd)}>{t("安装说明")}</button> : null}
          {binding(preset.id, preset.name, true)}
        </div>)}
      </div></section>
      <section className="group"><div className="settings-section-heading"><h2>{t("自定义")}</h2>
        <button className="btn" data-a="custom" onClick={() => onNewExec(hostId)}><Icon name="plus" />{t("添加")}</button>
      </div><div className="card">
        {state.custom.length ? state.custom.map((item) => {
          const launch = executorForHost(item, hostId)
          return <div className="srow executor-binding-row" key={item.id}>
            <Mark letter={item.letter} color={item.color} size="md" />
            <div className="lt"><b>{item.name}</b><small className="mono">{cmdline(launch)}</small></div>
            <button className="btn ghost" data-a="custom" data-id={item.id} onClick={() => onEditExec(item.id, hostId)}>{t("编辑")}</button>
            {binding(item.id, item.name, false)}
          </div>
        }) : <div className="settings-empty">{t("还没有自定义执行器")}</div>}
      </div></section>
    </>}
    {editing ? <TemplateEditor state={state} initial={editing} onClose={() => setEditing(undefined)} onSave={async (draft) => {
      onDatabase(await window.awb.saveTemplate(draft)); onHost(draft.hostId); setEditing(undefined)
    }} /> : null}
    {deleting ? <ResourceDialog className="settings-dialog settings-dialog-narrow" title={t("删除模板？")} busy={pending} onClose={() => { setDeleting(undefined); setError('') }} footer={<>
      <button className="btn ghost" disabled={pending} onClick={() => { setDeleting(undefined); setError('') }}>{t("取消")}</button>
      <button className="btn dangerf" disabled={pending} onClick={() => void save(() => window.awb.deleteTemplate(deleting.id), () => setDeleting(undefined))}>{t("删除并解绑")}</button>
    </>}>
      <p>{t("确定删除「{{0}}」？", deleting.name)}</p>
      {usedBy(deleting.id).length ? <div className="settings-warning"><strong>{t("以下执行器会解除绑定")}</strong><ul>{usedBy(deleting.id).map((item) => <li key={item.id}>{item.name} · {PRESETS.some((preset) => preset.id === item.id) ? t("使用原生默认位置") : t("需要重新选择模板")}</li>)}</ul></div> : null}
      <p className="resource-help">{t("机器上的 Skill 和 MCP 文件会保留。")}</p>
      {error ? <p className="file-error" role="alert">{error}</p> : null}
    </ResourceDialog> : null}
  </>
}
