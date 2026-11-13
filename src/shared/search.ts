export type TextMatch = { from: number; to: number }

/** Literal, non-overlapping matches; replacement text is never a regex template. */
export function textMatches(text: string, query: string, sensitive = false): TextMatch[] {
  if (!query) return []
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), sensitive ? 'gu' : 'giu')
  return Array.from(text.matchAll(pattern), (match) => ({ from: match.index, to: match.index + match[0].length }))
}

export function replaceMatches(text: string, matches: TextMatch[], value: string): string {
  let offset = 0
  const parts: string[] = []
  for (const match of matches) { parts.push(text.slice(offset, match.from), value); offset = match.to }
  parts.push(text.slice(offset))
  return parts.join('')
}
