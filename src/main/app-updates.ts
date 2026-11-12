import { app } from 'electron'
import path from 'node:path'
import { NsisUpdater } from 'electron-updater'
import { dataDirectory, installationDirectory } from './app-paths'
import { UpdateController } from './update-controller'
import type { AppUpdateState } from '../shared/types'

class InstallationUpdater extends NsisUpdater {
  constructor() {
    super()
    // Keep the normal Electron HTTP executor; only relocate its disk cache.
    Object.defineProperty(this.app, 'baseCachePath', { get: () => path.join(dataDirectory, 'updates') })
  }
}

export function createAppUpdates(emit: (state: AppUpdateState) => void): UpdateController {
  if (!app.isPackaged || process.platform !== 'win32') return new UpdateController(null, emit)
  const driver = new InstallationUpdater()
  driver.autoDownload = false
  driver.autoInstallOnAppQuit = false
  driver.allowPrerelease = false
  driver.allowDowngrade = false
  driver.installDirectory = installationDirectory
  return new UpdateController(driver, emit)
}
