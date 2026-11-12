import { en } from './locales/en'

export type Language = 'zh-CN' | 'en'
let language: Language = 'zh-CN'
const listeners = new Set<() => void>()

export function getLanguage(): Language { return language }
export function setLanguage(value: unknown): void {
  const next = value === 'en' ? 'en' : 'zh-CN'
  if (next === language) return
  language = next
  for (const listener of listeners) listener()
}
export function subscribeLanguage(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Translate application-owned text only. Parameters are never translated. */
export function t(source: string, ...values: unknown[]): string {
  const text = language === 'en' ? en[source] ?? source : source
  return text.replace(/\{\{(\d+)\}\}/g, (match, index: string) => Number(index) < values.length ? String(values[Number(index)]) : match)
}

/** A task can outlive a language change; recognize its original messages too. */
export function hasMessageFragment(text: string | undefined, source: string): boolean {
  return !!text && (text.includes(source) || (!!en[source] && text.includes(en[source])))
}

export function isMessage(text: string | undefined, source: string): boolean {
  return text === source || (!!en[source] && text === en[source])
}
