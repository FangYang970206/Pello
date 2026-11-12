import { t } from '../shared/i18n'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { DirListing } from '../shared/types'
import { Icon } from './icons'

export function DirectoryBrowser({ hostId, initialPath, onSelect, onClose }: {
  hostId: string; initialPath: string; onSelect: (path: string) => void; onClose: () => void
}) {
  const [address, setAddress] = useState(initialPath)
  const [query, setQuery] = useState('')
  const [listing, setListing] = useState<DirListing | null>(null)
  const [loading, setLoading] = useState(true)
  const request = useRef(0)

  const navigate = useCallback(async (input: string) => {
    const token = ++request.current
    setLoading(true)
    setAddress(input)
    setQuery('')
    try {
      const next = await window.awb.listDir(hostId, input.trim())
      if (token !== request.current) return
      setListing(next)
      setAddress(next.path)
    } catch (error) {
      if (token !== request.current) return
      setListing({ path: input, parent: null, dirs: [], error: String(error) })
    } finally {
      if (token === request.current) setLoading(false)
    }
  }, [hostId])

  useEffect(() => {
    void navigate(initialPath)
    return () => { request.current++ }
  }, [initialPath, navigate])

  const dirs = listing?.dirs.filter((entry) => entry.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())) || []
  return <div className="directory-browser" aria-label={t("远程目录浏览")}>
    <div className="inrow">
      <input className="tx mono" aria-label={t("浏览路径")} placeholder={t("输入绝对路径，留空打开主目录")} value={address}
        onChange={(event) => setAddress(event.target.value)} onKeyDown={(event) => {
          if (event.key === 'Enter') { event.preventDefault(); void navigate(address) }
        }} />
      <button className="btn" onClick={() => void navigate(address)}>{t("前往")}</button>
    </div>
    <div className="directory-actions">
      <button className="btn sm" onClick={() => void navigate('')}>{t("主目录")}</button>
      <button className="btn sm" disabled={loading || !listing?.parent} onClick={() => void navigate(listing?.parent || '')}>{t("上一级")}</button>
      <button className="btn sm" onClick={onClose}>{t("收起")}</button>
    </div>
    <input className="tx" aria-label={t("筛选子目录")} placeholder={t("筛选当前目录中的文件夹")} value={query} onChange={(event) => setQuery(event.target.value)} />
    {loading ? <p role="status">{t("正在读取目录…")}</p> : listing?.error ? <div role="alert">
      <p className="bad">{t("无法读取目录：")}{listing.error}</p>
      <button className="btn sm" onClick={() => void navigate(address)}>{t("重试")}</button>
    </div> : <>
      <div className="mlist browse">
        {dirs.map((entry) => <button key={entry.path} className="mopt" onClick={() => void navigate(entry.path)}>
          <Icon name="folder" className="s" /><span className="grow">{entry.name}</span>
        </button>)}
        {!dirs.length ? <p className="directory-empty">{query ? t("没有匹配的文件夹") : t("此目录没有子文件夹")}</p> : null}
      </div>
      <small role="status">{query ? `${dirs.length} / ${listing?.dirs.length || 0}` : `${dirs.length}`} {t(" 个文件夹")}</small>
    </>}
    <button className="btn directory-select" disabled={loading || !listing || !!listing.error} onClick={() => listing && onSelect(listing.path)}>
      {t("使用此目录")}{listing && !loading ? <span className="mono">{listing.path}</span> : null}
    </button>
  </div>
}
