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
  TestExecRequest,
  TreeNode
} from './types'

export interface WorkbenchApi {
  getState(): Promise<{ db: Database; installed: Record<string, boolean> }>
  saveSettings(settings: Settings): Promise<Database>
  saveProjects(projects: Project[]): Promise<Database>
  saveCustom(custom: Executor[]): Promise<Database>
  saveHosts(hosts: Host[]): Promise<Database>
  resourceTargets(): Promise<ResourceTarget[]>
  saveResourceTarget(target: ResourceTarget): Promise<void>
  resourceList(kind: 'mcp' | 'skills', agent: string, page: number, query: string): Promise<ResourcePage>
  resourceToggle(kind: 'mcp' | 'skills', agent: string, item: ResourceItem, enabled: boolean): Promise<void>
  resourceDetail(kind: 'mcp' | 'skills', agent: string, item: ResourceItem): Promise<ResourceDetail>
  addMcp(name: string, config: Record<string, unknown>, agents: string[]): Promise<ResourceResult[]>
  importSkills(source: string, agents: string[]): Promise<ResourceResult[]>
  pickResource(kind: 'folder' | 'zip' | 'config'): Promise<string | null>
  saveSessions(projectId: string, terms: SavedTerm[], activeId?: string | null): Promise<Database>
  saveBranch(projectId: string, branch: string): Promise<Database>
  setUnsavedChanges(dirty: boolean): void
  pickDirectory(): Promise<string | null>
  checkPath(hostId: string, input: string): Promise<PathCheck>
  listDir(hostId: string, input: string): Promise<DirListing>
  gitStatus(projectId: string): Promise<GitPanel & { untracked: Record<string, boolean> }>
  gitDiff(projectId: string, rel: string, untracked: boolean): Promise<FileDiff>
  gitDiscard(projectId: string, rel: string, untracked: boolean): Promise<boolean>
  gitTree(projectId: string, rel?: string): Promise<TreeNode[]>
  gitRead(projectId: string, rel: string): Promise<FileContent>
  gitWrite(projectId: string, rel: string, text: string, version: string): Promise<FileContent>
  previewUrl(projectId: string, rel: string, draft?: string): Promise<string>
  openHtmlPreview(projectId: string, rel: string): Promise<string>
  documentMenu(options: { markdown: boolean; visual: boolean; undo: boolean; redo: boolean; editable: boolean }): Promise<string | null>
  onPreviewSource(cb: () => void): () => void
  ptyCreate(req: PtyCreateRequest): Promise<{ id: string; state: string; exitCode: number | null; startedAt: number | null; inputReady: boolean; shell: ShellKind; kind: string }>
  ptyWrite(id: string, data: string, binary?: boolean): void
  ptyResize(id: string, cols: number, rows: number): void
  ptyInterrupt(id: string): Promise<'hint' | 'exit' | 'signal'>
  ptyKill(id: string): Promise<void>
  ptyRestart(id: string): Promise<void>
  ptyClose(id: string): Promise<void>
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
