import type { TermTab } from './Workspace'

export function terminalStatus(tab: TermTab) {
  if (tab.state === 'running' && !tab.inputReady) return { color: 'busy', label: '正在运行', state: 'running', activity: 'running', spinning: true }
  if (tab.state === 'failed') return { color: 'failed', label: `执行失败 · 退出码 ${tab.exitCode ?? 1}`, state: 'failed', activity: 'failed', spinning: false }
  if (tab.inputReady) return { color: tab.hasRun ? 'ready' : 'inactive', label: '等待指令', state: tab.hasRun ? 'completed' : 'not-started', activity: 'waiting', spinning: false }
  if (tab.state === 'exited') return { color: 'inactive', label: '终端已退出', state: 'completed', activity: 'closed', spinning: false }
  return { color: 'inactive', label: '正在启动', state: 'not-started', activity: 'starting', spinning: false }
}
