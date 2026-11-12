import { t } from '../shared/i18n'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { installationDirectory } from './app-paths'
import { db, mutate } from './store'
import type { Database, Project } from '../shared/types'

function configFile() { return path.join(process.env.AWB_USER_DATA || installationDirectory, 'pello.config.json') }

export function temporaryDirectory(): string | null {
  try {
    const value = JSON.parse(fs.readFileSync(configFile(), 'utf8')).temporarySessionsDirectory
    return typeof value === 'string' && path.isAbsolute(value) ? value : null
  } catch { return null }
}

function resolveDirectory(configured: string | null): string {
  if (!configured || !path.isAbsolute(configured) || configured.includes('\0')) throw new Error(t("请选择临时会话的绝对目录"))
  fs.mkdirSync(configured, { recursive: true })
  const base = fs.realpathSync(configured)
  if (!fs.statSync(base).isDirectory()) throw new Error(t("临时会话路径必须是文件夹"))
  return base
}

export function configureTemporaryDirectory(root: string): string {
  const base = resolveDirectory(root.trim())
  const file = configFile()
  let current: Record<string, unknown> = {}
  if (fs.existsSync(file)) {
    try { current = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { throw new Error(t("配置文件无法读取：{{0}}", file)) }
    if (!current || typeof current !== 'object' || Array.isArray(current)) throw new Error(t("配置文件格式无效：{{0}}", file))
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const staged = `${file}.${randomUUID()}.tmp`
    fs.writeFileSync(staged, JSON.stringify({ ...current, temporarySessionsDirectory: base }, null, 2), { flag: 'wx' })
    fs.renameSync(staged, file)
  } catch { throw new Error(t("无法保存临时会话目录。请确认 Pello 安装目录可写：{{0}}", path.dirname(file))) }
  return base
}

export function createTemporarySession(root?: string): { database: Database; projectId: string } {
  const base = root === undefined ? resolveDirectory(temporaryDirectory()) : configureTemporaryDirectory(root)
  const id = randomUUID()
  const directory = path.join(base, id)
  fs.mkdirSync(directory)
  fs.writeFileSync(path.join(directory, 'AGENTS.md'), `# 临时会话工作范围\n\n本次临时会话的工作目录为\n\n\`${directory}\`\n\n所有临时文件、下载内容、中间产物、脚本、日志和生成的输出必须保存在此 UUID 目录内部，按用途分门别类存放，例如 tmp/、scripts/、logs/、outputs/。不得将文件或输出写到此目录之外，也不得使用其他项目或系统临时目录存放本会话产物。引用外部资料时保持只读；需要修改时先复制到此目录。清理操作也仅限本目录内部。\n`, { flag: 'wx' })
  fs.writeFileSync(path.join(directory, 'CLAUDE.md'), '@AGENTS.md\n', { flag: 'wx' })
  const name = t("临时会话 {{0}}", db().projects.filter((project) => project.temporary).length + 1)
  const project: Project = { id, name, host: 'local', path: directory, branch: '', agent: db().settings.defAgent, temporary: true }
  const database = mutate((draft) => { draft.projects.push(project) })
  return { database, projectId: id }
}
