import { t } from '../shared/i18n'
import type { TermTab } from './Workspace'

export const activeAgentKind = (tab: TermTab) => tab.agentKind === undefined ? (tab.kind === 'shell' ? null : tab.kind) : tab.agentKind

export function terminalStatus(tab: TermTab) {
  const agent = activeAgentKind(tab)
  if (!agent && tab.state !== 'failed' && tab.state !== 'exited') return { color: 'inactive', label: tab.state === 'running' ? t("Shell · 正在执行") : t("Shell · 空闲"), state: 'not-started', activity: 'shell', spinning: false }
  if (tab.state === 'running' && !tab.inputReady) return { color: 'busy', label: t("正在运行"), state: 'running', activity: 'running', spinning: true }
  if (tab.state === 'failed') return { color: 'failed', label: t("执行失败 · 退出码 {{0}}", tab.exitCode ?? 1), state: 'failed', activity: 'failed', spinning: false }
  if (tab.state === 'exited') return { color: 'inactive', label: t("终端已退出 · 退出码 {{0}}", tab.exitCode ?? 0), state: 'completed', activity: 'closed', spinning: false }
  if (tab.inputReady) return { color: agent ? 'ready' : 'inactive', label: agent ? t("空闲中") : t("Shell · 空闲"), state: tab.hasRun ? 'completed' : 'not-started', activity: 'waiting', spinning: false }
  return { color: 'inactive', label: t("正在启动"), state: 'not-started', activity: 'starting', spinning: false }
}
