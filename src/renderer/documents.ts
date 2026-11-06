import type { FileContent } from '../shared/types'

export type DocumentDraft = FileContent & {
  projectId: string
  path: string
  draft: string
  saving?: boolean
  error?: string
  past?: string[]
  future?: string[]
  editAt?: number
  composing?: boolean
  replacing?: boolean
  replacementId?: string
}

export const documentKey = (projectId: string, path: string) => `${projectId}:${path}`
export const editableText = (text: string) => text.replace(/^\ufeff/, '').replace(/\r\n?/g, '\n')
export const isDirty = (doc: DocumentDraft) => doc.draft !== editableText(doc.text)
export const AUTO_SAVE_DELAY = 120_000

function historyLimit(entries: string[]): string[] {
  const result = entries.slice(-100)
  let size = result.reduce((total, text) => total + text.length, 0)
  while (result.length > 1 && size > 4_000_000) size -= result.shift()!.length
  return result
}

/** History belongs to the draft, so saving or switching editors cannot erase it. */
export function recordChange(doc: DocumentDraft, draft: string, now = Date.now()): DocumentDraft {
  if (doc.draft === draft) return doc
  const past = !doc.editAt || now - doc.editAt > 600 ? historyLimit([...(doc.past || []), doc.draft]) : doc.past || []
  return { ...doc, draft, past, future: [], editAt: now }
}

export function undoDocument(doc: DocumentDraft, redo = false): DocumentDraft {
  const source = redo ? doc.future || [] : doc.past || []
  if (!source.length) return doc
  const draft = source[source.length - 1]
  return { ...doc, draft, editAt: 0,
    past: redo ? historyLimit([...(doc.past || []), doc.draft]) : source.slice(0, -1),
    future: redo ? source.slice(0, -1) : historyLimit([...(doc.future || []), doc.draft]) }
}
export function fileText(doc: DocumentDraft): string {
  const bom = doc.text.startsWith('\ufeff') ? '\ufeff' : ''
  const eol = doc.text.includes('\r\n') ? '\r\n' : '\n'
  return bom + doc.draft.replace(/\n/g, eol)
}
