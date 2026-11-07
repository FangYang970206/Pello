import mermaid from 'mermaid'

declare global { interface Window { renderMermaid: (source: string, id: string) => Promise<string> } }

mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral', suppressErrorRendering: true, maxTextSize: 100_000 })
window.renderMermaid = async (source, id) => {
  try { return (await mermaid.render(id, source)).svg }
  finally { document.body.replaceChildren() }
}
