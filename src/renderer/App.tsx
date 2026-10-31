import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { AgentInfo, Database, FileDiff, GitPanel, Host, SettingsSection, ShellKind, ThemeName, TreeNode } from '../shared/types'
import { PRESETS, SHELL_AGENT, cmdline, resolveAgent, shellLabel, uid } from '../shared/types'
import { Icon } from './icons'
import { paint, writeTerm } from './terms'
import { SettingsView } from './SettingsView'
import { ConfirmDialog, ExecDialog, HostDialog, NewProjectDialog, NewTermDialog } from './Dialogs'
import { RightPanel } from './RightPanel'
import { Workspace, type Tab, type TermTab } from './Workspace'

type Modal =
  | { type: 'project' }
  | { type: 'term' }
  | { type: 'exec'; id?: string }
  | { type: 'host'; id?: string }
  | { type: 'confirm'; title: string; body: ReactNode; ok: string; run: () => void }

type GitState = GitPanel & { untracked: Record<string, boolean> }

function shellFor(host: Host | undefined, pref: ShellKind): ShellKind {
  if (host?.platform === 'linux') return 'bash'
  if (pref === 'bash') return 'pwsh'
  return pref
}

export function App() {
  const [db, setDb] = useState<Database | null>(null)
  const [installed, setInstalled] = useState<Record<string, boolean>>({})
  const [route, setRoute] = useState<'work' | 'settings'>('work')
  const [section, setSection] = useState<SettingsSection>('general')
  const [projectId, setProjectId] = useState<string | null>(null)
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeMap, setActiveMap] = useState<Record<string, string | undefined>>({})
  const [split, setSplit] = useState<Record<string, boolean>>({})
  const [right, setRight] = useState(true)
  const [rmode, setRmode] = useState<'files' | 'changes'>('changes')
  const [dmode, setDmode] = useState<'unified' | 'split'>('unified')
  const [openDirs, setOpenDirs] = useState<Record<string, boolean>>({})
  const [modal, setModal] = useState<Modal | null>(null)
  const [toasts, setToasts] = useState<{ id: string; text: string; bad?: boolean }[]>([])
  const [git, setGit] = useState<GitState | null>(null)
  const [tree, setTree] = useState<TreeNode[]>([])
  const [diff, setDiff] = useState<FileDiff | null>(null)
  const [preview, setPreview] = useState<{ path: string; text: string; binary: boolean; missing: boolean } | null>(null)
  const [gitTick, setGitTick] = useState(0)
  const booted = useRef(false)
  const touring = useRef(false)
  const modalRef = useRef<Modal | null>(null)
  modalRef.current = modal

  const toast = useCallback((text: string, bad = false) => {
    const id = uid('z')
    setToasts((list) => [...list, { id, text, bad }])
    setTimeout(() => setToasts((list) => list.filter((item) => item.id !== id)), 2600)
  }, [])

  useEffect(() => {
    void window.awb.getState().then((state) => {
      setDb(state.db)
      setInstalled(state.installed)
    })
  }, [])

  useEffect(() => {
    if (!db) return
    document.documentElement.dataset.theme = db.settings.theme
    document.documentElement.style.setProperty('--fs', `${db.settings.fontSize}px`)
  }, [db])

  const project = db?.projects.find((item) => item.id === projectId) || null
  const host = db?.hosts.find((item) => item.id === project?.host) || db?.hosts[0]
  const theme: ThemeName = db?.settings.theme || 'dark'
  const active = project ? tabs.find((tab) => tab.id === activeMap[project.id] && tab.projectId === project.id) : undefined
  const agents: AgentInfo[] = db
    ? [...PRESETS.map((item) => resolveAgent(item.id, db.custom, installed)), ...db.custom.map((item) => resolveAgent(item.id, db.custom, installed)), SHELL_AGENT]
    : []

  const persist = useCallback((next: Tab[], draft = db) => {
    if (!draft) return
    for (const item of draft.projects) {
      const terms = next.filter((tab): tab is TermTab => tab.type === 'term' && tab.projectId === item.id).map((tab) => ({ kind: tab.kind, shell: tab.shell }))
      void window.awb.saveSessions(item.id, terms)
    }
  }, [db])

  const openTerm = useCallback(async (target: NonNullable<typeof project>, kind: string, shell: ShellKind, activate = true) => {
    const id = uid('t')
    const tab: TermTab = {
      id,
      type: 'term',
      projectId: target.id,
      kind,
      shell,
      state: kind === 'shell' ? 'idle' : 'running',
      startedAt: kind === 'shell' ? null : Date.now(),
      exitCode: null
    }
    setTabs((list) => {
      const next = [...list, tab]
      return next
    })
    if (activate) setActiveMap((map) => ({ ...map, [target.id]: id }))
    try {
      const info = await window.awb.ptyCreate({ id, projectId: target.id, kind, shell })
      setTabs((list) => {
        const next = list.map((item) =>
          item.id === id && item.type === 'term'
            ? { ...item, shell: info.shell, state: info.state as TermTab['state'], startedAt: info.startedAt, exitCode: info.exitCode }
            : item
        )
        persist(next)
        return next
      })
    } catch (err) {
      setTabs((list) => list.filter((item) => item.id !== id))
      toast(err instanceof Error ? err.message : '无法启动终端', true)
    }
  }, [persist, toast])

  useEffect(() => {
    if (!db || touring.current) return
    touring.current = true
    void window.awb.meta().then((meta) => {
      if (!meta.capture) return
      void import('./tour').then((mod) => mod.runTour())
    })
  }, [db])

  useEffect(() => {
    if (!db || booted.current) return
    booted.current = true
    const first = db.projects[0]?.id ?? null
    setProjectId(first)
    if (!db.settings.restore) return
    for (const item of db.projects) {
      const saved = db.sessions[item.id] || []
      saved.forEach((term, index) => {
        void openTerm(item, term.kind, term.shell, item.id === first && index === saved.length - 1)
      })
    }
  }, [db, openTerm])

  useEffect(() => {
    return window.awb.onPty((event) => {
      if (event.type === 'data') {
        writeTerm(event.id, event.data)
        return
      }
      setTabs((list) =>
        list.map((tab) =>
          tab.id === event.id && tab.type === 'term'
            ? { ...tab, state: event.state, exitCode: event.exitCode, startedAt: event.startedAt }
            : tab
        )
      )
      if (!event.announce) return
      const mode = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
      if (event.reason === 'kill') writeTerm(event.id, paint(mode, 'red', '[进程已被强制结束]'))
      writeTerm(event.id, paint(mode, 'faint', `[进程已退出，退出码 ${event.exitCode ?? 0}]`))
    })
  }, [])

  useEffect(() => {
    if (!project || route !== 'work') return
    let stop = false
    const load = () => {
      void window.awb
        .gitStatus(project.id)
        .then((panel) => {
          if (!stop) setGit(panel)
        })
        .catch(() => undefined)
      if (rmode === 'files') {
        void window.awb
          .gitTree(project.id)
          .then((nodes) => {
            if (!stop) setTree(nodes)
          })
          .catch(() => undefined)
      }
    }
    load()
    const timer = setInterval(load, rmode === 'files' ? 4000 : 2000)
    return () => {
      stop = true
      clearInterval(timer)
    }
  }, [project?.id, route, rmode, gitTick])

  useEffect(() => {
    setGit(null)
    setTree([])
    setDiff(null)
    setPreview(null)
  }, [projectId])

  useEffect(() => {
    if (!project || active?.type !== 'diff') return
    let stop = false
    void window.awb.gitDiff(project.id, active.path, !!git?.untracked[active.path]).then((file) => {
      if (!stop) setDiff(file)
    }).catch((err) => toast(err instanceof Error ? err.message : '无法读取差异', true))
    return () => {
      stop = true
    }
  }, [project?.id, active?.type === 'diff' ? active.path : '', gitTick])

  useEffect(() => {
    if (!project || active?.type !== 'file') return
    let stop = false
    void window.awb.gitRead(project.id, active.path).then((file) => {
      if (!stop) setPreview({ path: active.path, ...file })
    })
    return () => {
      stop = true
    }
  }, [project?.id, active?.type === 'file' ? active.id + active.path : ''])

  function closeTab(id: string) {
    const tab = tabs.find((item) => item.id === id)
    if (!tab || !project) return
    if (tab.type === 'term') window.awb.ptyClose(id)
    const next = tabs.filter((item) => item.id !== id)
    setTabs(next)
    persist(next)
    if (activeMap[tab.projectId] === id) {
      const rest = next.filter((item) => item.projectId === tab.projectId)
      setActiveMap((map) => ({ ...map, [tab.projectId]: rest[rest.length - 1]?.id }))
    }
  }

  function selectProject(id: string) {
    setProjectId(id)
    setRoute('work')
    setModal(null)
  }

  async function toggleSplit() {
    if (!project || !db || !host) return
    const on = !split[project.id]
    setSplit((map) => ({ ...map, [project.id]: on }))
    if (on && tabs.filter((tab) => tab.type === 'term' && tab.projectId === project.id).length < 2) {
      await openTerm(project, 'shell', shellFor(host, db.settings.defShell), false)
    }
  }

  function askKill() {
    if (!db || active?.type !== 'term' || active.state !== 'running') return
    const go = () => void window.awb.ptyKill(active.id)
    if (!db.settings.confirmKill) {
      go()
      return
    }
    const agent = resolveAgent(active.kind, db.custom, installed)
    setModal({
      type: 'confirm',
      title: '结束进程？',
      ok: '结束进程',
      body: (
        <>
          将强制结束 <b>{agent.name}</b>（<span className="mono">{cmdline(agent) || shellLabel(active.shell)}</span>）。CLI 未保存的会话会丢失，已写入磁盘的文件不受影响。
        </>
      ),
      run: () => {
        setModal(null)
        go()
      }
    })
  }

  function askDiscard() {
    if (!project || active?.type !== 'diff') return
    const rel = active.path
    setModal({
      type: 'confirm',
      title: '放弃更改？',
      ok: '放弃更改',
      body: (
        <>
          <span className="mono">{rel}</span> 的工作区修改将被还原（git restore），无法撤销。
        </>
      ),
      run: () => {
        setModal(null)
        void window.awb
          .gitDiscard(project.id, rel, !!git?.untracked[rel])
          .then(() => {
            setTabs((list) => {
              const next = list.filter((tab) => !(tab.type === 'diff' && tab.projectId === project.id && tab.path === rel))
              if (activeMap[project.id] === active.id) {
                const rest = next.filter((tab) => tab.projectId === project.id)
                setActiveMap((map) => ({ ...map, [project.id]: rest[rest.length - 1]?.id }))
              }
              return next
            })
            setGitTick((n) => n + 1)
            toast('已放弃更改')
          })
          .catch((err) => toast(err instanceof Error ? err.message : '放弃失败', true))
      }
    })
  }

  function openDiff(rel: string) {
    if (!project) return
    const existing = tabs.find((tab) => tab.type === 'diff' && tab.projectId === project.id)
    if (existing) {
      setTabs((list) => list.map((tab) => (tab.id === existing.id && tab.type === 'diff' ? { ...tab, path: rel } : tab)))
      setActiveMap((map) => ({ ...map, [project.id]: existing.id }))
      return
    }
    const id = uid('d')
    setTabs((list) => [...list, { id, type: 'diff', projectId: project.id, path: rel }])
    setActiveMap((map) => ({ ...map, [project.id]: id }))
  }

  function openFile(rel: string) {
    if (!project) return
    const existing = tabs.find((tab) => tab.type === 'file' && tab.projectId === project.id)
    if (existing && existing.type === 'file') {
      setTabs((list) => list.map((tab) => (tab.id === existing.id && tab.type === 'file' ? { ...tab, path: rel } : tab)))
      setActiveMap((map) => ({ ...map, [project.id]: existing.id }))
      setPreview(null)
      return
    }
    const id = uid('f')
    setTabs((list) => [...list, { id, type: 'file', projectId: project.id, path: rel }])
    setActiveMap((map) => ({ ...map, [project.id]: id }))
  }

  function onAppKey(key: string) {
    if (modalRef.current) return
    if (key === 'n') setModal({ type: 'project' })
    else if (key === 't') {
      if (!project) setModal({ type: 'project' })
      else setModal({ type: 'term' })
    } else if (key === ',') setRoute('settings')
    else if (key === 'b') setRight((value) => !value)
    else if (key === 'w' && active) closeTab(active.id)
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const field = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')
      const inTerm = !!target?.closest('.xterm')
      if (event.key === 'Escape') {
        if (modalRef.current) {
          setModal(null)
          return
        }
        if (!field && route === 'settings') {
          setRoute('work')
          return
        }
      }
      if (field || inTerm || modalRef.current) return
      if (!event.ctrlKey || event.altKey || event.metaKey) return
      const key = event.key.toLowerCase()
      if (key === 'n' || key === 't' || key === ',' || key === 'b' || key === 'w') {
        event.preventDefault()
        onAppKey(key)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const withRight = route === 'work' && !!project && right
  const editing = modal?.type === 'exec' ? db?.custom.find((item) => item.id === modal.id) || null : null
  const editingHost = modal?.type === 'host' && modal.id ? db?.hosts.find((item) => item.id === modal.id) || null : null

  return (
    <>
      <div id="app" className={withRight ? 'with-right' : ''}>
        <header className="title">
          <div className="brand">
            <span className="logo">
              <svg className="i" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M5 17l6-5-6-5M13 19h6" />
              </svg>
            </span>
            Agent Workbench
          </div>
          <span className="grow" />
          <div className="wc">
            <button aria-label="最小化" onClick={() => void window.awb.winMin()}>
              <Icon name="minus" className="s" />
            </button>
            <button aria-label="最大化" onClick={() => void window.awb.winMax()}>
              <Icon name="square" className="s" />
            </button>
            <button className="close" aria-label="关闭窗口" onClick={() => void window.awb.winClose()}>
              <Icon name="x" className="s" />
            </button>
          </div>
        </header>
        <div className="body">
          {route === 'settings' && db ? (
            <SettingsView
              section={section}
              settings={db.settings}
              custom={db.custom}
              hosts={db.hosts}
              plugins={db.plugins}
              installed={installed}
              onSection={(id) => {
                setSection(id)
                document.querySelector('.scontent')?.scrollTo(0, 0)
              }}
              onBack={() => setRoute('work')}
              onSettings={(settings) => {
                setDb({ ...db, settings })
                void window.awb.saveSettings(settings)
              }}
              onPlugins={(plugins) => {
                setDb({ ...db, plugins })
                void window.awb.savePlugins(plugins)
              }}
              onEditExec={(id) => setModal({ type: 'exec', id })}
              onNewExec={() => setModal({ type: 'exec' })}
              onEditHost={(id) => setModal({ type: 'host', id })}
              onNewHost={() => setModal({ type: 'host' })}
              onInstall={(name, cmd) => toast(cmd ? `请先安装 ${name}，并确保命令 ${cmd} 在 PATH 中` : name)}
              onLocalHost={() => toast('本机无需配置')}
            />
          ) : (
            <>
              <aside className="side" aria-label="项目">
                <button className="newp" data-a="newproj" onClick={() => setModal({ type: 'project' })}>
                  <Icon name="plus" />
                  新建项目
                  <kbd>Ctrl N</kbd>
                </button>
                <div className="sec">项目</div>
                <nav className="plist" aria-label="项目">
                  {db?.projects.length ? (
                    db.projects.map((item) => {
                      const itemHost = db.hosts.find((hostItem) => hostItem.id === item.host) || db.hosts[0]
                      const live = tabs.some((tab) => tab.projectId === item.id && tab.type === 'term' && tab.state === 'running')
                      const on = projectId === item.id && route === 'work'
                      return (
                        <button key={item.id} className={`proj ${on ? 'on' : ''}`} data-a="proj" data-id={item.id} aria-current={on ? 'true' : undefined} onClick={() => selectProject(item.id)}>
                          <span className="pi">{item.name[0]?.toUpperCase()}</span>
                          <span className="grow">
                            <span className="n" style={{ display: 'block' }}>
                              {item.name}
                            </span>
                            <span className="m">
                              <Icon name={itemHost.id === 'local' ? 'laptop' : 'server'} className="s" />
                              {itemHost.name}
                            </span>
                          </span>
                          {live ? <span className="live" title="有终端在运行" aria-label="有终端在运行" /> : null}
                        </button>
                      )
                    })
                  ) : (
                    <p style={{ fontSize: 12, color: 'var(--faint)', padding: '4px 8px' }}>暂无项目</p>
                  )}
                </nav>
                <div className="sfoot">
                  <button className="navb" data-a="settings" onClick={() => setRoute('settings')}>
                    <Icon name="settings" />
                    设置
                    <kbd style={{ marginLeft: 'auto' }}>Ctrl ,</kbd>
                  </button>
                </div>
              </aside>
              <div id="mainwrap" style={{ display: 'contents' }}>
                <Workspace
                  project={project}
                  tabs={tabs}
                  active={active}
                  split={!!(project && split[project.id])}
                  rightOpen={right}
                  dmode={dmode}
                  theme={theme}
                  fontSize={db?.settings.fontSize || 13}
                  agents={agents}
                  installed={installed}
                  diff={diff}
                  preview={preview}
                  onSelect={(id) => project && setActiveMap((map) => ({ ...map, [project.id]: id }))}
                  onClose={closeTab}
                  onNewTerm={() => (project ? setModal({ type: 'term' }) : setModal({ type: 'project' }))}
                  onNewProject={() => setModal({ type: 'project' })}
                  onQuick={() => {
                    if (!project || !db || !host) return
                    void openTerm(project, project.agent, shellFor(host, db.settings.defShell))
                  }}
                  onInterrupt={(id) => {
                    void window.awb.ptyInterrupt(id).then((action) => {
                      if (action === 'hint') writeTerm(id, paint(theme, 'amber', '再次按 Ctrl+C 退出'))
                    })
                  }}
                  onKill={askKill}
                  onRestart={() => {
                    if (active?.type !== 'term') return
                    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false })
                    writeTerm(active.id, paint(theme, 'faint', `── 重新启动 · ${time} ──`))
                    void window.awb.ptyRestart(active.id)
                  }}
                  onSplit={() => void toggleSplit()}
                  onToggleRight={() => setRight((value) => !value)}
                  onDmode={setDmode}
                  onDiscard={askDiscard}
                  onAppKey={onAppKey}
                />
                {withRight && project && host ? (
                  <RightPanel
                    project={project}
                    host={host}
                    mode={rmode}
                    files={git?.files || []}
                    loaded={!!git}
                    isRepo={!!git?.isRepo}
                    branch={git?.branch || project.branch}
                    tree={tree}
                    openDirs={openDirs}
                    activePath={active && active.type !== 'term' ? active.path : undefined}
                    onMode={setRmode}
                    onToggleDir={(dir) => setOpenDirs((map) => ({ ...map, [dir]: !map[dir] }))}
                    onOpenDiff={openDiff}
                    onOpenFile={openFile}
                    onCollapse={() => setRight(false)}
                  />
                ) : null}
              </div>
            </>
          )}
        </div>
      </div>
      <div id="modal">
        {modal?.type === 'confirm' ? <ConfirmDialog title={modal.title} body={modal.body} ok={modal.ok} onOk={modal.run} onClose={() => setModal(null)} /> : null}
        {modal?.type === 'project' && db ? (
          <NewProjectDialog
            hosts={db.hosts}
            settings={db.settings}
            custom={db.custom}
            installed={installed}
            onClose={() => setModal(null)}
            onToast={toast}
            onHosts={(hosts) => {
              setDb({ ...db, hosts })
              void window.awb.saveHosts(hosts)
            }}
            onCreate={(draft) => {
              const created = { id: uid('p'), name: draft.name, host: draft.host, path: draft.path, branch: draft.branch, agent: draft.agent }
              const projects = [created, ...db.projects]
              setDb({ ...db, projects })
              setProjectId(created.id)
              setRoute('work')
              setModal(null)
              void window.awb.saveProjects(projects)
              toast('已创建项目')
            }}
          />
        ) : null}
        {modal?.type === 'term' && project && host ? (
          <NewTermDialog
            host={host}
            cwd={project.path}
            initialKind={project.agent}
            initialShell={shellFor(host, db?.settings.defShell || 'pwsh')}
            agents={agents}
            onClose={() => setModal(null)}
            onManage={() => {
              setModal(null)
              setRoute('settings')
              setSection('agents')
            }}
            onOpen={(kind, shell) => {
              setModal(null)
              void openTerm(project, kind, shell)
            }}
          />
        ) : null}
        {modal?.type === 'exec' && db ? (
          <ExecDialog
            initial={editing && modal.id ? editing : null}
            cwd={project?.path || ''}
            onClose={() => setModal(null)}
            onToast={toast}
            onDelete={(id) => {
              const custom = db.custom.filter((item) => item.id !== id)
              setDb({ ...db, custom })
              setModal(null)
              void window.awb.saveCustom(custom)
            }}
            onSave={(exec) => {
              const custom = exec.id ? db.custom.map((item) => (item.id === exec.id ? exec : item)) : [...db.custom, { ...exec, id: uid('c') }]
              setDb({ ...db, custom })
              setModal(null)
              void window.awb.saveCustom(custom).then(() => window.awb.getState()).then((state) => setInstalled(state.installed))
              toast('已保存执行器')
            }}
          />
        ) : null}
        {modal?.type === 'host' && db ? (
          <HostDialog
            initial={editingHost}
            onClose={() => setModal(null)}
            onToast={toast}
            onDelete={(id) => {
              setModal({
                type: 'confirm',
                title: '移除机器？',
                ok: '移除',
                body: '使用这台机器的项目将无法打开终端。',
                run: () => {
                  const hosts = db.hosts.filter((item) => item.id !== id)
                  setDb({ ...db, hosts })
                  setModal(null)
                  void window.awb.saveHosts(hosts)
                }
              })
            }}
            onSave={(item) => {
              const hosts = item.id ? db.hosts.map((hostItem) => (hostItem.id === item.id ? item : hostItem)) : [...db.hosts, { ...item, id: uid('h') }]
              setDb({ ...db, hosts })
              setModal(null)
              void window.awb.saveHosts(hosts)
              toast('已保存')
            }}
          />
        ) : null}
      </div>
      <div id="toasts" aria-live="polite">
        {toasts.map((item) => (
          <div key={item.id} className={`toast ${item.bad ? 'bad' : ''}`}>
            <Icon name={item.bad ? 'x' : 'check'} className="s" />
            {item.text}
          </div>
        ))}
      </div>
    </>
  )
}
