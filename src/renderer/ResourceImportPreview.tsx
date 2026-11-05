import { useState } from 'react'
import type { ResourceSourceItem } from '../shared/types'

export function ResourceImportPreview({ items, selected, onChange, disabled }: {
  items: ResourceSourceItem[]; selected: string[]; onChange: (ids: string[]) => void; disabled: boolean
}) {
  const [query, setQuery] = useState('')
  const available = items.filter((item) => !item.error)
  const visible = items.filter((item) => `${item.name} ${item.path}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
  return <div className="resource-import-preview">
    <div className="resource-actions"><b>发现 {items.length} 项 · 已选择 {selected.length} 项</b><span className="grow" />
      <button type="button" className="btn sm" disabled={disabled || !available.length} onClick={() => onChange(selected.length === available.length ? [] : available.map((item) => item.id))}>{selected.length === available.length ? '取消全选' : '全选'}</button>
    </div>
    <input className="tx" type="search" aria-label="搜索待导入资源" placeholder="搜索名称或来源目录" value={query} disabled={disabled} onChange={(event) => setQuery(event.target.value)} />
    <div className="resource-import-list">
      {visible.map((item) => <label key={item.id} className="resource-import-item">
        <input type="checkbox" checked={selected.includes(item.id)} disabled={disabled || !!item.error} onChange={(event) => onChange(event.target.checked ? [...selected, item.id] : selected.filter((id) => id !== item.id))} />
        <span><b>{item.name}</b>{item.enabled === false ? <small>源配置已停用，导入时保留</small> : null}<small className="mono">{item.path}</small>{item.error ? <small className="bad">{item.error}</small> : null}</span>
      </label>)}
      {!visible.length ? <p className="resource-help">没有匹配的资源</p> : null}
    </div>
  </div>
}
