import type { Workspace } from '../houston/client'

export function applyOrder(workspaces: Workspace[], order: string[]): Workspace[] {
  const byPath = new Map(workspaces.map((w) => [w.path, w]))
  const ordered: Workspace[] = []
  const seen = new Set<string>()
  for (const path of order) {
    const w = byPath.get(path)
    if (w && !seen.has(path)) {
      ordered.push(w)
      seen.add(path)
    }
  }
  for (const w of workspaces) {
    if (!seen.has(w.path)) ordered.push(w)
  }
  return ordered
}

export function partitionPinned(
  workspaces: Workspace[],
  pinned: ReadonlySet<string>
): { pinned: Workspace[]; unpinned: Workspace[] } {
  const pinnedList: Workspace[] = []
  const unpinnedList: Workspace[] = []
  for (const w of workspaces) {
    if (pinned.has(w.path)) pinnedList.push(w)
    else unpinnedList.push(w)
  }
  return { pinned: pinnedList, unpinned: unpinnedList }
}

export function reorderPinned(
  displayed: Workspace[],
  pinned: ReadonlySet<string>,
  fromPath: string,
  toIndex: number
): string[] {
  const { pinned: pinnedList, unpinned: unpinnedList } = partitionPinned(displayed, pinned)
  const pinnedPaths = pinnedList.map((w) => w.path)
  const unpinnedPaths = unpinnedList.map((w) => w.path)
  if (pinned.has(fromPath)) {
    const clamped = Math.max(0, Math.min(toIndex, pinnedPaths.length))
    return [...reorder(pinnedPaths, fromPath, clamped), ...unpinnedPaths]
  }
  const localIndex = Math.max(0, Math.min(toIndex - pinnedPaths.length, unpinnedPaths.length))
  return [...pinnedPaths, ...reorder(unpinnedPaths, fromPath, localIndex)]
}

export function translateFilteredDropIndex(
  all: Workspace[],
  filtered: Workspace[],
  pinned: ReadonlySet<string>,
  fromPath: string,
  filteredIndex: number
): number {
  const isPinnedDrag = pinned.has(fromPath)
  const { pinned: allPinned, unpinned: allUnpinned } = partitionPinned(all, pinned)
  const { pinned: filtPinned, unpinned: filtUnpinned } = partitionPinned(filtered, pinned)
  const fullGroup = isPinnedDrag ? allPinned : allUnpinned
  const filteredGroup = isPinnedDrag ? filtPinned : filtUnpinned
  const groupOffset = isPinnedDrag ? 0 : allPinned.length
  const localFilteredIndex = filteredIndex - (isPinnedDrag ? 0 : filtPinned.length)
  const clampedLocal = Math.max(0, Math.min(localFilteredIndex, filteredGroup.length))
  if (clampedLocal >= filteredGroup.length) return groupOffset + fullGroup.length
  const target = filteredGroup[clampedLocal]
  const fullLocalIndex = fullGroup.findIndex((w) => w.path === target.path)
  return groupOffset + (fullLocalIndex === -1 ? fullGroup.length : fullLocalIndex)
}

export function reorder(order: string[], fromPath: string, toIndex: number): string[] {
  const fromIndex = order.indexOf(fromPath)
  const without = order.filter((p) => p !== fromPath)
  const adjusted = fromIndex !== -1 && toIndex > fromIndex ? toIndex - 1 : toIndex
  const clamped = Math.max(0, Math.min(adjusted, without.length))
  return [...without.slice(0, clamped), fromPath, ...without.slice(clamped)]
}
