import { t } from '../shared/i18n'
import { useRef, useState } from 'react'
import { Frame } from './Dialogs'
import { DirectoryBrowser } from './DirectoryBrowser'

export function TemporarySessionDialog({ onCreate, onClose }: { onCreate: (directory: string) => Promise<void>; onClose: () => void }) {
  const [directory, setDirectory] = useState('D:\\TempSessions')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [browsing, setBrowsing] = useState(false)
  const submitting = useRef(false)
  async function submit() {
    if (submitting.current) return
    if (!directory.trim()) { setError(t("请选择临时会话目录")); return }
    submitting.current = true; setBusy(true); setError('')
    try { await onCreate(directory.trim()) } catch (error) { setError(String(error)); setBusy(false); submitting.current = false }
  }
  return <Frame title={t("配置临时会话目录")} busy={busy} onClose={onClose}
    sub={t("首次设置后自动记忆。每次新建都会在此目录创建独立的 UUID 文件夹和 AGENTS.md。")}
    footer={<><button className="btn" disabled={busy} onClick={onClose}>{t("取消")}</button><button className="btn pri" disabled={busy} onClick={() => void submit()}>{busy ? t("正在创建…") : t("保存并新建")}</button></>}>
    <form onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <div className="fld"><span>{t("临时会话目录")}</span><div className="inrow"><input className="tx" aria-label={t("临时会话目录")} value={directory} disabled={busy} onChange={(event) => setDirectory(event.target.value)} /><button type="button" className="btn" disabled={busy} onClick={() => setBrowsing(true)}>{t("浏览…")}</button></div></div>
      {browsing ? <DirectoryBrowser hostId="local" initialPath={directory} onClose={() => setBrowsing(false)} onSelect={(path) => { setDirectory(path); setBrowsing(false) }} /> : null}
      <p className="repository-help">{t("目录配置保存在 Pello 安装目录的 pello.config.json。")}</p>
      {error ? <p className="file-error" role="alert">{error}</p> : null}
    </form>
  </Frame>
}
