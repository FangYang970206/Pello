import type { FileContent } from '../shared/types'

export type DocumentDraft = FileContent & {
  projectId: string
  path: string
  draft: string
  saving?: boolean
  error?: string
}

export const documentKey = (projectId: string, path: string) => `${projectId}:${path}`
export const editableText = (text: string) => text.replace(/^\ufeff/, '').replace(/\r\n?/g, '\n')
export const isDirty = (doc: DocumentDraft) => doc.draft !== editableText(doc.text)
export function fileText(doc: DocumentDraft): string {
  const bom = doc.text.startsWith('\ufeff') ? '\ufeff' : ''
  const eol = doc.text.includes('\r\n') ? '\r\n' : '\n'
  return bom + doc.draft.replace(/\n/g, eol)
}
