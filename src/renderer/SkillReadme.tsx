import type { ReactNode } from 'react'

/** Read-only Markdown text. Imported HTML and scripts are never mounted. */
export function SkillReadme({ content }: { content: string }) {
  const lines = content.replace(/^\ufeff?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').split(/\r?\n/)
  const blocks: ReactNode[] = []
  const inline = (text: string) => text.split(/(`[^`]+`|\*\*[^*]+\*\*)/).map((part, index) => part.startsWith('`') ? <code key={index}>{part.slice(1, -1)}</code> : part.startsWith('**') ? <strong key={index}>{part.slice(2, -2)}</strong> : part)
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index], heading = /^(#{1,6})\s+(.+)$/.exec(line)
    if (/^\s*```/.test(line)) {
      const code: string[] = []
      while (++index < lines.length && !/^\s*```/.test(lines[index])) code.push(lines[index])
      blocks.push(<pre key={index}><code>{code.join('\n')}</code></pre>)
    } else if (heading) {
      blocks.push(heading[1].length <= 2 ? <h3 key={index}>{inline(heading[2])}</h3> : <h4 key={index}>{inline(heading[2])}</h4>)
    } else if (/^\s*[-*+]\s+/.test(line)) {
      const items = [line.replace(/^\s*[-*+]\s+/, '')]
      while (index + 1 < lines.length && /^\s*[-*+]\s+/.test(lines[index + 1])) items.push(lines[++index].replace(/^\s*[-*+]\s+/, ''))
      blocks.push(<ul key={index}>{items.map((item, i) => <li key={i}>{inline(item)}</li>)}</ul>)
    } else if (line.trim()) {
      const paragraph = [line]
      while (index + 1 < lines.length && lines[index + 1].trim() && !/^(\s*```|#{1,6}\s|\s*[-*+]\s)/.test(lines[index + 1])) paragraph.push(lines[++index])
      blocks.push(<p key={index}>{inline(paragraph.join('\n'))}</p>)
    }
  }
  return <div className="skill-readme">{blocks}</div>
}
