import { useEffect, useState } from 'react'
import { t } from '../shared/i18n'
import type { WorkbenchApi } from '../shared/api'
import { Icon } from './icons'
import { AboutLogo } from './AboutLogo'

export function AboutView() {
  const [meta, setMeta] = useState<Awaited<ReturnType<WorkbenchApi['meta']>> | null>(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let current = true
    void window.awb.meta().then((value) => { if (current) { setMeta(value); setError('') } }).catch(() => { if (current) setError(t("无法读取软件信息")) })
    return () => { current = false }
  }, [attempt])
  return <div className="about-view">
    <div className="about-logo" role="img" aria-label={t("Pello 作品图标")}><AboutLogo /></div>
    <h1>Pello</h1>
    <p className="about-description">{t("你的本地 Code Agent 工作台")}</p>
    <dl className="about-details">
      <div><dt>{t("软件版本")}</dt><dd data-about="version">{meta ? `v${meta.version}` : '—'}</dd></div>
      <div><dt>{t("作品作者")}</dt><dd>{meta?.author || '—'}</dd></div>
      <div><dt>{t("作品地址")}</dt><dd>{meta ? <a href={meta.homepage} onClick={(event) => { event.preventDefault(); void window.awb.openHomepage().catch(() => setError(t("无法打开作品地址"))) }}><span>{meta.homepage.replace('https://', '')}</span><Icon name="external" className="s" /></a> : '—'}</dd></div>
    </dl>
    {error ? <div className="about-error" role="alert"><span>{error}</span>{!meta ? <button className="btn sm" onClick={() => setAttempt((value) => value + 1)}>{t("重试")}</button> : null}</div> : null}
  </div>
}
