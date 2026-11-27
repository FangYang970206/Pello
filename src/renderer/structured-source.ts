import { applyEdits, createScanner, format } from 'jsonc-parser'

export function structuredLanguage(path: string): 'json' | 'yaml' | undefined {
  if (/\.json$/i.test(path)) return 'json'
  if (/\.ya?ml$/i.test(path)) return 'yaml'
}

export function transformJson(text: string, pretty: boolean): string {
  // Validate strictly, but keep the original tokens (including large numbers,
  // repeated keys and string escapes) instead of serializing the parsed value.
  JSON.parse(text)
  const scanner = createScanner(text, true)
  const tokens: string[] = []
  for (scanner.scan(); scanner.getTokenLength(); scanner.scan()) tokens.push(text.slice(scanner.getTokenOffset(), scanner.getPosition()))
  const compact = tokens.join('')
  return pretty ? applyEdits(compact, format(compact, undefined, { tabSize: 2, insertSpaces: true, eol: '\n' })) + '\n' : compact
}
