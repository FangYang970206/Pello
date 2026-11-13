import { t } from '../shared/i18n'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { DirListing } from '../shared/types'
import { Icon } from './icons'
import { ResourceDialog } from './ResourceDialog'

export function DirectoryBrowser({ hostId, initialPath, onSelect, onClose }: {
  hostId: string; initialPath: string; onSelect: (path: string) => void; onClose: () => void
}) {
  const [address, setAddress] = useState(initialPath)
  const [query, setQuery] = useState('')
  const [listing, setListing] = useState<DirListing | null>(null)
  const [selected, setSelected] = useState('')
  const [loading, setLoading] = useState(true)
  const [history, setHistory] = useState<{ paths: string[]; index: number }>({ paths: [], index: -1 })
  const request = useRef(0), list = useRef<HTMLDivElement>(null)

  const navigate = useCallback(async (input: string, historyIndex?: number) => {
    const token = ++request.current
    setLoading(true); setAddress(input); setQuery(''); setSelected('')
    try {
      const next = await window.awb.listDir(hostId, input.trim())
      if (token !== request.current) return
      setListing(next); setAddress(next.path)
      if (!next.error) setHistory((old) => historyIndex !== undefined ? { ...old, index: historyIndex } :
        old.paths[old.index] === next.path ? old : { paths: [...old.paths.slice(0, old.index + 1), next.path], index: old.index + 1 })
    } catch (error) {
      if (token !== request.current) return
      setListing({ path: input, parent: null, dirs: [], error: String(error) })
    } finally { if (token === request.current) setLoading(false) }
  }, [hostId])

  useEffect(() => {
    void navigate(initialPath)
    return () => { request.current++ }
  }, [initialPath, navigate])

  const dirs = listing?.dirs.filter((entry) => entry.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())) || []
  const picked = selected || listing?.path || ''
  const windows = /^[A-Za-z]:[\\/]/.test(listing?.path || '')
  const crumbs = listing?.path.split(windows ? /[\\/]/ : '/').filter(Boolean) || []
  const breadcrumbPath = (index: number) => windows ? crumbs.slice(0, index + 1).join('\\') + (index === 0 ? '\\' : '') : '/' + crumbs.slice(0, index + 1).join('/')
  const move = (offset: number) => { const index = history.index + offset; if (history.paths[index]) void navigate(history.paths[index], index) }
  return <ResourceDialog title={t("选择文件夹")} onClose={onClose} footer={<>
    <div className="directory-picked"><span>{t("文件夹")}</span><span className="mono" title={picked}>{picked}</span></div>
    <button className="btn ghost" onClick={onClose}>{t("取消")}</button>
    <button className="btn pri directory-select" disabled={loading || !listing || !!listing.error} onClick={() => onSelect(picked)}>{t("使用此目录")}</button>
  </>}>
    <div className="directory-browser" aria-label={t("远程目录浏览")} onKeyDown={(event) => {
      if (event.altKey && event.key === 'ArrowLeft') { event.preventDefault(); move(-1) }
      if (event.altKey && event.key === 'ArrowRight') { event.preventDefault(); move(1) }
      if (event.altKey && event.key === 'ArrowUp' && listing?.parent) { event.preventDefault(); void navigate(listing.parent) }
    }}>
      <div className="directory-toolbar">
        <button className="ib" aria-label={t("返回")} title={t("返回")} disabled={history.index <= 0} onClick={() => move(-1)}><Icon name="back" /></button>
        <button className="ib" aria-label={t("前进")} title={t("前进")} disabled={history.index >= history.paths.length - 1} onClick={() => move(1)}><Icon name="chev" /></button>
        <button className="ib" aria-label={t("上一级")} title={t("上一级")} disabled={loading || !listing?.parent} onClick={() => void navigate(listing?.parent || '')}><Icon name="up" /></button>
        <div className="inrow grow"><input autoFocus className="tx mono" aria-label={t("浏览路径")} placeholder={t("输入绝对路径，留空打开主目录")} value={address}
          onChange={(event) => setAddress(event.target.value)} onKeyDown={(event) => {
            if (event.key === 'Enter') { event.preventDefault(); void navigate(address) }
          }} /><button className="btn" onClick={() => void navigate(address)}>{t("前往")}</button></div>
      </div>
      <div className="directory-location">
        <nav aria-label={t("目录路径")} className="directory-crumbs">
          {!windows ? <button className="btn ghost sm" onClick={() => void navigate('/')}>/</button> : null}
          {crumbs.map((name, index) => <button key={index} className="btn ghost sm" title={breadcrumbPath(index)} onClick={() => void navigate(breadcrumbPath(index))}>{name}<Icon name="chev" className="s" /></button>)}
        </nav>
        <input className="tx" aria-label={t("筛选子目录")} placeholder={t("筛选当前目录中的文件夹")} value={query} onChange={(event) => { setQuery(event.target.value); setSelected('') }} />
      </div>
      <div className="directory-body">
        <aside><button className="btn ghost" onClick={() => void navigate('')}><Icon name="home" className="s" />{t("主目录")}</button></aside>
        <div className="directory-contents">
          <div className="directory-list-heading">{t("名称")}<span>{t("双击打开文件夹")}</span></div>
          <div className="directory-list" ref={list} role="group" aria-label={t("文件夹")} aria-busy={loading}>
            {loading ? <p className="directory-empty" role="status">{t("正在读取目录…")}</p> : listing?.error ? <div className="directory-empty" role="alert">
              <p className="bad">{t("无法读取目录：")}{listing.error}</p><button className="btn sm" onClick={() => void navigate(address)}>{t("重试")}</button>
            </div> : dirs.length ? dirs.map((entry) => <button key={entry.path} className={`directory-entry${selected === entry.path ? ' on' : ''}`} aria-pressed={selected === entry.path}
              onClick={() => setSelected(entry.path)} onDoubleClick={() => void navigate(entry.path)} onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === 'ArrowRight') {
                  event.preventDefault()
                  void navigate(entry.path).then(() => requestAnimationFrame(() => { list.current?.querySelector<HTMLButtonElement>('button')?.focus() }))
                }
                if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                  event.preventDefault()
                  const buttons = Array.from(list.current?.querySelectorAll<HTMLButtonElement>('button') || [])
                  const index = buttons.indexOf(event.currentTarget), next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))
                  buttons[next]?.focus(); setSelected(dirs[next]?.path || '')
                }
              }}><Icon name="folder" className="s" /><span>{entry.name}</span></button>) : <p className="directory-empty">{query ? t("没有匹配的文件夹") : t("此目录没有子文件夹")}</p>}
          </div>
          <small role="status" className="directory-count">{!loading && !listing?.error ? `${dirs.length} ${t(" 个文件夹")}` : '\u00a0'}</small>
        </div>
      </div>
    </div>
  </ResourceDialog>
}
