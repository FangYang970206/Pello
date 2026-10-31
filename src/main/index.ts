import { app, BrowserWindow, dialog, ipcMain, nativeTheme } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { PRESETS, type Executor, type Host, type Plugin, type Project, type SavedTerm, type Settings, type ShellKind } from '../shared/types'
import { db, mutate } from './store'
import { commandExists, osLabel } from './platform'
import { checkPath, fileTree, gitDiff, gitDiscard, gitStatus, listDir, readFile, targetFor } from './git'
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
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

if (process.env.AWB_USER_DATA) app.setPath('userData', process.env.AWB_USER_DATA)
if (process.env.AWB_CAPTURE) {
  app.commandLine.appendSwitch('force-device-scale-factor', '1')
  app.disableHardwareAcceleration()
}

let win: BrowserWindow | null = null

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
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    const url = process.env.AWB_CAPTURE ? devUrl + (devUrl.includes('?') ? '&' : '?') + 'capture=1' : devUrl
    void win.loadURL(url)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'), {
      query: process.env.AWB_CAPTURE ? { capture: '1' } : undefined
    })
  }
  win.on('closed', () => {
    win = null
  })
}

function registerIpc(): void {
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
    draft.custom = custom
  }))
  ipcMain.handle('db:hosts', (_e, hosts: Host[]) => mutate((draft) => {
    const local = hosts.find((h) => h.id === 'local')
    if (local) {
      local.on = true
      local.os = local.os || osLabel()
    }
    draft.hosts = hosts
  }))
  ipcMain.handle('db:plugins', (_e, plugins: Plugin[]) => mutate((draft) => {
    draft.plugins = plugins
  }))
  ipcMain.handle('db:sessions', (_e, projectId: string, terms: SavedTerm[]) => mutate((draft) => {
    draft.sessions[projectId] = terms
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
  ipcMain.handle('git:tree', async (_e, projectId: string) => {
    const { target } = projectTarget(projectId)
    return fileTree(target)
  })
  ipcMain.handle('git:read', async (_e, projectId: string, rel: string) => {
    const { target } = projectTarget(projectId)
    return readFile(target, rel)
  })

  ipcMain.handle('pty:create', (_e, req: { id: string; projectId: string; kind: string; shell: ShellKind }) => {
    return createSession(send, req)
  })
  ipcMain.on('pty:write', (_e, id: string, data: string) => writeSession(id, String(data)))
  ipcMain.on('pty:resize', (_e, id: string, cols: number, rows: number) => resizeSession(id, cols, rows))
  ipcMain.handle('pty:interrupt', (_e, id: string) => interruptSession(id))
  ipcMain.handle('pty:kill', (_e, id: string) => killSession(id))
  ipcMain.handle('pty:restart', (_e, id: string) => restartSession(id))
  ipcMain.on('pty:close', (_e, id: string) => closeSession(id))

  ipcMain.handle('exec:test', async (_e, req: { cmd: string; args: string; shell: ShellKind; env: { k: string; v: string; secret: boolean }[]; cwd?: string }) => {
    return testExecutor({
      cmd: req.cmd || '',
      args: req.args || '',
      shell: req.shell || 'bash',
      env: Array.isArray(req.env) ? req.env : [],
      cwd: req.cwd || ''
    })
  })

  ipcMain.handle('host:test', async (_e, host: Host) => {
    if (!host.addr || !host.user) return { ok: false, error: '请填写用户和地址' }
    try {
      const probe = 'uname -s 2>/dev/null || ver'
      const { stdout } = await execFileP('ssh', sshBatchArgs(host, [probe]), { timeout: 12000, windowsHide: true })
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
  })

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
    const safe = path.basename(String(name)).replace(/[^\w.\-]+/g, '_')
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
  closeAllSessions()
  app.quit()
})

app.on('before-quit', () => closeAllSessions())
