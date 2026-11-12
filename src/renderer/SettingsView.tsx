import { t } from '../shared/i18n'
import { useState, type ReactNode } from 'react'
import { useAnchoredMenu } from './useAnchoredMenu'
import type { Executor, Host, Project, Settings, SettingsSection, ShellKind } from '../shared/types'
import { FileSearchSettings } from './FileSearchSettings'
import { hostColor } from '../shared/host-colors'
import { PRESETS, cmdline, hostDisplayName, hostLine, preferredAgent, shellLabel } from '../shared/types'
import { useLocalShells } from './useLocalShells'
import { ResourceSettings } from './ResourceSettings'
import { AppUpdate } from './AppUpdate'
import { CODE_FONTS, UI_FONTS } from '../shared/fonts'
import { THEMES } from '../shared/themes'
import { Icon, type IconName, Mark } from './icons'

const SECTIONS: { id: SettingsSection; label: string; icon: IconName }[] = [
  { id: 'general', get label() { return t("通用") }, icon: 'sliders' },
  { id: 'look', get label() { return t("外观") }, icon: 'palette' },
  { id: 'agents', get label() { return t("执行器") }, icon: 'cpu' },
  { id: 'hosts', get label() { return t("远程机器") }, icon: 'server' },
  { id: 'mcp', label: 'MCP', icon: 'puzzle' },
  { id: 'skills', label: 'Skill', icon: 'file' },
  { id: 'keys', get label() { return t("快捷键") }, icon: 'key' }
]

const LEADS: Record<SettingsSection, string> = {
  get general() { return t("终端与项目的默认行为") },
  get look() { return t("主题与终端字体") },
  get agents() { return t("在终端里启动的 Code Agent CLI") },
  get hosts() { return t("项目可以运行在本机或通过 SSH 连接的远程机器上") },
  get mcp() { return t("管理各个 Code Agent 的 MCP 服务器") },
  get skills() { return t("查看与分发 Code Agent 的 Skill") },
  get keys() { return t("键盘快捷键") }
}

function Row({ title, desc, control, lead }: { title: string; desc?: ReactNode; control?: ReactNode; lead?: ReactNode }) {
  return (
    <div className="srow">
      {lead}
      <div className="lt">
        <b>{title}</b>
        {desc ? <small>{desc}</small> : null}
      </div>
      {control}
    </div>
  )
}

export function SettingsView({
  section,
  settings,
  custom,
  hosts,
  projects,
  installed,
  onSection,
  onBack,
  onSettings,
  onEditExec,
  onNewExec,
  onEditHost,
  onNewHost,
  onInstall,
  onLocalHost
}: {
  section: SettingsSection
  settings: Settings
  custom: Executor[]
  hosts: Host[]
  projects: Project[]
  installed: Record<string, boolean>
  onSection: (id: SettingsSection) => void
  onBack: () => void
  onSettings: (next: Settings, options?: { inlineError: boolean }) => Promise<boolean>
  onEditExec: (id: string) => void
  onNewExec: () => void
  onEditHost: (id: string) => void
  onNewHost: () => void
  onInstall: (name: string, cmd: string) => void
  onLocalHost: () => void
}) {
  const title = SECTIONS.find((item) => item.id === section)?.label || ''
  const { shells, loading: shellsLoading, error: shellsError, refresh: refreshShells } = useLocalShells()
  const shellValue: ShellKind = settings.defShell
  const agentChoices = [
    ...PRESETS.map((item) => ({ id: item.id, name: item.name, installed: !!installed[item.cmd] })),
    ...custom.map((item) => ({ id: item.id, name: item.name, installed: true })),
    { id: 'shell', name: t("仅 Shell"), installed: true }
  ]
  const agentValue = preferredAgent(settings.defAgent, agentChoices)
  const agentLabel = agentChoices.find((item) => item.id === agentValue)?.name || t("仅 Shell")
  const [agentOpen, setAgentOpen] = useState(false)
  const agentMenu = useAnchoredMenu(agentOpen, () => setAgentOpen(false))
  let body: ReactNode = null
  if (section === 'general') {
    body = (
      <>
        <div className="group">
          <h2>{t("语言")}</h2>
          <div className="card"><Row title={t("应用语言")} desc={t("立即生效，重启后保留")} control={<select className="sel" aria-label={t("应用语言")} data-set="language" value={settings.language || 'zh-CN'} onChange={(event) => onSettings({ ...settings, language: event.target.value === 'en' ? 'en' : 'zh-CN' })}><option value="zh-CN">{t("简体中文")}</option><option value="en">English</option></select>} /></div>
        </div>
        <AppUpdate settings={settings} onSettings={onSettings} />
        <div className="group">
          <h2>{t("终端")}</h2>
          <div className="card">
            <Row
              title={t("默认 Shell")}
              desc={<>{shellsLoading ? t("正在检测本机 Shell…") : shellsError || t("新建终端时预选")} <button className="btn sm ghost" type="button" disabled={shellsLoading} onClick={refreshShells}>{t("重新检测")}</button></>}
              control={
                <select
                  className="sel"
                  aria-label={t("默认 Shell")}
                  value={shellValue}
                  disabled={shellsLoading || !shells.length}
                  data-set="defShell"
                  onChange={(e) => {
                    const next = shells.find((item) => item.id === e.target.value)?.id
                    if (next) onSettings({ ...settings, defShell: next })
                  }}
                >
                  {!shells.some((item) => item.id === shellValue) ? <option value={shellValue} disabled>{shellLabel(shellValue)}{t('（')}{shellsLoading ? t("检测中") : t("未检测到")}{t('）')}</option> : null}
                  {shells.map((item) => (
                    <option key={item.id} value={item.id} title={item.path}>
                      {item.label}
                    </option>
                  ))}
                </select>
              }
            />
            <Row
              title={t("结束进程前确认")}
              desc={t("防止误杀正在运行的 Agent")}
              control={<button className={`switch ${settings.confirmKill ? 'on' : ''}`} role="switch" aria-checked={settings.confirmKill} aria-label={t("结束进程前确认")} data-a="swset" data-k="confirmKill" onClick={() => onSettings({ ...settings, confirmKill: !settings.confirmKill })} />}
            />
            <Row
              title={t("启动时恢复终端")}
              desc={t("重新打开项目时按原命令启动")}
              control={<button className={`switch ${settings.restore ? 'on' : ''}`} role="switch" aria-checked={settings.restore} aria-label={t("启动时恢复终端")} data-a="swset" data-k="restore" onClick={() => onSettings({ ...settings, restore: !settings.restore })} />}
            />
          </div>
        </div>
        <FileSearchSettings projects={projects} />
        <div className="group">
          <h2>{t("项目")}</h2>
          <div className="card">
            <Row
              title={t("新项目的默认 Agent")}
              desc={t("可在每个项目中单独修改")}
              control={
                <div className="agentpick">
                  <button type="button" className="sel" aria-label={t("默认 Agent")} aria-haspopup="listbox" aria-expanded={agentOpen} data-set="defAgent" onClick={() => setAgentOpen((open) => !open)}
                    onKeyDown={(event) => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setAgentOpen(true) } }}>
                    {agentLabel}
                  </button>
                  {agentOpen ? (
                    <div ref={agentMenu} className="selmenu" role="listbox" aria-label={t("默认 Agent")} popover="manual">
                      {agentChoices.map((item) => {
                        const off = !item.installed
                        return (
                          <button
                            type="button"
                            key={item.id}
                            role="option"
                            className={item.id === agentValue ? 'on' : ''}
                            aria-selected={item.id === agentValue}
                            aria-disabled={off || undefined}
                            disabled={off}
                            data-set-opt={item.id}
                            onClick={() => {
                              if (off) return
                              onSettings({ ...settings, defAgent: item.id })
                              setAgentOpen(false)
                            }}
                          >
                            {item.name}
                            {off ? t("（未找到命令）") : ''}
                          </button>
                        )
                      })}
                    </div>
                  ) : null}
                </div>
              }
            />
          </div>
        </div>
      </>
    )
  }
  if (section === 'look') {
    body = (
      <>
        <div className="group">
          <h2>{t("主题")}</h2>
          <div className="card">
            <div className="srow" style={{ padding: 16 }}>
              <div className="themes" role="radiogroup" aria-label={t("主题")}>
                {THEMES.map(({ id, name: label, colors }) => {
                  const side = colors.side, panel = colors.panel
                  return (
                  <button key={id} className={`th ${settings.theme === id ? 'on' : ''}`} role="radio" aria-checked={settings.theme === id} data-a="theme" data-id={id} onClick={() => onSettings({ ...settings, theme: id })}>
                    <div className="pv" style={{ background: panel }}>
                      <div style={{ background: side }} />
                      <div style={{ padding: 8 }}>
                        <div style={{ height: 4, width: '60%', borderRadius: 2, background: colors.muted }} />
                        <div style={{ height: 4, width: '40%', borderRadius: 2, marginTop: 6, background: colors.accent }} />
                      </div>
                    </div>
                    <span>{label}</span>
                  </button>
                  )
                })}
              </div>
            </div>
          </div>
        </div>
        <div className="group">
          <h2>{t("终端字体")}</h2>
          <div className="card">
            <Row title={t("字体")} control={<select className="sel" aria-label={t("终端字体")} value={settings.fontFamily || 'Cascadia Mono'} onChange={(event) => onSettings({ ...settings, fontFamily: event.target.value })}>{CODE_FONTS.map((family) => <option key={family}>{family}</option>)}</select>} />
            <Row
              title={t("字号")}
              control={
                <select className="sel" aria-label={t("字号")} value={String(settings.fontSize)} onChange={(e) => onSettings({ ...settings, fontSize: Number(e.target.value) })}>
                  {Array.from({ length: 15 }, (_, index) => index + 10).map((size) => (
                    <option key={size} value={size}>
                      {size}
                    </option>
                  ))}
                </select>
              }
            />
          </div>
        </div>
        <div className="group"><h2>{t("布局")}</h2><div className="card">
          <Row title={t("工作布局")} control={<select className="sel" aria-label={t("工作布局")} value={settings.layout || 'focus'} onChange={(event) => onSettings({ ...settings, layout: event.target.value as Settings['layout'] })}>
            <option value="balanced">{t("均衡布局")}</option><option value="focus">{t("终端专注")}</option><option value="review">{t("跨仓库审阅")}</option></select>} />
          <Row title={t("文件与变更面板位置")} control={<select className="sel" aria-label={t("文件与变更面板位置")} value={settings.panelSide || 'right'} onChange={(event) => onSettings({ ...settings, panelSide: event.target.value as Settings['panelSide'] })}><option value="right">{t("右侧")}</option><option value="left">{t("左侧")}</option></select>} />
          <Row title={t("界面密度")} control={<select className="sel" aria-label={t("界面密度")} value={settings.density || 'comfortable'} onChange={(event) => onSettings({ ...settings, density: event.target.value as Settings['density'] })}><option value="comfortable">{t("舒适")}</option><option value="compact">{t("紧凑")}</option></select>} />
        </div></div>
        <div className="group"><h2>{t("界面与编辑器")}</h2><div className="card">
          <Row title={t("界面字体")} control={<select className="sel" aria-label={t("界面字体")} value={settings.uiFontFamily || 'Geist'} onChange={(event) => onSettings({ ...settings, uiFontFamily: event.target.value })}>{UI_FONTS.map((family) => <option key={family}>{family}</option>)}</select>} />
          <Row title={t("界面字号")} control={<select className="sel" aria-label={t("界面字号")} value={settings.uiFontSize || 13} onChange={(event) => onSettings({ ...settings, uiFontSize: Number(event.target.value) })}>{[12, 13, 14, 15, 16].map((size) => <option key={size}>{size}</option>)}</select>} />
          <Row title={t("源码字号")} control={<select className="sel" aria-label={t("源码字号")} value={settings.editorFontSize || 14} onChange={(event) => onSettings({ ...settings, editorFontSize: Number(event.target.value) })}>{Array.from({ length: 15 }, (_, index) => index + 10).map((size) => <option key={size}>{size}</option>)}</select>} />
        </div></div>
      </>
    )
  }
  if (section === 'agents') {
    body = (
      <>
        <div className="group">
          <h2>{t("内置预设")}</h2>
          <div className="card">
            {PRESETS.map((preset) => {
              const ok = !!installed[preset.cmd]
              return (
                <Row
                  key={preset.id}
                  lead={<Mark letter={preset.letter} color={preset.color} size="md" />}
                  title={preset.name}
                  desc={<span className="mono">{preset.cmd}</span>}
                  control={
                    ok ? (
                      <span className="okt">
                        <Icon name="check" className="s" />
                        {t("已安装")}</span>
                    ) : (
                      <>
                        <span className="tag warn">{t("未找到命令")}</span>
                        <button className="btn sm" data-a="install" onClick={() => onInstall(preset.name, preset.cmd)}>
                          {t("安装说明")}</button>
                      </>
                    )
                  }
                />
              )
            })}
          </div>
        </div>
        <div className="group">
          <h2>
            <span className="grow">{t("自定义")}</span>
            <button className="btn sm" data-a="custom" onClick={onNewExec}>
              <Icon name="plus" className="s" />
              {t("添加")}</button>
          </h2>
          <div className="card">
            {custom.length ? (
              custom.map((item) => (
                <button key={item.id} className="srow click" data-a="custom" data-id={item.id} onClick={() => onEditExec(item.id)}>
                  <Mark letter={item.letter} color={item.color} size="md" />
                  <div className="lt">
                    <b>{item.name}</b>
                    <small className="mono">{cmdline(item)}</small>
                  </div>
                  <span className="tag">{shellLabel(item.shell)}</span>
                  <Icon name="chev" className="s" />
                </button>
              ))
            ) : (
              <Row title={t("还没有自定义执行器")} desc={t("任何能在 PowerShell / CMD 里启动的 CLI 都可以添加")} />
            )}
          </div>
        </div>
      </>
    )
  }
  if (section === 'hosts') {
    body = (
      <>
        <div className="group">
          <h2>
            <span className="grow">{t("机器")}</span>
            <button className="btn sm" data-a="host" onClick={onNewHost}>
              <Icon name="plus" className="s" />
              {t("添加机器")}</button>
          </h2>
          <div className="card">
            {hosts.map((host) => (
              <button
                key={host.id}
                className="srow click"
                data-a={host.id === 'local' ? 'local-host' : 'host'}
                data-id={host.id}
                onClick={() => (host.id === 'local' ? onLocalHost() : onEditHost(host.id))}
              >
                <span className="hic project-folder" data-color={hostColor(host.color)}>
                  <Icon name={host.id === 'local' ? 'laptop' : 'server'} />
                </span>
                <div className="lt">
                  <b>{hostDisplayName(host)}</b>
                  <small>{hostLine(host)}</small>
                </div>
                <span className="tag">
                  <span className={`dot ${host.on ? 'running' : 'exited'}`} />
                  {host.on ? t("已连接") : t("未连接")}
                </span>
                <Icon name="chev" className="s" />
              </button>
            ))}
          </div>
        </div>
        <p style={{ fontSize: 12, color: 'var(--faint)' }}>{t("远程终端通过 SSH 连接，使用目标机器的默认 Shell（Windows：PowerShell，Linux / macOS：bash 或 zsh）。")}</p>
      </>
    )
  }
  if (section === 'mcp' || section === 'skills') body = <ResourceSettings key={section} kind={section} />
  if (section === 'keys') {
    const rows: [string, string][] = [
      [t("新建项目"), 'Ctrl N'],
      [t("新建终端"), 'Ctrl T'],
      [t("关闭标签"), 'Ctrl W'],
      [t("切换文件面板"), 'Ctrl B'],
      [t("打开设置"), 'Ctrl ,'],
      [t("保存当前文件"), 'Ctrl S'],
      [t("撤销文件编辑"), 'Ctrl Z'],
      [t("重做文件编辑"), 'Ctrl Shift Z']
    ]
    body = (
      <>
        <div className="group">
          <h2>{t("常用")}</h2>
          <div className="card">
            {rows.map(([label, keys]) => (
              <Row
                key={label}
                title={label}
                control={
                  <span className="keys">
                    {keys.split(' ').map((key) => (
                      <kbd key={key}>{key}</kbd>
                    ))}
                  </span>
                }
              />
            ))}
          </div>
        </div>
        <div className="group">
          <h2>{t("终端内")}</h2>
          <div className="card">
            <Row
              title={t("中断")}
              desc={t("发给前台进程")}
              control={
                <span className="keys">
                  <kbd>Ctrl</kbd>
                  <kbd>C</kbd>
                </span>
              }
            />
          </div>
        </div>
      </>
    )
  }
  return (
    <section className="settings">
      <nav className="snav" aria-label={t("设置分区")}>
        <button className="back" data-a="back" onClick={onBack}>
          <Icon name="back" className="s" />
          {t("返回")}<kbd style={{ marginLeft: 'auto' }}>Esc</kbd>
        </button>
        <div className="sec" style={{ paddingTop: 0 }}>
          {t("设置")}</div>
        {SECTIONS.map((item) => (
          <button key={item.id} className={`navb ${section === item.id ? 'on' : ''}`} data-a="sec" data-id={item.id} aria-current={section === item.id ? 'page' : undefined} onClick={() => onSection(item.id)}>
            <Icon name={item.icon} />
            {item.label}
          </button>
        ))}
      </nav>
      <div className="scontent">
        <div className="scol">
          <h1>{title}</h1>
          <p className="lead">{LEADS[section]}</p>
          {body}
        </div>
      </div>
    </section>
  )
}
