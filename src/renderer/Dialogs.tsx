import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { AgentInfo, Executor, Host, OsKind, PathCheck, Settings, ShellKind } from '../shared/types'
import { EXEC_COLORS, PRESETS, SHELL_AGENT, cmdline, hostLine, preferredAgent, shellLabel, uid } from '../shared/types'

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
      <div className={`dlg ${wide ? 'lg' : ''} ${small ? 'sm' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header>
          <h2>{title}</h2>
          <button className="ib" data-a="mclose" aria-label="关闭" onClick={onClose}>
            <Icon name="x" />
          </button>
        </header>
        {sub ? <p className={`sub ${subClass || ''}`}>{sub}</p> : null}
        <div className="bdy">{children}</div>
        <footer>{footer}</footer>
      </div>
    </div>
  )
}

export function ConfirmDialog({ title, body, ok, onOk, onClose }: { title: string; body: ReactNode; ok: string; onOk: () => void; onClose: () => void }) {
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
  onHosts: (hosts: Host[]) => void
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
  const [hostName, setHostName] = useState('')
  const [hostAddr, setHostAddr] = useState('')
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
  useEffect(() => {
    const node = document.querySelector('#modal .dlg')
    node?.classList.toggle('menuopen', agentOpen)
    return () => node?.classList.remove('menuopen')
  }, [agentOpen])

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
                      const result = await window.awb.testHost(item)
                      if (!result.ok) {
                        onToast(result.error || '连接失败', true)
                        return
                      }
                      onHosts(hosts.map((hostItem) => (hostItem.id === item.id ? { ...hostItem, on: true, os: result.os || hostItem.os, platform: result.platform || hostItem.platform } : hostItem)))
                      setHostId(item.id)
                      onToast(`已连接 ${item.name}`)
                    }}
                  >
                    连接
                  </button>
                </>
              )}
              <span className="radio" />
            </div>
          ))}
        </div>
        {adding ? (
          <div className="card" style={{ padding: 12, marginTop: 8 }}>
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
            <div style={{ display: 'flex', gap: 8, marginTop: 12, justifyContent: 'flex-end' }}>
              <button className="btn sm ghost" data-a="np-addhost" onClick={() => setAdding(false)}>
                取消
              </button>
              <button
                className="btn sm"
                data-a="np-savehost"
                onClick={async () => {
                  const raw = hostAddr.trim() || 'yang@build-02'
                  const user = raw.includes('@') ? raw.split('@')[0] : 'yang'
                  const addr = raw.includes('@') ? raw.split('@').slice(1).join('@') : raw
                  const next: Host = {
                    id: uid('h'),
                    name: hostName.trim() || 'build-02',
                    addr,
                    user,
                    os: 'Linux',
                    on: false,
                    port: 22,
                    platform: 'linux',
                    auth: 'key'
                  }
                  const result = await window.awb.testHost(next)
                  const saved = result.ok ? { ...next, on: true, os: result.os || next.os, platform: result.platform || next.platform } : next
                  onHosts([...hosts, saved])
                  if (saved.on) setHostId(saved.id)
                  setAdding(false)
                  onToast(saved.on ? `已连接 ${saved.name}` : result.error || '未能连接', !saved.on)
                }}
              >
                添加并连接
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
          <button type="button" className="sel" data-np="agent" aria-haspopup="listbox" aria-expanded={agentOpen} onClick={() => setAgentOpen((open) => !open)}>
            {agentLabel}
          </button>
          {agentOpen ? (
            <div className="selmenu" role="listbox" aria-label="默认 Agent">
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
  onSave: (exec: Executor) => void
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
            onClick={() => {
              if (!draft.name.trim() || !draft.cmd.trim()) {
                onToast('请填写名称和命令')
                return
              }
              const letter = draft.letter.trim() || draft.name.trim()[0].toUpperCase()
              onSave({ ...draft, name: draft.name.trim(), cmd: draft.cmd.trim(), letter, env: draft.env.filter((item) => item.k) })
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
        环境变量与外观
        {draft.env.length ? <span className="tag">{draft.env.length}</span> : null}
      </button>
      {more ? (
        <div style={{ margin: '-4px 0 16px 22px' }}>
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

export function HostDialog({
  initial,
  onClose,
  onSave,
  onDelete,
  onToast
}: {
  initial: Host | null
  onClose: () => void
  onSave: (host: Host) => void
  onDelete: (id: string) => void
  onToast: (text: string, bad?: boolean) => void
}) {
  const [draft, setDraft] = useState<Host>(
    initial || { id: '', name: '', addr: '', user: '', os: 'Linux', on: false, port: 22, platform: 'linux', auth: 'key' }
  )
  const patch = (partial: Partial<Host>) => setDraft((prev) => ({ ...prev, ...partial }))
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
            onClick={() => {
              if (!draft.name.trim() || !draft.addr.trim() || !draft.user.trim()) {
                onToast('请填写名称、用户和地址')
                return
              }
              onSave({ ...draft, name: draft.name.trim(), addr: draft.addr.trim(), user: draft.user.trim(), port: Number(draft.port) || 22 })
            }}
          >
            {initial ? '保存' : '添加'}
          </button>
        </>
      }
    >
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
      <label className="fld" style={{ margin: 0 }}>
        <span>认证</span>
        <select className="sel" value={draft.auth} onChange={(e) => patch({ auth: e.target.value === 'agent' ? 'agent' : 'key' })}>
          <option value="key">SSH 密钥（~/.ssh/id_ed25519）</option>
          <option value="agent">SSH Agent</option>
        </select>
      </label>
    </Frame>
  )
}
