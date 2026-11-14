import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { WorkbenchApi } from '../shared/api'

type Handler = (payload: unknown) => void
const listeners = new Map<string, Set<Handler>>()
let listening = false

function publish(channel: string, payload: unknown) {
  listeners.get(channel)?.forEach((callback) => callback(payload))
}

function subscribe(channel: string, callback: Handler) {
  const set = listeners.get(channel) ?? new Set<Handler>()
  set.add(callback)
  listeners.set(channel, set)
  return () => { set.delete(callback) }
}

async function call<T>(channel: string, args: unknown[] = []): Promise<T> {
  try {
    return await invoke<T>('awb', { channel, args })
  } catch (error) {
    const message = typeof error === 'string' ? error : error instanceof Error ? error.message : String(error)
    throw new Error(message, { cause: error })
  }
}

const api: WorkbenchApi = {
  appUpdateState: () => call('app:update-state'),
  checkAppUpdate: () => call('app:update-check'),
  downloadAppUpdate: () => call('app:update-download'),
  installAppUpdate: () => call('app:update-install'),
  onAppUpdate: (callback) => subscribe('app:update', (payload) => callback(payload as Parameters<typeof callback>[0])),
  getState: () => call('db:get'),
  localShells: () => call('shells:local'),
  saveSettings: (settings) => call('db:settings', [settings]),
  saveProjects: (projects) => call('db:projects', [projects]),
  saveCustom: (custom) => call('db:custom', [custom]),
  saveHosts: (hosts) => call('db:hosts', [hosts]),
  resourceTargets: () => call('resources:targets'),
  saveResourceTarget: (target) => call('resources:target', [target]),
  resourceList: (kind, agent, page, query) => call('resources:list', [kind, agent, page, query]),
  resourceToggle: (kind, agent, item, enabled) => call('resources:toggle', [kind, agent, item, enabled]),
  resourceDetail: (kind, agent, item) => call('resources:detail', [kind, agent, item]),
  openSkillFolder: (agent, item) => call('resources:skill-open', [agent, item]),
  deleteSkill: (agent, item) => call('resources:skill-delete', [agent, item]),
  addMcp: (name, config, agents) => call('resources:mcp', [name, config, agents]),
  scanResources: (kind, source) => call('resources:scan', [kind, source]),
  importMcpConfig: (source, agents, ids) => call('resources:import-mcp', [source, agents, ids]),
  importSkills: (source, agents, names) => call('resources:skills', [source, agents, names]),
  pickResource: (kind) => call('resources:pick', [kind]),
  saveSessions: (projectId, terms, activeId, groups, selected) => call('db:sessions', [projectId, terms, activeId ?? null, groups, selected]),
  saveBranch: (projectId, branch) => call('db:branch', [projectId, branch]),
  setUnsavedChanges: (dirty) => { void call('files:dirty', [dirty]) },
  pickDirectory: () => call('dialog:directory'),
  picker: (request) => call('dialog:picker', [request]),
  temporaryDirectory: () => call('temporary:directory'),
  configureTemporaryDirectory: (root) => call('temporary:configure', [root]),
  createTemporarySession: (root) => call('temporary:create', [root ?? null]),
  checkPath: (hostId, input) => call('path:check', [hostId, input]),
  listDir: (hostId, input) => call('path:list', [hostId, input]),
  gitStatus: (projectId, rescan) => call('git:status', [projectId, rescan ?? false]),
  gitDiff: (projectId, rel, untracked) => call('git:diff', [projectId, rel, untracked]),
  gitDiscard: (projectId, rel, untracked) => call('git:discard', [projectId, rel, untracked]),
  gitTree: (projectId, rel) => call('git:tree', [projectId, rel ?? '']),
  treeIgnoreGet: (projectId) => call('tree:ignore-get', [projectId]),
  treeIgnoreSet: (projectId, rules) => call('tree:ignore-set', [projectId, rules]),
  treeCreate: (projectId, parent, name, directory) => call('tree:create', [projectId, parent, name, directory]),
  treeRename: (projectId, rel, name, directory) => call('tree:rename', [projectId, rel, name, directory]),
  treeMove: (projectId, rel, parent, directory) => call('tree:move', [projectId, rel, parent, directory]),
  treeTrash: (projectId, rel, directory) => call('tree:trash', [projectId, rel, directory]),
  transferPick: (projectId, parent, kind) => call('transfer:pick', [projectId, parent, kind]),
  droppedFilePath: () => '',
  transferDrop: (projectId, parent, sources) => call('transfer:drop', [projectId, parent, sources]),
  transferCancel: (id) => call('transfer:cancel', [id]),
  transferDownload: (projectId, rel, directory) => call('transfer:download', [projectId, rel, directory ?? false]),
  transferDecide: (id, choice, applyToBatch) => call('transfer:decide', [id, choice, applyToBatch ?? false]),
  onReplacement: (callback) => subscribe('file:replacement', (payload) => callback(payload as Parameters<typeof callback>[0])),
  replacementReady: (id, allow) => { void call('file:replacement-ready', [id, allow]) },
  transferRetry: (id) => call('transfer:retry', [id]),
  transferKeepBoth: (id) => call('transfer:keep-both', [id]),
  transferDismiss: (id) => call('transfer:dismiss', [id]),
  onTransfer: (callback) => subscribe('transfer:update', (payload) => callback(payload as Parameters<typeof callback>[0])),
  treeSearchStart: (projectId, id, query) => call('tree:search-start', [projectId, id, query]),
  treeSearchNext: (id) => call('tree:search-next', [id]),
  treeSearchCancel: (id) => call('tree:search-cancel', [id]),
  contentSearchStart: (projectId, id, query, sensitive, regex, whole) => call('content:search-start', [projectId, id, query, sensitive, regex ?? false, whole ?? false]),
  contentSearchNext: (id) => call('content:search-next', [id]),
  contentSearchCancel: (id) => call('content:search-cancel', [id]),
  gitRead: (projectId, rel) => call('git:read', [projectId, rel]),
  gitWrite: (projectId, rel, text, version) => call('git:write', [projectId, rel, text, version]),
  previewUrl: (projectId, rel, draft) => call('file:preview-url', [projectId, rel, draft]),
  renderMermaid: (source) => call('diagram:mermaid', [source]),
  cancelDiagrams: () => call('diagram:cancel'),
  openHtmlPreview: (projectId, rel) => call('file:open-html', [projectId, rel]),
  treeMenu: (projectId, rel, directory) => call('tree:menu', [projectId, rel, directory]),
  treeAction: (projectId, rel, directory, action) => call('tree:action', [projectId, rel, directory, action]),
  treeReference: (projectId, rel, kind, shell) => call('tree:reference', [projectId, rel, kind, shell]),
  documentMenu: (options) => call('file:menu', [options]),
  documentLink: (projectId, source, href) => call('file:link', [projectId, source, href]),
  terminalMenu: (options) => call('terminal:menu', [options]),
  onPreviewSource: (callback) => subscribe('file:preview-source', () => callback()),
  ptyCreate: (request) => call('pty:create', [request]),
  ptyWrite: (id, data, binary) => { void call('pty:write', [id, data, binary ?? false]) },
  ptyResize: (id, cols, rows) => { void call('pty:resize', [id, cols, rows]) },
  ptyInterrupt: (id) => call('pty:interrupt', [id]),
  ptyKill: (id) => call('pty:kill', [id]),
  ptyRestart: (id) => call('pty:restart', [id]),
  ptyClose: (id) => call('pty:close', [id]),
  terminalSplit: (request) => call('terminal:split', [request]),
  terminalHistory: (id) => call('terminal:history', [id]),
  exportTerminalHistory: (id) => call('terminal:export', [id]),
  saveTerminalHistory: (id, text) => { void call('terminal:history-save', [id, text]) },
  onFlushTerminalHistory: (callback) => subscribe('terminal:history-flush', () => { void callback().finally(() => { void call('terminal:history-flushed') }) }),
  onPty: (callback) => subscribe('pty:event', (payload) => callback(payload as Parameters<typeof callback>[0])),
  testExec: (request) => call('exec:test', [request]),
  testHost: (host) => call('host:test', [host]),
  winMin: () => call('win:min'),
  winMax: () => call('win:max'),
  winClose: () => call('win:close'),
  winResize: (width, height) => call('win:resize', [width, height]),
  shot: (name) => call('app:shot', [name]),
  meta: () => call('app:meta')
}

/** Install `window.awb` when the page is hosted by Tauri. Electron keeps using the preload bridge. */
export function installTauriWorkbench(): boolean {
  if (!('__TAURI_INTERNALS__' in window)) return false
  if (!listening) {
    listening = true
    void listen<{ channel: string; payload: unknown }>('awb', (event) => publish(event.payload.channel, event.payload.payload))
  }
  window.awb = api
  return true
}
