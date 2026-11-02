import { useEffect, useState, type ReactNode } from 'react'
import type { Executor, Host, Plugin, Settings, SettingsSection, ShellKind } from '../shared/types'
import { PRESETS, cmdline, hostLine, preferredAgent, shellChoices, shellLabel } from '../shared/types'
import { Icon, type IconName, Mark } from './icons'

const SECTIONS: { id: SettingsSection; label: string; icon: IconName }[] = [
  { id: 'general', label: '通用', icon: 'sliders' },
  { id: 'look', label: '外观', icon: 'palette' },
  { id: 'agents', label: '执行器', icon: 'cpu' },
  { id: 'hosts', label: '远程机器', icon: 'server' },
  { id: 'plugins', label: '插件', icon: 'puzzle' },
  { id: 'keys', label: '快捷键', icon: 'key' }
]

const LEADS: Record<SettingsSection, string> = {
  general: '终端与项目的默认行为',
  look: '主题与终端字体',
  agents: '在终端里启动的 Code Agent CLI',
  hosts: '项目可以运行在本机或通过 SSH 连接的远程机器上',
  plugins: '为 Agent 提供的外部工具',
  keys: '键盘快捷键'
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
  plugins,
  installed,
  onSection,
  onBack,
  onSettings,
  onPlugins,
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
  plugins: Plugin[]
  installed: Record<string, boolean>
  onSection: (id: SettingsSection) => void
  onBack: () => void
  onSettings: (next: Settings) => void
  onPlugins: (next: Plugin[]) => void
  onEditExec: (id: string) => void
  onNewExec: () => void
  onEditHost: (id: string) => void
  onNewHost: () => void
  onInstall: (name: string, cmd: string) => void
  onLocalHost: () => void
}) {
  const title = SECTIONS.find((item) => item.id === section)?.label || ''
  const localPlatform = hosts.find((item) => item.id === 'local')?.platform || 'linux'
  const shells = shellChoices(localPlatform)
  const shellValue: ShellKind = shells.some((item) => item.id === settings.defShell) ? settings.defShell : shells[0].id
  const agentChoices = [
    ...PRESETS.map((item) => ({ id: item.id, name: item.name, installed: !!installed[item.cmd] })),
    ...custom.map((item) => ({ id: item.id, name: item.name, installed: true })),
    { id: 'shell', name: '仅 Shell', installed: true }
  ]
  const agentValue = preferredAgent(settings.defAgent, agentChoices)
  const agentLabel = agentChoices.find((item) => item.id === agentValue)?.name || '仅 Shell'
  const [agentOpen, setAgentOpen] = useState(false)
  useEffect(() => {
    const card = document.querySelector('[data-set=defAgent]')?.closest('.card')
    card?.classList.toggle('menuopen', agentOpen)
    return () => card?.classList.remove('menuopen')
  }, [agentOpen])
  let body: ReactNode = null
  if (section === 'general') {
    body = (
      <>
        <div className="group">
          <h3>终端</h3>
          <div className="card">
            <Row
              title="默认 Shell"
              desc="新建终端时预选"
              control={
                <select
                  className="sel"
                  aria-label="默认 Shell"
                  value={shellValue}
                  data-set="defShell"
                  onChange={(e) => {
                    const next = shells.find((item) => item.id === e.target.value)?.id || shells[0].id
                    onSettings({ ...settings, defShell: next })
                  }}
                >
                  {shells.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                </select>
              }
            />
            <Row
              title="结束进程前确认"
              desc="防止误杀正在运行的 Agent"
              control={<button className={`switch ${settings.confirmKill ? 'on' : ''}`} role="switch" aria-checked={settings.confirmKill} aria-label="结束进程前确认" data-a="swset" data-k="confirmKill" onClick={() => onSettings({ ...settings, confirmKill: !settings.confirmKill })} />}
            />
            <Row
              title="启动时恢复终端"
              desc="重新打开项目时按原命令启动"
              control={<button className={`switch ${settings.restore ? 'on' : ''}`} role="switch" aria-checked={settings.restore} aria-label="启动时恢复终端" data-a="swset" data-k="restore" onClick={() => onSettings({ ...settings, restore: !settings.restore })} />}
            />
          </div>
        </div>
        <div className="group">
          <h3>项目</h3>
          <div className="card">
            <Row
              title="新项目的默认 Agent"
              desc="可在每个项目中单独修改"
              control={
                <div className="agentpick">
                  <button type="button" className="sel" aria-label="默认 Agent" aria-haspopup="listbox" aria-expanded={agentOpen} data-set="defAgent" onClick={() => setAgentOpen((open) => !open)}>
                    {agentLabel}
                  </button>
                  {agentOpen ? (
                    <div className="selmenu" role="listbox" aria-label="默认 Agent">
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
                            {off ? '（未找到命令）' : ''}
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
          <h3>主题</h3>
          <div className="card">
            <div className="srow" style={{ padding: 16 }}>
              <div className="themes" role="radiogroup" aria-label="主题">
                {(
                  [
                    ['dark', '深色', '#0c0d0f', '#16171a'],
                    ['light', '浅色', '#f3f3f5', '#ffffff']
                  ] as const
                ).map(([id, label, side, panel]) => (
                  <button key={id} className={`th ${settings.theme === id ? 'on' : ''}`} role="radio" aria-checked={settings.theme === id} data-a="theme" data-id={id} onClick={() => onSettings({ ...settings, theme: id })}>
                    <div className="pv" style={{ background: panel }}>
                      <div style={{ background: side }} />
                      <div style={{ padding: 8 }}>
                        <div style={{ height: 4, width: '60%', borderRadius: 2, background: id === 'dark' ? '#3a3c44' : '#d9dae0' }} />
                        <div style={{ height: 4, width: '40%', borderRadius: 2, marginTop: 6, background: id === 'dark' ? '#8e96ff' : '#5355d1' }} />
                      </div>
                    </div>
                    <span>{label}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
        <div className="group">
          <h3>终端字体</h3>
          <div className="card">
            <Row
              title="字号"
              desc="等宽字体：Cascadia Mono，回退 Consolas"
              control={
                <select className="sel" aria-label="字号" value={String(settings.fontSize)} onChange={(e) => onSettings({ ...settings, fontSize: Number(e.target.value) })}>
                  {[12, 13, 14, 15].map((size) => (
                    <option key={size} value={size}>
                      {size}
                    </option>
                  ))}
                </select>
              }
            />
          </div>
        </div>
      </>
    )
  }
  if (section === 'agents') {
    body = (
      <>
        <div className="group">
          <h3>内置预设</h3>
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
                        已安装
                      </span>
                    ) : (
                      <>
                        <span className="tag warn">未找到命令</span>
                        <button className="btn sm" data-a="install" onClick={() => onInstall(preset.name, preset.cmd)}>
                          安装说明
                        </button>
                      </>
                    )
                  }
                />
              )
            })}
          </div>
        </div>
        <div className="group">
          <h3>
            <span className="grow">自定义</span>
            <button className="btn sm" data-a="custom" onClick={onNewExec}>
              <Icon name="plus" className="s" />
              添加
            </button>
          </h3>
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
              <Row title="还没有自定义执行器" desc="任何能在 PowerShell / CMD 里启动的 CLI 都可以添加" />
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
          <h3>
            <span className="grow">机器</span>
            <button className="btn sm" data-a="host" onClick={onNewHost}>
              <Icon name="plus" className="s" />
              添加机器
            </button>
          </h3>
          <div className="card">
            {hosts.map((host) => (
              <button
                key={host.id}
                className="srow click"
                data-a={host.id === 'local' ? 'local-host' : 'host'}
                data-id={host.id}
                onClick={() => (host.id === 'local' ? onLocalHost() : onEditHost(host.id))}
              >
                <span className="hic">
                  <Icon name={host.id === 'local' ? 'laptop' : 'server'} />
                </span>
                <div className="lt">
                  <b>{host.name}</b>
                  <small>{hostLine(host)}</small>
                </div>
                <span className="tag">
                  <span className={`dot ${host.on ? 'running' : 'exited'}`} />
                  {host.on ? '已连接' : '未连接'}
                </span>
                {host.id === 'local' ? <span style={{ width: 14 }} /> : <Icon name="chev" className="s" />}
              </button>
            ))}
          </div>
        </div>
        <p style={{ fontSize: 12, color: 'var(--faint)' }}>远程终端通过 SSH 连接，使用目标机器的默认 Shell（Windows：PowerShell，Linux / macOS：bash 或 zsh）。</p>
      </>
    )
  }
  if (section === 'plugins') {
    body = (
      <div className="group">
        <h3>已安装</h3>
        <div className="card">
          {plugins.map((plugin) => (
            <Row
              key={plugin.id}
              title={plugin.name}
              desc={plugin.desc}
              control={
                <button
                  className={`switch ${plugin.on ? 'on' : ''}`}
                  role="switch"
                  aria-checked={plugin.on}
                  aria-label={plugin.name}
                  data-a="swset"
                  data-k={`plugin:${plugin.id}`}
                  onClick={() => onPlugins(plugins.map((item) => (item.id === plugin.id ? { ...item, on: !item.on } : item)))}
                />
              }
            />
          ))}
        </div>
      </div>
    )
  }
  if (section === 'keys') {
    const rows: [string, string][] = [
      ['新建项目', 'Ctrl N'],
      ['新建终端', 'Ctrl T'],
      ['关闭标签', 'Ctrl W'],
      ['切换文件面板', 'Ctrl B'],
      ['打开设置', 'Ctrl ,'],
      ['保存当前文件', 'Ctrl S'],
      ['撤销文件编辑', 'Ctrl Z'],
      ['重做文件编辑', 'Ctrl Shift Z']
    ]
    body = (
      <>
        <div className="group">
          <h3>常用</h3>
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
          <h3>终端内</h3>
          <div className="card">
            <Row
              title="中断"
              desc="发给前台进程"
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
      <nav className="snav" aria-label="设置分区">
        <button className="back" data-a="back" onClick={onBack}>
          <Icon name="back" className="s" />
          返回
          <kbd style={{ marginLeft: 'auto' }}>Esc</kbd>
        </button>
        <div className="sec" style={{ paddingTop: 0 }}>
          设置
        </div>
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
