import type { DirEntry } from '../../env'

export interface TreeRow {
  path: string
  name: string
  dir: boolean
  depth: number
  expanded: boolean
}

export type TreeChildren = ReadonlyMap<string, readonly DirEntry[]>

export function sortEntries(entries: readonly DirEntry[]): DirEntry[] {
  return [...entries].sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })
  })
}

// The denylist lives in `fs.rs` (`IGNORED_ENTRY_NAMES`), which annotates entries
// rather than filtering them so a reveal INTO an ignored dir can still expand.
// Do not copy that list here: two answers to "what is noise" would drift.
export function visibleEntries(entries: readonly DirEntry[]): DirEntry[] {
  return sortEntries(entries.filter((e) => !e.ignored))
}

export function flattenTree(
  root: string,
  children: TreeChildren,
  expanded: ReadonlySet<string>,
  depth = 0
): TreeRow[] {
  const listing = children.get(root)
  if (!listing) return []
  const out: TreeRow[] = []
  for (const e of listing) {
    const isOpen = e.dir && expanded.has(e.path)
    out.push({ path: e.path, name: e.name, dir: e.dir, depth, expanded: isOpen })
    if (isOpen) out.push(...flattenTree(e.path, children, expanded, depth + 1))
  }
  return out
}

export type TreeKeyAction =
  | { kind: 'none' }
  | { kind: 'focus'; index: number }
  | { kind: 'expand'; path: string }
  | { kind: 'collapse'; path: string }
  | { kind: 'open'; path: string }

export function treeKeyAction(rows: readonly TreeRow[], index: number, key: string): TreeKeyAction {
  const row = rows[index]
  if (!row) return { kind: 'none' }
  switch (key) {
    case 'ArrowDown':
      return index + 1 < rows.length ? { kind: 'focus', index: index + 1 } : { kind: 'none' }
    case 'ArrowUp':
      return index > 0 ? { kind: 'focus', index: index - 1 } : { kind: 'none' }
    case 'ArrowRight':
      if (!row.dir) return { kind: 'none' }
      if (!row.expanded) return { kind: 'expand', path: row.path }
      return index + 1 < rows.length ? { kind: 'focus', index: index + 1 } : { kind: 'none' }
    case 'ArrowLeft': {
      if (row.dir && row.expanded) return { kind: 'collapse', path: row.path }
      for (let i = index - 1; i >= 0; i--) {
        if (rows[i].depth < row.depth) return { kind: 'focus', index: i }
      }
      return { kind: 'none' }
    }
    case 'Enter':
    case ' ':
      if (!row.dir) return { kind: 'open', path: row.path }
      return row.expanded ? { kind: 'collapse', path: row.path } : { kind: 'expand', path: row.path }
    default:
      return { kind: 'none' }
  }
}
