import { t } from '../shared/i18n'
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { AgentInfo, Executor, Host, OsKind, PathCheck, Settings, ShellKind } from '../shared/types'
import { EXEC_COLORS, PRESETS, SHELL_AGENT, cmdline, hostDisplayName, hostLine, preferredAgent, shellLabel, uid } from '../shared/types'
import { useAnchoredMenu } from './useAnchoredMenu'
import { DirectoryBrowser } from './DirectoryBrowser'
import { HostColorPicker } from './HostColorPicker'
import { useLocalShells } from './useLocalShells'
import { hostColor, nextHostColor } from '../shared/host-colors'
import { executorForHost } from '../shared/executor'

export const dialogOpener: { current: HTMLElement | null } = { current: null }

export function focusableIn(root: ParentNode): HTMLElement[] {
  const nodes = root.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]')
  return [...nodes].filter((el) => {
    if (el.hasAttribute('disabled')) return false
    if (el.closest('[inert]')) return false
    if (el.getAttribute('aria-disabled') === 'true') return false
    if (el.tabIndex < 0) return false
    if (el.closest('[aria-hidden="true"]') && el.closest('[aria-hidden="true"]') !== root) return false
    const style = window.getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden') return false
    return el.getClientRects().length > 0
  })
}
import { Icon, Mark } from './icons'

function invalidPath(platform: OsKind): string {
  return platform === 'windows' ? t("请输入 Windows 绝对路径，例如 C:\\dev\\app") : t("请输入绝对路径，例如 /home/user/app")
}

function placeholder(platform: OsKind): string {
  return platform === 'windows' ? 'C:\\dev\\app' : '/home/user/app'
}

function baseName(value: string): string {
  const parts = value.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || value
}

export function Frame({
  title,
  sub,
  subClass,
  wide,
  small,
  children,
  footer,
  busy = false,
  onClose
}: {
  title: string
  sub?: ReactNode
  subClass?: string
  wide?: boolean
  small?: boolean
  children: ReactNode
  footer: ReactNode
  busy?: boolean
  onClose: () => void
}) {
  const headingId = useId()
  const descriptionId = useId()
  const busyRef = useRef(busy)
  busyRef.current = busy
  const dismiss = () => { if (!busyRef.current) onClose() }
  useLayoutEffect(() => {
    const root = document.querySelector('#modal .dlg') as HTMLElement | null
    if (!root) return
    const opener = document.activeElement instanceof HTMLElement && !root.contains(document.activeElement) ? document.activeElement : null
    const first = root.querySelector<HTMLElement>('[data-autofocus], input:not([disabled]), .btn.pri')
    first?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (document.querySelector('dialog[open]')) return
      if (event.key === 'Escape' && busyRef.current) { event.preventDefault(); event.stopPropagation(); return }
      if (event.key !== 'Tab') return
      const items = focusableIn(root)
      if (!items.length) {
        event.preventDefault()
        event.stopPropagation()
        root.focus()
        return
      }
      const current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      const index = current ? items.indexOf(current) : -1
      const next = event.shiftKey ? (index <= 0 ? items.length - 1 : index - 1) : index === -1 || index >= items.length - 1 ? 0 : index + 1
      event.preventDefault()
      event.stopPropagation()
      items[next].focus()
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      if (!opener?.isConnected) return
      if (opener.closest('[inert]')) {
        dialogOpener.current = opener
        return
      }
      opener.focus()
    }
  }, [])
  return (
    <div
      className="bd"
      data-a="bd"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) dismiss()
      }}
    >
      <div className={`dlg ${wide ? 'lg' : ''} ${small ? 'sm' : ''}`} role="dialog" tabIndex={-1} aria-busy={busy || undefined} aria-modal="true" aria-labelledby={headingId} aria-describedby={sub ? descriptionId : undefined}>
        <header>
          <h2 id={headingId}>{title}</h2>
          <button className="ib" data-a="mclose" aria-label={t("关闭")} disabled={busy} onClick={dismiss}>
            <Icon name="x" />
          </button>
        </header>
        {sub ? <p id={descriptionId} className={`sub ${subClass || ''}`}>{sub}</p> : null}
        <div className="bdy" inert={busy ? true : undefined}>{children}</div>
        <footer inert={busy ? true : undefined}>{footer}</footer>
      </div>
    </div>
  )
}

export function ConfirmDialog({ title, body, ok, onOk, onClose, onSave }: { title: string; body: ReactNode; ok: string; onOk: () => void | Promise<void>; onClose: () => void; onSave?: () => void }) {
  const [busy, setBusy] = useState(false)
  const submitting = useRef(false)
  return (
    <Frame
      title={title}
      small
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <span className="grow" />
          <button className="btn ghost" data-a="mclose" data-autofocus onClick={onClose}>
            {t("取消")}</button>
          <button className="btn dangerf" data-a="confirm" disabled={busy} onClick={async () => { if (submitting.current) return; submitting.current = true; setBusy(true); try { await onOk() } finally { submitting.current = false; setBusy(false) } }}>
            {ok}
          </button>
          {onSave ? <button className="btn pri" data-a="save-close" onClick={onSave}>{t("保存并关闭")}</button> : null}
        </>
      }
    >
      <p style={{ color: 'var(--muted)' }}>{body}</p>
    </Frame>
  )
}

export function NewProjectDialog({
  hosts,
  settings,
  custom,
  installed,
  onClose,
  onCreate,
  onHosts,
  onToast
}: {
  hosts: Host[]
  settings: Settings
  custom: Executor[]
  installed: Record<string, boolean>
  onClose: () => void
  onCreate: (draft: { name: string; host: string; path: string; agent: string; branch: string }) => void
  onHosts: (hosts: Host[]) => Promise<void>
  onToast: (text: string, bad?: boolean) => void
}) {
  const [name, setName] = useState('')
  const [hostId, setHostId] = useState('local')
  const [dir, setDir] = useState('')
  const agents = [
    ...PRESETS.map((item) => ({ id: item.id, name: item.name, installed: !!installed[item.cmd] })),
    ...custom.map((item) => ({ id: item.id, name: item.name, installed: true })),
    { id: 'shell', name: t("仅 Shell"), installed: true }
  ]
  const [agent, setAgent] = useState(() => preferredAgent(settings.defAgent, agents))
  const [agentOpen, setAgentOpen] = useState(false)
  const [adding, setAdding] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [editingHost, setEditingHost] = useState<Host | null>(null)
  const [removingHost, setRemovingHost] = useState<Host | null>(null)
  const [hostName, setHostName] = useState('')
  const [hostAddr, setHostAddr] = useState('')
  const [hostPort, setHostPort] = useState('22')
  const [hostTint, setHostTint] = useState(() => nextHostColor(hosts))
  const hostRequest = useRef(0)
  useEffect(() => () => { hostRequest.current++ }, [])
  const [hostAuth, setHostAuth] = useState<Host['auth']>('key')
  const [hostPassword, setHostPassword] = useState('')
  const [check, setCheck] = useState<PathCheck>({ kind: 'empty' })
  const [browsing, setBrowsing] = useState(false)
  const host = hosts.find((item) => item.id === hostId) || hosts[0]
  function selectHost(id: string) { setBrowsing(false); setHostId(id) }

  useEffect(() => {
    const value = dir.trim()
    if (!value) {
      setCheck({ kind: 'empty' })
      return
    }
    let stop = false
    const timer = setTimeout(() => {
      void window.awb.checkPath(host.id, value).then((result) => {
        if (!stop) setCheck(result)
      })
    }, 180)
    return () => {
      stop = true
      clearTimeout(timer)
    }
  }, [dir, host.id])

  const ok = !!name.trim() && (check.kind === 'git' || check.kind === 'plain')
  const noneInstalled = agents.every((item) => item.id === 'shell' || !item.installed)
  const agentLabel = agents.find((item) => item.id === agent)?.name || t("仅 Shell")
  const agentMenu = useAnchoredMenu(agentOpen, () => setAgentOpen(false))

  if (editingHost) return <HostDialog hosts={hosts} initial={editingHost} onClose={() => setEditingHost(null)} onToast={onToast}
    onSave={async (next) => { await onHosts(hosts.map((item) => item.id === next.id ? next : item)); setEditingHost(null) }}
    onDelete={() => { setRemovingHost(editingHost); setEditingHost(null) }} />
  if (removingHost) return <Frame title={t("移除机器？")} onClose={() => setRemovingHost(null)} footer={<>
    <button className="btn" onClick={() => setRemovingHost(null)}>{t("取消")}</button>
    <button className="btn danger" data-a="confirm" onClick={async () => {
      try { await onHosts(hosts.filter((item) => item.id !== removingHost.id)); if (hostId === removingHost.id) selectHost('local'); setRemovingHost(null) }
      catch (error) { onToast(String(error), true) }
    }}>{t("移除")}</button></>}><p>{t("移除 ")}{removingHost.name} {t(" 后，使用这台机器的项目将无法打开终端。远程文件不会被删除。")}</p></Frame>
  return (
    <Frame
      title={t("新建项目")}
      onClose={onClose}
      footer={
        <>
          <span className="grow" />
          <button className="btn ghost" data-a="mclose" onClick={onClose}>
            {t("取消")}</button>
          <button
            className="btn pri"
            data-a="np-ok"
            disabled={!ok}
            onClick={() => onCreate({ name: name.trim(), host: host.id, path: dir.trim(), agent, branch: check.branch || '' })}
          >
            {t("创建项目")}</button>
        </>
      }
    >
      <label className="fld">
        <span>{t("名称")}</span>
        <input className="tx" data-np="name" data-autofocus value={name} placeholder={t("例如 orca")} onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="fld">
        <span>{t("机器")}</span>
        <div className="mlist" role="radiogroup" aria-label={t("机器")}>
          {hosts.map((item) => (
            <div
              key={item.id}
              className={`mopt ${hostId === item.id ? 'on' : ''}`}
              role="radio"
              tabIndex={0}
              onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if (item.on) selectHost(item.id) } }}
              aria-checked={hostId === item.id}
              data-a="nph"
              data-id={item.id}
              onClick={() => {
                if (!item.on) {
                  onToast(t("请先连接该机器"))
                  return
                }
                selectHost(item.id)
              }}
            >
              <span className="ic project-folder" data-color={hostColor(item.color)}>
                <Icon name={item.id === 'local' ? 'laptop' : 'server'} />
              </span>
              <span className="grow">
                <b>{hostDisplayName(item)}</b>
                <small>{hostLine(item)}</small>
              </span>
              {item.on ? null : (
                <>
                  <span className="tag">{t("未连接")}</span>
                  <button
                    className="btn sm"
                    data-a="hconnect"
                    data-id={item.id}
                    onClick={async (event) => {
                      event.stopPropagation()
                      try {
                        const result = await window.awb.testHost(item)
                        if (!result.ok) { onToast(result.error || t("连接失败"), true); return }
                        await onHosts(hosts.map((hostItem) => (hostItem.id === item.id ? { ...hostItem, on: true, os: result.os || hostItem.os, platform: result.platform || hostItem.platform } : hostItem)))
                        selectHost(item.id)
                        onToast(t("已连接 {{0}}", item.name))
                      } catch (error) { onToast(String(error), true) }
                    }}
                  >
                    {t("连接")}</button>
                </>
              )}
              <span className="radio" />
              {item.id !== 'local' ? <button className="btn sm" aria-label={t("编辑 {{0}}", item.name)} onClick={(event) => { event.stopPropagation(); setEditingHost(item) }}>{t("编辑")}</button> : null}
            </div>
          ))}
        </div>
        {adding ? (
          <div className="card" style={{ padding: 12, marginTop: 8 }}>
            <fieldset className="host-fields" disabled={connecting}>
            <div className="two">
              <label className="fld" style={{ margin: 0 }}>
                <span>{t("名称")}</span>
                <input className="tx" data-nh="name" placeholder="build-02" value={hostName} onChange={(e) => setHostName(e.target.value)} />
              </label>
              <label className="fld" style={{ margin: 0 }}>
                <span>{t("地址")}</span>
                <input className="tx mono" data-nh="addr" placeholder="user@host" value={hostAddr} onChange={(e) => setHostAddr(e.target.value)} />
              </label>
            </div>
            <label className="fld" style={{ marginTop: 12, marginBottom: 0 }}><span>{t("端口")}</span><input className="tx" aria-label={t("SSH 端口")} inputMode="numeric" value={hostPort} onChange={(event) => setHostPort(event.target.value)} /></label>
            <HostAuthentication host={{ auth: hostAuth, password: hostPassword }} onChange={(next) => {
              if (next.auth) setHostAuth(next.auth)
              if (next.password !== undefined) setHostPassword(next.password)
            }} />
            <HostColorPicker value={hostTint} hosts={hosts} onChange={setHostTint} />
            </fieldset>
            <div style={{ display: 'flex', gap: 8, marginTop: 12, justifyContent: 'flex-end' }}>
              <button className="btn sm ghost" data-a="np-addhost" onClick={() => { hostRequest.current++; setAdding(false); setConnecting(false) }}>
                {t("取消")}</button>
              <button
                className="btn sm"
                data-a="np-savehost"
                disabled={connecting || !hostName.trim() || !hostAddr.includes('@')}
                onClick={async () => {
                  const raw = hostAddr.trim(), at = raw.indexOf('@')
                  const user = raw.slice(0, at), addr = raw.slice(at + 1)
                  const port = Number(hostPort)
                  if (!user || !addr || !Number.isInteger(port) || port < 1 || port > 65535) { onToast(t("请填写 user@host 和 1 到 65535 的端口"), true); return }
                  const request = ++hostRequest.current
                  const next: Host = {
                    id: uid('h'),
                    name: hostName.trim(),
                    addr,
                    user,
                    os: 'Linux',
                    on: false,
                    port,
                    platform: 'linux',
                    auth: hostAuth,
                    color: hostTint,
                    ...(hostAuth === 'password' ? { password: hostPassword } : {})
                  }
                  setConnecting(true)
                  try {
                    const result = await window.awb.testHost(next)
                    if (request !== hostRequest.current) return
                    if (!result.ok) { onToast(result.error || t("连接失败，请检查地址和认证信息"), true); return }
                    const saved = { ...next, on: true, os: result.os || next.os, platform: result.platform || next.platform }
                    await onHosts([...hosts, saved])
                    selectHost(saved.id)
                    setAdding(false)
                    setHostPassword('')
                    onToast(t("已连接 {{0}}", saved.name))
                  } catch (error) { onToast(String(error), true) }
                  finally { if (request === hostRequest.current) setConnecting(false) }
                }}
              >
                {connecting ? t("正在连接…") : t("添加并连接")}
              </button>
            </div>
          </div>
        ) : (
          <button className="disc" data-a="np-addhost" style={{ margin: '4px 0 0' }} onClick={() => { setHostTint(nextHostColor(hosts)); setAdding(true) }}>
            <Icon name="plus" className="s" />
            {t("添加 SSH 机器")}</button>
        )}
      </div>
      <div className="fld">
        <span>{t("目录")}</span>
        <div className="inrow">
          <input className="tx mono" data-np="path" value={dir} placeholder={placeholder(host.platform)} onChange={(e) => setDir(e.target.value)} />
          <button
            className="btn"
            data-a="browse"
            onClick={async () => {
              if (host.id === 'local') {
                const picked = await window.awb.pickDirectory()
                if (!picked) return
                setDir(picked)
                if (!name.trim()) setName(baseName(picked))
                return
              }
              setBrowsing(true)
            }}
          >
            <Icon name="open" className="s" />
            {t("浏览")}</button>
        </div>
        <div id="pchk">
          {check.kind === 'git' ? (
            <small className="ok">
              <Icon name="branch" className="s" />
              {t("Git 仓库 · ")}{check.branch || 'HEAD'}
            </small>
          ) : null}
          {check.kind === 'plain' ? (
            <small>
              <Icon name="folder" className="s" />
              {t("目录可用 · 不是 Git 仓库（变更面板不可用）")}</small>
          ) : null}
          {check.kind === 'missing' ? <small className="bad">{t("目录不存在")}</small> : null}
          {check.kind === 'invalid' ? <small className="bad">{invalidPath(host.platform)}</small> : null}
          {check.kind === 'error' ? <small className="bad">{check.detail || t("无法检查目录")}</small> : null}
        </div>
        {browsing ? <DirectoryBrowser key={host.id} hostId={host.id} initialPath={dir.trim()} onClose={() => setBrowsing(false)} onSelect={(picked) => {
          setDir(picked)
          if (!name.trim()) setName(baseName(picked))
          setBrowsing(false)
        }} /> : null}
      </div>
      <div className="fld" style={{ margin: 0 }}>
        <span>{t("默认 Agent")}</span>
        <div className="agentpick">
          <button type="button" className="sel" data-np="agent" aria-label={t("默认 Agent")} aria-haspopup="listbox" aria-expanded={agentOpen} onClick={() => setAgentOpen((open) => !open)}
            onKeyDown={(event) => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setAgentOpen(true) } }}>
            {agentLabel}
          </button>
          {agentOpen ? (
            <div ref={agentMenu} className="selmenu" role="listbox" aria-label={t("默认 Agent")} popover="manual">
              {agents.map((item) => {
                const off = !item.installed
                return (
                  <button
                    type="button"
                    key={item.id}
                    role="option"
                    className={!off && agent === item.id ? 'on' : ''}
                    aria-selected={!off && agent === item.id}
                    aria-disabled={off || undefined}
                    data-np-opt={item.id}
                    onClick={() => {
                      if (off) return
                      setAgent(item.id)
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
        {noneInstalled ? <small>{t("未检测到已安装的 Agent CLI，可在 设置 › 执行器 中添加")}</small> : <small>{t("新建终端时预选，可随时更换。")}</small>}
      </div>
    </Frame>
  )
}

function shellOptions(platform: OsKind): { id: ShellKind; label: string }[] {
  if (platform === 'linux') return [{ id: 'bash', label: 'bash' }]
  return [
    { id: 'pwsh', label: 'PowerShell' },
    { id: 'cmd', label: 'CMD' }
  ]
}

function commandPreview(host: Host, shell: string, cwd: string, command: string): string {
  const remote = host.id === 'local' ? '' : `[${host.name}]: `
  const prompt = shell === 'cmd' ? `${cwd}>` : shell === 'bash' ? `${remote}${cwd}$` : `${remote}PS ${cwd}>`
  return `${prompt} ${command}`.trimEnd()
}

export function NewTermDialog({
  newSession = false,
  host,
  cwd,
  initialKind,
  initialShell,
  agents,
  onClose,
  onOpen,
  onManage
}: {
  newSession?: boolean
  host: Host
  cwd: string
  initialKind: string
  initialShell: ShellKind
  agents: AgentInfo[]
  onClose: () => void
  onOpen: (kind: string, shell: ShellKind) => void | Promise<void>
  onManage: () => void
}) {
  const local = useLocalShells(host.id === 'local')
  const options = host.id === 'local' ? local.shells : shellOptions(host.platform)
  const detecting = host.id === 'local' && local.loading
  const [kind, setKind] = useState(() => preferredAgent(initialKind, agents))
  const agentShell = (id: string) => {
    const agent = agents.find((item) => item.id === id)
    const pref = agent?.hosts?.[host.id]?.shell || agent?.shell
    if (!pref) return initialShell
    if (host.platform === 'linux') return pref === 'zsh' ? 'zsh' : 'bash'
    return pref === 'cmd' ? 'cmd' : host.id === 'local' && pref === 'bash' ? 'bash' : 'pwsh'
  }
  const [shell, setShell] = useState(() => agentShell(kind))
  const kindRef = useRef(kind)
  const shellRef = useRef(shell)
  const pickKind = (id: string) => {
    kindRef.current = id
    setKind(id)
    const nextShell = agentShell(id)
    shellRef.current = nextShell
    setShell(nextShell)
  }
  const pickShell = (id: ShellKind) => {
    shellRef.current = id
    setShell(id)
  }
  const agent = agents.find((item) => item.id === kind) || SHELL_AGENT
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submitting = useRef(false)
  const open = async () => {
    if (submitting.current || detecting || !options.some((item) => item.id === shellRef.current)) return
    submitting.current = true; setBusy(true); setError('')
    try { await onOpen(kindRef.current, shellRef.current) }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { submitting.current = false; setBusy(false) }
  }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Enter' && (event.target as HTMLElement).tagName !== 'BUTTON') {
        event.preventDefault()
        void open()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  return (
    <Frame
      title={newSession ? t("新建会话") : t("新建终端")}
      busy={busy}
      wide
      onClose={() => { if (!submitting.current) onClose() }}
      subClass="subline"
      sub={
        <>
          <Icon name={host.id === 'local' ? 'laptop' : 'server'} className="s" />
          <span className="grow">
            {hostDisplayName(host)} · <span className="mono">{cwd}</span>
          </span>
        </>
      }
      footer={
        <>
          <button className="btn ghost" data-a="settings-agents" onClick={onManage}>
            {t("管理执行器")}</button>
          <span className="grow" />
          <button className="btn ghost" data-a="mclose" onClick={onClose}>
            {t("取消")}</button>
          <button className="btn pri" data-a="nt-ok" disabled={busy || detecting || !options.some((item) => item.id === shell)} onClick={() => void open()}>
            {busy ? t("正在启动…") : newSession ? t("创建并启动") : t("打开")}
            <kbd className="enter">Enter</kbd>
          </button>
        </>
      }
    >
      <div className="picks" role="radiogroup" aria-label="Agent">
        {agents.map((item) => {
          const off = item.installed === false
          const on = !off && kind === item.id
          return (
          <button
            key={item.id}
            className={`pick ${on ? 'on' : ''}`}
            role="radio"
            aria-checked={on}
            aria-disabled={off || undefined}
            data-a="ntk"
            data-id={item.id}
            data-autofocus={on ? true : undefined}
            onMouseDown={(event) => {
              if (off) event.preventDefault()
            }}
            onClick={() => {
              if (off) return
              pickKind(item.id)
            }}
          >
            <Mark letter={item.id === 'shell' ? '>_ ' .trim() : item.letter} color={item.color} size="md" />
            <span style={{ minWidth: 0 }}>
              <span className="nm">{item.id === 'shell' ? t("仅 Shell") : item.name}</span>
              <span className="cm">{item.installed === false ? t("未找到命令") : item.cmd || t("无 Agent")}</span>
            </span>
          </button>
          )
        })}
      </div>
      {detecting ? <p role="status">{t("正在检测本机 Shell…")}</p> : options.length === 1 && options[0].id === shell ? (
        <div className="shellone">{t('Shell：')}{options[0].label}</div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16, marginTop: 16 }}>
          <div className="fld" style={{ margin: 0 }}>
            <span>Shell</span>
            <div className="seg" role="radiogroup" aria-label="Shell">
              {options.map((item) => (
                <button key={item.id} className={shell === item.id ? 'on' : ''} role="radio" aria-checked={shell === item.id} data-a="nts" data-id={item.id} onClick={() => pickShell(item.id)}>
                  {item.label}
                </button>
              ))}
            </div>
          </div>
          <span className="grow" />
        </div>
      )}
      {!detecting && host.id === 'local' && (local.error || !options.some((item) => item.id === shell)) ? <p className="file-error" role="alert">{local.error || t("未检测到 {{0}}，请选择可用 Shell。", shellLabel(shell))} <button type="button" className="btn sm ghost" onClick={local.refresh}>{t("重新检测")}</button></p> : null}
      <div className="fld" style={{ margin: '16px 0 0' }}>
        <span>{t("将执行")}</span>
        <div className="cmdpv">
          {commandPreview(host, shell, cwd, '').replace(/\s+$/, '')} <b>{cmdline(agent)}</b>
        </div>
      </div>
      {error ? <p className="file-error" role="alert">{error}</p> : null}
    </Frame>
  )
}

export function ExecDialog({
  initial,
  hostId,
  cwd,
  hosts,
  onClose,
  onSave,
  onDelete,
  onToast
}: {
  initial: Executor | null
  hostId?: string
  cwd: string
  hosts: Host[]
  onClose: () => void
  onSave: (exec: Executor) => Promise<void>
  onDelete: (id: string) => Promise<void>
  onToast: (text: string, bad?: boolean) => void
}) {
  const [draft, setDraft] = useState<Executor>(
    initial
      ? { ...initial, env: initial.env.map((item) => ({ ...item })) }
      : { id: '', name: '', cmd: '', args: '', shell: 'pwsh', env: [], letter: '', color: EXEC_COLORS[1] }
  )
  const [more, setMore] = useState(false)
  const [output, setOutput] = useState('')
  const [running, setRunning] = useState(false)
  const [scope, setScope] = useState(hostId === 'local' ? '' : hostId || '')
  const local = useLocalShells()
  const target = hosts.find((host) => host.id === (scope || 'local')) || hosts[0]
  const launch = executorForHost(draft, scope)
  const options = target?.id === 'local' ? local.shells : shellOptions(target?.platform || 'linux')
  const selectedShell = options.some((item) => item.id === launch.shell) ? launch.shell : options[0]?.id || launch.shell
  const patch = (partial: Partial<Executor>) => setDraft((prev) => ({ ...prev, ...partial }))
  const patchLaunch = (partial: Partial<Pick<Executor, 'cmd' | 'args' | 'shell'>>) => {
    if (!scope) { patch(partial); return }
    patch({ hosts: { ...draft.hosts, [scope]: { cmd: launch.cmd, args: launch.args, shell: selectedShell, ...partial } } })
  }
  return (
    <Frame
      title={draft.id ? t("编辑执行器") : t("添加执行器")}
      busy={running}
      onClose={onClose}
      footer={
        <>
          <button
            className="btn"
            data-a="ce-test"
            disabled={running || (target?.id === 'local' && local.loading) || !options.length}
            onClick={async () => {
              if (!launch.cmd.trim()) {
                setOutput(t("请先填写命令。"))
                return
              }
              setRunning(true)
              setOutput(t("正在启动…"))
              try {
                const result = await window.awb.testExec({ executorId: draft.id, cmd: launch.cmd, args: launch.args, shell: selectedShell, env: draft.env, cwd: target?.id === 'local' ? cwd : '', hostId: target?.id })
                const text = [result.text, result.running ? t("[启动观察结束 · 进程仍在运行，已停止测试；未验证服务连接]") : result.code === null ? t("[测试结束 · 已中断]") : t("[测试结束 · 退出码 {{0}}]", result.code)].filter(Boolean).join('\n')
                setOutput(text)
              } catch (err) {
                setOutput(err instanceof Error ? err.message : t("测试失败"))
              } finally {
                setRunning(false)
              }
            }}
          >
            <Icon name="play" className="s" />
            {t("测试启动")}</button>
          {draft.id ? (
            <button className="btn ghost" data-a="ce-del" disabled={running} style={{ color: 'var(--red)' }} onClick={async () => {
              setRunning(true)
              try { await onDelete(draft.id) } catch (error) { setOutput(String(error)) }
              finally { setRunning(false) }
            }}>
              {t("删除")}</button>
          ) : null}
          <span className="grow" />
          <button className="btn ghost" data-a="mclose" onClick={onClose}>
            {t("取消")}</button>
          <button
            className="btn pri"
            data-a="ce-save"
            disabled={running}
            onClick={async () => {
              if (!draft.name.trim() || !(draft.cmd.trim() || launch.cmd.trim())) {
                onToast(t("请填写名称和命令"))
                return
              }
              const letter = draft.letter.trim() || draft.name.trim()[0].toUpperCase()
              setRunning(true)
              try { await onSave({ ...draft, name: draft.name.trim(), cmd: draft.cmd.trim() || launch.cmd.trim(), letter }) }
              catch (error) { setOutput(String(error)); onToast(String(error), true) }
              finally { setRunning(false) }
            }}
          >
            {draft.id ? t("保存") : t("添加")}
          </button>
        </>
      }
    >
      <div className="custom-executor-form">
      <div className="two">
        <label className="fld">
          <span>{t("名称")}</span>
          <input className="tx" data-ce="name" value={draft.name} placeholder={t("例如 内部 Agent")} onChange={(e) => patch({ name: e.target.value })} />
        </label>
        <label className="fld"><span>{t("配置机器")}</span><select className="sel" data-ce="host" value={scope} onChange={(event) => { setScope(event.target.value); setOutput('') }}><option value="">{t("默认配置（本机测试）")}</option>{hosts.map((host) => <option key={host.id} value={host.id}>{hostDisplayName(host)}</option>)}</select></label>
      </div>
      <div className="fld">
        {scope ? <button className="btn sm ghost" disabled={!draft.hosts?.[scope]} onClick={() => { const next = { ...draft.hosts }; delete next[scope]; patch({ hosts: next }) }}>{t("使用默认配置")}</button> : null}
          <span>Shell</span>
          <div className="seg" role="radiogroup" aria-label="Shell">
            {options.map(({id, label}) => (
              <button key={id} className={selectedShell === id ? 'on' : ''} role="radio" aria-checked={selectedShell === id} data-a="ces" data-id={id} onClick={() => patchLaunch({ shell: id })}>
                {label}
              </button>
            ))}
          </div>
      </div>
      <div className="two">
        <label className="fld">
          <span>{t("命令")}</span>
          <input className="tx mono" data-ce="cmd" value={launch.cmd} placeholder="my-agent" onChange={(e) => patchLaunch({ cmd: e.target.value })} />
        </label>
        <label className="fld">
          <span>{t("参数")}</span>
          <input className="tx mono" data-ce="args" value={launch.args} placeholder="--interactive" onChange={(e) => patchLaunch({ args: e.target.value })} />
        </label>
      </div>
      <button className="disc" data-a="ce-more" aria-expanded={more} onClick={() => setMore((value) => !value)}>
        <Icon name="chev" className={`s chev${more ? ' open' : ''}`} />
        {t("标识与颜色")}
      </button>
      {more ? (
        <div style={{ margin: '-4px 0 16px 22px' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-end', marginTop: 12 }}>
            <label className="fld" style={{ margin: 0, width: 88 }}>
              <span>{t("标识")}</span>
              <input className="tx" maxLength={2} value={draft.letter} placeholder={t("自动")} onChange={(e) => patch({ letter: e.target.value })} />
            </label>
            <div className="fld" style={{ margin: 0 }}>
              <span>{t("颜色")}</span>
              <div className="sws">
                {EXEC_COLORS.map((color) => (
                  <button key={color} className={`sw ${draft.color === color ? 'on' : ''}`} style={{ background: color }} aria-label={t("颜色 {{0}}", color)} aria-pressed={draft.color === color} onClick={() => patch({ color })} />
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : null}
      <div className="fld" style={{ margin: 0 }}>
        <span>{t("测试输出")}</span>
        <div className="out" id="ceout">
          {output || <span className="c-d">{t("“测试启动”会在当前项目目录中运行一次，并显示原始输出。")}</span>}
        </div>
      </div>
      </div>
    </Frame>
  )
}

function HostAuthentication({ host, onChange }: {
  host: Pick<Host, 'auth' | 'password' | 'hasPassword'>
  onChange: (next: Partial<Host>) => void
}) {
  return <>
    <label className="fld" style={{ marginTop: 12, marginBottom: 0 }}>
      <span>{t("认证")}</span>
      <select className="sel" aria-label={t("认证方式")} value={host.auth} onChange={(event) => onChange({ auth: event.target.value as Host['auth'], on: false })}>
        <option value="key">{t("SSH 密钥（~/.ssh/id_ed25519）")}</option>
        <option value="agent">SSH Agent</option>
        <option value="password">{t("用户密码")}</option>
      </select>
    </label>
    {host.auth === 'password' ? <label className="fld" style={{ marginTop: 12, marginBottom: 0 }}>
      <span>{t("登录密码")}</span>
      <input className="tx" aria-label={t("登录密码")} type="password" autoComplete="new-password"
        value={host.password ?? ''} placeholder={host.hasPassword ? t("留空沿用已保存的密码") : t("远程用户的登录密码")}
        onChange={(event) => onChange({ password: event.target.value || (host.hasPassword ? undefined : ''), on: false })} />
    </label> : null}
  </>
}

export function HostDialog({
  initial,
  hosts = [],
  onClose,
  onSave,
  onDelete,
  onToast
}: {
  initial: Host | null
  hosts?: Host[]
  onClose: () => void
  onSave: (host: Host) => Promise<void>
  onDelete: (id: string) => void
  onToast: (text: string, bad?: boolean) => void
}) {
  const [draft, setDraft] = useState<Host>(
    initial ? { ...initial, color: hostColor(initial.color) } : { id: '', name: '', addr: '', user: '', os: 'Linux', on: false, port: 22, platform: 'linux', auth: 'key', color: nextHostColor(hosts) }
  )
  const patch = (partial: Partial<Host>) => setDraft((prev) => ({ ...prev, ...partial }))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  return (
    <Frame
      title={initial ? initial.name : t("添加机器")}
      busy={busy}
      sub={
        initial ? (
          <span className="tag">
            <span className={`dot ${draft.on ? 'running' : 'exited'}`} />
            {draft.on ? t("已连接") : t("未连接")}
          </span>
        ) : undefined
      }
      onClose={onClose}
      footer={
        <>
          {draft.id && draft.id !== 'local' ? (
            <button className="btn ghost" data-a="hdel" style={{ color: 'var(--red)' }} onClick={() => onDelete(draft.id)}>
              <Icon name="trash" className="s" />
              {t("移除")}</button>
          ) : null}
          <span className="grow" />
          {draft.id && draft.id !== 'local' ? (
            <button
              className="btn"
              data-a="hconn2"
              disabled={busy}
              onClick={async () => {
                if (draft.on) {
                  patch({ on: false })
                  onToast(t("已断开 {{0}}", draft.name || t("机器")))
                  return
                }
                const result = await window.awb.testHost(draft)
                if (!result.ok) {
                  onToast(result.error || t("连接失败"), true)
                  return
                }
                patch({ on: true, os: result.os || draft.os, platform: result.platform || draft.platform })
                onToast(t("已连接 {{0}}", draft.name || draft.addr))
              }}
            >
              {draft.on ? t("断开") : t("连接")}
            </button>
          ) : null}
          <button
            className="btn"
            data-a="htest"
            hidden={draft.id === 'local'}
            disabled={busy}
            onClick={async () => {
              const result = await window.awb.testHost(draft)
              if (!result.ok) onToast(result.error || t("连接失败"), true)
              else {
                patch({ os: result.os || draft.os, platform: result.platform || draft.platform, on: true })
                onToast(t("SSH 连接正常"))
              }
            }}
          >
            {t("测试连接")}</button>
          <button
            className="btn pri"
            data-a="hsave"
            disabled={busy}
            onClick={async () => {
              if (draft.id !== 'local' && (!draft.name.trim() || !draft.addr.trim() || !draft.user.trim())) {
                onToast(t("请填写名称、用户和地址"))
                return
              }
              if (!Number.isInteger(draft.port) || draft.port < 1 || draft.port > 65535) { setError(t("端口必须为 1 到 65535")); return }
              setBusy(true); setError('')
              try {
                const next = { ...draft, name: draft.name.trim(), addr: draft.addr.trim(), user: draft.user.trim() }
                if (draft.id === 'local') { await onSave(next); return }
                const changedConnection = !initial || ['addr', 'port', 'user', 'auth'].some((key) => initial[key as keyof Host] !== next[key as keyof Host]) || next.password !== undefined
                if (changedConnection || next.on) {
                  const result = await window.awb.testHost(next)
                  if (!mounted.current) return
                  if (!result.ok) { setError(result.error || t("连接失败，请检查地址和认证信息")); return }
                  await onSave({ ...next, on: true, os: result.os || next.os, platform: result.platform || next.platform })
                } else await onSave(next)
              } catch (reason) { setError(String(reason)) }
              finally { setBusy(false) }
            }}
          >
            {busy ? t("正在保存…") : initial ? t("保存") : t("连接并添加")}
          </button>
        </>
      }
    >
      <fieldset className="host-fields" disabled={busy}>
      <HostColorPicker value={hostColor(draft.color)} id={draft.id} hosts={hosts} onChange={(color) => patch({ color })} />
      {draft.id === 'local' ? <p className="host-local-description">{t("此环境的所有项目使用上方选择的文件夹颜色。")}</p> : <>
      <div className="two">
        <label className="fld">
          <span>{t("名称")}</span>
          <input className="tx" value={draft.name} placeholder="build-02" onChange={(e) => patch({ name: e.target.value })} />
        </label>
        <label className="fld">
          <span>{t("用户")}</span>
          <input className="tx mono" value={draft.user} placeholder="yang" onChange={(e) => patch({ user: e.target.value })} />
        </label>
      </div>
      <div className="two" style={{ gridTemplateColumns: '1fr 96px' }}>
        <label className="fld">
          <span>{t("地址")}</span>
          <input className="tx mono" value={draft.addr} placeholder="host.intranet" onChange={(e) => patch({ addr: e.target.value })} />
        </label>
        <label className="fld">
          <span>{t("端口")}</span>
          <input className="tx mono" aria-label={t("端口")} value={String(draft.port)} onChange={(e) => patch({ port: Number(e.target.value) || 22 })} />
        </label>
      </div>
      <HostAuthentication host={draft} onChange={patch} />
      </>}
      </fieldset>
      {error ? <p className="file-error" role="alert">{error}</p> : null}
    </Frame>
  )
}
