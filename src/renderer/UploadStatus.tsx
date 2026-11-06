import { useState } from 'react'
import type { TransferSnapshot } from '../shared/types'
import { Icon } from './icons'

export const UPLOAD_SUCCESS_DURATION = 2000

export function uploadSucceeded(task: TransferSnapshot): boolean {
  return task.direction === 'upload' && task.state === 'completed' && !task.warnings?.length && task.items.every((item) => item.status === 'done')
}

export function UploadStatus({ task, onDismiss }: { task: TransferSnapshot; onDismiss: (id: string) => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const running = task.state === 'running' || task.state === 'conflicts'
  const failed = task.items.some((item) => item.status !== 'done')
  const message = running ? '上传中' : task.state === 'cancelled' ? '上传已取消' : failed ? '上传失败' : task.warnings?.length ? '上传完成，需处理提示' : '上传成功'
  const details = [...new Set([error, ...task.items.filter((item) => item.status !== 'done').map((item) => item.error), ...(task.warnings || [])].filter(Boolean))]
  return <div className="upload-status" data-transfer-id={task.id}>
    <div className="upload-status-row">
      <Icon name={running ? 'refresh' : failed ? 'x' : 'check'} className={running ? 's upload-spinner' : failed ? 's bad' : 's'} />
      <span className="grow" role="status">{message}</span>
      {!running && failed && task.retryable !== false && task.items.some((item) => item.status === 'failed' && item.source && item.error !== '部分内容未能上传') ? <button className="btn sm" disabled={busy} onClick={() => {
        setBusy(true); setError('')
        void window.awb.transferRetry(task.id).then(() => onDismiss(task.id)).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : '重试失败')).finally(() => setBusy(false))
      }}>重试上传</button> : null}
      {!uploadSucceeded(task) ? <button type="button" className="ib" aria-label={running ? '取消上传' : '关闭上传提示'} title={running && task.phase === 'publishing' ? '正在完成上传，请稍候' : running ? '取消上传' : '关闭上传提示'} disabled={busy || (running && task.phase === 'publishing')} onClick={() => {
        if (!running) { onDismiss(task.id); return }
        setBusy(true); setError('')
        void window.awb.transferCancel(task.id).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : '取消上传失败')).finally(() => setBusy(false))
      }}><Icon name="x" className="s" /></button> : null}
    </div>
    {!running || error ? details.map((detail) => <p className="upload-error" role="alert" key={detail}>{detail}</p>) : null}
  </div>
}
