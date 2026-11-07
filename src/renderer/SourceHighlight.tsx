import { useMemo, type ReactNode } from 'react'
import hljs from 'highlight.js'

const aliases: Record<string, string> = { md: 'markdown', mdown: 'markdown', h: 'cpp', hpp: 'cpp', cc: 'cpp', cxx: 'cpp', cs: 'csharp', ps1: 'powershell', yml: 'yaml', vue: 'xml', svelte: 'xml', svg: 'xml', xsd: 'xml', xsl: 'xml', xhtml: 'xml', toml: 'ini', env: 'ini', conf: 'ini', sh: 'bash', zsh: 'bash', bashrc: 'bash', zshrc: 'bash', tsx: 'typescript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', jsonc: 'json', json5: 'json' }
const filenames: Record<string, string> = { dockerfile: 'dockerfile', makefile: 'makefile', 'cmakelists.txt': 'cmake' }

/** Convert escaped highlighter output to span/text nodes, never document HTML. */
export function SourceHighlight({ value, path }: { value: string; path: string }) {
  const tokens = useMemo(() => {
    const name = path.split(/[\\/]/).pop()?.toLowerCase() || ''
    const ext = name.split('.').pop() || ''
    const language = filenames[name] || aliases[ext] || ext
    if (!hljs.getLanguage(language) || value.length > 300_000) return value
    try {
      const parsed = new DOMParser().parseFromString(hljs.highlight(value, { language, ignoreIllegals: true }).value, 'text/html')
      const nodes = (parent: Node): ReactNode[] => Array.from(parent.childNodes, (node, index) => node instanceof Element && node.tagName === 'SPAN'
        ? <span key={index} className={node.className}>{nodes(node)}</span> : node.textContent)
      return nodes(parsed.body)
    } catch { return value }
  }, [value, path])
  return <code>{tokens}{value.endsWith('\n') ? '\n' : ''}</code>
}
