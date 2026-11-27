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

let unsavedWrite = Promise.resolve()

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
  saveCustom: (custom, bindings) => call('db:custom', bindings === undefined ? [custom] : [custom, bindings]),
  saveHosts: (hosts) => call('db:hosts', [hosts]),
  saveTemplate: (template) => call('templates:save', [template]),
  bindTemplate: (scope, templateId) => call('templates:bind', [scope, templateId]),
  deleteTemplate: (id) => call('templates:delete', [id]),
  resourceTargets: (hostId) => call('resources:targets', hostId === undefined ? [] : [hostId]),
  resourceList: (kind, agent, page, query) => call('resources:list', [kind, agent, page, query]),
  resourceToggle: (kind, agent, item, enabled) => call('resources:toggle', [kind, agent, item, enabled]),
  resourceDetail: (kind, agent, item) => call('resources:detail', [kind, agent, item]),
  openSkillFolder: (agent, item) => call('resources:skill-open', [agent, item]),
  deleteSkill: (agent, item) => call('resources:skill-delete', [agent, item]),
  addMcp: (name, config, agents) => call('resources:mcp', [name, config, agents]),
  openSkillRecommendation: (id) => call('resources:open-recommendation', [id]),
  scanResources: (kind, source, hostId) => call('resources:scan', hostId === undefined ? [kind, source] : [kind, source, hostId]),
  importMcpConfig: (source, agents, ids, hostId) => call('resources:import-mcp', hostId === undefined ? [source, agents, ids] : [source, agents, ids, hostId]),
  importSkills: (source, agents, names) => call('resources:skills', [source, agents, names]),
  pickResource: (kind) => call('resources:pick', [kind]),
  saveSessions: (projectId, terms, activeId, groups, selected) => call('db:sessions', [projectId, terms, activeId ?? null, groups, selected]),
  saveBranch: (projectId, branch) => call('db:branch', [projectId, branch]),
  setUnsavedChanges: (dirty) => { unsavedWrite = unsavedWrite.then(() => call('files:dirty', [dirty])).then(() => {}, () => {}) },
  pickDirectory: () => call('dialog:directory'),
  picker: (request) => call('dialog:picker', [request]),
  temporaryDirectory: () => call('temporary:directory'),
  configureTemporaryDirectory: (root) => call('temporary:configure', [root]),
  createTemporarySession: (root) => call('temporary:create', [root ?? null]),
  checkPath: (hostId, input) => call('path:check', [hostId, input]),
  listDir: (hostId, input) => call('path:list', [hostId, input]),
  browseResources: (hostId, input, files) => call('resources:browse', [hostId, input, files]),
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
  transferDrop: async (projectId, parent, sources) => { await unsavedWrite; return call('transfer:drop', [projectId, parent, sources]) },
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
  previewMenu: () => call('preview:menu'),
  documentLink: (projectId, source, href) => call('file:link', [projectId, source, href]),
  paneMenu: (options) => call('workspace:menu', [options]),
  onPreviewSource: (callback) => subscribe('file:preview-source', (payload) => callback(payload as string)),
  ptyCreate: (request) => call('pty:create', [request]),
  ptyWrite: (id, data, binary) => { void call('pty:write', [id, data, binary ?? false]) },
  ptyShiftEnter: (id) => { void call('pty:shift-enter', [id]) },
  ptyResize: (id, cols, rows) => { void call('pty:resize', [id, cols, rows]) },
  ptyInterrupt: (id) => call('pty:interrupt', [id]),
  ptyKill: (id) => call('pty:kill', [id]),
  ptyRestart: (id) => call('pty:restart', [id]),
  ptyClose: (id) => call('pty:close', [id]),
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
  meta: () => call('app:meta'),
  openHomepage: () => call('app:homepage')
}

/**
 * Keep the keyboard in the page when Tab would leave it at an end.
 *
 * The page is the only control in the window, but WebView2 is made for a window that has others: past the last control, or before the first with Shift+Tab, it hands the keyboard focus to the window around it and takes it back on the next key. Electron's window hands it straight back. Here one Tab at an end reached nothing, and a second was needed to get to the other end. So at an end the page turns the focus round itself, in the scope the focus is in: an open modal dialog, or the page when none is.
 *
 * Two listeners, one for each scope, because each has to be at the other end of the key's way. A native file dialog keeps the key to itself and stops it on its way up, so a listener that waits for the key to bubble to the page never hears it: the dialog's scope is heard on the way down. On the page a control may take Tab for its own use, as the source editor does for two spaces, and it is heard before anything above it only on the way up: there the listener is the last, and a key that was taken is left alone.
 */
function turnTabRoundAtEnds(): void {
  const modal = 'dialog[open], [role=dialog][aria-modal=true]'
  const controls = (scope: ParentNode): HTMLElement[] => [...scope.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]')]
    .filter((node) => !((node as HTMLButtonElement).disabled) && node.tabIndex >= 0 && !node.closest('[inert]'))
  const topDialog = (): Element | undefined => [...document.querySelectorAll(modal)].pop()
  const turn = (event: KeyboardEvent, scope: ParentNode) => {
    const order = controls(scope)
    const index = order.findIndex((node) => node === document.activeElement)
    const atEnd = event.shiftKey ? index <= 0 : index === -1 || index === order.length - 1
    if (!atEnd || order.length === 0) return
    event.preventDefault()
    ;(event.shiftKey ? order[order.length - 1] : order[0]).focus()
  }
  const taken = (event: KeyboardEvent) => event.defaultPrevented || event.isComposing || event.ctrlKey || event.altKey || event.metaKey
  // On the way down: only inside the dialog that is on top.
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab' || taken(event)) return
    const dialog = topDialog()
    if (!dialog || !dialog.contains(document.activeElement)) return
    turn(event, dialog)
  }, true)
  // On the way up, after the control the key was typed in: only on the page,
  // with no dialog on top of it.
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab' || taken(event) || topDialog()) return
    turn(event, document)
  })
}

/** Install `window.awb` when the page is hosted by Tauri. Electron keeps using the preload bridge. */
export function installTauriWorkbench(): boolean {
  if (!('__TAURI_INTERNALS__' in window)) return false
  if (!listening) {
    listening = true
    void listen<{ channel: string; payload: unknown }>('awb', (event) => publish(event.payload.channel, event.payload.payload))
  }
  window.awb = api
  turnTabRoundAtEnds()
  return true
}
