import { t } from './i18n'
import type { Host } from './types'

export const HOST_COLORS = [
  { id: 'blue', get name() { return t("蓝色") } }, { id: 'teal', get name() { return t("青色") } },
  { id: 'purple', get name() { return t("紫色") } }, { id: 'orange', get name() { return t("橙色") } },
  { id: 'rose', get name() { return t("玫红") } }, { id: 'olive', get name() { return t("橄榄绿") } },
  { id: 'sky', get name() { return t("天蓝") } }, { id: 'mauve', get name() { return t("藕紫") } }
] as const

export function hostColor(value: unknown): string {
  return HOST_COLORS.some((color) => color.id === value) ? String(value) : 'blue'
}

export function nextHostColor(hosts: Host[]): string {
  return HOST_COLORS.find((color) => !hosts.some((host) => hostColor(host.color) === color.id))?.id || 'blue'
}
