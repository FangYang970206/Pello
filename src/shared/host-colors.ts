import type { Host } from './types'

export const HOST_COLORS = [
  { id: 'blue', name: '蓝色' }, { id: 'teal', name: '青色' },
  { id: 'purple', name: '紫色' }, { id: 'orange', name: '橙色' },
  { id: 'rose', name: '玫红' }, { id: 'olive', name: '橄榄绿' },
  { id: 'sky', name: '天蓝' }, { id: 'mauve', name: '藕紫' }
] as const

export function hostColor(value: unknown): string {
  return HOST_COLORS.some((color) => color.id === value) ? String(value) : 'blue'
}

export function nextHostColor(hosts: Host[]): string {
  return HOST_COLORS.find((color) => !hosts.some((host) => hostColor(host.color) === color.id))?.id || 'blue'
}
