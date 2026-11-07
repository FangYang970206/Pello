import type { TermTab } from './Workspace'

export const activeAgentKind = (tab: TermTab) => tab.agentKind === undefined ? (tab.kind === 'shell' ? null : tab.kind) : tab.agentKind

export function terminalStatus(tab: TermTab) {
  const agent = activeAgentKind(tab)
  if (!agent && tab.state !== 'failed' && tab.state !== 'exited') return { color: 'inactive', label: tab.state === 'running' ? 'Shell · 正在执行' : 'Shell · 空闲', state: 'not-started', activity: 'shell', spinning: false }
  if (tab.state === 'running' && !tab.inputReady) return { color: 'busy', label: '正在运行', state: 'running', activity: 'running', spinning: true }
  if (tab.state === 'failed') return { color: 'failed', label: `执行失败 · 退出码 ${tab.exitCode ?? 1}`, state: 'failed', activity: 'failed', spinning: false }
  if (tab.state === 'exited') return { color: 'inactive', label: `终端已退出 · 退出码 ${tab.exitCode ?? 0}`, state: 'completed', activity: 'closed', spinning: false }
  if (tab.inputReady) return { color: agent ? 'ready' : 'inactive', label: agent ? '空闲中' : 'Shell · 空闲', state: tab.hasRun ? 'completed' : 'not-started', activity: 'waiting', spinning: false }
  return { color: 'inactive', label: '正在启动', state: 'not-started', activity: 'starting', spinning: false }
}
