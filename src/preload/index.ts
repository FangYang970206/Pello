import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { PtyEvent } from '../shared/types'
import type { WorkbenchApi } from '../shared/api'

const api: WorkbenchApi = {
  getState: () => ipcRenderer.invoke('db:get'),
  localShells: () => ipcRenderer.invoke('shells:local'),
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
  temporaryDirectory: () => ipcRenderer.invoke('temporary:directory'),
  configureTemporaryDirectory: (root) => ipcRenderer.invoke('temporary:configure', root),
  createTemporarySession: (root) => ipcRenderer.invoke('temporary:create', root),
  checkPath: (hostId, input) => ipcRenderer.invoke('path:check', hostId, input),
  listDir: (hostId, input) => ipcRenderer.invoke('path:list', hostId, input),
  gitStatus: (projectId, rescan) => ipcRenderer.invoke('git:status', projectId, rescan),
  gitDiff: (projectId, rel, untracked) => ipcRenderer.invoke('git:diff', projectId, rel, untracked),
  gitDiscard: (projectId, rel, untracked) => ipcRenderer.invoke('git:discard', projectId, rel, untracked),
  gitTree: (projectId, rel) => ipcRenderer.invoke('git:tree', projectId, rel),
  treeIgnoreGet: (projectId) => ipcRenderer.invoke('tree:ignore-get', projectId),
  treeIgnoreSet: (projectId, rules) => ipcRenderer.invoke('tree:ignore-set', projectId, rules),
  treeCreate: (projectId, parent, name, directory) => ipcRenderer.invoke('tree:create', projectId, parent, name, directory),
  treeRename: (projectId, rel, name, directory) => ipcRenderer.invoke('tree:rename', projectId, rel, name, directory),
  treeMove: (projectId, rel, parent, directory) => ipcRenderer.invoke('tree:move', projectId, rel, parent, directory),
  treeTrash: (projectId, rel, directory) => ipcRenderer.invoke('tree:trash', projectId, rel, directory),
  transferPick: (projectId, parent, kind) => ipcRenderer.invoke('transfer:pick', projectId, parent, kind),
  droppedFilePath: (file) => webUtils.getPathForFile(file),
  transferDrop: (projectId, parent, sources) => ipcRenderer.invoke('transfer:drop', projectId, parent, sources),
  transferCancel: (id) => ipcRenderer.invoke('transfer:cancel', id),
  transferDownload: (projectId, rel, directory) => ipcRenderer.invoke('transfer:download', projectId, rel, directory),
  transferDecide: (id, choice, applyToBatch) => ipcRenderer.invoke('transfer:decide', id, choice, applyToBatch),
  replacementReady: (id, allow) => ipcRenderer.send('file:replacement-ready', id, allow),
  onReplacement: (cb) => {
    const listener = (_event: Electron.IpcRendererEvent, event: Parameters<typeof cb>[0]) => cb(event)
    ipcRenderer.on('file:replacement', listener)
    return () => { ipcRenderer.removeListener('file:replacement', listener) }
  },
  transferRetry: (id) => ipcRenderer.invoke('transfer:retry', id),
  transferKeepBoth: (id) => ipcRenderer.invoke('transfer:keep-both', id),
  transferDismiss: (id) => ipcRenderer.invoke('transfer:dismiss', id),
  onTransfer: (cb) => {
    const listener = (_event: unknown, payload: import('../shared/types').TransferSnapshot) => cb(payload)
    ipcRenderer.on('transfer:update', listener)
    return () => ipcRenderer.removeListener('transfer:update', listener)
  },
  treeSearchStart: (projectId, id, query) => ipcRenderer.invoke('tree:search-start', projectId, id, query),
  treeSearchNext: (id) => ipcRenderer.invoke('tree:search-next', id),
  treeSearchCancel: (id) => ipcRenderer.invoke('tree:search-cancel', id),
  gitRead: (projectId, rel) => ipcRenderer.invoke('git:read', projectId, rel),
  gitWrite: (projectId, rel, text, version) => ipcRenderer.invoke('git:write', projectId, rel, text, version),
  previewUrl: (projectId, rel, draft) => ipcRenderer.invoke('file:preview-url', projectId, rel, draft),
  renderMermaid: (source) => ipcRenderer.invoke('diagram:mermaid', source),
  cancelDiagrams: () => ipcRenderer.invoke('diagram:cancel'),
  openHtmlPreview: (projectId, rel) => ipcRenderer.invoke('file:open-html', projectId, rel),
  treeMenu: (projectId, rel, directory) => ipcRenderer.invoke('tree:menu', projectId, rel, directory),
  treeAction: (projectId, rel, directory, action) => ipcRenderer.invoke('tree:action', projectId, rel, directory, action),
  treeReference: (projectId, rel, kind, shell) => ipcRenderer.invoke('tree:reference', projectId, rel, kind, shell),
  documentMenu: (options) => ipcRenderer.invoke('file:menu', options),
  documentLink: (projectId, source, href) => ipcRenderer.invoke('file:link', projectId, source, href),
  terminalMenu: (options) => ipcRenderer.invoke('terminal:menu', options),
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
