import { t } from '../shared/i18n'
export type Tile = { id: string; x: number; y: number; width: number; height: number; tabs?: string[]; active?: string }
export type SplitDirection = 'left' | 'right' | 'up' | 'down'

export function splitTile(tiles: Tile[], id: string, nextId: string, direction: SplitDirection): Tile[] {
  if (tiles.length >= 4 || tiles.some((tile) => tile.id === nextId)) throw new Error(t("最多支持四个内容分栏"))
  const tile = tiles.find((item) => item.id === id)
  if (!tile) throw new Error(t("标签已关闭"))
  const horizontal = direction === 'left' || direction === 'right'
  if ((horizontal ? tile.width : tile.height) < 2) throw new Error(t("此方向已达到分栏上限，请选择另一方向"))
  const first = { ...tile, width: horizontal ? 1 : tile.width, height: horizontal ? tile.height : 1 }
  const second = { ...first, x: horizontal ? tile.x + 1 : tile.x, y: horizontal ? tile.y : tile.y + 1 }
  const before = direction === 'left' || direction === 'up'
  return tiles.flatMap((item) => item.id === id ? [{ ...first, id: before ? nextId : id }, { ...second, id: before ? id : nextId }] : [item])
}

export function loadTerminalLayouts(): Record<string, Tile[]> {
  try {
    const raw = JSON.parse(localStorage.getItem('awb:terminalLayouts') || '{}')
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, Tile[]] => {
      const tiles = entry[1]
      if (!Array.isArray(tiles) || tiles.length < 1 || tiles.length > 4 || (tiles.length === 1 && !tiles[0]?.tabs) || new Set(tiles.map((tile) => tile?.id)).size !== tiles.length) return false
      const occupied = new Set<string>()
      const assigned = new Set<string>()
      for (const tile of tiles) {
        if (!tile || typeof tile.id !== 'string' || ![tile.x, tile.y, tile.width, tile.height].every(Number.isInteger) || tile.x < 0 || tile.y < 0 || tile.width < 1 || tile.height < 1 || tile.x + tile.width > 2 || tile.y + tile.height > 2) return false
        if (tile.tabs !== undefined && (!Array.isArray(tile.tabs) || !tile.tabs.length || !tile.tabs.every((id: unknown) => typeof id === 'string') || !tile.tabs.includes(tile.active))) return false
        for (const id of tile.tabs || [tile.id]) { if (assigned.has(id)) return false; assigned.add(id) }
        for (let x = tile.x; x < tile.x + tile.width; x++) for (let y = tile.y; y < tile.y + tile.height; y++) { const key = `${x}:${y}`; if (occupied.has(key)) return false; occupied.add(key) }
      }
      return occupied.size === 4
    }))
  } catch { return {} }
}
