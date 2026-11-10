import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, shell, type MenuItemConstructorOptions } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { PRESETS, type Executor, type Host, type Project, type SavedTerm, type Settings, type ShellKind, type ResourceTarget, type WorkSession } from '../shared/types'
import { hostColor } from '../shared/host-colors'
import { ResourceManager, validateResourcePaths } from './resources'
import { db, mutate, validTreeIgnores, writeSessions } from './store'
import { bashQuote, commandExists, osLabel, psQuote } from './platform'
import { workbenchTheme } from '../shared/themes'
import { checkPath, createTreeEntry, fileTree, gitDiff, gitDiscard, gitStatus, listDir, moveTreeEntry, readFile, removeRemoteEntry, renameTreeEntry, targetFor, treePath, TREE_DEFAULT_IGNORE, writeFile } from './git'
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
import { invalidatePreview, isPreviewUrl, openHtmlPreview, previewUrl } from './preview'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { copyToNewFile } from './file-copy'
import { TransferManager } from './transfer'
import { uploadRemoteSources, type UploadChoice, type UploadConflict } from './remote-file'
import { DownloadManager } from './downloads'
import { installedEditors, launchEditor } from './external-editors'
import { configureTemporaryDirectory, createTemporarySession, temporaryDirectory } from './temporary-sessions'
import { randomUUID } from 'node:crypto'
import { windowsTaskbarIcon } from './app-icon'
import type { TransferSnapshot, ReplacementEvent } from '../shared/types'
import { ConflictPolicy } from '../shared/file-conflicts'
import { discoverLocalShells } from './local-shells'
import { cancelDiagramRenderer, DiagramCancelled, disposeDiagramRenderer, renderMermaid } from './diagram-renderer'
import { deleteTerminalHistory, loadTerminalHistory, pruneTerminalHistory, saveTerminalHistory } from './terminal-history'

const execFileP = promisify(execFile)
const windowsAppId = app.isPackaged ? 'com.pello.app' : 'com.pello.app.dev'
if (process.platform === 'win32') app.setAppUserModelId(windowsAppId)

// Keep the existing profile, including encrypted SSH credentials, across the rename.
app.setName('Pello')
app.setPath('userData', process.env.AWB_USER_DATA || path.join(app.getPath('appData'), 'agent-workbench'))
if (process.env.AWB_CAPTURE) {
  app.commandLine.appendSwitch('force-device-scale-factor', '1')
  app.disableHardwareAcceleration()
}

let win: BrowserWindow | null = null
const transfers = new TransferManager((snapshot) => { if (win && !win.isDestroyed()) win.webContents.send('transfer:update', snapshot) }, guardReplacement)
const replacementLocks = new Map<string, boolean>()
const activeFileWrites = new Set<string>()
const replacementAnswers = new Map<string, (allow: boolean) => void>()
const downloads = new Map<string, AbortController>()
const uploadCompletions = new Set<Promise<void>>()
const uploadDecisions = new Map<string, (choice: UploadChoice, applyToBatch: boolean) => void>()
const downloadTasks = new DownloadManager((projectId) => {
  const { target, host } = projectTarget(projectId)
  if (host.id === 'local') throw new Error('项目环境已更改')
  return { target, identity: uploadIdentity(target, host) }
}, (snapshot) => { if (win && !win.isDestroyed()) win.webContents.send('transfer:update', snapshot) })
type UploadRetry = { source: string; parent: string }
const uploadHistory = new Map<string, { projectId: string; identity: string; entries: UploadRetry[]; conflicts: UploadRetry[]; complete: boolean }>()
let hasUnsavedChanges = false
let allowWindowClose = false
let closingWindow = false
const treeSearches = new Map<string, { projectId: string; query: string; pending: string[]; cancelled: boolean; ignored: Set<string> }>()
const treeIgnored = (projectId: string) => new Set(db().treeIgnores?.[projectId] ?? TREE_DEFAULT_IGNORE)

function fileWriteKey(target: ReturnType<typeof targetFor>, relative: string): string {
  const full = treePath(target, relative).full
  const normalized = target.platform === 'windows' ? full.toLowerCase() : full
  return target.host && target.host.id !== 'local'
    ? JSON.stringify([target.host.addr, target.host.port, target.host.user, normalized])
    : `local:${normalized}`
}

function withinWriteKey(candidate: string, parent: string): boolean {
  if (candidate === parent) return true
  if (candidate.startsWith('local:') && parent.startsWith('local:')) return candidate.startsWith(parent + path.sep)
  if (candidate.startsWith('local:') || parent.startsWith('local:')) return false
  const a = JSON.parse(candidate) as [string, number, string, string], b = JSON.parse(parent) as [string, number, string, string]
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && (a[3].startsWith(b[3] + '/') || a[3].startsWith(b[3] + '\\'))
}
function replacementBlocked(key: string, directory = false): boolean {
  return [...replacementLocks].some(([locked, tree]) => locked === key || (tree && withinWriteKey(key, locked)) || (directory && withinWriteKey(locked, key)))
}

async function guardReplacement(projectId: string, destination: string, operation: () => Promise<void>, signal: AbortSignal, directory = false): Promise<void> {
  const { target, host } = projectTarget(projectId)
  const relative = host.id === 'local' ? path.relative(fs.realpathSync(target.cwd), fs.realpathSync(destination)).replaceAll('\\', '/') : destination
  const resolved = treePath(target, relative)
  if (resolved.relative === '.' || (host.id === 'local' && !fs.lstatSync(destination).isFile())) throw new Error('不能覆盖项目根目录或不支持的对象')
  const key = fileWriteKey(target, resolved.relative)
  if (replacementBlocked(key, directory) || [...activeFileWrites].some((active) => active === key || (directory && withinWriteKey(active, key)))) throw new Error('文件正在保存或进行其他操作')
  const targets = [{ projectId, path: resolved.relative }]
  const paths = target.platform === 'windows' ? path.win32 : path.posix
  for (const project of db().projects) {
    if (project.id === projectId) continue
    const aliasHost = db().hosts.find((item) => item.id === project.host)
    if (!aliasHost || (host.id === 'local' ? aliasHost.id !== 'local' : aliasHost.id === 'local' || aliasHost.addr !== host.addr || aliasHost.port !== host.port || aliasHost.user !== host.user || aliasHost.platform !== host.platform)) continue
    let aliasRoot = project.path
    if (host.id === 'local') { try { aliasRoot = fs.realpathSync(project.path) } catch { continue } }
    const relative = paths.relative(aliasRoot, resolved.full)
    if (!relative || (relative !== '..' && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative))) targets.push({ projectId: project.id, path: relative.replaceAll('\\', '/') })
    else if (directory) {
      const nested = paths.relative(resolved.full, aliasRoot)
      if (nested && nested !== '..' && !nested.startsWith(`..${paths.sep}`) && !paths.isAbsolute(nested)) targets.push({ projectId: project.id, path: '' })
    }
  }
  const event: ReplacementEvent = { id: randomUUID(), projectId, path: resolved.relative, directory, caseInsensitive: target.platform === 'windows', targets, phase: 'prepare' }
  replacementLocks.set(key, directory)
  let success = false
  try {
    if (!win || win.isDestroyed() || signal.aborted) throw new Error('覆盖已取消')
    const allowed = await new Promise<boolean>((resolve) => {
      const abort = () => finish(false)
      const finish = (allow: boolean) => { signal.removeEventListener('abort', abort); replacementAnswers.delete(event.id); resolve(allow) }
      replacementAnswers.set(event.id, finish)
      signal.addEventListener('abort', abort, { once: true })
      win!.webContents.send('file:replacement', event)
    })
    if (!allowed || signal.aborted) throw new Error('覆盖已取消，原文件和草稿已保留')
    await operation()
    success = true
    for (const item of targets) invalidatePreview(item.projectId, item.path)
  } finally {
    replacementAnswers.delete(event.id)
    replacementLocks.delete(key)
    if (win && !win.isDestroyed()) win.webContents.send('file:replacement', { ...event, phase: 'finish', success } satisfies ReplacementEvent)
  }
}

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
  if (closingWindow || quitting) throw new Error('工作台正在关闭')
  const draft = db()
  const project = draft.projects.find((p) => p.id === projectId)
  if (!project) throw new Error('项目不存在')
  const host = draft.hosts.find((h) => h.id === project.host)
  if (!host) throw new Error('机器已移除')
  if (host.id !== 'local' && !host.on) throw new Error('这台机器未连接')
  return { project, host, target: targetFor(project.path, host.id === 'local' ? null : host) }
}

function validateTransferTarget(id: string): void {
  const context = transfers.context(id)
  const { target, host } = projectTarget(context.projectId)
  if (host.id !== 'local') throw new Error('项目环境已更改')
  const projectRoot = fs.realpathSync(target.cwd)
  const resolved = treePath(target, path.relative(projectRoot, context.root)).full
  if (!fs.statSync(resolved).isDirectory()) throw new Error('目标不是目录')
}

function uploadIdentity(target: ReturnType<typeof targetFor>, host: Host): string {
  return JSON.stringify([target.cwd, target.platform, host.id, host.addr, host.port, host.user, host.auth])
}

function startRemoteUpload(projectId: string, parent: string, sources: string[], retryEntries?: UploadRetry[], keepBoth = false): string {
  const { target, host } = projectTarget(projectId)
  if (host.id === 'local') throw new Error('项目环境已更改')
  const destination = treePath(target, parent).full
  const id = randomUUID(), controller = new AbortController()
  downloads.set(id, controller)
  for (const [key, history] of uploadHistory) if (uploadHistory.size >= 50 && history.complete) uploadHistory.delete(key)
  const history = { projectId, identity: uploadIdentity(target, host), entries: [] as UploadRetry[], conflicts: [] as UploadRetry[], complete: false }
  uploadHistory.set(id, history)
  const snapshot: TransferSnapshot = { id, projectId, state: 'running', current: '', destination, bytes: 0, total: 0, items: [], direction: 'upload', overallBytes: 0, phase: 'preparing' }
  const emit = () => { if (win && !win.isDestroyed()) win.webContents.send('transfer:update', snapshot) }
  const completion = new Promise<void>((done) => setImmediate(() => {
    emit()
    let last = 0
    let previousBytes = 0
    let progressTimer: ReturnType<typeof setTimeout> | undefined
    const policy = new ConflictPolicy()
    const progress = (source: string, bytes: number, total: number) => {
      if (bytes === 0) previousBytes = 0
      snapshot.overallBytes = (snapshot.overallBytes || 0) + Math.max(0, bytes - previousBytes)
      previousBytes = bytes; snapshot.phase = 'transferring'
      snapshot.current = source; snapshot.bytes = bytes; snapshot.total = total
      const remaining = 100 - (Date.now() - last)
      if (remaining <= 0) { if (progressTimer) clearTimeout(progressTimer); progressTimer = undefined; last = Date.now(); emit() }
      else if (!progressTimer) progressTimer = setTimeout(() => { progressTimer = undefined; last = Date.now(); emit() }, remaining)
    }
    const result = (source: string, rel: string, error?: string, skipped = false) => {
      const separator = target.platform === 'windows' ? '\\' : '/'
      const itemPath = `${target.cwd.replace(/[\\/]+$/, '')}${separator}${rel.replaceAll('/', separator)}`
      if (error && error !== '部分内容未能上传') (skipped ? history.conflicts : history.entries).push({ source, parent: rel.split('/').slice(0, -1).join('/') })
      snapshot.items.push({ source, destination: itemPath, status: skipped ? 'conflict' : error ? 'failed' : 'done', ...(error ? { error } : {}) }); emit()
    }
    const decide = async (conflict: UploadConflict): Promise<UploadChoice> => {
      if (controller.signal.aborted) throw new Error('传输已取消')
      if (keepBoth) return 'keep'
      const remembered = policy.get(conflict)
      if (remembered) return remembered
      const pending = { source: conflict.source, destination: treePath(target, conflict.relative).full, status: 'conflict' as const, mergeable: conflict.mergeable, replaceable: conflict.replaceable }
      snapshot.items.push(pending); snapshot.state = 'conflicts'
      const choice = await new Promise<UploadChoice>((resolve) => {
        const abort = () => finish('cancel', false)
        const finish = (value: UploadChoice, apply: boolean) => {
          policy.validate(conflict, value)
          if (apply) policy.remember(conflict, value)
          controller.signal.removeEventListener('abort', abort); uploadDecisions.delete(id); resolve(value)
        }
        uploadDecisions.set(id, finish); controller.signal.addEventListener('abort', abort, { once: true }); emit()
      })
      snapshot.items = snapshot.items.filter((item) => item !== pending)
      if (choice === 'cancel') controller.abort()
      else {
        const fresh = projectTarget(projectId)
        if (uploadIdentity(fresh.target, fresh.host) !== history.identity) throw new Error('项目环境已更改')
        snapshot.state = 'running'; emit()
      }
      return choice
    }
    const operation = async () => {
      const replace = (relative: string, write: () => Promise<void>, directory = false) => {
        const fresh = projectTarget(projectId)
        if (uploadIdentity(fresh.target, fresh.host) !== history.identity) throw new Error('项目环境已更改')
        return guardReplacement(projectId, relative, write, controller.signal, directory)
      }
      const options = { automatic: !keepBoth, planned: (bytes: number) => { snapshot.overallTotal = (snapshot.overallTotal || 0) + bytes; emit() }, publishing: () => { snapshot.phase = 'publishing'; emit() }, file: (relative: string) => { snapshot.destination = treePath(target, relative.split('/').slice(0, -1).join('/')).full }, warning: (message: string) => { snapshot.warnings = [...(snapshot.warnings || []), message]; emit() } }
      if (retryEntries) for (const entry of retryEntries) await uploadRemoteSources(target, entry.parent, [entry.source], controller.signal, progress, result, decide, replace, options)
      else await uploadRemoteSources(target, parent, sources, controller.signal, progress, result, decide, replace, options)
    }
    void operation().then(() => { snapshot.state = 'completed' }).catch((error: unknown) => {
      snapshot.state = controller.signal.aborted ? 'cancelled' : 'completed'
      if (!controller.signal.aborted) snapshot.items.push({ source: '', destination, status: 'failed', error: error instanceof Error ? error.message : '上传失败' })
    }).finally(() => { if (progressTimer) clearTimeout(progressTimer); history.complete = true; downloads.delete(id); emit(); done() })
  }))
  uploadCompletions.add(completion)
  void completion.then(() => uploadCompletions.delete(completion))
  return id
}

async function closeTransfers(): Promise<void> {
  for (const controller of downloads.values()) controller.abort()
  await Promise.allSettled([transfers.shutdown(), downloadTasks.shutdown(), ...uploadCompletions])
}

function broadcastTheme(theme: Settings['theme']): void {
  const color = workbenchTheme(theme).colors.side
  win?.setBackgroundColor(color)
  nativeTheme.themeSource = workbenchTheme(theme).mode
}

function createWindow(): void {
  const theme = db().settings.theme
  const iconDirectory = app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'assets')
  const windowsIconPath = process.platform === 'win32'
    ? windowsTaskbarIcon(path.join(iconDirectory, 'pello-rounded.ico'), app.getPath('userData')) : ''
  win = new BrowserWindow({
    icon: process.platform === 'win32' ? windowsIconPath : path.join(iconDirectory, 'pello-rounded.png'),
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    useContentSize: true,
    x: process.env.AWB_CAPTURE ? 0 : undefined,
    y: process.env.AWB_CAPTURE ? 0 : undefined,
    frame: false,
    backgroundColor: workbenchTheme(theme).colors.side,
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
  if (process.platform === 'win32') {
    // The taskbar group uses Shell relaunch metadata independently of WM_SETICON.
    win.setAppDetails({
      appId: windowsAppId,
      appIconPath: windowsIconPath,
      appIconIndex: 0,
      relaunchCommand: app.isPackaged ? `"${process.execPath}"` : `"${process.execPath}" "${app.getAppPath()}"`,
      relaunchDisplayName: 'Pello'
    })
  }
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
    if (closing) closing.webContents.send('terminal:history-flush')
    // Preserve the PTY parent processes until their complete trees are killed.
    void Promise.all([closeAllSessions(), closeTransfers()]).catch((error) => console.error('Failed to close workbench tasks', error)).finally(() => {
      sessionsClosed = true
      if (closing && !closing.isDestroyed()) closing.destroy()
      app.quit()
    })
  })
  win.on('closed', () => {
    disposeDiagramRenderer()
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
  ipcMain.handle('diagram:mermaid', (event, source: string) => {
    if (!win || win.isDestroyed() || closingWindow) throw new Error('工作台正在关闭')
    if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('不允许此图表请求')
    return renderMermaid(win, source).catch((error) => { if (error instanceof DiagramCancelled) return ''; throw error })
  })
  ipcMain.handle('diagram:cancel', (event) => {
    if (event.sender === win?.webContents && event.senderFrame === win?.webContents.mainFrame) cancelDiagramRenderer()
  })
  ipcMain.handle('temporary:directory', () => temporaryDirectory())
  ipcMain.handle('temporary:configure', (_event, root: string) => {
    if (typeof root !== 'string') throw new Error('临时目录无效')
    return configureTemporaryDirectory(root)
  })
  ipcMain.handle('temporary:create', (_event, root?: string) => {
    if (root !== undefined && typeof root !== 'string') throw new Error('临时目录无效')
    return createTemporarySession(root)
  })
  ipcMain.on('files:dirty', (_event, dirty: boolean) => { hasUnsavedChanges = !!dirty })
  ipcMain.handle('db:get', async () => ({ db: db(), installed: await installedMap() }))
  ipcMain.handle('shells:local', () => discoverLocalShells())
  ipcMain.handle('db:settings', (_e, settings: Settings) => {
    const next = mutate((draft) => {
      draft.settings = settings
    })
    broadcastTheme(settings.theme)
    return next
  })
  ipcMain.handle('db:projects', (_e, projects: Project[]) => mutate((draft) => {
    draft.projects = projects
    if (draft.treeIgnores) for (const id of Object.keys(draft.treeIgnores)) if (!projects.some((project) => project.id === id)) delete draft.treeIgnores[id]
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
        return publicHost({ ...host, color: hostColor(host.color) })
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
  ipcMain.handle('resources:skill-open', async (_e, agent, item) => {
    const error = await shell.openPath(resources.skillDirectory(targets(), agent, item))
    if (error) throw new Error(error)
  })
  ipcMain.handle('resources:skill-delete', async (_e, agent, item) => {
    await shell.trashItem(resources.skillDirectory(targets(), agent, item, true))
  })
  ipcMain.handle('resources:mcp', (_e, name: string, config: Record<string, unknown>, agents: string[]) => resources.addMcp(targets(), name, config, agents))
  ipcMain.handle('resources:scan', (_e, kind: string, source: string) => kind === 'skills' ? resources.scanSkills(source).map((item) => ({ ...item, id: item.name })) : resources.scanMcp(source))
  ipcMain.handle('resources:import-mcp', (_e, source: string, agents: string[], ids: string[]) => resources.importMcpConfig(targets(), source, agents, ids))
  ipcMain.handle('resources:skills', (_e, source: string, agents: string[], names?: string[]) => resources.importSkills(targets(), source, agents, names))
  ipcMain.handle('resources:pick', async (_e, kind: string) => {
    if (!win) return null
    const result = await dialog.showOpenDialog(win, { properties: [kind === 'folder' ? 'openDirectory' : 'openFile'],
      filters: kind === 'folder' ? undefined : [{ name: kind === 'zip' ? 'ZIP 压缩包' : 'Agent 配置', extensions: kind === 'zip' ? ['zip'] : ['json', 'jsonc', 'toml', 'yaml', 'yml'] }] })
    return result.canceled ? null : result.filePaths[0] || null
  })
  ipcMain.handle('db:sessions', (_e, projectId: string, terms: SavedTerm[], activeId?: string | null, groups?: WorkSession[], selected?: string) => mutate((draft) => {
    if (!draft.projects.some((project) => project.id === projectId)) {
      delete draft.sessions[projectId]; delete draft.activeTab[projectId]
      if (draft.workSessions) delete draft.workSessions[projectId]
      if (draft.activeSession) delete draft.activeSession[projectId]
      return
    }
    writeSessions(draft, projectId, terms, activeId, groups, selected)
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

  ipcMain.handle('git:status', async (_e, projectId: string, rescan?: boolean) => {
    const { project, target } = projectTarget(projectId)
    const panel = await gitStatus(target, rescan === true)
    if (panel.isRepo && panel.branch && panel.branch !== project.branch) {
      mutate((draft) => {
        const item = draft.projects.find((p) => p.id === projectId)
        if (item) item.branch = panel.branch
      })
    }
    return { isRepo: panel.isRepo, branch: panel.branch, files: panel.files, repositories: panel.repositories, errors: panel.errors, untracked: panel.flags }
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
    return fileTree(target, rel, treeIgnored(projectId))
  })
  ipcMain.handle('tree:ignore-get', (_e, projectId: string) => {
    projectTarget(projectId)
    return db().treeIgnores?.[projectId] ?? TREE_DEFAULT_IGNORE
  })
  ipcMain.handle('tree:ignore-set', (_e, projectId: string, rules: string[]) => {
    projectTarget(projectId)
    if (!validTreeIgnores(rules)) throw new Error('请输入有效的目录名称')
    mutate((draft) => { draft.treeIgnores ??= {}; draft.treeIgnores[projectId] = [...new Set(rules)] })
  })
  ipcMain.handle('tree:create', async (_e, projectId: string, parent: string, name: string, directory: boolean) => {
    if (typeof parent !== 'string' || typeof name !== 'string' || typeof directory !== 'boolean') throw new Error('创建参数无效')
    return createTreeEntry(projectTarget(projectId).target, parent, name, directory)
  })
  ipcMain.handle('tree:rename', async (_e, projectId: string, rel: string, name: string, directory: boolean) => {
    if (typeof rel !== 'string' || typeof name !== 'string' || typeof directory !== 'boolean') throw new Error('重命名参数无效')
    const next = await renameTreeEntry(projectTarget(projectId).target, rel, name, directory)
    invalidatePreview(projectId, rel.replace(/\\/g, '/'))
    return next
  })
  ipcMain.handle('tree:move', async (_e, projectId: string, rel: string, parent: string, directory: boolean) => {
    if (typeof rel !== 'string' || typeof parent !== 'string' || typeof directory !== 'boolean') throw new Error('移动参数无效')
    const next = await moveTreeEntry(projectTarget(projectId).target, rel, parent, directory)
    invalidatePreview(projectId, rel.replace(/\\/g, '/'))
    return next
  })
  ipcMain.handle('tree:trash', async (_e, projectId: string, rel: string, directory: boolean) => {
    if (typeof rel !== 'string' || typeof directory !== 'boolean') throw new Error('删除参数无效')
    const { target, host } = projectTarget(projectId)
    const resolved = treePath(target, rel)
    if (resolved.relative === '.') throw new Error('不能删除项目根目录')
    if (host.id !== 'local') {
      await removeRemoteEntry(target, resolved.relative, directory)
      invalidatePreview(projectId, resolved.relative)
      return
    }
    const raw = path.resolve(fs.realpathSync(target.cwd), resolved.relative)
    const same = process.platform === 'win32' ? raw.toLowerCase() === resolved.full.toLowerCase() : raw === resolved.full
    const info = fs.lstatSync(raw)
    if (!same || info.isSymbolicLink()) throw new Error('不能通过符号链接删除项目文件')
    if (info.isDirectory() !== directory || (!info.isDirectory() && !info.isFile())) throw new Error('文件类型已更改，请刷新目录')
    await shell.trashItem(raw)
    invalidatePreview(projectId, resolved.relative)
  })
  ipcMain.handle('transfer:pick', async (_e, projectId: string, parent: string, kind: 'files' | 'directory') => {
    projectTarget(projectId)
    if (!win || (kind !== 'files' && kind !== 'directory')) throw new Error('导入参数无效')
    const choice = await dialog.showOpenDialog(win, { title: '选择导入来源', properties: kind === 'files' ? ['openFile', 'multiSelections'] : ['openDirectory'] })
    if (choice.canceled || !choice.filePaths.length) return null
    const fresh = projectTarget(projectId)
    if (fresh.host.id !== 'local') return startRemoteUpload(projectId, parent, choice.filePaths)
    const destination = treePath(fresh.target, parent).full
    if (!fs.statSync(destination).isDirectory()) throw new Error('目标不是目录')
    return transfers.start(choice.filePaths, destination, projectId)
  })
  ipcMain.handle('transfer:cancel', (_e, id: string) => { if (typeof id === 'string') { transfers.cancel(id); downloads.get(id)?.abort(); downloadTasks.cancel(id) } })
  ipcMain.handle('transfer:download', async (_e, projectId: string, rel: string, directory = false) => {
    if (!win || typeof rel !== 'string' || typeof directory !== 'boolean') throw new Error('下载参数无效')
    const { target, host } = projectTarget(projectId)
    if (host.id === 'local' || treePath(target, rel).relative === '.') throw new Error('请选择远程对象')
    let destination: string
    if (directory) {
      const choice = await dialog.showOpenDialog(win, { title: '选择下载位置', properties: ['openDirectory', 'createDirectory'] })
      if (choice.canceled || !choice.filePaths[0]) return null
      destination = choice.filePaths[0]
    } else {
      const choice = await dialog.showSaveDialog(win, { title: '下载文件（请选择新文件名）', defaultPath: rel.split('/').pop(), properties: ['createDirectory'] })
      if (choice.canceled || !choice.filePath) return null
      destination = choice.filePath
    }
    return downloadTasks.start(projectId, rel, destination, directory)
  })
  ipcMain.handle('transfer:decide', (_e, id: string, choice: UploadChoice, applyToBatch = false) => {
    if (!['skip', 'keep', 'cancel', 'merge', 'overwrite'].includes(choice) || typeof applyToBatch !== 'boolean') throw new Error('冲突处理方式无效')
    const remote = uploadDecisions.get(id)
    if (remote) { remote(choice, applyToBatch); return }
    if (choice !== 'cancel') validateTransferTarget(id)
    transfers.decide(id, choice, applyToBatch)
  })
  ipcMain.handle('transfer:dismiss', (_e, id: string) => { if (typeof id === 'string') { transfers.dismiss(id); downloadTasks.dismiss(id); if (uploadHistory.get(id)?.complete) uploadHistory.delete(id) } })
  ipcMain.handle('transfer:retry', (_e, id: string) => {
    if (downloadTasks.has(id)) return downloadTasks.retry(id)
    const remote = uploadHistory.get(id)
    if (remote) {
      if (!remote.complete || !remote.entries.length) throw new Error('没有可重试的失败项')
      const { target, host } = projectTarget(remote.projectId)
      if (host.id === 'local' || uploadIdentity(target, host) !== remote.identity) throw new Error('项目环境已更改')
      return startRemoteUpload(remote.projectId, '', [], remote.entries)
    }
    validateTransferTarget(id)
    return transfers.retry(id)
  })
  ipcMain.handle('transfer:keep-both', (_e, id: string) => {
    const remote = uploadHistory.get(id)
    if (remote) {
      if (!remote.complete || !remote.conflicts.length) throw new Error('没有同名冲突项')
      const fresh = projectTarget(remote.projectId)
      if (uploadIdentity(fresh.target, fresh.host) !== remote.identity) throw new Error('项目环境已更改')
      return startRemoteUpload(remote.projectId, '', [], remote.conflicts, true)
    }
    validateTransferTarget(id); return transfers.keepBoth(id)
  })
  ipcMain.handle('transfer:drop', (_e, projectId: string, parent: string, sources: string[]) => {
    const { target, host } = projectTarget(projectId)
    if (!Array.isArray(sources) || !sources.length || sources.length > 1000 || sources.some((item) => typeof item !== 'string' || !path.isAbsolute(item) || item.includes('\0'))) throw new Error('无法读取拖入文件的本机路径')
    if (host.id !== 'local') return startRemoteUpload(projectId, parent, sources)
    const destination = treePath(target, parent).full
    if (!fs.statSync(destination).isDirectory()) throw new Error('目标不是目录')
    return transfers.start(sources, destination, projectId)
  })
  ipcMain.handle('tree:search-start', (_e, projectId: string, id: string, query: string) => {
    projectTarget(projectId)
    if (!/^[\w-]{1,100}$/.test(id) || typeof query !== 'string' || !query.trim() || query.length > 500) throw new Error('搜索参数无效')
    treeSearches.set(id, { projectId, query: query.trim().toLocaleLowerCase(), pending: [''], cancelled: false, ignored: treeIgnored(projectId) })
  })
  ipcMain.handle('tree:search-cancel', (_e, id: string) => {
    const search = treeSearches.get(id)
    if (search) search.cancelled = true
    treeSearches.delete(id)
  })
  ipcMain.handle('tree:search-next', async (_e, id: string) => {
    const search = treeSearches.get(id)
    if (!search) return { items: [], done: true }
    const { target } = projectTarget(search.projectId)
    const items = []
    try {
      for (let count = 0; count < 8 && search.pending.length && !search.cancelled; count++) {
        const nodes = await fileTree(target, search.pending.shift()!, search.ignored)
        if (search.cancelled) break
        for (const node of nodes) {
          // Hidden tooling and cache folders are never useful search targets.
          if (node.dir) { if (!node.name.startsWith('.')) search.pending.push(node.path) }
          else if (node.path.toLocaleLowerCase().includes(search.query)) items.push(node)
        }
      }
      const done = search.cancelled || !search.pending.length
      if (done) treeSearches.delete(id)
      return { items: search.cancelled ? [] : items, done }
    } catch (error) { treeSearches.delete(id); throw error }
  })
  ipcMain.handle('git:read', async (_e, projectId: string, rel: string) => {
    const { target } = projectTarget(projectId)
    return readFile(target, rel)
  })
  ipcMain.handle('git:write', async (_e, projectId: string, rel: string, text: string, version: string) => {
    const { target } = projectTarget(projectId)
    const key = fileWriteKey(target, rel)
    if (replacementBlocked(key) || activeFileWrites.has(key)) throw new Error('文件正在进行其他写入操作')
    activeFileWrites.add(key)
    try { return await writeFile(target, rel, text, version) } finally { activeFileWrites.delete(key) }
  })
  ipcMain.on('file:replacement-ready', (_e, id: string, allow: boolean) => { if (typeof allow === 'boolean') replacementAnswers.get(id)?.(allow) })
  ipcMain.handle('file:preview-url', async (_e, projectId: string, rel: string, draft?: string) => previewUrl(projectId, projectTarget(projectId).target, rel, draft))
  ipcMain.handle('file:open-html', async (_e, projectId: string, rel: string) => openHtmlPreview(projectId, projectTarget(projectId).target, rel))
  ipcMain.handle('tree:menu', (_e, projectId: string, rel: string, directory: boolean) => new Promise<string | null>((resolve) => {
    const { target, host } = projectTarget(projectId)
    const resolved = treePath(target, rel)
    if (host.id === 'local' && fs.statSync(resolved.full).isDirectory() !== directory) throw new Error('文件类型已更改，请刷新目录')
    const action = (label: string, id: string): MenuItemConstructorOptions => ({ id, label, click: () => resolve(id) })
    const template: MenuItemConstructorOptions[] = []
    if (directory) {
      template.push(action('新建文件', 'create-file'), action('新建文件夹', 'create-directory'))
      template.push(action(host.id === 'local' ? '导入文件…' : '上传文件…', 'import-files'), action(host.id === 'local' ? '导入文件夹…' : '上传文件夹…', 'import-directory'))
      template.push({ type: 'separator' })
    }
    if (!directory) template.push(action('打开', 'open'), action('引用到当前终端', 'reference'), { type: 'separator' })
    if (resolved.relative !== '.') template.push(action('重命名', 'rename'), action('移动到…', 'move'))
    if (resolved.relative !== '.') template.push(action('删除', 'trash'))
    template.push({ label: '复制路径', submenu: [action('复制完整路径', 'copy-full'), action('复制项目相对路径', 'copy-relative')] })
    if (host.id === 'local') {
      template.push(action(directory ? '在资源管理器中打开' : '在资源管理器中显示', 'reveal'))
      if (!directory) {
        const editors = installedEditors(resolved.full)
        template.push({ label: '打开方式', submenu: [action('默认应用', 'open-default'), ...editors.map((editor) => action(editor.name, `editor:${editor.id}`))] }, action('另存为…', 'save-as'))
      }
    }
    else if (resolved.relative !== '.') template.push(action('下载…', 'download'))
    Menu.buildFromTemplate(template).popup({ window: win!, callback: () => resolve(null) })
  }))
  ipcMain.handle('tree:action', async (_e, projectId: string, rel: string, directory: boolean, action: string) => {
    const { target, host } = projectTarget(projectId)
    const resolved = treePath(target, rel)
    if (action === 'copy-full' || action === 'copy-relative') {
      clipboard.writeText(action === 'copy-full' ? resolved.full : resolved.relative)
      return
    }
    if (host.id !== 'local') throw new Error('远程项目不支持本机打开')
    if (fs.statSync(resolved.full).isDirectory() !== directory) throw new Error('文件类型已更改，请刷新目录')
    if (!directory && action.startsWith('editor:')) {
      const editor = installedEditors(resolved.full).find((item) => `editor:${item.id}` === action)
      if (!editor) throw new Error('该编辑器不可用，请重新打开菜单')
      await launchEditor(editor, resolved.full)
      return
    }
    if (action === 'save-as' && !directory) {
      if (!win) throw new Error('窗口不可用')
      const choice = await dialog.showSaveDialog(win, { title: '另存为（请选择新文件名）', defaultPath: resolved.full, properties: ['createDirectory'] })
      if (choice.canceled || !choice.filePath) return
      // Re-resolve the source after the picker, which may have been open for a long time.
      const source = treePath(projectTarget(projectId).target, rel).full
      if (!fs.statSync(source).isFile()) throw new Error('源文件已更改')
      try { await copyToNewFile(source, choice.filePath) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('目标已存在，请选择新的文件名', { cause: error })
        throw error
      }
      return
    }
    if (action === 'reveal' && !directory) { shell.showItemInFolder(resolved.full); return }
    if ((action === 'reveal' && directory) || (action === 'open-default' && !directory)) {
      const error = await shell.openPath(resolved.full)
      if (error) throw new Error(error)
      return
    }
    throw new Error('不支持此操作')
  })
  ipcMain.handle('tree:reference', (_e, projectId: string, rel: string, kind: string, termShell: ShellKind) => {
    const { target, host } = projectTarget(projectId)
    const resolved = treePath(target, rel)
    if (!rel || [...resolved.full].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new Error('此路径包含终端控制字符，无法引用')
    if (host.id === 'local' && !fs.statSync(resolved.full).isFile()) throw new Error('请选择文件')
    if (kind !== 'shell') return resolved.full
    if (termShell === 'pwsh') return psQuote(resolved.full)
    if (termShell === 'cmd') {
      if (/[%!"]/.test(resolved.full)) throw new Error('此路径无法安全引用到 CMD')
      return `"${resolved.full}"`
    }
    if (termShell === 'bash' || termShell === 'zsh') return bashQuote(host.id === 'local' && target.platform === 'windows' ? resolved.full.replaceAll('\\', '/') : resolved.full)
    throw new Error('不支持此终端')
  })
  ipcMain.handle('file:link', async (_event, projectId: string, source: string, href: string) => {
    if (typeof href !== 'string' || href.length > 8192) throw new Error('无效的链接')
    if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith('//')) {
      const url = new URL(href.startsWith('//') ? `https:${href}` : href)
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('仅支持网页链接和项目内文件链接')
      await shell.openExternal(url.href)
      return null
    }
    const { target } = projectTarget(projectId)
    const from = treePath(target, source).relative
    const hash = href.indexOf('#')
    const link = decodeURIComponent((hash < 0 ? href : href.slice(0, hash)).split('?')[0])
    const anchor = hash < 0 ? undefined : decodeURIComponent(href.slice(hash + 1))
    const relative = !link ? from : path.posix.normalize(link.startsWith('/') ? link.slice(1) : path.posix.join(path.posix.dirname(from), link))
    return { path: treePath(target, relative).relative, anchor }
  })
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

  ipcMain.handle('terminal:menu', (_e, options: { horizontal: boolean; vertical: boolean; merge: boolean; reconnect?: boolean }) => new Promise<string | null>((resolve) => {
    const action = (label: string, id: string, enabled = true): MenuItemConstructorOptions => ({ id, label, enabled, click: () => resolve(id) })
    Menu.buildFromTemplate([...(options.reconnect ? [action('重新连接会话', 'reconnect'), { type: 'separator' as const }] : []), action('重命名终端', 'rename'), { type: 'separator' }, action('向左分栏', 'split-left', options.horizontal), action('向右分栏', 'split-right', options.horizontal), action('向上分栏', 'split-up', options.vertical), action('向下分栏', 'split-down', options.vertical), { type: 'separator' }, action('撤销分栏（合并）', 'merge', options.merge)]).popup({ window: win!, callback: () => resolve(null) })
  }))

  ipcMain.handle('pty:create', (_e, req: { id: string; projectId: string; kind: string; shell: ShellKind; agentSessionId?: string }) => {
    if (closingWindow || quitting) throw new Error('工作台正在关闭')
    return createSession(send, req)
  })
  ipcMain.handle('terminal:history', (_e, id: string) => typeof id === 'string' && id ? loadTerminalHistory(id) : '')
  ipcMain.on('terminal:history-save', (_e, id: string, text: string) => {
    if (typeof id === 'string' && id && typeof text === 'string' && text.length <= 2_000_000) saveTerminalHistory(id, text)
  })
  ipcMain.on('pty:write', (_e, id: string, data: string, binary = false) => { if (!closingWindow && !quitting) writeSession(id, String(data), !!binary) })
  ipcMain.on('pty:resize', (_e, id: string, cols: number, rows: number) => { if (!closingWindow && !quitting) resizeSession(id, cols, rows) })
  ipcMain.handle('pty:interrupt', (_e, id: string) => closingWindow || quitting ? 'signal' : interruptSession(id))
  ipcMain.handle('pty:kill', (_e, id: string) => { if (!closingWindow && !quitting) return killSession(id) })
  ipcMain.handle('pty:restart', (_e, id: string) => {
    if (closingWindow || quitting) throw new Error('工作台正在关闭')
    return restartSession(id)
  })
  ipcMain.handle('pty:close', async (_e, id: string) => {
    if (closingWindow || quitting) return closeAllSessions()
    await closeSession(id)
    deleteTerminalHistory(id)
  })

  ipcMain.handle('exec:test', async (_e, req: { cmd: string; args: string; shell: ShellKind; env: { k: string; v: string; secret: boolean }[]; cwd?: string }) => {
    if (closingWindow || quitting) throw new Error('工作台正在关闭')
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
  pruneTerminalHistory(Object.values(db().sessions).flat().map((term) => term.id))
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
  void Promise.all([closeAllSessions(), closeTransfers()]).catch((error) => console.error('Failed to close workbench tasks', error)).finally(() => {
    sessionsClosed = true
    app.quit()
  })
})
