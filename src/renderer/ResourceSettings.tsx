import { useEffect, useRef, useState } from 'react'
import type { ResourcePage, ResourceResult, ResourceTarget, ResourceItem, ResourceDetail, ResourceSourceItem } from '../shared/types'
import { ResourceDialog } from './ResourceDialog'
import { ResourceImportPreview } from './ResourceImportPreview'
import { ResourceItemMenu } from './ResourceItemMenu'
import { Icon } from './icons'

export function ResourceSettings({ kind }: { kind: 'mcp' | 'skills' }) {
  const [targets, setTargets] = useState<ResourceTarget[]>([])
  const [agent, setAgent] = useState('claude')
  const [pages, setPages] = useState<Record<string, number>>({})
  const [query, setQuery] = useState('')
  const [listing, setListing] = useState<ResourcePage | null>(null)
  const [error, setError] = useState('')
  const [adding, setAdding] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [name, setName] = useState('')
  const [config, setConfig] = useState('')
  const [source, setSource] = useState('')
  const [importMode, setImportMode] = useState(false)
  const [sourceItems, setSourceItems] = useState<ResourceSourceItem[]>([])
  const [selectedItems, setSelectedItems] = useState<string[]>([])
  const [scanning, setScanning] = useState(false)
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<ResourceResult[]>([])
  const [tick, setTick] = useState(0)
  const [details, setDetails] = useState<ResourceDetail | null>(null)
  const detailOpener = useRef<HTMLButtonElement | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<ResourceItem | null>(null)
  const [deleteError, setDeleteError] = useState('')
  const target = targets.find((item) => item.id === agent)
  const page = pages[agent] || 1
  useEffect(() => {
    let stopped = false
    void window.awb.resourceTargets().then((value) => { if (!stopped) setTargets(value) }).catch((reason) => { if (!stopped) setError(String(reason)) })
    return () => { stopped = true }
  }, [tick])
  useEffect(() => {
    let stopped = false
    setListing(null); setError('')
    void window.awb.resourceList(kind, agent, page, query).then((value) => { if (!stopped) setListing(value) }).catch((reason) => { if (!stopped) setError(String(reason)) })
    return () => { stopped = true }
  }, [kind, agent, page, query, tick])
  async function submit() {
    setBusy(true); setError(''); setResults([])
    try {
      const value = kind === 'mcp' ? importMode ? await window.awb.importMcpConfig(source, selected, selectedItems) : await window.awb.addMcp(name.trim(), JSON.parse(config), selected) : await window.awb.importSkills(source, selected, selectedItems)
      setResults(value); setTick((value) => value + 1)
      if (value.every((item) => item.ok)) { setAdding(false); setConfig(''); setName(''); setSource(''); setSourceItems([]); setSelectedItems([]) }
      else setSelected([...new Set(value.filter((item) => !item.ok).map((item) => item.agent))])
    } catch (reason) { setError(String(reason)) }
    finally { setBusy(false) }
  }
  async function choose(type: 'folder' | 'zip' | 'config') {
    setBusy(true); setError('')
    try {
      const value = await window.awb.pickResource(type)
      if (value) {
        setSource(value); setSourceItems([]); setSelectedItems([]); setScanning(true)
        const items = await window.awb.scanResources(kind, value)
        setSourceItems(items); setSelectedItems(items.filter((item) => !item.error).map((item) => item.id))
      }
    }
    catch (reason) { setError(String(reason)) }
    finally { setBusy(false); setScanning(false) }
  }
  function closeAdd() { setAdding(false); setError(''); setResults([]) }
  async function inspect(item: ResourceItem, opener: HTMLButtonElement) {
    detailOpener.current = opener
    setPending(item.path + item.name); setError('')
    try { setDetails(await window.awb.resourceDetail(kind, agent, item)) }
    catch (reason) { setError(String(reason)) } finally { setPending(null) }
  }
  async function toggle(item: ResourceItem) {
    setPending(item.path + item.name); setError('')
    try { await window.awb.resourceToggle(kind, agent, item, item.enabled === false); setTick((value) => value + 1) }
    catch (reason) { setError(String(reason)) } finally { setPending(null) }
  }
  async function openFolder(item: ResourceItem) {
    setPending(item.path + item.name); setError('')
    try { await window.awb.openSkillFolder(agent, item) }
    catch (reason) { setError(String(reason)) } finally { setPending(null) }
  }
  async function removeSkill() {
    if (!deleting || busy) return
    setBusy(true); setDeleteError('')
    try { await window.awb.deleteSkill(agent, deleting); setDeleting(null); setTick((value) => value + 1) }
    catch (reason) { setDeleteError(String(reason)) } finally { setBusy(false) }
  }
  return <div className="group resources">
    {details ? <ResourceDialog title={details.name} compact={kind === 'skills'} dismissOnBackdrop returnFocus={detailOpener.current} onClose={() => setDetails(null)} footer={<><span className="grow" /><button className="btn" onClick={() => setDetails(null)}>关闭</button></>}>
      <dl className="resource-details"><dt>Agent</dt><dd>{target?.name}</dd><dt>状态</dt><dd>{details.enabled === false ? '已停用' : '已启用'}</dd><dt>位置</dt><dd>{details.path}</dd>
      {details.description ? <><dt>说明</dt><dd>{details.description}</dd></> : null}</dl>
      {details.notice ? <p className="resource-help">{details.notice}</p> : null}<pre className="resource-content">{details.content}</pre>
    </ResourceDialog> : null}
    {deleting ? <ResourceDialog title="删除 Skill" onClose={() => setDeleting(null)} busy={busy} footer={<>
      <span className="grow" /><button className="btn" disabled={busy} onClick={() => setDeleting(null)}>取消</button><button className="btn dangerf" disabled={busy} onClick={() => void removeSkill()}>{busy ? '正在删除…' : '删除'}</button>
    </>}><p>将 <strong>{deleting.name}</strong> 的文件夹及附属文件移到系统回收站，可从回收站恢复。共享此目录的其他 Agent 也会受影响。</p>
      <p className="resource-path">{deleting.path}</p>{deleteError ? <p className="file-error" role="alert">{deleteError}</p> : null}
    </ResourceDialog> : null}
    <div className="resource-agents" role="tablist" aria-label="Code Agent">
      {targets.map((item) => <button key={item.id} className={`btn sm ${agent === item.id ? 'on' : ''}`} role="tab" aria-selected={agent === item.id}
        onClick={() => { setAgent(item.id); setQuery(''); setResults([]) }}>{item.name}</button>)}
    </div>
    <h2><span className="grow">{target?.name} · {kind === 'mcp' ? 'MCP' : 'Skill'}</span>
      <button className="btn sm" disabled={busy} onClick={() => { setAdding(!adding); setSelected([agent]); setError(''); setResults([]) }}><Icon name="plus" className="s" />{kind === 'mcp' ? '添加 MCP' : '添加 Skill'}</button>
    </h2>
    {adding ? <ResourceDialog title={kind === 'mcp' ? '添加 MCP' : '添加 Skill'} onClose={closeAdd} busy={busy} footer={<>
      <span className="grow" /><button className="btn" disabled={busy} onClick={closeAdd}>取消</button><button className="btn pri" form="resource-add" type="submit" disabled={busy || !selected.length || ((kind === 'skills' || importMode) && (!source || !selectedItems.length))}>{scanning ? '正在扫描…' : busy ? '正在添加…' : '添加到所选 Agent'}</button>
    </>}><form id="resource-add" onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <fieldset className="host-fields" disabled={busy}>{kind === 'mcp' ? <div className="resource-actions">
        <button type="button" className={`btn sm ${!importMode ? 'on' : ''}`} aria-pressed={!importMode} onClick={() => setImportMode(false)}>手动配置</button>
        <button type="button" className={`btn sm ${importMode ? 'on' : ''}`} aria-pressed={importMode} onClick={() => { setImportMode(true); void choose('config') }}>从配置文件导入</button>
      </div> : null}{kind === 'mcp' && !importMode ? <>
        <label className="fld"><span>MCP 名称</span><input className="tx" autoFocus required value={name} onChange={(e) => setName(e.target.value)} placeholder="例如 project-tools" /></label>
        <label className="fld"><span>服务器配置 JSON</span><textarea className="tx resource-json" required value={config} spellCheck={false} onChange={(e) => setConfig(e.target.value)} placeholder={'{"command":"可执行命令","args":[],"env":{}}\n或 {"url":"https://服务器/mcp","headers":{}}'} /></label>
        <p className="resource-help">支持 stdio 和 HTTP。使用单个服务器对象，args 为数组；环境变量放在 env，请求头放在 headers。同名配置会保留，原文件写入前自动备份。认证和 OAuth 由对应 Agent 完成。</p>
      </> : <>
        {kind === 'skills' ? <div className="resource-actions"><button type="button" className="btn" onClick={() => void choose('folder')}>选择文件夹</button><button type="button" className="btn" onClick={() => void choose('zip')}>选择 ZIP 压缩包</button></div> : null}
        <p className="resource-path">{source || (kind === 'skills' ? '请选择文件夹或 ZIP，将递归扫描所有 SKILL.md 所在目录。' : '请选择 JSON、JSONC、TOML 或 YAML 格式的 MCP 配置文件。')}</p>
        <p className="resource-help">{kind === 'skills' ? '保留 scripts、references 等附属文件；同名 Skill 不覆盖。导入上限为 32 MB、10000 个文件。' : '自动识别常见 Code Agent 配置。同名 MCP 不覆盖，源文件中的停用状态保留；认证值不显示在预览中。'}</p>
        {sourceItems.length ? <ResourceImportPreview key={source} items={sourceItems} selected={selectedItems} onChange={setSelectedItems} disabled={busy} /> : null}
      </>}
      <fieldset disabled={busy}><legend>分发到 Code Agent</legend><div className="resource-agents">
        {targets.map((item) => <label key={item.id} className="resource-choice"><input type="checkbox" checked={selected.includes(item.id)}
          onChange={(e) => setSelected(e.target.checked ? [...selected, item.id] : selected.filter((id) => id !== item.id))} />{item.name}</label>)}
      </div></fieldset>
      </fieldset>
      {error ? <p role="alert" className="file-error">{error}</p> : null}
      {results.filter((item) => !item.ok).map((item) => <p key={`${item.agent}:${item.id || item.name || ''}`} role="alert" className="file-error">{item.agent}{item.name ? ` · ${item.name}` : ''} · {item.error}</p>)}
    </form></ResourceDialog> : null}
    {error && !adding ? <p role="alert" className="file-error">{error}</p> : null}
    {results.length ? <div role="status" className="resource-results">{results.map((item) => <p key={`${item.agent}:${item.id || item.name || ''}`} className={item.ok ? '' : 'file-error'}>{targets.find((t) => t.id === item.agent)?.name || item.agent} · {item.ok ? '添加成功' : item.error}{item.name ? ` · ${item.name}` : ''}</p>)}</div> : null}
    <label className="fld"><span>搜索{kind === 'mcp' ? ' MCP' : ' Skill'}</span><input className="tx" type="search" value={query} onChange={(event) => { setQuery(event.target.value); setPages((v) => ({ ...v, [agent]: 1 })) }} /></label>
    {listing?.errors.map((value) => <p key={value} className="file-error" role="alert">{value}</p>)}
    <div className="card" role="tabpanel" aria-label={`${target?.name || agent} ${kind}`}>
      {!listing ? <div className="srow">正在读取…</div> : listing.items.length ? listing.items.map((item) => <div className="srow resource-item" key={item.path + item.name}>
        <b className="resource-name">{item.name}</b><span className="grow" />
        <button className="ib" aria-label={`查看 ${item.name} 详情`} disabled={!!pending} onClick={(event) => void inspect(item, event.currentTarget)}><Icon name="eye" /></button>
        <button className={`switch ${item.enabled !== false ? 'on' : ''}`} role="switch" aria-checked={item.enabled !== false} aria-label={`启用 ${item.name}`} disabled={!!pending}
          onClick={() => void toggle(item)} />
        {kind === 'skills' ? <ResourceItemMenu name={item.name} disabled={!!pending || busy} onOpen={() => void openFolder(item)} onDelete={() => { setDeleteError(''); setDeleting(item) }} /> : null}
      </div>) : <div className="srow">{query ? '没有匹配的结果' : `尚未发现 ${kind === 'mcp' ? 'MCP' : 'Skill'}`}</div>}
    </div>
    {listing ? <div className="resource-pagination"><span>共 {listing.total} 项 · 第 {listing.page} / {listing.pages} 页</span><span className="grow" />
      <button className="btn sm" disabled={listing.page <= 1} onClick={() => setPages((v) => ({ ...v, [agent]: listing.page - 1 }))}>上一页</button>
      <button className="btn sm" disabled={listing.page >= listing.pages} onClick={() => setPages((v) => ({ ...v, [agent]: listing.page + 1 }))}>下一页</button>
    </div> : null}
  </div>
}
