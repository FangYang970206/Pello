import { t } from '../shared/i18n'
import { useEffect, useRef, useState } from 'react'
import { Frame } from './Dialogs'
import type { Host } from '../shared/types'
import { hostDisplayName } from '../shared/types'
import { DirectoryBrowser } from './DirectoryBrowser'

export function TemporarySessionDialog({ hosts, onCreate, onClose }: { hosts: Host[]; onCreate: (directory: string, hostId: string) => Promise<void>; onClose: () => void }) {
  const [hostId, setHostId] = useState('local')
  const host = hosts.find((item) => item.id === hostId)!
  const [directories, setDirectories] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true), [browsing, setBrowsing] = useState(false)
  const directory = directories[hostId] ?? (host.platform === 'windows' ? 'D:\\TempSessions' : '')
  const setDirectory = (value: string) => setDirectories((old) => ({ ...old, [hostId]: value }))
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const submitting = useRef(false)
  useEffect(() => {
    let stopped = false
    void window.awb.temporaryDirectory(hostId).then((saved) => {
      if (!stopped && saved) setDirectories((old) => old[hostId] === undefined ? { ...old, [hostId]: saved } : old)
    }).catch((error) => { if (!stopped) setError(String(error)) }).finally(() => { if (!stopped) setLoading(false) })
    return () => { stopped = true }
  }, [hostId])
  async function submit() {
    if (submitting.current || loading) return
    if (!directory.trim()) { setError(t("请选择临时会话目录")); return }
    submitting.current = true; setBusy(true); setError('')
    try { await onCreate(directory.trim(), hostId) } catch (error) { setError(String(error)); setBusy(false); submitting.current = false }
  }
  return <Frame title={t("配置临时会话目录")} busy={busy} onClose={onClose}
    sub={t("按机器记忆目录。选择执行器后，在所选机器上创建独立的 UUID 文件夹和 AGENTS.md。")}
    footer={<><button className="btn" disabled={busy} onClick={onClose}>{t("取消")}</button><button className="btn pri" disabled={busy || loading} onClick={() => void submit()}>{busy ? t("正在保存…") : t("保存并新建")}</button></>}>
    <form onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <label className="fld"><span>{t("运行环境")}</span><select className="sel" aria-label={t("运行环境")} value={hostId} disabled={busy} onChange={(event) => { setBrowsing(false); setLoading(true); setError(''); setHostId(event.target.value) }}>{hosts.map((item) => <option key={item.id} value={item.id}>{hostDisplayName(item)}{item.id === 'local' ? '' : ' · SSH'}</option>)}</select></label>
      <div className="fld"><span>{t("临时会话目录")}</span><div className="inrow"><input className="tx" aria-label={t("临时会话目录")} value={directory} disabled={busy || loading} onChange={(event) => setDirectory(event.target.value)} /><button type="button" className="btn" disabled={busy || loading} onClick={() => {
        if (hostId !== 'local') { setBrowsing(true); return }
        void window.awb.pickDirectory().then((value) => { if (value) setDirectory(value) }).catch((error) => setError(String(error)))
      }}>{t("浏览…")}</button></div></div>
      <p className="repository-help">{t("目录配置保存在 Pello 安装目录的 pello.config.json。")}</p>
      {error ? <p className="file-error" role="alert">{error}</p> : null}
    </form>
    {browsing ? <DirectoryBrowser hostId={hostId} initialPath={directory} onSelect={(value) => { setDirectory(value); setBrowsing(false) }} onClose={() => setBrowsing(false)} /> : null}
  </Frame>
}
