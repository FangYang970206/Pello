import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { AgentInfo, Executor, Host, OsKind, PathCheck, Settings, ShellKind } from '../shared/types'
import { EXEC_COLORS, PRESETS, SHELL_AGENT, cmdline, hostLine, preferredAgent, shellLabel, uid } from '../shared/types'
import { useAnchoredMenu } from './useAnchoredMenu'

export const dialogOpener: { current: HTMLElement | null } = { current: null }

export function focusableIn(root: ParentNode): HTMLElement[] {
  const nodes = root.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]')
  return [...nodes].filter((el) => {
    if (el.hasAttribute('disabled')) return false
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
  return platform === 'windows' ? '请输入 Windows 绝对路径，例如 C:\\dev\\app' : '请输入绝对路径，例如 /home/user/app'
}

function placeholder(platform: OsKind): string {
  return platform === 'windows' ? 'C:\\dev\\app' : '/home/user/app'
}

function baseName(value: string): string {
  const parts = value.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || value
}

function Frame({
  title,
  sub,
  subClass,
  wide,
  small,
  children,
  footer,
  onClose
}: {
  title: string
  sub?: ReactNode
  subClass?: string
  wide?: boolean
  small?: boolean
  children: ReactNode
  footer: ReactNode
  onClose: () => void
}) {
  const headingId = useId()
  const descriptionId = useId()
  useLayoutEffect(() => {
    const root = document.querySelector('#modal .dlg') as HTMLElement | null
    if (!root) return
    const opener = document.activeElement instanceof HTMLElement && !root.contains(document.activeElement) ? document.activeElement : null
    const first = root.querySelector<HTMLElement>('[data-autofocus], input:not([disabled]), .btn.pri')
    first?.focus()
    const onKey = (event: KeyboardEvent) => {
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
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className={`dlg ${wide ? 'lg' : ''} ${small ? 'sm' : ''}`} role="dialog" aria-modal="true" aria-labelledby={headingId} aria-describedby={sub ? descriptionId : undefined}>
        <header>
          <h2 id={headingId}>{title}</h2>
          <button className="ib" data-a="mclose" aria-label="关闭" onClick={onClose}>
            <Icon name="x" />
          </button>
        </header>
        {sub ? <p id={descriptionId} className={`sub ${subClass || ''}`}>{sub}</p> : null}
        <div className="bdy">{children}</div>
        <footer>{footer}</footer>
      </div>
    </div>
  )
}

export function ConfirmDialog({ title, body, ok, onOk, onClose, onSave }: { title: string; body: ReactNode; ok: string; onOk: () => void; onClose: () => void; onSave?: () => void }) {
  return (
    <Frame
      title={title}
      small
      onClose={onClose}
      footer={
        <>
          <span className="grow" />
          <button className="btn ghost" data-a="mclose" onClick={onClose}>
            取消
          </button>
          <button className="btn dangerf" data-a="confirm" onClick={onOk}>
            {ok}
          </button>
          {onSave ? <button className="btn pri" data-a="save-close" onClick={onSave}>保存并关闭</button> : null}
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
    { id: 'shell', name: '仅 Shell', installed: true }
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
  const hostRequest = useRef(0)
  useEffect(() => () => { hostRequest.current++ }, [])
  const [hostAuth, setHostAuth] = useState<Host['auth']>('key')
  const [hostPassword, setHostPassword] = useState('')
  const [check, setCheck] = useState<PathCheck>({ kind: 'empty' })
  const [browsing, setBrowsing] = useState(false)
  const [listing, setListing] = useState<{ path: string; parent: string | null; dirs: { name: string; path: string }[] } | null>(null)
  const host = hosts.find((item) => item.id === hostId) || hosts[0]

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
  const agentLabel = agents.find((item) => item.id === agent)?.name || '仅 Shell'
  const agentMenu = useAnchoredMenu(agentOpen, () => setAgentOpen(false))

  if (editingHost) return <HostDialog initial={editingHost} onClose={() => setEditingHost(null)} onToast={onToast}
    onSave={async (next) => { await onHosts(hosts.map((item) => item.id === next.id ? next : item)); setEditingHost(null) }}
    onDelete={() => { setRemovingHost(editingHost); setEditingHost(null) }} />
  if (removingHost) return <Frame title="移除机器？" onClose={() => setRemovingHost(null)} footer={<>
    <button className="btn" onClick={() => setRemovingHost(null)}>取消</button>
    <button className="btn danger" data-a="confirm" onClick={async () => {
      try { await onHosts(hosts.filter((item) => item.id !== removingHost.id)); if (hostId === removingHost.id) setHostId('local'); setRemovingHost(null) }
      catch (error) { onToast(String(error), true) }
    }}>移除</button></>}><p>移除 {removingHost.name} 后，使用这台机器的项目将无法打开终端。远程文件不会被删除。</p></Frame>
  return (
    <Frame
      title="新建项目"
      onClose={onClose}
      footer={
        <>
          <span className="grow" />
          <button className="btn ghost" data-a="mclose" onClick={onClose}>
            取消
          </button>
          <button
            className="btn pri"
            data-a="np-ok"
            disabled={!ok}
            onClick={() => onCreate({ name: name.trim(), host: host.id, path: dir.trim(), agent, branch: check.branch || '' })}
          >
            创建项目
          </button>
        </>
      }
    >
      <label className="fld">
        <span>名称</span>
        <input className="tx" data-np="name" data-autofocus value={name} placeholder="例如 orca" onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="fld">
        <span>机器</span>
        <div className="mlist" role="radiogroup" aria-label="机器">
          {hosts.map((item) => (
            <div
              key={item.id}
              className={`mopt ${hostId === item.id ? 'on' : ''}`}
              role="radio"
              tabIndex={0}
              onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if (item.on) setHostId(item.id) } }}
              aria-checked={hostId === item.id}
              data-a="nph"
              data-id={item.id}
              onClick={() => {
                if (!item.on) {
                  onToast('请先连接该机器')
                  return
                }
                setHostId(item.id)
              }}
            >
              <span className="ic">
                <Icon name={item.id === 'local' ? 'laptop' : 'server'} />
              </span>
              <span className="grow">
                <b>{item.name}</b>
                <small>{hostLine(item)}</small>
              </span>
              {item.on ? null : (
                <>
                  <span className="tag">未连接</span>
                  <button
                    className="btn sm"
                    data-a="hconnect"
                    data-id={item.id}
                    onClick={async (event) => {
                      event.stopPropagation()
                      try {
                        const result = await window.awb.testHost(item)
                        if (!result.ok) { onToast(result.error || '连接失败', true); return }
                        await onHosts(hosts.map((hostItem) => (hostItem.id === item.id ? { ...hostItem, on: true, os: result.os || hostItem.os, platform: result.platform || hostItem.platform } : hostItem)))
                        setHostId(item.id)
                        onToast(`已连接 ${item.name}`)
                      } catch (error) { onToast(String(error), true) }
                    }}
                  >
                    连接
                  </button>
                </>
              )}
              <span className="radio" />
              {item.id !== 'local' ? <button className="btn sm" aria-label={`编辑 ${item.name}`} onClick={(event) => { event.stopPropagation(); setEditingHost(item) }}>编辑</button> : null}
            </div>
          ))}
        </div>
        {adding ? (
          <div className="card" style={{ padding: 12, marginTop: 8 }}>
            <fieldset className="host-fields" disabled={connecting}>
            <div className="two">
              <label className="fld" style={{ margin: 0 }}>
                <span>名称</span>
                <input className="tx" data-nh="name" placeholder="build-02" value={hostName} onChange={(e) => setHostName(e.target.value)} />
              </label>
              <label className="fld" style={{ margin: 0 }}>
                <span>地址</span>
                <input className="tx mono" data-nh="addr" placeholder="user@host" value={hostAddr} onChange={(e) => setHostAddr(e.target.value)} />
              </label>
            </div>
            <label className="fld" style={{ marginTop: 12, marginBottom: 0 }}><span>端口</span><input className="tx" aria-label="SSH 端口" inputMode="numeric" value={hostPort} onChange={(event) => setHostPort(event.target.value)} /></label>
            <HostAuthentication host={{ auth: hostAuth, password: hostPassword }} onChange={(next) => {
              if (next.auth) setHostAuth(next.auth)
              if (next.password !== undefined) setHostPassword(next.password)
            }} />
            </fieldset>
            <div style={{ display: 'flex', gap: 8, marginTop: 12, justifyContent: 'flex-end' }}>
              <button className="btn sm ghost" data-a="np-addhost" onClick={() => { hostRequest.current++; setAdding(false); setConnecting(false) }}>
                取消
              </button>
              <button
                className="btn sm"
                data-a="np-savehost"
                disabled={connecting || !hostName.trim() || !hostAddr.includes('@')}
                onClick={async () => {
                  const raw = hostAddr.trim(), at = raw.indexOf('@')
                  const user = raw.slice(0, at), addr = raw.slice(at + 1)
                  const port = Number(hostPort)
                  if (!user || !addr || !Number.isInteger(port) || port < 1 || port > 65535) { onToast('请填写 user@host 和 1 到 65535 的端口', true); return }
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
                    ...(hostAuth === 'password' ? { password: hostPassword } : {})
                  }
                  setConnecting(true)
                  try {
                    const result = await window.awb.testHost(next)
                    if (request !== hostRequest.current) return
                    if (!result.ok) { onToast(result.error || '连接失败，请检查地址和认证信息', true); return }
                    const saved = { ...next, on: true, os: result.os || next.os, platform: result.platform || next.platform }
                    await onHosts([...hosts, saved])
                    setHostId(saved.id)
                    setAdding(false)
                    setHostPassword('')
                    onToast(`已连接 ${saved.name}`)
                  } catch (error) { onToast(String(error), true) }
                  finally { if (request === hostRequest.current) setConnecting(false) }
                }}
              >
                {connecting ? '正在连接…' : '添加并连接'}
              </button>
            </div>
          </div>
        ) : (
          <button className="disc" data-a="np-addhost" style={{ margin: '4px 0 0' }} onClick={() => setAdding(true)}>
            <Icon name="plus" className="s" />
            添加 SSH 机器
          </button>
        )}
      </div>
      <div className="fld">
        <span>目录</span>
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
              const list = await window.awb.listDir(host.id, dir.trim())
              setListing(list)
              setBrowsing(true)
            }}
          >
            <Icon name="open" className="s" />
            浏览
          </button>
        </div>
        <div id="pchk">
          {check.kind === 'git' ? (
            <small className="ok">
              <Icon name="branch" className="s" />
              Git 仓库 · {check.branch || 'HEAD'}
            </small>
          ) : null}
          {check.kind === 'plain' ? (
            <small>
              <Icon name="folder" className="s" />
              目录可用 · 不是 Git 仓库（变更面板不可用）
            </small>
          ) : null}
          {check.kind === 'missing' ? <small className="bad">目录不存在</small> : null}
          {check.kind === 'invalid' ? <small className="bad">{invalidPath(host.platform)}</small> : null}
          {check.kind === 'error' ? <small className="bad">{check.detail || '无法检查目录'}</small> : null}
        </div>
        {browsing && listing ? (
          <div className="mlist browse">
            {listing.parent ? (
              <button
                className="mopt"
                onClick={async () => {
                  const next = await window.awb.listDir(host.id, listing.parent || '/')
                  setListing(next)
                }}
              >
                <span className="grow">..</span>
              </button>
            ) : null}
            <button
              className="mopt"
              onClick={() => {
                setDir(listing.path)
                if (!name.trim()) setName(baseName(listing.path))
                setBrowsing(false)
              }}
            >
              <span className="grow">选择 {listing.path}</span>
            </button>
            {listing.dirs.map((entry) => (
              <button
                key={entry.path}
                className="mopt"
                onClick={async () => {
                  const next = await window.awb.listDir(host.id, entry.path)
                  setListing(next)
                }}
              >
                <Icon name="folder" className="s" />
                <span className="grow">{entry.name}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <div className="fld" style={{ margin: 0 }}>
        <span>默认 Agent</span>
        <div className="agentpick">
          <button type="button" className="sel" data-np="agent" aria-label="默认 Agent" aria-haspopup="listbox" aria-expanded={agentOpen} onClick={() => setAgentOpen((open) => !open)}
            onKeyDown={(event) => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setAgentOpen(true) } }}>
            {agentLabel}
          </button>
          {agentOpen ? (
            <div ref={agentMenu} className="selmenu" role="listbox" aria-label="默认 Agent" popover="manual">
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
                    {off ? '（未找到命令）' : ''}
                  </button>
                )
              })}
            </div>
          ) : null}
        </div>
        {noneInstalled ? <small>未检测到已安装的 Agent CLI，可在 设置 › 执行器 中添加</small> : <small>新建终端时预选，可随时更换。</small>}
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
  host,
  cwd,
  initialKind,
  initialShell,
  agents,
  onClose,
  onOpen,
  onManage
}: {
  host: Host
  cwd: string
  initialKind: string
  initialShell: ShellKind
  agents: AgentInfo[]
  onClose: () => void
  onOpen: (kind: string, shell: ShellKind) => void
  onManage: () => void
}) {
  const options = shellOptions(host.platform)
  const [kind, setKind] = useState(() => preferredAgent(initialKind, agents))
  const [shell, setShell] = useState(options.some((item) => item.id === initialShell) ? initialShell : options[0].id)
  const kindRef = useRef(kind)
  const shellRef = useRef(shell)
  const pickKind = (id: string) => {
    kindRef.current = id
    setKind(id)
  }
  const pickShell = (id: ShellKind) => {
    shellRef.current = id
    setShell(id)
  }
  const agent = agents.find((item) => item.id === kind) || SHELL_AGENT
  const open = () => onOpen(kindRef.current, shellRef.current)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Enter' && (event.target as HTMLElement).tagName !== 'BUTTON') {
        event.preventDefault()
        open()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  return (
    <Frame
      title="新建终端"
      wide
      onClose={onClose}
      subClass="subline"
      sub={
        <>
          <Icon name={host.id === 'local' ? 'laptop' : 'server'} className="s" />
          <span className="grow">
            {host.name} · <span className="mono">{cwd}</span>
          </span>
        </>
      }
      footer={
        <>
          <button className="btn ghost" data-a="settings-agents" onClick={onManage}>
            管理执行器
          </button>
          <span className="grow" />
          <button className="btn ghost" data-a="mclose" onClick={onClose}>
            取消
          </button>
          <button className="btn pri" data-a="nt-ok" onClick={open}>
            打开
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
              <span className="nm">{item.id === 'shell' ? '仅 Shell' : item.name}</span>
              <span className="cm">{item.installed === false ? '未找到命令' : item.cmd || '无 Agent'}</span>
            </span>
          </button>
          )
        })}
      </div>
      {options.length < 2 ? (
        <div className="shellone">Shell：{options[0]?.label || 'bash'}</div>
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
      <div className="fld" style={{ margin: '16px 0 0' }}>
        <span>将执行</span>
        <div className="cmdpv">
          {commandPreview(host, shell, cwd, '').replace(/\s+$/, '')} <b>{cmdline(agent)}</b>
        </div>
      </div>
    </Frame>
  )
}

export function ExecDialog({
  initial,
  cwd,
  onClose,
  onSave,
  onDelete,
  onToast
}: {
  initial: Executor | null
  cwd: string
  onClose: () => void
  onSave: (exec: Executor) => Promise<void>
  onDelete: (id: string) => void
  onToast: (text: string, bad?: boolean) => void
}) {
  const [draft, setDraft] = useState<Executor>(
    initial
      ? { ...initial, env: initial.env.map((item) => ({ ...item })) }
      : { id: '', name: '', cmd: '', args: '', shell: 'pwsh', env: [], letter: '', color: EXEC_COLORS[1] }
  )
  const [more, setMore] = useState(!!initial?.env.length)
  const [output, setOutput] = useState('')
  const [running, setRunning] = useState(false)
  const patch = (partial: Partial<Executor>) => setDraft((prev) => ({ ...prev, ...partial }))
  const resourcePaths = draft.resources || { mcpPath: '', skillPath: '', format: 'standard' as const, skillAdapter: 'portable' as const, skillConfigPath: '' }
  const resourcePatch = (partial: Partial<typeof resourcePaths>) => patch({ resources: { ...resourcePaths, ...partial } })
  useEffect(() => {
    if (!initial?.id || initial.resources) return
    let stopped = false
    void window.awb.resourceTargets().then((targets) => {
      const target = targets.find((item) => item.id === initial.id)
      if (!stopped && target) setDraft((value) => ({ ...value, resources: value.resources || target }))
    }).catch(() => {})
    return () => { stopped = true }
  }, [initial])
  return (
    <Frame
      title={draft.id ? '编辑执行器' : '添加执行器'}
      onClose={onClose}
      footer={
        <>
          <button
            className="btn"
            data-a="ce-test"
            disabled={running}
            onClick={async () => {
              if (!draft.cmd.trim()) {
                setOutput('请先填写命令。')
                return
              }
              setRunning(true)
              setOutput('正在启动…')
              try {
                const result = await window.awb.testExec({ cmd: draft.cmd, args: draft.args, shell: draft.shell, env: draft.env, cwd })
                const envLine = draft.env.filter((item) => item.k).map((item) => `${item.k}=${item.secret ? '********' : item.v}`).join('  ')
                const text = [envLine ? `env: ${envLine}` : '', result.text, result.code === null ? '[测试结束 · 已中断]' : `[测试结束 · 退出码 ${result.code}]`].filter(Boolean).join('\n')
                setOutput(text)
              } catch (err) {
                setOutput(err instanceof Error ? err.message : '测试失败')
              } finally {
                setRunning(false)
              }
            }}
          >
            <Icon name="play" className="s" />
            测试启动
          </button>
          {draft.id ? (
            <button className="btn ghost" data-a="ce-del" style={{ color: 'var(--red)' }} onClick={() => onDelete(draft.id)}>
              删除
            </button>
          ) : null}
          <span className="grow" />
          <button className="btn ghost" data-a="mclose" onClick={onClose}>
            取消
          </button>
          <button
            className="btn pri"
            data-a="ce-save"
            disabled={running}
            onClick={async () => {
              if (!draft.name.trim() || !draft.cmd.trim()) {
                onToast('请填写名称和命令')
                return
              }
              const letter = draft.letter.trim() || draft.name.trim()[0].toUpperCase()
              setRunning(true)
              try { await onSave({ ...draft, name: draft.name.trim(), cmd: draft.cmd.trim(), letter, env: draft.env.filter((item) => item.k) }) }
              catch (error) { setOutput(String(error)); onToast(String(error), true) }
              finally { setRunning(false) }
            }}
          >
            {draft.id ? '保存' : '添加'}
          </button>
        </>
      }
    >
      <div className="two" style={{ gridTemplateColumns: '1fr auto' }}>
        <label className="fld">
          <span>名称</span>
          <input className="tx" data-ce="name" value={draft.name} placeholder="例如 内部 Agent" onChange={(e) => patch({ name: e.target.value })} />
        </label>
        <div className="fld">
          <span>Shell</span>
          <div className="seg" role="radiogroup" aria-label="Shell">
            {(['pwsh', 'cmd'] as const).map((id) => (
              <button key={id} className={draft.shell === id ? 'on' : ''} role="radio" aria-checked={draft.shell === id} data-a="ces" data-id={id} onClick={() => patch({ shell: id })}>
                {shellLabel(id)}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="two">
        <label className="fld">
          <span>命令</span>
          <input className="tx mono" data-ce="cmd" value={draft.cmd} placeholder="my-agent" onChange={(e) => patch({ cmd: e.target.value })} />
        </label>
        <label className="fld">
          <span>参数</span>
          <input className="tx mono" data-ce="args" value={draft.args} placeholder="--interactive" onChange={(e) => patch({ args: e.target.value })} />
        </label>
      </div>
      <button className="disc" data-a="ce-more" aria-expanded={more} onClick={() => setMore((value) => !value)}>
        <Icon name="chev" className={`s chev${more ? ' open' : ''}`} />
        高级属性
        {draft.env.length ? <span className="tag">{draft.env.length}</span> : null}
      </button>
      {more ? (
        <div style={{ margin: '-4px 0 16px 22px' }}>
          <div className="executor-resources">
            <label className="fld"><span>Skill 存放目录</span><input className="tx mono" aria-label="Skill 存放目录" value={resourcePaths.skillPath} placeholder="Skill 目录的绝对路径" onChange={(event) => resourcePatch({ skillPath: event.target.value })} /></label>
            <label className="fld"><span>MCP 配置文件</span><input className="tx mono" aria-label="MCP 配置文件" value={resourcePaths.mcpPath} placeholder="JSON、JSONC 或 TOML 文件的绝对路径" onChange={(event) => resourcePatch({ mcpPath: event.target.value })} /></label>
            <div className="two"><label className="fld"><span>MCP 格式</span><select className="sel" aria-label="MCP 格式" value={resourcePaths.format} onChange={(event) => resourcePatch({ format: event.target.value as typeof resourcePaths.format })}><option value="standard">JSON · mcpServers</option><option value="codex">TOML · mcp_servers</option><option value="opencode">JSONC · mcp</option></select></label>
            <label className="fld"><span>Skill 管理方式</span><select className="sel" aria-label="Skill 管理方式" value={resourcePaths.skillAdapter || 'portable'} onChange={(event) => resourcePatch({ skillAdapter: event.target.value as typeof resourcePaths.skillAdapter })}>{['portable', 'claude', 'codex', 'opencode', 'pi'].map((adapter) => <option key={adapter} value={adapter}>{adapter === 'portable' ? '通用 · 文件开关' : adapter}</option>)}</select></label></div>
            <label className="fld"><span>Skill 配置文件（可选）</span><input className="tx mono" aria-label="Skill 配置文件" value={resourcePaths.skillConfigPath || ''} onChange={(event) => resourcePatch({ skillConfigPath: event.target.value })} /></label>
            <p className="resource-help">选择执行器支持的原生格式。通用开关会保留文件，并切换 SKILL.md 的文件名；独立目录可避免影响其他执行器。</p>
          </div>
          {draft.env.map((item, index) => (
            <div className="env" key={index}>
              <input
                className="tx mono"
                value={item.k}
                placeholder="KEY"
                aria-label="变量名"
                onChange={(e) => patch({ env: draft.env.map((env, i) => (i === index ? { ...env, k: e.target.value } : env)) })}
              />
              <input
                className="tx mono"
                type={item.secret ? 'password' : 'text'}
                value={item.v}
                placeholder="value"
                aria-label="变量值"
                onChange={(e) => patch({ env: draft.env.map((env, i) => (i === index ? { ...env, v: e.target.value } : env)) })}
              />
              <button
                className={`ib ${item.secret ? 'on' : ''}`}
                aria-pressed={item.secret}
                title={item.secret ? '密钥（已隐藏）' : '设为密钥'}
                aria-label="设为密钥"
                onClick={() => patch({ env: draft.env.map((env, i) => (i === index ? { ...env, secret: !env.secret } : env)) })}
              >
                <Icon name="eye" className="s" />
              </button>
              <button className="ib" aria-label="删除变量" onClick={() => patch({ env: draft.env.filter((_, i) => i !== index) })}>
                <Icon name="x" className="s" />
              </button>
            </div>
          ))}
          <button className="btn sm ghost" data-a="env-add" style={{ marginLeft: -10 }} onClick={() => patch({ env: [...draft.env, { k: '', v: '', secret: false }] })}>
            <Icon name="plus" className="s" />
            添加变量
          </button>
          <div style={{ display: 'flex', gap: 16, alignItems: 'flex-end', marginTop: 12 }}>
            <label className="fld" style={{ margin: 0, width: 88 }}>
              <span>标识</span>
              <input className="tx" maxLength={2} value={draft.letter} placeholder="自动" onChange={(e) => patch({ letter: e.target.value })} />
            </label>
            <div className="fld" style={{ margin: 0 }}>
              <span>颜色</span>
              <div className="sws">
                {EXEC_COLORS.map((color) => (
                  <button key={color} className={`sw ${draft.color === color ? 'on' : ''}`} style={{ background: color }} aria-label={`颜色 ${color}`} aria-pressed={draft.color === color} onClick={() => patch({ color })} />
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : null}
      <div className="fld" style={{ margin: 0 }}>
        <span>测试输出</span>
        <div className="out" id="ceout">
          {output || <span className="c-d">“测试启动”会在当前项目目录中运行一次，并显示原始输出。</span>}
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
      <span>认证</span>
      <select className="sel" aria-label="认证方式" value={host.auth} onChange={(event) => onChange({ auth: event.target.value as Host['auth'], on: false })}>
        <option value="key">SSH 密钥（~/.ssh/id_ed25519）</option>
        <option value="agent">SSH Agent</option>
        <option value="password">用户密码</option>
      </select>
    </label>
    {host.auth === 'password' ? <label className="fld" style={{ marginTop: 12, marginBottom: 0 }}>
      <span>登录密码</span>
      <input className="tx" aria-label="登录密码" type="password" autoComplete="new-password"
        value={host.password ?? ''} placeholder={host.hasPassword ? '留空沿用已保存的密码' : '远程用户的登录密码'}
        onChange={(event) => onChange({ password: event.target.value || (host.hasPassword ? undefined : ''), on: false })} />
    </label> : null}
  </>
}

export function HostDialog({
  initial,
  onClose,
  onSave,
  onDelete,
  onToast
}: {
  initial: Host | null
  onClose: () => void
  onSave: (host: Host) => Promise<void>
  onDelete: (id: string) => void
  onToast: (text: string, bad?: boolean) => void
}) {
  const [draft, setDraft] = useState<Host>(
    initial || { id: '', name: '', addr: '', user: '', os: 'Linux', on: false, port: 22, platform: 'linux', auth: 'key' }
  )
  const patch = (partial: Partial<Host>) => setDraft((prev) => ({ ...prev, ...partial }))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  return (
    <Frame
      title={initial ? initial.name : '添加机器'}
      sub={
        initial ? (
          <span className="tag">
            <span className={`dot ${draft.on ? 'running' : 'exited'}`} />
            {draft.on ? '已连接' : '未连接'}
          </span>
        ) : undefined
      }
      onClose={onClose}
      footer={
        <>
          {draft.id ? (
            <button className="btn ghost" data-a="hdel" style={{ color: 'var(--red)' }} onClick={() => onDelete(draft.id)}>
              <Icon name="trash" className="s" />
              移除
            </button>
          ) : null}
          <span className="grow" />
          {draft.id ? (
            <button
              className="btn"
              data-a="hconn2"
              disabled={busy}
              onClick={async () => {
                if (draft.on) {
                  patch({ on: false })
                  onToast(`已断开 ${draft.name || '机器'}`)
                  return
                }
                const result = await window.awb.testHost(draft)
                if (!result.ok) {
                  onToast(result.error || '连接失败', true)
                  return
                }
                patch({ on: true, os: result.os || draft.os, platform: result.platform || draft.platform })
                onToast(`已连接 ${draft.name || draft.addr}`)
              }}
            >
              {draft.on ? '断开' : '连接'}
            </button>
          ) : null}
          <button
            className="btn"
            data-a="htest"
            disabled={busy}
            onClick={async () => {
              const result = await window.awb.testHost(draft)
              if (!result.ok) onToast(result.error || '连接失败', true)
              else {
                patch({ os: result.os || draft.os, platform: result.platform || draft.platform, on: true })
                onToast('SSH 连接正常')
              }
            }}
          >
            测试连接
          </button>
          <button
            className="btn pri"
            data-a="hsave"
            disabled={busy}
            onClick={async () => {
              if (!draft.name.trim() || !draft.addr.trim() || !draft.user.trim()) {
                onToast('请填写名称、用户和地址')
                return
              }
              if (!Number.isInteger(draft.port) || draft.port < 1 || draft.port > 65535) { setError('端口必须为 1 到 65535'); return }
              setBusy(true); setError('')
              try {
                const next = { ...draft, name: draft.name.trim(), addr: draft.addr.trim(), user: draft.user.trim() }
                const changedConnection = !initial || ['addr', 'port', 'user', 'auth'].some((key) => initial[key as keyof Host] !== next[key as keyof Host]) || next.password !== undefined
                if (changedConnection || next.on) {
                  const result = await window.awb.testHost(next)
                  if (!mounted.current) return
                  if (!result.ok) { setError(result.error || '连接失败，请检查地址和认证信息'); return }
                  await onSave({ ...next, on: true, os: result.os || next.os, platform: result.platform || next.platform })
                } else await onSave(next)
              } catch (reason) { setError(String(reason)) }
              finally { setBusy(false) }
            }}
          >
            {busy ? '正在保存…' : initial ? '保存' : '连接并添加'}
          </button>
        </>
      }
    >
      <fieldset className="host-fields" disabled={busy}>
      <div className="two">
        <label className="fld">
          <span>名称</span>
          <input className="tx" value={draft.name} placeholder="build-02" onChange={(e) => patch({ name: e.target.value })} />
        </label>
        <label className="fld">
          <span>用户</span>
          <input className="tx mono" value={draft.user} placeholder="yang" onChange={(e) => patch({ user: e.target.value })} />
        </label>
      </div>
      <div className="two" style={{ gridTemplateColumns: '1fr 96px' }}>
        <label className="fld">
          <span>地址</span>
          <input className="tx mono" value={draft.addr} placeholder="host.intranet" onChange={(e) => patch({ addr: e.target.value })} />
        </label>
        <label className="fld">
          <span>端口</span>
          <input className="tx mono" aria-label="端口" value={String(draft.port)} onChange={(e) => patch({ port: Number(e.target.value) || 22 })} />
        </label>
      </div>
      <HostAuthentication host={draft} onChange={patch} />
      </fieldset>
      {error ? <p className="file-error" role="alert">{error}</p> : null}
    </Frame>
  )
}
