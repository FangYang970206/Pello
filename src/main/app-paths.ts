import { app, dialog } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { prepareDataDirectory } from './data-directory'
import { setLanguage, t } from '../shared/i18n'

// Imported before any module can read a profile or create a Chromium session.
export const installationDirectory = app.isPackaged ? path.dirname(app.getPath('exe')) : app.getAppPath()
export const dataDirectory = process.env.AWB_USER_DATA || path.join(installationDirectory, 'data')
const legacyDirectory = process.env.AWB_USER_DATA ? dataDirectory : path.join(app.getPath('appData'), 'agent-workbench')
try {
  const source = fs.existsSync(dataDirectory) ? dataDirectory : legacyDirectory
  setLanguage(JSON.parse(fs.readFileSync(path.join(source, 'workbench.json'), 'utf8')).settings?.language)
} catch { /* A first launch has no saved language. */ }
try {
  prepareDataDirectory(dataDirectory, legacyDirectory)
  app.setPath('userData', dataDirectory)
  app.setPath('sessionData', dataDirectory)
  for (const [name, folder] of [['temp', 'tmp'], ['logs', 'logs'], ['crashDumps', 'crashes']] as const) {
    const directory = path.join(dataDirectory, folder)
    fs.mkdirSync(directory, { recursive: true })
    app.setPath(name, directory)
  }
  app.setAppLogsPath(path.join(dataDirectory, 'logs'))
  process.env.TEMP = process.env.TMP = process.env.TMPDIR = app.getPath('temp')
} catch (error) {
  dialog.showErrorBox('Pello', t("无法使用安装目录中的数据文件夹：{{0}}。请确认该目录可写。\n{{1}}", dataDirectory, String(error)))
  app.exit(1)
}
