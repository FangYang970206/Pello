import { contextBridge, ipcRenderer } from 'electron'
import type { PtyEvent } from '../shared/types'
import type { WorkbenchApi } from '../shared/api'

const api: WorkbenchApi = {
  getState: () => ipcRenderer.invoke('db:get'),
  saveSettings: (settings) => ipcRenderer.invoke('db:settings', settings),
  saveProjects: (projects) => ipcRenderer.invoke('db:projects', projects),
  saveCustom: (custom) => ipcRenderer.invoke('db:custom', custom),
  saveHosts: (hosts) => ipcRenderer.invoke('db:hosts', hosts),
  resourceTargets: () => ipcRenderer.invoke('resources:targets'),
  saveResourceTarget: (target) => ipcRenderer.invoke('resources:target', target),
  resourceList: (kind, agent, page, query) => ipcRenderer.invoke('resources:list', kind, agent, page, query),
  resourceToggle: (kind, agent, item, enabled) => ipcRenderer.invoke('resources:toggle', kind, agent, item, enabled),
  resourceDetail: (kind, agent, item) => ipcRenderer.invoke('resources:detail', kind, agent, item),
  openSkillFolder: (agent, item) => ipcRenderer.invoke('resources:skill-open', agent, item),
  deleteSkill: (agent, item) => ipcRenderer.invoke('resources:skill-delete', agent, item),
  addMcp: (name, config, agents) => ipcRenderer.invoke('resources:mcp', name, config, agents),
  scanResources: (kind, source) => ipcRenderer.invoke('resources:scan', kind, source),
  importMcpConfig: (source, agents, ids) => ipcRenderer.invoke('resources:import-mcp', source, agents, ids),
  importSkills: (source, agents, names) => ipcRenderer.invoke('resources:skills', source, agents, names),
  pickResource: (kind) => ipcRenderer.invoke('resources:pick', kind),
  saveSessions: (projectId, terms, activeId, groups, selected) => ipcRenderer.invoke('db:sessions', projectId, terms, activeId, groups, selected),
  saveBranch: (projectId, branch) => ipcRenderer.invoke('db:branch', projectId, branch),
  setUnsavedChanges: (dirty) => ipcRenderer.send('files:dirty', dirty),
  pickDirectory: () => ipcRenderer.invoke('dialog:directory'),
  checkPath: (hostId, input) => ipcRenderer.invoke('path:check', hostId, input),
  listDir: (hostId, input) => ipcRenderer.invoke('path:list', hostId, input),
  gitStatus: (projectId, rescan) => ipcRenderer.invoke('git:status', projectId, rescan),
  gitDiff: (projectId, rel, untracked) => ipcRenderer.invoke('git:diff', projectId, rel, untracked),
  gitDiscard: (projectId, rel, untracked) => ipcRenderer.invoke('git:discard', projectId, rel, untracked),
  gitTree: (projectId, rel) => ipcRenderer.invoke('git:tree', projectId, rel),
  gitRead: (projectId, rel) => ipcRenderer.invoke('git:read', projectId, rel),
  gitWrite: (projectId, rel, text, version) => ipcRenderer.invoke('git:write', projectId, rel, text, version),
  previewUrl: (projectId, rel, draft) => ipcRenderer.invoke('file:preview-url', projectId, rel, draft),
  openHtmlPreview: (projectId, rel) => ipcRenderer.invoke('file:open-html', projectId, rel),
  documentMenu: (options) => ipcRenderer.invoke('file:menu', options),
  onPreviewSource: (cb) => {
    const listener = () => cb()
    ipcRenderer.on('file:preview-source', listener)
    return () => ipcRenderer.removeListener('file:preview-source', listener)
  },
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
