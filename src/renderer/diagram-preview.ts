import { t } from '../shared/i18n'
import { encode } from 'plantuml-encoder'

let sequence = 0

/** Generated SVG stays in an image rather than joining the workbench DOM. */
export function diagramPreview(language: string, content: string, applyPreview: (value: HTMLElement | null) => void): void | null {
  const kind = language.toLowerCase()
  if (!['mermaid', 'plantuml', 'puml'].includes(kind)) return null
  const figure = document.createElement('figure')
  figure.className = 'diagram-preview'
  figure.dataset.language = kind
  const id = `pello-diagram-${++sequence}`
  figure.dataset.diagramId = id
  figure.dataset.loading = 'true'
  const publish = () => {
    // Milkdown sanitizes/clones previews. Publish a fresh value, and do not let
    // an earlier asynchronous render replace a newly edited fence.
    if (document.querySelector(`[data-diagram-id="${id}"]`)) applyPreview(figure.cloneNode(true) as HTMLElement)
  }
  const status = document.createElement('figcaption')
  status.textContent = t("正在渲染图表…")
  status.setAttribute('role', 'status')
  figure.append(status)
  const image = document.createElement('img')
  image.alt = kind === 'mermaid' ? t("Mermaid 图表") : t("PlantUML 在线图表")
  image.referrerPolicy = 'no-referrer'
  image.onload = () => { figure.dataset.loading = 'false'; status.textContent = kind === 'mermaid' ? '' : t("PlantUML · plantuml.com 在线渲染"); publish() }
  image.onerror = () => { figure.dataset.loading = 'false'; status.textContent = t("图表加载失败，请检查语法或网络后重新编辑重试"); status.setAttribute('role', 'alert'); publish() }
  figure.append(image)
  applyPreview(figure)
  if (kind !== 'mermaid') {
    image.src = `https://www.plantuml.com/plantuml/svg/${encode(content)}`
    publish()
    return
  }
  void window.awb.renderMermaid(content).then((svg) => {
    if (!svg) return
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
    publish()
  }).catch((error) => { figure.dataset.loading = 'false'; image.remove(); status.textContent = t("Mermaid 渲染失败：{{0}}", String(error).slice(0, 240)); status.setAttribute('role', 'alert'); publish() })
}
