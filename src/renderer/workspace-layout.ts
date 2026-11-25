import { splitTile, type SplitDirection, type Tile } from './terminal-layout'

export type EditorGroup = Tile & { tabs: string[]; active: string }

function fillGroups(groups: EditorGroup[]): EditorGroup[] {
  if (groups.length === 1) return [{ ...groups[0], x: 0, y: 0, width: 2, height: 2 }]
  return groups.map((group, index) => groups.length === 2
    ? { ...group, x: index, y: 0, width: 1, height: 2 }
    : { ...group, x: index === 0 ? 0 : 1, y: index === 2 ? 1 : 0, width: 1, height: index === 0 ? 2 : 1 })
}

/** Every tab belongs to one group. Selecting it changes only that group's view. */
export function reconcileGroups(saved: Tile[] | undefined, ids: string[], selected: string | undefined, previous?: string): EditorGroup[] {
  if (!ids.length || !selected) return []
  if (!saved?.length) return [{ id: ids[0], x: 0, y: 0, width: 2, height: 2, tabs: ids, active: selected }]
  const owned = new Set<string>()
  let groups: EditorGroup[] = saved.map((tile) => {
    const tabs = (tile.tabs || [tile.id]).filter((id) => {
      if (!ids.includes(id) || owned.has(id)) return false
      owned.add(id); return true
    })
    return { ...tile, tabs, active: tabs.includes(tile.active || tile.id) ? tile.active || tile.id : tabs[0] }
  }).filter((group) => group.tabs.length)
  if (!groups.length) return reconcileGroups(undefined, ids, selected)
  if (groups.length !== saved.length) groups = fillGroups(groups)
  const target = groups.find((group) => group.tabs.includes(previous || '')) || groups.find((group) => group.tabs.includes(selected)) || groups[0]
  const added = ids.filter((id) => !owned.has(id))
  return groups.map((group) => {
    const tabs = group === target ? [...group.tabs, ...added] : group.tabs
    return { ...group, tabs, active: tabs.includes(selected) ? selected : group.active }
  })
}

export function splitGroup(groups: EditorGroup[], id: string, nextId: string, direction: SplitDirection): EditorGroup[] {
  const source = groups.find((group) => group.tabs.includes(id))!
  return splitTile(groups, source.id, nextId, direction).map((tile) => tile.id === nextId
    ? { ...tile, tabs: [nextId], active: nextId }
    : { ...tile, tabs: tile.tabs!, active: tile.id === source.id ? id : tile.active! })
}

export function mergeGroups(groups: EditorGroup[], id: string): EditorGroup[] {
  const target = groups.find((group) => group.tabs.includes(id)) || groups[0]
  return [{ ...target, x: 0, y: 0, width: 2, height: 2, tabs: groups.flatMap((group) => group.tabs), active: id }]
}

export function moveGroupTab(groups: EditorGroup[], id: string, targetId: string, before?: string): EditorGroup[] {
  const target = groups.find((group) => group.id === targetId)
  const source = groups.find((group) => group.tabs.includes(id))
  if (!source || !target || before === id) return groups
  const moved = groups.map((group) => {
    const tabs = group.tabs.filter((tab) => tab !== id)
    if (group === target) {
      const index = before ? tabs.indexOf(before) : -1
      tabs.splice(index < 0 ? tabs.length : index, 0, id)
    }
    return { ...group, tabs, active: group === target ? id : tabs.includes(group.active) ? group.active : tabs[0] }
  }).filter((group) => group.tabs.length)
  return moved.length === groups.length ? moved : fillGroups(moved)
}

/** Keep focus in the closing tab's group, then fall back to another visible group. */
export function preferredGroupTab(groups: Tile[] | undefined, available: string[], closing?: string): string | undefined {
  const same = groups?.find((group) => (group.tabs || [group.id]).includes(closing || ''))
  for (const group of same ? [same, ...groups!.filter((group) => group !== same)] : groups || []) {
    const tabs = group.tabs || [group.id], index = tabs.indexOf(closing || '')
    const candidates = group === same ? [tabs[index + 1], tabs[index - 1], group.active, ...tabs] : [group.active, ...tabs]
    const id = candidates.find((id): id is string => !!id && id !== closing && available.includes(id))
    if (id) return id
  }
}
