import { useEffect, useState } from 'react'
import { t } from '../shared/i18n'
import type { AppUpdateState, Settings } from '../shared/types'
import { Icon } from './icons'

function useAppUpdate() {
  const [state, setState] = useState<AppUpdateState>({ phase: 'idle' })
  useEffect(() => {
    let active = true, received = false
    const off = window.awb.onAppUpdate((next) => { received = true; setState(next) })
    void window.awb.appUpdateState().then((next) => { if (active && !received) setState(next) }).catch(() => { if (active && !received) setState({ phase: 'error', failed: 'check' }) })
    return () => { active = false; off() }
  }, [])
  return state
}

function updateStatus(state: AppUpdateState): string {
  switch (state.phase) {
    case 'available': return t("发现新版本 {{0}}", state.version)
    case 'downloading': return t("正在下载更新 {{0}}%", state.percent || 0)
    case 'downloaded': return t("版本 {{0}} 已下载，可安装并重启", state.version)
    case 'installing': return t("正在准备安装更新…")
    case 'error': return state.failed === 'install' ? t("更新安装失败，请重试") : state.failed === 'download' ? t("更新下载失败，请重试") : t("检查更新失败，请重试")
    case 'checking': return t("正在检查更新…")
    case 'current': return t("已是最新版本")
    case 'unsupported': return t("开发模式不检查更新")
    default: return t("尚未检查新版本")
  }
}

export function AppUpdate({ settings, onSettings }: { settings: Settings; onSettings: (settings: Settings, options?: { inlineError: boolean }) => Promise<boolean> }) {
  const state = useAppUpdate()
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [acting, setActing] = useState(false)
  const busy = acting || ['checking', 'downloading', 'installing'].includes(state.phase)
  const download = state.phase === 'available' || (state.phase === 'error' && state.failed === 'download')
  const install = state.phase === 'downloaded' || (state.phase === 'error' && state.failed === 'install')
  const run = (action: () => Promise<unknown>) => {
    setError(''); setActing(true)
    void action().catch(() => setError('action')).finally(() => setActing(false))
  }
  const toggle = async () => {
    setError(''); setSaving(true)
    try { if (!await onSettings({ ...settings, autoCheckUpdates: !settings.autoCheckUpdates }, { inlineError: true })) setError('save') }
    catch { setError('save') }
    finally { setSaving(false) }
  }
  return <section className="group app-update-settings" aria-label={t("应用更新")} data-update-phase={state.phase}>
    <h2>{t("应用更新")}</h2>
    <div className="card">
      <div className="srow">
        <div className="lt"><b>{t("自动检查更新")}</b><small>{t("启动后及每6小时检查新版本，关闭后仍可手动检查")}</small></div>
        <button type="button" className={`switch ${settings.autoCheckUpdates ? 'on' : ''}`} role="switch" aria-checked={settings.autoCheckUpdates} aria-label={t("自动检查更新")} disabled={saving} onClick={() => void toggle()} />
      </div>
      <div className="srow app-update-status">
        <div className="lt" role="status"><b>{updateStatus(state)}</b>{state.phase === 'error' && state.version ? <small>{t("可用版本 {{0}}", state.version)}</small> : null}</div>
        <div className="app-update-actions">
          {!install ? <button type="button" className="btn" disabled={busy || state.phase === 'unsupported'} onClick={() => run(() => window.awb.checkAppUpdate())}>{t("检查更新")}</button> : null}
          {download ? <button type="button" className="btn pri" aria-label={t("下载新版本 {{0}}", state.version)} disabled={busy} onClick={() => run(() => window.awb.downloadAppUpdate())}><Icon name="download" />{t("下载最新版本")}</button> : null}
          {install ? <button type="button" className="btn pri" aria-label={t("安装更新 {{0}} 并重启", state.version)} disabled={busy} onClick={() => run(() => window.awb.installAppUpdate())}><Icon name="refresh" />{t("安装并重启")}</button> : null}
        </div>
      </div>
      {error ? <p className="app-update-error" role="alert">{error === 'save' ? t("无法保存自动检查设置，请重试") : t("更新操作失败，请重试")}</p> : null}
    </div>
  </section>
}
