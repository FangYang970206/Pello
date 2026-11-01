import type { GitFile, Host, Project, TreeNode } from '../shared/types'
import { useRef } from 'react'
import { Icon } from './icons'

export function RightPanel({
  project,
  host,
  mode,
  files,
  loaded,
  isRepo,
  branch,
  tree,
  treeChildren,
  openDirs,
  width,
  onResize,
  activePath,
  onMode,
  onToggleDir,
  onOpenDiff,
  onOpenFile,
  onCollapse
}: {
  project: Project
  host: Host
  mode: 'files' | 'changes'
  files: GitFile[]
  loaded: boolean
  isRepo: boolean
  branch: string
  tree: TreeNode[]
  treeChildren: Record<string, TreeNode[]>
  openDirs: Record<string, boolean>
  width: number
  onResize: (width: number) => void
  activePath?: string
  onMode: (mode: 'files' | 'changes') => void
  onToggleDir: (path: string) => void
  onOpenDiff: (path: string) => void
  onOpenFile: (path: string) => void
  onCollapse: () => void
}) {
  const drag = useRef<{ x: number; width: number } | null>(null)
  const changed = new Map(files.map((file) => [file.path, file]))
  const renderTree = (nodes: TreeNode[], depth: number) =>
    nodes.map((node) => {
      const pad = 6 + depth * 14
      if (node.dir) {
        const key = `${project.id}:${node.path}`
        const open = !!openDirs[key]
        return (
          <div key={node.path}>
            <button className="row" style={{ paddingLeft: pad }} data-a="tog" data-id={node.path} aria-expanded={open} onClick={() => onToggleDir(node.path)}>
              <Icon name="chev" className={`s chev${open ? ' open' : ''}`} />
              <Icon name="folder" className="s" />
              <span className="nm">{node.name}</span>
            </button>
            {open ? treeChildren[key] ? renderTree(treeChildren[key], depth + 1) : <div className="tree-loading" style={{ paddingLeft: pad + 20 }}>正在读取…</div> : null}
          </div>
        )
      }
      const change = changed.get(node.path)
      return (
        <button
          key={node.path}
          className={`row ${activePath === node.path ? 'on' : ''}`}
          style={{ paddingLeft: 26 + depth * 14 }}
          data-a="preview"
          data-id={node.path}
          onClick={() => onOpenFile(node.path)}
          title={node.path}
        >
          <Icon name="file" className="s" />
          <span className="nm grow" style={change ? { color: change.st === 'A' ? 'var(--green)' : change.st === 'D' ? 'var(--red)' : 'var(--amber)' } : undefined}>
            {node.name}
          </span>
          {change ? <span className={`st ${change.st}`}>{change.st}</span> : null}
        </button>
      )
    })

  let body
  if (mode === 'changes') {
    if (!loaded) {
      body = <div className="rmeta">正在读取…</div>
    } else if (!isRepo) {
      body = (
        <div className="empty" style={{ background: 'none' }}>
          <div className="in">
            <div className="glyph">
              <Icon name="folder" />
            </div>
            <p style={{ marginTop: 8 }}>不是 Git 仓库</p>
            <p style={{ fontSize: 11, color: 'var(--faint)' }}>变更面板不可用</p>
          </div>
        </div>
      )
    } else if (!files.length) {
      body = (
        <div className="empty" style={{ background: 'none' }}>
          <div className="in">
            <div className="glyph">
              <Icon name="check" />
            </div>
            <p style={{ marginTop: 8 }}>工作区干净</p>
            <p style={{ fontSize: 11, color: 'var(--faint)' }}>{branch || '当前分支'} 上没有未提交的变更</p>
          </div>
        </div>
      )
    } else {
      body = (
        <>
          <div className="rmeta">
            <span className="br">
              <Icon name="branch" className="s" />
              {branch || 'HEAD'}
            </span>
            <span className="grow" />
            <span>git status</span>
          </div>
          <div className="rlist">
            {files.map((file) => {
              const parts = file.path.split('/')
              const name = parts.pop() || file.path
              return (
                <button key={file.path} className={`row ${activePath === file.path ? 'on' : ''}`} data-a="diff" data-id={file.path} title={file.path} onClick={() => onOpenDiff(file.path)}>
                  <span className={`st ${file.st}`}>{file.st}</span>
                  <span className="nm">{name}</span>
                  <span className="dir grow">{parts.join('/')}</span>
                  <span className="num">
                    <span className="a">+{file.add}</span>
                    {file.del ? <span className="d">−{file.del}</span> : null}
                  </span>
                </button>
              )
            })}
          </div>
        </>
      )
    }
  } else {
    body = (
      <>
        <div className="rmeta">
          <span className="mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {project.path}
          </span>
        </div>
        <div className="rlist">{tree.length ? renderTree(tree, 0) : <p style={{ fontSize: 12, color: 'var(--faint)', padding: '4px 8px' }}>目录是空的</p>}</div>
      </>
    )
  }

  return (
    <aside className="right" aria-label="文件面板">
      <div className="right-resize" role="separator" aria-label="调整文件面板宽度" aria-orientation="vertical" aria-valuenow={width} aria-valuemin={220} tabIndex={0}
        onPointerDown={(event) => {
          event.preventDefault()
          event.currentTarget.setPointerCapture(event.pointerId)
          drag.current = { x: event.clientX, width }
        }}
        onPointerMove={(event) => {
          if (drag.current) onResize(drag.current.width + drag.current.x - event.clientX)
        }}
        onPointerUp={(event) => { drag.current = null; event.currentTarget.releasePointerCapture(event.pointerId) }}
        onLostPointerCapture={() => { drag.current = null }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault()
            onResize(width + (event.key === 'ArrowLeft' ? 20 : -20))
          }
        }} />
      <div className="rh">
        <div className="seg" role="radiogroup" aria-label="文件面板模式">
          <button className={mode === 'files' ? 'on' : ''} role="radio" aria-checked={mode === 'files'} data-a="rmode" data-id="files" onClick={() => onMode('files')}>
            文件
          </button>
          <button className={mode === 'changes' ? 'on' : ''} role="radio" aria-checked={mode === 'changes'} data-a="rmode" data-id="changes" onClick={() => onMode('changes')}>
            变更{files.length ? <span className="c">{files.length}</span> : null}
          </button>
        </div>
        <span className="grow" />
        <button className="ib" data-a="right" title="收起面板" aria-label="收起文件面板" onClick={onCollapse}>
          <Icon name="panel" />
        </button>
      </div>
      {body}
      <div className="rfoot">
        <Icon name={host.id === 'local' ? 'laptop' : 'server'} className="s" />
        <span>{host.name}</span>
        <span>·</span>
        <span>{host.os}</span>
      </div>
    </aside>
  )
}
