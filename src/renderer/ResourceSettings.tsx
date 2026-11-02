import { useEffect, useState } from 'react'
import type { ResourcePage, ResourceResult, ResourceTarget } from '../shared/types'
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
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<ResourceResult[]>([])
  const [tick, setTick] = useState(0)
  const [mapping, setMapping] = useState<ResourceTarget | null>(null)
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
      const value = kind === 'mcp' ? await window.awb.addMcp(name.trim(), JSON.parse(config), selected) : await window.awb.importSkills(source, selected)
      setResults(value); setTick((value) => value + 1)
      if (value.every((item) => item.ok)) { setAdding(false); setConfig(''); setName(''); setSource('') }
      else setSelected(value.filter((item) => !item.ok).map((item) => item.agent))
    } catch (reason) { setError(String(reason)) }
    finally { setBusy(false) }
  }
  async function choose(type: 'folder' | 'zip') {
    try { const value = await window.awb.pickResource(type); if (value) setSource(value) }
    catch (reason) { setError(String(reason)) }
  }
  return <div className="group resources">
    <div className="resource-agents" role="tablist" aria-label="Code Agent">
      {targets.map((item) => <button key={item.id} className={`btn sm ${agent === item.id ? 'on' : ''}`} role="tab" aria-selected={agent === item.id}
        onClick={() => { setAgent(item.id); setQuery(''); setResults([]) }}>{item.name}</button>)}
    </div>
    <p className="resource-help">本机用户配置。添加后在对应 Agent 中重新加载或启动新会话。{kind === 'skills' ? '列表包含兼容目录；共享目录中的 Skill 也可能被其他 Agent 自动发现。' : ''}</p>
    <h2><span className="grow">{target?.name} · {kind === 'mcp' ? 'MCP' : 'Skill'}</span>
      <button className="btn sm" disabled={busy} onClick={() => { setAdding(!adding); setSelected([agent]); setError(''); setResults([]) }}><Icon name="plus" className="s" />{kind === 'mcp' ? '添加 MCP' : '添加 Skill'}</button>
    </h2>
    {target ? <p className="resource-path">{kind === 'mcp' ? target.mcpPath || '尚未设置 MCP 配置路径' : target.skillPath || '尚未设置 Skill 目录'}</p> : null}
    {target && !['claude', 'codex', 'opencode', 'pi'].includes(target.id) ? <button className="btn sm" onClick={() => setMapping({ ...target })}>设置资源路径</button> : null}
    {mapping ? <form className="resource-form" onSubmit={async (event) => {
      event.preventDefault(); setBusy(true)
      try { await window.awb.saveResourceTarget(mapping); setMapping(null); setTick((v) => v + 1) }
      catch (reason) { setError(String(reason)) } finally { setBusy(false) }
    }}>
      <label className="fld"><span>MCP 配置文件绝对路径</span><input className="tx" value={mapping.mcpPath} onChange={(e) => setMapping({ ...mapping, mcpPath: e.target.value })} /></label>
      <label className="fld"><span>配置格式</span><select className="sel" value={mapping.format} onChange={(e) => setMapping({ ...mapping, format: e.target.value as ResourceTarget['format'] })}>
        <option value="standard">JSON · mcpServers（Claude / Pi 兼容）</option><option value="codex">TOML · mcp_servers</option><option value="opencode">JSON / JSONC · mcp（OpenCode 兼容）</option>
      </select></label>
      <label className="fld"><span>Skill 目录绝对路径</span><input className="tx" value={mapping.skillPath} onChange={(e) => setMapping({ ...mapping, skillPath: e.target.value })} /></label>
      <div className="resource-actions"><button type="button" className="btn" onClick={() => setMapping(null)}>取消</button><button className="btn pri" disabled={busy}>保存路径</button></div>
    </form> : null}
    {adding ? <form className="resource-form" onSubmit={(event) => { event.preventDefault(); void submit() }}>
      {kind === 'mcp' ? <>
        <label className="fld"><span>MCP 名称</span><input className="tx" required value={name} onChange={(e) => setName(e.target.value)} placeholder="例如 project-tools" /></label>
        <label className="fld"><span>服务器配置 JSON</span><textarea className="tx resource-json" required value={config} spellCheck={false} onChange={(e) => setConfig(e.target.value)} placeholder={'{"command":"可执行命令","args":[],"env":{}}\n或 {"url":"https://服务器/mcp","headers":{}}'} /></label>
        <p className="resource-help">支持 stdio 和 HTTP。使用单个服务器对象，args 为数组；环境变量放在 env，请求头放在 headers。同名配置会保留，原文件写入前自动备份。认证和 OAuth 由对应 Agent 完成。</p>
      </> : <>
        <div className="resource-actions"><button type="button" className="btn" onClick={() => void choose('folder')}>选择文件夹</button><button type="button" className="btn" onClick={() => void choose('zip')}>选择 ZIP 压缩包</button></div>
        <p className="resource-path">{source || '请选择包含 SKILL.md 的文件夹或 ZIP，可一次导入多个 Skill。'}</p>
        <p className="resource-help">保留 scripts、references 等附属文件；同名 Skill 不覆盖。导入上限为 32 MB、10000 个文件。</p>
      </>}
      <fieldset disabled={busy}><legend>分发到 Code Agent</legend><div className="resource-agents">
        {targets.map((item) => <label key={item.id} className="resource-choice"><input type="checkbox" checked={selected.includes(item.id)}
          onChange={(e) => setSelected(e.target.checked ? [...selected, item.id] : selected.filter((id) => id !== item.id))} />{item.name}</label>)}
      </div></fieldset>
      <div className="resource-actions"><button type="button" className="btn" disabled={busy} onClick={() => setAdding(false)}>取消</button><button className="btn pri" disabled={busy || !selected.length || (kind === 'skills' && !source)}>{busy ? '正在添加…' : '添加到所选 Agent'}</button></div>
    </form> : null}
    {error ? <p role="alert" className="file-error">{error}</p> : null}
    {results.length ? <div role="status" className="resource-results">{results.map((item) => <p key={item.agent} className={item.ok ? '' : 'file-error'}>{targets.find((t) => t.id === item.agent)?.name || item.agent} · {item.ok ? '添加成功' : item.error}</p>)}</div> : null}
    <label className="fld"><span>搜索{kind === 'mcp' ? ' MCP' : ' Skill'}</span><input className="tx" type="search" value={query} onChange={(event) => { setQuery(event.target.value); setPages((v) => ({ ...v, [agent]: 1 })) }} /></label>
    {listing?.errors.map((value) => <p key={value} className="file-error" role="alert">{value}</p>)}
    <div className="card" role="tabpanel" aria-label={`${target?.name || agent} ${kind}`}>
      {!listing ? <div className="srow">正在读取…</div> : listing.items.length ? listing.items.map((item) => <div className="srow resource-item" key={item.path + item.name}>
        <div className="lt"><b>{item.name}</b><small>{item.description}</small><small className="resource-path">{item.path}</small></div>
        {item.transport ? <span className="tag">{item.transport} · {item.enabled ? '启用' : '停用'}</span> : null}
      </div>) : <div className="srow">{query ? '没有匹配的结果' : `尚未发现 ${kind === 'mcp' ? 'MCP' : 'Skill'}`}</div>}
    </div>
    {listing ? <div className="resource-pagination"><span>共 {listing.total} 项 · 第 {listing.page} / {listing.pages} 页</span><span className="grow" />
      <button className="btn sm" disabled={listing.page <= 1} onClick={() => setPages((v) => ({ ...v, [agent]: listing.page - 1 }))}>上一页</button>
      <button className="btn sm" disabled={listing.page >= listing.pages} onClick={() => setPages((v) => ({ ...v, [agent]: listing.page + 1 }))}>下一页</button>
    </div> : null}
  </div>
}
