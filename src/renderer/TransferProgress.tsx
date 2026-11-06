import type { TransferSnapshot } from '../shared/types'

function bytes(value: number): string {
  if (value < 1024) return `${value} B`
  const unit = value < 1024 ** 2 ? 1024 : value < 1024 ** 3 ? 1024 ** 2 : 1024 ** 3
  return `${(value / unit).toFixed(1)} ${unit === 1024 ? 'KB' : unit === 1024 ** 2 ? 'MB' : 'GB'}`
}

export function TransferProgress({ task }: { task: TransferSnapshot }) {
  if (task.direction !== 'upload') return task.state === 'running' && task.total ? <progress max={task.total} value={task.bytes} aria-label="当前文件进度" /> : null
  const total = task.overallTotal, sent = task.overallBytes || 0
  const emptyDone = task.state === 'completed' && !task.items.some((item) => item.status === 'failed')
  const percentage = total ? Math.min(100, Math.floor(sent * 100 / total)) : emptyDone ? 100 : ['completed', 'cancelled'].includes(task.state) ? 0 : undefined
  const label = task.state === 'cancelled' ? `已取消 · ${bytes(sent)} / ${bytes(total || 0)}` : task.phase === 'preparing' && task.state === 'running' ? '正在检查上传内容…' : task.phase === 'publishing' && task.state === 'running' ? '正在替换目标…' : percentage === undefined ? '准备上传…' : `总进度 ${percentage}% · ${bytes(sent)} / ${bytes(total || 0)}`
  return <>
    <span className="transfer-progress-label" role="status">{label}</span>
    <progress max={total || 1} value={percentage === undefined ? undefined : total ? Math.min(sent, total) : 1} aria-label="上传总进度" aria-valuetext={label} />
    {task.state === 'running' && task.phase === 'transferring' && task.total > 0 ? <>
      <span>当前文件 {Math.min(100, Math.floor(task.bytes * 100 / task.total))}%</span>
      <progress max={task.total} value={task.bytes} aria-label="当前文件进度" />
    </> : null}
    <span title={task.destination}>目标目录：{task.destination}</span>
  </>
}
