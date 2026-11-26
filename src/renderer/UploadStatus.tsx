import { isMessage, t } from '../shared/i18n'
import { useState } from 'react'
import { FileOperationDialog } from './FileOperationDialog'
import type { TransferSnapshot } from '../shared/types'
import { Icon } from './icons'

export const TRANSFER_SUCCESS_DURATION = 2000

export function transferSucceeded(task: TransferSnapshot): boolean {
  return task.state === 'completed' && !task.warnings?.length && task.items.every((item) => item.status === 'done')
}

export function transferNeedsAttention(task: TransferSnapshot): boolean {
  return task.state !== 'running' && task.state !== 'conflicts' && !transferSucceeded(task)
}

/** Completed failures share one notice; paths and recovery actions stay behind Details. */
export function UploadStatus({ tasks, onDismiss }: { tasks: TransferSnapshot[]; onDismiss: (id: string) => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [batch, setBatch] = useState(false)
  const task = tasks[0]
  const running = task.state === 'running' || task.state === 'conflicts'
  const failed = tasks.some((item) => item.items.some((entry) => entry.status === 'failed'))
  const skipped = !running && tasks.some((item) => item.items.some((entry) => entry.status === 'conflict'))
  const warning = tasks.some((item) => item.warnings?.length)
  const upload = tasks.every((item) => item.direction === 'upload')
  const download = tasks.every((item) => item.direction === 'download')
  const message = running ? task.state === 'conflicts' ? t("请选择同名项目的处理方式") : upload ? t("上传中") : download ? t("正在下载") : t("正在导入")
    : failed ? upload ? t("上传失败") : download ? t("下载失败") : t("传输失败")
      : warning ? t("传输完成，需处理提示") : skipped ? t("部分项目已跳过") : upload ? t("上传成功") : download ? t("下载成功") : t("导入成功")
  const closeLabel = running ? upload ? t("取消上传") : download ? t("取消下载") : t("取消传输") : t("关闭传输提示")
  async function act(operation: () => Promise<unknown>) {
    setBusy(true); setError('')
    try { await operation() } catch (reason) { setError(reason instanceof Error ? reason.message : t("文件操作失败")); setExpanded(true) }
    finally { setBusy(false) }
  }
  function decide(choice: 'skip' | 'keep' | 'merge' | 'overwrite') { void act(() => window.awb.transferDecide(task.id, choice, batch)) }
  const details = <>
      {error ? <p role="alert" className="bad">{error}</p> : null}
      {tasks.map((item) => <div className="transfer-detail-task" data-issue-id={item.id} key={item.id}>
        {item.items.filter((entry) => entry.status !== 'done').map((entry, index) => <p key={index}><span>{entry.destination}</span><small>{entry.error || t("同名冲突")}</small></p>)}
        {item.warnings?.map((value) => <p key={value}>{value}</p>)}
        {!running && item.items.some((entry) => entry.status === 'conflict') ? <button className="btn sm" disabled={busy} onClick={() => void act(async () => { await window.awb.transferKeepBoth(item.id); onDismiss(item.id) })}>{t("冲突项保留两者")}</button> : null}
        {!running && item.retryable !== false && item.items.some((entry) => entry.status === 'failed' && entry.source && !isMessage(entry.error, '部分内容未能上传') && !isMessage(entry.error, '部分内容未能复制')) ? <button className="btn sm" disabled={busy} onClick={() => void act(async () => { await window.awb.transferRetry(item.id); onDismiss(item.id) })}>{t("重试失败项")}</button> : null}
      </div>)}
  </>
  return <><div className="upload-status" data-transfer-id={task.id} data-transfer-count={tasks.length}>
    <div className="upload-status-row">
      <Icon name={running ? 'refresh' : failed || warning || skipped ? 'info' : 'check'} className={running ? 's upload-spinner' : failed ? 's bad' : warning || skipped ? 's transfer-warning' : 's transfer-success'} />
      <span className="grow" role={failed || warning ? 'alert' : 'status'}>{message}</span>
      <button type="button" className="ib transfer-close" aria-label={closeLabel} title={running && task.phase === 'publishing' ? t("正在完成上传，请稍候") : closeLabel} disabled={busy || (running && task.phase === 'publishing')} onClick={() => {
        if (!running) { for (const item of tasks) onDismiss(item.id); return }
        void act(() => window.awb.transferCancel(task.id))
      }}><Icon name="x" className="s" /></button>
    </div>
    {!running && (failed || warning || skipped) ? <button className="transfer-details-toggle" type="button" aria-haspopup="dialog" aria-expanded={expanded} onClick={() => setExpanded(true)}>{t("详情")}</button> : null}
    {task.state === 'conflicts' ? <div className="transfer-conflict-details">
      {details}
      {task.state === 'conflicts' ? <>
        <label className="transfer-batch"><input type="checkbox" checked={batch} disabled={busy} onChange={(event) => setBatch(event.target.checked)} />{t("应用到本批次同类冲突")}</label>
        <div className="transfer-conflict-actions">{([['skip', t("跳过冲突项")], ['keep', t("冲突项保留两者")], ...(task.items.length && task.items.every((item) => item.replaceable) ? [['overwrite', t("覆盖冲突文件")] as const] : []), ...(task.items.some((item) => item.mergeable) ? [['merge', t("合并同名目录")] as const] : [])] as const).map(([choice, label]) => <button type="button" className="btn sm" disabled={busy} key={choice} onClick={() => decide(choice)}>{label}</button>)}</div>
      </> : null}
    </div> : null}
  </div>
    {expanded ? <FileOperationDialog title={t("传输详情")} busy={busy} onClose={() => setExpanded(false)} onSubmit={(event) => event.preventDefault()}
      footer={<button type="button" className="btn" disabled={busy} onClick={() => setExpanded(false)}>{t("关闭")}</button>}>
      <div className="transfer-error-details">{details}</div>
    </FileOperationDialog> : null}
  </>
}
