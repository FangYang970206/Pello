import { contextBridge, ipcRenderer } from 'electron'
import type { PtyEvent } from '../shared/types'
import type { WorkbenchApi } from '../shared/api'

const api: WorkbenchApi = {
  getState: () => ipcRenderer.invoke('db:get'),
  saveSettings: (settings) => ipcRenderer.invoke('db:settings', settings),
  saveProjects: (projects) => ipcRenderer.invoke('db:projects', projects),
  saveCustom: (custom) => ipcRenderer.invoke('db:custom', custom),
  saveHosts: (hosts) => ipcRenderer.invoke('db:hosts', hosts),
  savePlugins: (plugins) => ipcRenderer.invoke('db:plugins', plugins),
  saveSessions: (projectId, terms, activeId) => ipcRenderer.invoke('db:sessions', projectId, terms, activeId),
  saveBranch: (projectId, branch) => ipcRenderer.invoke('db:branch', projectId, branch),
  setUnsavedChanges: (dirty) => ipcRenderer.send('files:dirty', dirty),
  pickDirectory: () => ipcRenderer.invoke('dialog:directory'),
  checkPath: (hostId, input) => ipcRenderer.invoke('path:check', hostId, input),
  listDir: (hostId, input) => ipcRenderer.invoke('path:list', hostId, input),
  gitStatus: (projectId) => ipcRenderer.invoke('git:status', projectId),
  gitDiff: (projectId, rel, untracked) => ipcRenderer.invoke('git:diff', projectId, rel, untracked),
  gitDiscard: (projectId, rel, untracked) => ipcRenderer.invoke('git:discard', projectId, rel, untracked),
  gitTree: (projectId, rel) => ipcRenderer.invoke('git:tree', projectId, rel),
  gitRead: (projectId, rel) => ipcRenderer.invoke('git:read', projectId, rel),
  gitWrite: (projectId, rel, text, version) => ipcRenderer.invoke('git:write', projectId, rel, text, version),
  previewUrl: (projectId, rel) => ipcRenderer.invoke('file:preview-url', projectId, rel),
  openHtmlPreview: (projectId, rel) => ipcRenderer.invoke('file:open-html', projectId, rel),
  ptyCreate: (req) => ipcRenderer.invoke('pty:create', req),
  ptyWrite: (id, data, binary) => ipcRenderer.send('pty:write', id, data, binary),
  ptyResize: (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows),
  ptyInterrupt: (id) => ipcRenderer.invoke('pty:interrupt', id),
  ptyKill: (id) => ipcRenderer.invoke('pty:kill', id),
  ptyRestart: (id) => ipcRenderer.invoke('pty:restart', id),
  ptyClose: (id) => ipcRenderer.invoke('pty:close', id),
  onPty: (cb) => {
    const listener = (_event: unknown, payload: PtyEvent) => cb(payload)
    ipcRenderer.on('pty:event', listener)
    return () => ipcRenderer.removeListener('pty:event', listener)
  },
  testExec: (req) => ipcRenderer.invoke('exec:test', req),
  testHost: (host) => ipcRenderer.invoke('host:test', host),
  winMin: () => ipcRenderer.invoke('win:min'),
  winMax: () => ipcRenderer.invoke('win:max'),
  winClose: () => ipcRenderer.invoke('win:close'),
  winResize: (width, height) => ipcRenderer.invoke('win:resize', width, height),
  shot: (name) => ipcRenderer.invoke('app:shot', name),
  meta: () => ipcRenderer.invoke('app:meta')
}

contextBridge.exposeInMainWorld('awb', api)
