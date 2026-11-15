import { t } from '../shared/i18n'
import { useCallback, useEffect, useState } from 'react'
import type { DirectoryPickerView } from '../shared/types'
import { Icon } from './icons'
import { ResourceDialog } from './ResourceDialog'

export function DirectoryBrowser({ hostId, initialPath, onSelect, onClose }: {
  hostId: string; initialPath: string; onSelect: (path: string) => void; onClose: () => void
}) {
  const [view, setView] = useState<DirectoryPickerView | null>(null)
  const [address, setAddress] = useState(initialPath)
  const [sessionId, setSessionId] = useState('')

  const show = useCallback((next: DirectoryPickerView) => {
    setView((current) => current && next.generation < current.generation ? current : next)
    setSessionId(next.id)
    setAddress(next.address || next.path || '')
  }, [])
  const apply = useCallback(async (request: { op: string; id?: string; hostId?: string; initial?: string; path?: string; query?: string }) => {
    const navigating = ['go', 'home', 'enter', 'back', 'forward', 'parent'].includes(request.op)
    const staged = await window.awb.picker(navigating ? { ...request, stage: true } : request)
    if (staged && typeof staged === 'object' && 'closed' in staged && staged.closed) {
      onClose()
      return staged
    }
    if (staged && typeof staged === 'object' && 'id' in staged) show(staged)
    if (!navigating || !staged || typeof staged !== 'object' || !('loading' in staged) || !staged.loading) return staged
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const next = await window.awb.picker({ op: 'finish', id: staged.id, generation: staged.generation })
    if (next && typeof next === 'object' && 'id' in next) show(next)
    return next
  }, [onClose, show])

  useEffect(() => {
    let live = true
    void window.awb.picker({ op: 'open', hostId, initial: initialPath }).then((next) => {
      if (!live || !next || typeof next !== 'object' || !('id' in next)) return
      setView(next)
      setSessionId(next.id)
      setAddress(next.address || next.path || '')
    }).catch((error) => {
      if (!live) return
      setView({ id: '', hostId, loading: false, error: String(error), path: initialPath, parent: null, address: initialPath, query: '', selected: '', dirs: [], crumbs: [], canBack: false, canForward: false, canConfirm: false, closed: false, formPath: initialPath, generation: 0 })
    })
    return () => { live = false }
  }, [hostId, initialPath])

  const run = (op: string, extra: { path?: string; query?: string } = {}) => {
    if (!sessionId) return
    void apply({ op, id: sessionId, ...extra }).catch((error) => setView((current) => current ? { ...current, loading: false, error: String(error) } : current))
  }
  const dirs = view?.dirs || []
  const picked = view?.selected || view?.path || ''
  const windows = /^[A-Za-z]:[\\/]/.test(view?.path || '')
  const crumbPath = (index: number) => windows ? (view?.crumbs.slice(0, index + 1).join('\\') || '') + (index === 0 ? '\\' : '') : '/' + (view?.crumbs.slice(0, index + 1).join('/') || '')
  return <ResourceDialog title={t("选择文件夹")} onClose={() => { if (sessionId) void window.awb.picker({ op: 'esc', id: sessionId }); onClose() }} footer={<>
    <div className="directory-picked"><span>{t("文件夹")}</span><span className="mono" title={picked}>{picked}</span></div>
    <button className="btn ghost" onClick={() => { if (sessionId) void window.awb.picker({ op: 'esc', id: sessionId }); onClose() }}>{t("取消")}</button>
    <button className="btn pri directory-select" disabled={!view?.canConfirm} onClick={() => { void window.awb.picker({ op: 'confirm', id: sessionId }).then((value) => { if (typeof value === 'string' && value) onSelect(value) }) }}>{t("使用此目录")}</button>
  </>}>
    <div className="directory-browser" aria-label={t("远程目录浏览")} onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); if (sessionId) void window.awb.picker({ op: 'esc', id: sessionId }); onClose() }
      if (event.altKey && event.key === 'ArrowLeft') { event.preventDefault(); run('back') }
      if (event.altKey && event.key === 'ArrowRight') { event.preventDefault(); run('forward') }
      if (event.altKey && event.key === 'ArrowUp' && view?.parent) { event.preventDefault(); run('parent') }
    }}>
      <div className="directory-toolbar">
        <button className="ib" aria-label={t("返回")} title={t("返回")} disabled={!view?.canBack} onClick={() => run('back')}><Icon name="back" /></button>
        <button className="ib" aria-label={t("前进")} title={t("前进")} disabled={!view?.canForward} onClick={() => run('forward')}><Icon name="chev" /></button>
        <button className="ib" aria-label={t("上一级")} title={t("上一级")} disabled={view?.loading || !view?.parent} onClick={() => run('parent')}><Icon name="up" /></button>
        <div className="inrow grow"><input autoFocus className="tx mono" aria-label={t("浏览路径")} placeholder={t("输入绝对路径，留空打开主目录")} value={address}
          onChange={(event) => setAddress(event.target.value)} onKeyDown={(event) => {
            if (event.key === 'Enter') { event.preventDefault(); run('go', { path: address }) }
          }} /><button className="btn" onClick={() => run('go', { path: address })}>{t("前往")}</button></div>
      </div>
      <div className="directory-location">
        <nav aria-label={t("目录路径")} className="directory-crumbs">
          {!windows ? <button className="btn ghost sm" onClick={() => run('go', { path: '/' })}>/</button> : null}
          {(view?.crumbs || []).map((name, index) => <button key={index} className="btn ghost sm" title={crumbPath(index)} onClick={() => run('go', { path: crumbPath(index) })}>{name}<Icon name="chev" className="s" /></button>)}
        </nav>
        <input className="tx" aria-label={t("筛选子目录")} placeholder={t("筛选当前目录中的文件夹")} value={view?.query || ''} onChange={(event) => run('filter', { query: event.target.value })} />
      </div>
      <div className="directory-body">
        <aside><button className="btn ghost" onClick={() => run('home')}><Icon name="home" className="s" />{t("主目录")}</button></aside>
        <div className="directory-contents">
          <div className="directory-list-heading">{t("名称")}<span>{t("双击打开文件夹")}</span></div>
          <div className="directory-list" role="group" aria-label={t("文件夹")} aria-busy={view?.loading}>
            {view?.loading ? <p className="directory-empty" role="status">{t("正在读取目录…")}</p> : view?.error ? <div className="directory-empty" role="alert">
              <p className="bad">{t("无法读取目录：")}{view.error}</p><button className="btn sm" onClick={() => run('go', { path: address })}>{t("重试")}</button>
            </div> : dirs.length ? dirs.map((entry) => <button key={entry.path} className={`directory-entry${view?.selected === entry.path ? ' on' : ''}`} aria-pressed={view?.selected === entry.path}
              onClick={() => run('click', { path: entry.path })} onDoubleClick={() => run('enter', { path: entry.path })} onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === 'ArrowRight') { event.preventDefault(); run('enter', { path: entry.path }) }
              }}><Icon name="folder" className="s" /><span>{entry.name}</span></button>) : <p className="directory-empty">{view?.query ? t("没有匹配的文件夹") : t("此目录没有子文件夹")}</p>}
          </div>
          <small role="status" className="directory-count">{view && !view.loading && !view.error ? `${dirs.length} ${t(" 个文件夹")}` : '\u00a0'}</small>
        </div>
      </div>
    </div>
  </ResourceDialog>
}
