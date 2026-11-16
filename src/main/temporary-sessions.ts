import { t } from '../shared/i18n'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { installationDirectory } from './app-paths'
import { db, mutate } from './store'
import type { Database, Host, Project } from '../shared/types'
import { isAbsPath } from './platform'
import { prepareRemoteTemporaryDirectory } from './temporary-session-remote'

function configFile() { return path.join(process.env.AWB_USER_DATA || installationDirectory, 'pello.config.json') }

function temporaryHost(hostId: string): Host {
  const host = db().hosts.find((item) => item.id === hostId)
  if (!host) throw new Error(t("环境不存在"))
  return host
}

export function temporaryDirectory(hostId = 'local'): string | null {
  const host = temporaryHost(hostId)
  try {
    const config = JSON.parse(fs.readFileSync(configFile(), 'utf8'))
    const value = hostId === 'local' ? config.temporarySessionsDirectory : config.remoteTemporarySessionsDirectories?.[hostId]
    return typeof value === 'string' && !value.includes('\0') && (hostId === 'local' ? path.isAbsolute(value) : isAbsPath(value, host.platform)) ? value : null
  } catch { return null }
}

function resolveDirectory(configured: string | null): string {
  if (!configured || !path.isAbsolute(configured) || configured.includes('\0')) throw new Error(t("请选择临时会话的绝对目录"))
  fs.mkdirSync(configured, { recursive: true })
  const base = fs.realpathSync(configured)
  if (!fs.statSync(base).isDirectory()) throw new Error(t("临时会话路径必须是文件夹"))
  return base
}

async function resolveHostDirectory(root: string | null, host: Host): Promise<string> {
  if (!root || root.includes('\0') || !(host.id === 'local' ? path.isAbsolute(root) : isAbsPath(root, host.platform))) throw new Error(t("请选择临时会话的绝对目录"))
  return host.id === 'local' ? resolveDirectory(root) : prepareRemoteTemporaryDirectory(host, root, t("临时会话路径必须是文件夹"))
}

export async function configureTemporaryDirectory(root: string, hostId = 'local'): Promise<string> {
  const base = await resolveHostDirectory(root.trim(), temporaryHost(hostId))
  const file = configFile()
  let current: Record<string, unknown> = {}
  if (fs.existsSync(file)) {
    try { current = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { throw new Error(t("配置文件无法读取：{{0}}", file)) }
    if (!current || typeof current !== 'object' || Array.isArray(current)) throw new Error(t("配置文件格式无效：{{0}}", file))
  }
  const remotes = current.remoteTemporarySessionsDirectories
  const next = hostId === 'local' ? { ...current, temporarySessionsDirectory: base } : {
    ...current, remoteTemporarySessionsDirectories: { ...(remotes && typeof remotes === 'object' && !Array.isArray(remotes) ? remotes : {}), [hostId]: base }
  }
  const staged = `${file}.${randomUUID()}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(staged, JSON.stringify(next, null, 2), { flag: 'wx' })
    fs.renameSync(staged, file)
  } catch {
    fs.rmSync(staged, { force: true })
    throw new Error(t("无法保存临时会话目录。请确认 Pello 安装目录可写：{{0}}", path.dirname(file)))
  }
  return base
}

export async function createTemporarySession(root?: string, hostId = 'local'): Promise<{ database: Database; projectId: string }> {
  const host = temporaryHost(hostId)
  const base = root === undefined ? await resolveHostDirectory(temporaryDirectory(hostId), host) : await configureTemporaryDirectory(root, hostId)
  const id = randomUUID()
  const instructions = `# 临时会话工作范围\n\n本次临时会话的工作目录为\n\n\`{{DIRECTORY}}\`\n\n所有临时文件、下载内容、中间产物、脚本、日志和生成的输出必须保存在此 UUID 目录内部，按用途分门别类存放，例如 tmp/、scripts/、logs/、outputs/。不得将文件或输出写到此目录之外，也不得使用其他项目或系统临时目录存放本会话产物。引用外部资料时保持只读；需要修改时先复制到此目录。清理操作也仅限本目录内部。\n`
  let directory: string
  if (hostId === 'local') {
    directory = path.join(base, id)
    fs.mkdirSync(directory)
    try {
      fs.writeFileSync(path.join(directory, 'AGENTS.md'), instructions.replace('{{DIRECTORY}}', directory), { flag: 'wx' })
      fs.writeFileSync(path.join(directory, 'CLAUDE.md'), '@AGENTS.md\n', { flag: 'wx' })
    } catch (error) { fs.rmSync(directory, { recursive: true, force: true }); throw error }
  } else directory = await prepareRemoteTemporaryDirectory(host, base, t("临时会话路径必须是文件夹"), id, instructions)
  const name = t("临时会话 {{0}}", db().projects.filter((project) => project.temporary).length + 1)
  const project: Project = { id, name, host: hostId, path: directory, branch: '', agent: db().settings.defAgent, temporary: true }
  const database = mutate((draft) => { draft.projects.push(project) })
  return { database, projectId: id }
}
