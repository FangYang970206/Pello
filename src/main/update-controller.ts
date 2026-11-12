import type { AppUpdateState } from '../shared/types'

export interface UpdateDriver {
  on(event: string, listener: (...args: never[]) => void): unknown
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(silent?: boolean, runAfter?: boolean): void
}

/** Serializes checks/downloads; installation only follows the normal close path. */
export class UpdateController {
  state: AppUpdateState
  private pending: Promise<AppUpdateState> | null = null
  constructor(private driver: UpdateDriver | null, private emit: (state: AppUpdateState) => void) {
    this.state = { phase: driver ? 'idle' : 'unsupported' }
    driver?.on('update-available', (info: { version: string }) => this.publish({ phase: 'available', version: info.version }))
    driver?.on('update-not-available', () => this.publish({ phase: 'current' }))
    driver?.on('download-progress', (info: { percent: number }) => this.publish({ ...this.state, phase: 'downloading', percent: Math.max(0, Math.min(100, Math.round(info.percent))) }))
    driver?.on('update-downloaded', (info: { version: string }) => this.publish({ phase: 'downloaded', version: info.version }))
    driver?.on('error', () => this.fail())
  }
  private publish(state: AppUpdateState): void { this.state = state; this.emit(state) }
  private fail(): void {
    const failed = this.state.phase === 'error' ? this.state.failed : this.state.phase === 'downloading' ? 'download' : this.state.phase === 'installing' ? 'install' : 'check'
    this.publish({ ...this.state, phase: 'error', failed })
  }
  check(): Promise<AppUpdateState> {
    if (this.pending) return this.pending
    if (!this.driver || ['downloaded', 'installing', 'downloading'].includes(this.state.phase)) return Promise.resolve(this.state)
    this.publish({ phase: 'checking' })
    return this.run(() => this.driver!.checkForUpdates())
  }
  download(): Promise<AppUpdateState> {
    if (this.pending) return this.pending
    if (!this.driver || !(this.state.phase === 'available' || (this.state.phase === 'error' && this.state.failed === 'download'))) return Promise.resolve(this.state)
    this.publish({ phase: 'downloading', version: this.state.version, percent: 0 })
    return this.run(() => this.driver!.downloadUpdate())
  }
  private run(operation: () => Promise<unknown>): Promise<AppUpdateState> {
    this.pending = Promise.resolve().then(operation).catch(() => this.fail()).then(() => this.state).finally(() => { this.pending = null })
    return this.pending
  }
  async install(prepare: () => Promise<boolean>): Promise<boolean> {
    if (!this.driver || !(this.state.phase === 'downloaded' || (this.state.phase === 'error' && this.state.failed === 'install'))) return false
    this.publish({ ...this.state, phase: 'installing' })
    try {
      if (!await prepare()) { this.publish({ ...this.state, phase: 'downloaded' }); return false }
      this.driver.quitAndInstall(false, true)
      return true
    } catch {
      this.fail()
      return false
    }
  }
}
