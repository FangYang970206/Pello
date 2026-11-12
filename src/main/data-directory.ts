import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { t } from '../shared/i18n'

/** Publish a complete copy once; never merge over an existing installation profile. */
export function prepareDataDirectory(directory: string, legacy: string): void {
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(path.dirname(directory), { recursive: true })
    const staged = `${directory}.migration-${randomUUID()}`
    try {
      if (fs.existsSync(legacy)) {
        fs.cpSync(legacy, staged, { recursive: true, filter: (source) => {
          if (/^(Singleton.*|DevToolsActivePort)$/.test(path.basename(source))) return false
          if (fs.lstatSync(source).isSymbolicLink()) throw new Error(t("数据目录包含链接，无法自动迁移：{{0}}", source))
          return true
        } })
      } else fs.mkdirSync(staged)
      fs.renameSync(staged, directory)
    } finally {
      if (fs.existsSync(staged)) fs.rmSync(staged, { recursive: true, force: true })
    }
  }
  if (fs.lstatSync(directory).isSymbolicLink() || !fs.statSync(directory).isDirectory()) throw new Error(t("数据目录无效：{{0}}", directory))
  const probe = path.join(directory, `.write-${randomUUID()}`)
  fs.writeFileSync(probe, '', { flag: 'wx' })
  fs.unlinkSync(probe)
}
