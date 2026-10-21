import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import { gridStorageKey } from '../../layout/tree'
import type { NoticeStore } from '../../notices'
import { toggleRailGridRead, type RailPrefs } from '../../railPrefs'
import { RAIL_VIEW_LABEL, setRailViewHidden, type RailView } from '../../railView'
import type { RailUndoEntry } from './railUndo'

type UndoModule = typeof import('./railUndo')
type Overrides = RailPrefs['gridUnreadOverrides']

function withMember(set: ReadonlySet<string>, key: string, member: boolean): Set<string> {
  const next = new Set(set)
  if (member) next.add(key)
  else next.delete(key)
  return next
}

function withOverride(overrides: Overrides, key: string, value: Overrides[string] | undefined): Overrides {
  const next = { ...overrides }
  if (value) next[key] = value
  else delete next[key]
  return next
}

/** The rail's reversible actions; each one offers Undo through the workspace notices. */
export function useRailUndoActions(input: {
  notices?: Pick<NoticeStore, 'push' | 'dismiss'>
  workspaces: readonly { path: string; name: string }[]
  gridsByWorkspace: Record<string, readonly { id: string; name: string }[]>
  pinnedWorkspaces: ReadonlySet<string>
  onTogglePinWorkspace: (path: string) => void
  pinnedGridIds: ReadonlySet<string>
  setPinnedGridIds: Dispatch<SetStateAction<Set<string>>>
  railPrefs: RailPrefs
  setRailPrefs: Dispatch<SetStateAction<RailPrefs>>
}): {
  toggleGridPin: (path: string, gridId: string) => void
  togglePinWorkspace: (path: string) => void
  hideView: (view: RailView) => void
  toggleGridUnread: (key: string, signature: string, unread: boolean) => void
} {
  // Undo runs after later renders, so existence checks read the newest props.
  const latest = useRef(input)
  latest.current = input
  const undo = useRef<ReturnType<UndoModule['createRailUndo']> | null>(null)
  useEffect(() => () => undo.current?.dispose(), [])
  // The batching and its wording load on the first action, keeping them off the boot path.
  const record = (make: (module: UndoModule) => RailUndoEntry): void => {
    void import('./railUndo').then((module) => {
      const notices = latest.current.notices
      if (!notices) return
      undo.current ??= module.createRailUndo()
      undo.current.record(make(module), notices)
    })
  }
  const gridByKey = (key: string): { id: string; name: string } | undefined => {
    for (const [path, grids] of Object.entries(latest.current.gridsByWorkspace)) {
      const grid = grids.find((entry) => gridStorageKey(path, entry.id) === key)
      if (grid) return grid
    }
    return undefined
  }
  const grid = (key: string, restore: () => void) => ({ name: gridByKey(key)?.name ?? key, exists: () => gridByKey(key) !== undefined, restore })

  const toggleGridPin = (path: string, gridId: string): void => {
    const key = gridStorageKey(path, gridId)
    const wasPinned = input.pinnedGridIds.has(key)
    input.setPinnedGridIds((current) => withMember(current, key, !wasPinned))
    const target = grid(key, () => latest.current.setPinnedGridIds((current) => withMember(current, key, wasPinned)))
    record((module) => module.gridPinUndo(!wasPinned, target))
  }

  const togglePinWorkspace = (path: string): void => {
    const wasPinned = input.pinnedWorkspaces.has(path)
    input.onTogglePinWorkspace(path)
    const target = {
      name: input.workspaces.find((ws) => ws.path === path)?.name ?? path,
      exists: () => latest.current.workspaces.some((ws) => ws.path === path),
      restore: () => {
        if (latest.current.pinnedWorkspaces.has(path) !== wasPinned) latest.current.onTogglePinWorkspace(path)
      }
    }
    record((module) => module.workspacePinUndo(!wasPinned, target))
  }

  const hideView = (view: RailView): void => {
    setRailViewHidden(view, true)
    record((module) => module.viewHideUndo({ name: RAIL_VIEW_LABEL[view], exists: () => true, restore: () => setRailViewHidden(view, false) }))
  }

  const toggleGridUnread = (key: string, signature: string, unread: boolean): void => {
    const previous = input.railPrefs.gridUnreadOverrides[key]
    input.setRailPrefs((current) => ({ ...current, gridUnreadOverrides: toggleRailGridRead(current.gridUnreadOverrides, key, signature, unread) }))
    const target = grid(key, () => latest.current.setRailPrefs((current) => ({ ...current, gridUnreadOverrides: withOverride(current.gridUnreadOverrides, key, previous) })))
    record((module) => module.gridReadUndo(!unread, target))
  }

  return { toggleGridPin, togglePinWorkspace, hideView, toggleGridUnread }
}
