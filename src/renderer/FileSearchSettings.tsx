import { useEffect, useState } from 'react'
import type { Project } from '../shared/types'

export function FileSearchSettings({ projects }: { projects: Project[] }) {
  const [selected, setSelected] = useState(projects[0]?.id || '')
  const projectId = projects.some((project) => project.id === selected) ? selected : projects[0]?.id || ''
  const [rules, setRules] = useState(''), [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('')
  const [loadedId, setLoadedId] = useState(''), [revision, setRevision] = useState(0)
  const loaded = loadedId === projectId
  useEffect(() => {
    let current = true
    setLoading(true); setLoadedId(''); setRules(''); setError(''); setMessage('')
    if (!projectId) { setLoading(false); return }
    void window.awb.treeIgnoreGet(projectId).then((items) => { if (current) { setRules(items.join(', ')); setLoadedId(projectId) } }).catch((reason: unknown) => { if (current) setError(reason instanceof Error ? reason.message : '无法读取忽略规则') }).finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [projectId, revision])
  return <details className="group file-search-settings">
    <summary>文件搜索设置</summary>
    <div className="card">
      {!projectId ? <p className="repository-help">添加项目后可调整搜索忽略规则。</p> : <>
        <div className="srow"><div className="lt"><b>项目</b></div><select className="sel" aria-label="搜索规则所属项目" value={projectId} disabled={busy} onChange={(event) => setSelected(event.target.value)}>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></div>
        <div className="srow"><div className="lt"><b>忽略的目录</b><small>目录名称，用逗号分隔；以 . 开头的文件夹始终跳过</small></div><input className="tx" aria-label="忽略的目录名称" value={rules} disabled={!loaded || busy} onChange={(event) => { setRules(event.target.value); setMessage('') }} /></div>
        <div className="srow"><span className="grow">{error ? <span role="alert" className="bad">{error}</span> : <span role="status">{loading ? '正在读取…' : message}</span>}</span>{!loading && !loaded && error ? <button className="btn sm" onClick={() => setRevision((value) => value + 1)}>重新读取</button> : null}<button className="btn sm" disabled={!loaded || busy} onClick={() => {
          if (busy) return
          setBusy(true); setError(''); setMessage('')
          void window.awb.treeIgnoreSet(projectId, rules.split(',').map((rule) => rule.trim()).filter(Boolean)).then(() => setMessage('规则已保存')).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : '保存失败')).finally(() => setBusy(false))
        }}>{busy ? '正在保存…' : '应用规则'}</button></div>
      </>}
    </div>
  </details>
}
