import { useRef, useState } from 'react'
import { Frame } from './Dialogs'

export function TemporarySessionDialog({ onCreate, onClose }: { onCreate: (directory: string) => Promise<void>; onClose: () => void }) {
  const [directory, setDirectory] = useState('D:\\TempSessions')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const submitting = useRef(false)
  async function submit() {
    if (submitting.current) return
    if (!directory.trim()) { setError('请选择临时会话目录'); return }
    submitting.current = true; setBusy(true); setError('')
    try { await onCreate(directory.trim()) } catch (error) { setError(String(error)); setBusy(false); submitting.current = false }
  }
  return <Frame title="配置临时会话目录" busy={busy} onClose={onClose}
    sub="首次设置后自动记忆。每次新建都会在此目录创建独立的 UUID 文件夹和 AGENTS.md。"
    footer={<><button className="btn" disabled={busy} onClick={onClose}>取消</button><button className="btn pri" disabled={busy} onClick={() => void submit()}>{busy ? '正在创建…' : '保存并新建'}</button></>}>
    <form onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <div className="fld"><span>临时会话目录</span><div className="inrow"><input className="tx" aria-label="临时会话目录" value={directory} disabled={busy} onChange={(event) => setDirectory(event.target.value)} /><button type="button" className="btn" disabled={busy} onClick={() => void window.awb.pickDirectory().then((value) => { if (value) setDirectory(value) }).catch((error) => setError(String(error)))}>浏览…</button></div></div>
      <p className="repository-help">目录配置保存在 Pello 安装目录的 pello.config.json。</p>
      {error ? <p className="file-error" role="alert">{error}</p> : null}
    </form>
  </Frame>
}
