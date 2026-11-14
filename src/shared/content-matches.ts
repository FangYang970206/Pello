import type { ContentSearchMatch } from './types'

export function contentPattern(query: string, sensitive: boolean, regex: boolean, whole: boolean): RegExp {
  const source = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const flags = sensitive ? 'gu' : 'giu'
  // Validate the expression before adding boundaries; wrappers must not repair
  // an unclosed character class or change the meaning of invalid input.
  const pattern = new RegExp(source, flags)
  return whole ? new RegExp(`(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`, flags) : pattern
}

/** Standalone so the same bounded scan can execute in a cancellable worker. */
export function scanContent(text: string, source: string, flags: string, remaining: number): ContentSearchMatch[] {
  const pattern = new RegExp(source, flags), matches: ContentSearchMatch[] = []
  let number = 0
  for (const originalLine of text.split('\n')) {
    const line = originalLine.replace(/\r$/, '')
    number++
    for (const match of line.matchAll(pattern)) {
      const end = match.index + match[0].length
      matches.push({ line: number, column: match.index + 1, before: line.slice(Math.max(0, match.index - 80), match.index), match: match[0], after: line.slice(end, end + 160).replace(/\r$/, '') })
      if (--remaining <= 0) break
    }
    if (remaining <= 0) break
  }
  return matches
}
