import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, type MenuItemConstructorOptions } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { PRESETS, type Executor, type Host, type Project, type SavedTerm, type Settings, type ShellKind, type ResourceTarget } from '../shared/types'
import { ResourceManager, validateResourcePaths } from './resources'
import { db, mutate, writeSessions } from './store'
import { commandExists, osLabel } from './platform'
import { checkPath, fileTree, gitDiff, gitDiscard, gitStatus, listDir, readFile, targetFor, writeFile } from './git'
import {
  closeAllSessions,
  closeSession,
  createSession,
  interruptSession,
  killSession,
  resizeSession,
  restartSession,
  testExecutor,
  writeSession
} from './pty'
import { sshBatchArgs } from './platform'
import { publicHost, rememberPassword } from './credentials'
import { runPasswordCommand } from './ssh'
import { isPreviewUrl, openHtmlPreview, previewUrl } from './preview'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

if (process.env.AWB_USER_DATA) app.setPath('userData', process.env.AWB_USER_DATA)
if (process.env.AWB_CAPTURE) {
  app.commandLine.appendSwitch('force-device-scale-factor', '1')
  app.disableHardwareAcceleration()
}

let win: BrowserWindow | null = null
let hasUnsavedChanges = false
let allowWindowClose = false
let closingWindow = false

function confirmUnsavedClose(): boolean {
  if (!win) return true
  const choice = dialog.showMessageBoxSync(win, {
    type: 'question', title: '文件尚未保存', message: '有尚未保存的文件更改。',
    buttons: ['继续编辑', '放弃更改并关闭'], defaultId: 0, cancelId: 0
  })
  return choice === 1
}

function send(event: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send('pty:event', event)
}

async function installedMap(): Promise<Record<string, boolean>> {
  const cmds = new Set<string>(PRESETS.map((p) => p.cmd))
  for (const custom of db().custom) if (custom.cmd) cmds.add(custom.cmd)
  const entries = await Promise.all([...cmds].map(async (cmd) => [cmd, await commandExists(cmd)] as const))
  return Object.fromEntries(entries)
}

function projectTarget(projectId: string) {
  const draft = db()
  const project = draft.projects.find((p) => p.id === projectId)
  if (!project) throw new Error('项目不存在')
  const host = draft.hosts.find((h) => h.id === project.host)
  if (!host) throw new Error('机器已移除')
  if (host.id !== 'local' && !host.on) throw new Error('这台机器未连接')
  return { project, host, target: targetFor(project.path, host.id === 'local' ? null : host) }
}

function broadcastTheme(theme: Settings['theme']): void {
  const color = theme === 'light' ? '#f3f3f5' : '#131417'
  win?.setBackgroundColor(color)
  nativeTheme.themeSource = theme
}

function createWindow(): void {
  const theme = db().settings.theme
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    useContentSize: true,
    x: process.env.AWB_CAPTURE ? 0 : undefined,
    y: process.env.AWB_CAPTURE ? 0 : undefined,
    frame: false,
    backgroundColor: theme === 'light' ? '#f3f3f5' : '#131417',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  })
  win.once('ready-to-show', () => win?.show())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  win.webContents.on('will-frame-navigate', (event) => { if (!event.isMainFrame && !isPreviewUrl(event.url)) event.preventDefault() })
  win.webContents.on('context-menu', (_event, params) => {
    if (!isPreviewUrl(params.frameURL)) return
    Menu.buildFromTemplate([
      { id: 'source', label: '源码模式', click: () => win?.webContents.send('file:preview-source') },
      { type: 'separator' }, { role: 'copy', label: '复制' }, { role: 'selectAll', label: '全选' }
    ]).popup({ window: win! })
  })
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    const url = process.env.AWB_CAPTURE ? devUrl + (devUrl.includes('?') ? '&' : '?') + 'capture=1' : devUrl
    void win.loadURL(url)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'), {
      query: process.env.AWB_CAPTURE ? { capture: '1' } : undefined
    })
  }
  win.on('close', (event) => {
    if (sessionsClosed) return
    event.preventDefault()
    if (closingWindow) return
    if (hasUnsavedChanges && !allowWindowClose && !confirmUnsavedClose()) return
    allowWindowClose = true
    closingWindow = true
    const closing = win
    // Preserve the PTY parent processes until their complete trees are killed.
    void closeAllSessions().catch((error) => console.error('Failed to close terminal sessions', error)).finally(() => {
      sessionsClosed = true
      if (closing && !closing.isDestroyed()) closing.destroy()
      app.quit()
    })
  })
  win.on('closed', () => {
    win = null
  })
  win.webContents.on('will-prevent-unload', (event) => {
    if (!win) return
    if (allowWindowClose || confirmUnsavedClose()) {
      allowWindowClose = true
      event.preventDefault()
    }
  })
}

async function testHostConnection(host: Host): Promise<import('../shared/types').HostTest> {
  if (!host.addr || !host.user) return { ok: false, error: '请填写用户和地址' }
  try {
    const probe = 'uname -s 2>/dev/null || ver'
    const stdout = host.auth === 'password'
      ? await runPasswordCommand(host, probe)
      : (await execFileP('ssh', sshBatchArgs(host, [probe]), { timeout: 12000, windowsHide: true })).stdout
    const text = stdout.trim()
    const linux = /linux/i.test(text)
    const platform = linux ? 'linux' : 'windows'
    const os = text.split(/\r?\n/).filter(Boolean).pop() || (linux ? 'Linux' : 'Windows')
    return { ok: true, os: os.slice(0, 80), platform }
  } catch (err) {
    const e = err as { stderr?: string; message?: string }
    const message = (e.stderr || e.message || '连接失败').trim().split(/\r?\n/).pop() || '连接失败'
    return { ok: false, error: message.slice(0, 240) }
  }
}

function registerIpc(): void {
  ipcMain.on('files:dirty', (_event, dirty: boolean) => { hasUnsavedChanges = !!dirty })
  ipcMain.handle('db:get', async () => ({ db: db(), installed: await installedMap() }))
  ipcMain.handle('db:settings', (_e, settings: Settings) => {
    const next = mutate((draft) => {
      draft.settings = settings
    })
    broadcastTheme(settings.theme)
    return next
  })
  ipcMain.handle('db:projects', (_e, projects: Project[]) => mutate((draft) => {
    draft.projects = projects
  }))
  ipcMain.handle('db:custom', (_e, custom: Executor[]) => mutate((draft) => {
    for (const executor of custom) validateResourcePaths(executor.resources)
    draft.custom = custom
  }))
  ipcMain.handle('db:hosts', async (_e, hosts: Host[]) => {
    for (const host of hosts) {
      if (host.id === 'local') continue
      const old = db().hosts.find((item) => item.id === host.id)
      const changed = !old || ['addr', 'port', 'user', 'auth'].some((key) => old[key as keyof Host] !== host[key as keyof Host]) || host.password !== undefined
      if (changed) {
        const result = await testHostConnection(host)
        if (!result.ok) throw new Error(result.error || 'SSH 连接失败，未保存机器')
        Object.assign(host, { on: true, os: result.os, platform: result.platform })
      }
    }
    return mutate((draft) => {
      const local = hosts.find((h) => h.id === 'local')
      if (local) {
        local.on = true
        local.os = local.os || osLabel()
      }
      draft.hosts = hosts.map((host) => {
        rememberPassword(host)
        return publicHost(host)
      })
    })
  })
  const resources = new ResourceManager(app.getPath('userData'))
  const targets = () => resources.targets(db().custom)
  ipcMain.handle('resources:targets', () => targets())
  ipcMain.handle('resources:target', (_e, target: ResourceTarget) => resources.saveTarget(target, db().custom))
  ipcMain.handle('resources:list', (_e, kind: 'mcp' | 'skills', agent: string, page: number, query: string) => resources.list(targets(), kind, agent, page, query))
  ipcMain.handle('resources:toggle', (_e, kind, agent, item, enabled) => resources.toggle(targets(), kind, agent, item, enabled))
  ipcMain.handle('resources:detail', (_e, kind, agent, item) => resources.detail(targets(), kind, agent, item))
  ipcMain.handle('resources:mcp', (_e, name: string, config: Record<string, unknown>, agents: string[]) => resources.addMcp(targets(), name, config, agents))
  ipcMain.handle('resources:skills', (_e, source: string, agents: string[]) => resources.importSkills(targets(), source, agents))
  ipcMain.handle('resources:pick', async (_e, kind: string) => {
    if (!win) return null
    const result = await dialog.showOpenDialog(win, { properties: [kind === 'folder' ? 'openDirectory' : 'openFile'],
      filters: kind === 'folder' ? undefined : [{ name: kind === 'zip' ? 'ZIP 压缩包' : 'Agent 配置', extensions: kind === 'zip' ? ['zip'] : ['json', 'jsonc', 'toml'] }] })
    return result.canceled ? null : result.filePaths[0] || null
  })
  ipcMain.handle('db:sessions', (_e, projectId: string, terms: SavedTerm[], activeId?: string | null) => mutate((draft) => {
    writeSessions(draft, projectId, terms, activeId)
  }))
  ipcMain.handle('db:branch', (_e, projectId: string, branch: string) => mutate((draft) => {
    const project = draft.projects.find((p) => p.id === projectId)
    if (project) project.branch = branch
  }))

  ipcMain.handle('dialog:directory', async () => {
    if (!win) return null
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    if (result.canceled || !result.filePaths[0]) return null
    return result.filePaths[0]
  })

  ipcMain.handle('path:check', async (_e, hostId: string, input: string) => {
    const draft = db()
    const host = draft.hosts.find((h) => h.id === hostId) || draft.hosts[0]
    const target = targetFor(host.id === 'local' ? input || process.cwd() : input || '/', host.id === 'local' ? null : host)
    return checkPath(target, input)
  })
  ipcMain.handle('path:list', async (_e, hostId: string, input: string) => {
    const draft = db()
    const host = draft.hosts.find((h) => h.id === hostId) || draft.hosts[0]
    const target = targetFor(input || '/', host.id === 'local' ? null : host)
    return listDir(target, input)
  })

  ipcMain.handle('git:status', async (_e, projectId: string) => {
    const { project, target } = projectTarget(projectId)
    const panel = await gitStatus(target)
    if (panel.isRepo && panel.branch && panel.branch !== project.branch) {
      mutate((draft) => {
        const item = draft.projects.find((p) => p.id === projectId)
        if (item) item.branch = panel.branch
      })
    }
    return { isRepo: panel.isRepo, branch: panel.branch, files: panel.files, untracked: panel.flags }
  })
  ipcMain.handle('git:diff', async (_e, projectId: string, rel: string, untracked: boolean) => {
    const { target } = projectTarget(projectId)
    return gitDiff(target, rel, !!untracked)
  })
  ipcMain.handle('git:discard', async (_e, projectId: string, rel: string, untracked: boolean) => {
    const { target } = projectTarget(projectId)
    await gitDiscard(target, rel, !!untracked)
    return true
  })
  ipcMain.handle('git:tree', async (_e, projectId: string, rel = '') => {
    const { target } = projectTarget(projectId)
    return fileTree(target, rel)
  })
  ipcMain.handle('git:read', async (_e, projectId: string, rel: string) => {
    const { target } = projectTarget(projectId)
    return readFile(target, rel)
  })
  ipcMain.handle('git:write', async (_e, projectId: string, rel: string, text: string, version: string) => {
    const { target } = projectTarget(projectId)
    return writeFile(target, rel, text, version)
  })
  ipcMain.handle('file:preview-url', async (_e, projectId: string, rel: string, draft?: string) => previewUrl(projectId, projectTarget(projectId).target, rel, draft))
  ipcMain.handle('file:open-html', async (_e, projectId: string, rel: string) => openHtmlPreview(projectId, projectTarget(projectId).target, rel))
  ipcMain.handle('file:menu', (_e, options: { markdown: boolean; visual: boolean; undo: boolean; redo: boolean; editable: boolean }) => new Promise<string | null>((resolve) => {
    const action = (label: string, id: string, enabled = true): MenuItemConstructorOptions => ({ id, label, enabled, click: () => resolve(id) })
    const template: MenuItemConstructorOptions[] = [
      action(options.visual ? '源码模式' : '渲染模式', 'mode'), { type: 'separator' },
      action('撤销', 'undo', options.undo), action('重做', 'redo', options.redo),
      { type: 'separator' }, { role: 'cut', label: '剪切', enabled: options.editable }, { role: 'copy', label: '复制' },
      { role: 'paste', label: '粘贴', enabled: options.editable }, { role: 'pasteAndMatchStyle', label: '粘贴为纯文本', enabled: options.editable },
      { role: 'selectAll', label: '全选' }
    ]
    if (options.markdown && options.visual && options.editable) template.push({ type: 'separator' },
      { label: '格式', submenu: [action('加粗', 'bold'), action('斜体', 'italic'), action('行内代码', 'code')] },
      { label: '段落', submenu: [action('一级标题', 'heading'), action('引用', 'quote'), action('无序列表', 'bullet'), action('有序列表', 'ordered'), action('代码块', 'codeblock'), action('插入表格', 'table')] })
    template.push({ type: 'separator' }, action('保存', 'save', options.editable), action('重新读取', 'reload'), action('切换文件面板', 'panel'))
    Menu.buildFromTemplate(template).popup({ window: win!, callback: () => resolve(null) })
  }))

  ipcMain.handle('pty:create', (_e, req: { id: string; projectId: string; kind: string; shell: ShellKind }) => {
    return createSession(send, req)
  })
  ipcMain.on('pty:write', (_e, id: string, data: string, binary = false) => writeSession(id, String(data), !!binary))
  ipcMain.on('pty:resize', (_e, id: string, cols: number, rows: number) => resizeSession(id, cols, rows))
  ipcMain.handle('pty:interrupt', (_e, id: string) => interruptSession(id))
  ipcMain.handle('pty:kill', (_e, id: string) => killSession(id))
  ipcMain.handle('pty:restart', (_e, id: string) => restartSession(id))
  ipcMain.handle('pty:close', (_e, id: string) => closeSession(id))

  ipcMain.handle('exec:test', async (_e, req: { cmd: string; args: string; shell: ShellKind; env: { k: string; v: string; secret: boolean }[]; cwd?: string }) => {
    return testExecutor({
      cmd: req.cmd || '',
      args: req.args || '',
      shell: req.shell || 'bash',
      env: Array.isArray(req.env) ? req.env : [],
      cwd: req.cwd || ''
    })
  })

  ipcMain.handle('host:test', (_e, host: Host) => testHostConnection(host))

  ipcMain.handle('win:min', () => win?.minimize())
  ipcMain.handle('win:max', () => {
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.handle('win:close', () => win?.close())
  ipcMain.handle('win:resize', (_e, width: number, height: number) => {
    if (!win) return
    win.setSize(Math.max(1024, width), Math.max(680, height))
  })
  ipcMain.handle('app:shot', async (_e, name: string) => {
    if (!process.env.AWB_SHOTS || !win) return false
    const safe = path.basename(String(name)).replace(/[^\w.-]+/g, '_')
    const dir = process.env.AWB_SHOTS
    fs.mkdirSync(dir, { recursive: true })
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 4, y: 4 })
    await new Promise((resolve) => setTimeout(resolve, 40))
    const image = await win.capturePage()
    fs.writeFileSync(path.join(dir, safe.endsWith('.png') ? safe : safe + '.png'), image.toPNG())
    return true
  })
  ipcMain.handle('app:meta', () => ({
    capture: process.env.AWB_CAPTURE === '1',
    platform: process.platform,
    shots: !!process.env.AWB_SHOTS
  }))
}

app.whenReady().then(() => {
  registerIpc()
  createWindow()
  broadcastTheme(db().settings.theme)
})

app.on('window-all-closed', () => {
  app.quit()
})

let sessionsClosed = false
let quitting = false
app.on('before-quit', (event) => {
  if (sessionsClosed) return
  event.preventDefault()
  if (quitting) return
  if (hasUnsavedChanges && win && !allowWindowClose) {
    if (!confirmUnsavedClose()) return
    allowWindowClose = true
  }
  quitting = true
  void closeAllSessions().catch((error) => console.error('Failed to close terminal sessions', error)).finally(() => {
    sessionsClosed = true
    app.quit()
  })
})
