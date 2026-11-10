import type {
  Database,
  DirListing,
  Executor,
  FileDiff,
  FileContent,
  GitFile,
  GitPanel,
  Host,
  HostTest,
  PathCheck,
  ResourceTarget,
  ResourcePage,
  ResourceResult,
  ResourceItem,
  ResourceDetail,
  Project,
  PtyCreateRequest,
  PtyEvent,
  SavedTerm,
  Settings,
  ShellKind,
  LocalShell,
  TestExecRequest,
  TreeNode,
  TransferSnapshot,
  ReplacementEvent,
  WorkSession
} from './types'

export interface WorkbenchApi {
  getState(): Promise<{ db: Database; installed: Record<string, boolean> }>
  localShells(): Promise<LocalShell[]>
  saveSettings(settings: Settings): Promise<Database>
  saveProjects(projects: Project[]): Promise<Database>
  saveCustom(custom: Executor[]): Promise<Database>
  saveHosts(hosts: Host[]): Promise<Database>
  resourceTargets(): Promise<ResourceTarget[]>
  saveResourceTarget(target: ResourceTarget): Promise<void>
  resourceList(kind: 'mcp' | 'skills', agent: string, page: number, query: string): Promise<ResourcePage>
  resourceToggle(kind: 'mcp' | 'skills', agent: string, item: ResourceItem, enabled: boolean): Promise<void>
  resourceDetail(kind: 'mcp' | 'skills', agent: string, item: ResourceItem): Promise<ResourceDetail>
  openSkillFolder(agent: string, item: ResourceItem): Promise<void>
  deleteSkill(agent: string, item: ResourceItem): Promise<void>
  addMcp(name: string, config: Record<string, unknown>, agents: string[]): Promise<ResourceResult[]>
  scanResources(kind: 'mcp' | 'skills', source: string): Promise<import('./types').ResourceSourceItem[]>
  importMcpConfig(source: string, agents: string[], ids: string[]): Promise<ResourceResult[]>
  importSkills(source: string, agents: string[], names?: string[]): Promise<ResourceResult[]>
  pickResource(kind: 'folder' | 'zip' | 'config'): Promise<string | null>
  saveSessions(projectId: string, terms: SavedTerm[], activeId?: string | null, groups?: WorkSession[], selected?: string): Promise<Database>
  saveBranch(projectId: string, branch: string): Promise<Database>
  setUnsavedChanges(dirty: boolean): void
  pickDirectory(): Promise<string | null>
  temporaryDirectory(): Promise<string | null>
  configureTemporaryDirectory(root: string): Promise<string>
  createTemporarySession(root?: string): Promise<{ database: Database; projectId: string }>
  checkPath(hostId: string, input: string): Promise<PathCheck>
  listDir(hostId: string, input: string): Promise<DirListing>
  gitStatus(projectId: string, rescan?: boolean): Promise<GitPanel & { untracked: Record<string, boolean> }>
  gitDiff(projectId: string, rel: string, untracked: boolean): Promise<FileDiff>
  gitDiscard(projectId: string, rel: string, untracked: boolean): Promise<boolean>
  gitTree(projectId: string, rel?: string): Promise<TreeNode[]>
  treeIgnoreGet(projectId: string): Promise<string[]>
  treeIgnoreSet(projectId: string, rules: string[]): Promise<void>
  treeCreate(projectId: string, parent: string, name: string, directory: boolean): Promise<string>
  treeRename(projectId: string, rel: string, name: string, directory: boolean): Promise<string>
  treeMove(projectId: string, rel: string, parent: string, directory: boolean): Promise<string>
  treeTrash(projectId: string, rel: string, directory: boolean): Promise<void>
  transferPick(projectId: string, parent: string, kind: 'files' | 'directory'): Promise<string | null>
  droppedFilePath(file: File): string
  transferDrop(projectId: string, parent: string, sources: string[]): Promise<string>
  transferCancel(id: string): Promise<void>
  transferDownload(projectId: string, rel: string, directory?: boolean): Promise<string | null>
  transferDecide(id: string, choice: 'skip' | 'keep' | 'cancel' | 'merge' | 'overwrite', applyToBatch?: boolean): Promise<void>
  onReplacement(cb: (event: ReplacementEvent) => void): () => void
  replacementReady(id: string, allow: boolean): void
  transferRetry(id: string): Promise<string>
  transferKeepBoth(id: string): Promise<string>
  transferDismiss(id: string): Promise<void>
  onTransfer(cb: (snapshot: TransferSnapshot) => void): () => void
  treeSearchStart(projectId: string, id: string, query: string): Promise<void>
  treeSearchNext(id: string): Promise<{ items: TreeNode[]; done: boolean }>
  treeSearchCancel(id: string): Promise<void>
  gitRead(projectId: string, rel: string): Promise<FileContent>
  gitWrite(projectId: string, rel: string, text: string, version: string): Promise<FileContent>
  previewUrl(projectId: string, rel: string, draft?: string): Promise<string>
  renderMermaid(source: string): Promise<string>
  cancelDiagrams(): Promise<void>
  openHtmlPreview(projectId: string, rel: string): Promise<string>
  treeMenu(projectId: string, rel: string, directory: boolean): Promise<string | null>
  treeAction(projectId: string, rel: string, directory: boolean, action: string): Promise<void>
  treeReference(projectId: string, rel: string, kind: string, shell: ShellKind): Promise<string>
  documentMenu(options: { markdown: boolean; visual: boolean; undo: boolean; redo: boolean; editable: boolean }): Promise<string | null>
  documentLink(projectId: string, source: string, href: string): Promise<{ path: string; anchor?: string } | null>
  terminalMenu(options: { horizontal: boolean; vertical: boolean; merge: boolean; reconnect?: boolean }): Promise<string | null>
  onPreviewSource(cb: () => void): () => void
  ptyCreate(req: PtyCreateRequest): Promise<{ id: string; state: string; exitCode: number | null; startedAt: number | null; inputReady: boolean; shell: ShellKind; kind: string; agentKind?: string | null; agentSessionId?: string | null }>
  ptyWrite(id: string, data: string, binary?: boolean): void
  ptyResize(id: string, cols: number, rows: number): void
  ptyInterrupt(id: string): Promise<'hint' | 'exit' | 'signal'>
  ptyKill(id: string): Promise<void>
  ptyRestart(id: string): Promise<void>
  ptyClose(id: string): Promise<void>
  terminalHistory(id: string): Promise<string>
  saveTerminalHistory(id: string, text: string): void
  onFlushTerminalHistory(cb: () => void): () => void
  onPty(cb: (event: PtyEvent) => void): () => void
  testExec(req: TestExecRequest): Promise<{ text: string; code: number | null }>
  testHost(host: Host): Promise<HostTest>
  winMin(): Promise<void>
  winMax(): Promise<void>
  winClose(): Promise<void>
  winResize(width: number, height: number): Promise<void>
  shot(name: string): Promise<boolean>
  meta(): Promise<{ capture: boolean; platform: string; shots: boolean }>
}

export type { GitFile }
