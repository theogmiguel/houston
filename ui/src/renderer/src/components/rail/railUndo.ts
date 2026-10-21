import type { NoticeStore } from '../../notices'

/** How long a reversible rail action can be undone; the notice and the batch expire together. */
export const RAIL_UNDO_WINDOW_MS = 5000
export const RAIL_UNDO_CODE = 'rail-undo'
export const RAIL_UNDO_MISSING_CODE = 'rail-undo-missing'

export interface RailUndoEntry {
  /** Entries batch only with the same kind, such as `unpin-grid`. */
  kind: string
  /** The notice for this entry alone, for example "Unpinned api-refactor". */
  title: string
  /** The notice for a batch of `count` entries, for example "Unpinned 3 grids". */
  batchTitle: (count: number) => string
  /** The noun used when restoring skips a target that no longer exists. */
  noun: (count: number) => string
  exists: () => boolean
  restore: () => void
}

export interface RailUndoBatch {
  kind: string
  entries: readonly RailUndoEntry[]
}

export function addToBatch(batch: RailUndoBatch | null, entry: RailUndoEntry): RailUndoBatch {
  if (batch?.kind === entry.kind) return { kind: batch.kind, entries: [...batch.entries, entry] }
  return { kind: entry.kind, entries: [entry] }
}

export function batchTitle(batch: RailUndoBatch): string {
  const [first] = batch.entries
  return batch.entries.length === 1 ? first.title : first.batchTitle(batch.entries.length)
}

/** Restores newest first and skips any target that went away after the action. */
export function restoreBatch(batch: RailUndoBatch): { restored: number; missing: number } {
  let restored = 0
  for (const entry of [...batch.entries].reverse()) {
    if (!entry.exists()) continue
    entry.restore()
    restored++
  }
  return { restored, missing: batch.entries.length - restored }
}

export function missingTitle(batch: RailUndoBatch, missing: number): string {
  const noun = batch.entries[0].noun(missing)
  return missing === 1 ? `Couldn't restore 1 ${noun}: it no longer exists` : `Couldn't restore ${missing} ${noun}: they no longer exist`
}

export type RailUndoNotices = Pick<NoticeStore, 'push' | 'dismiss'>

/** Batches reversible rail actions and offers one Undo notice per batch of identical actions. */
export function createRailUndo(): { record: (entry: RailUndoEntry, notices: RailUndoNotices) => void; dispose: () => void } {
  let batch: RailUndoBatch | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  const take = (): RailUndoBatch | null => {
    const current = batch
    batch = null
    if (timer) clearTimeout(timer)
    timer = null
    return current
  }
  const undo = (notices: RailUndoNotices): void => {
    const current = take()
    notices.dismiss(RAIL_UNDO_CODE)
    if (!current) return
    const { missing } = restoreBatch(current)
    if (missing > 0) notices.push({ code: RAIL_UNDO_MISSING_CODE, kind: 'warning', title: missingTitle(current, missing), durationMs: RAIL_UNDO_WINDOW_MS })
  }
  const record = (entry: RailUndoEntry, notices: RailUndoNotices): void => {
    const next = addToBatch(take(), entry)
    batch = next
    timer = setTimeout(() => {
      batch = null
      timer = null
    }, RAIL_UNDO_WINDOW_MS)
    notices.push({ code: RAIL_UNDO_CODE, kind: 'info', title: batchTitle(next), action: { label: 'Undo', onClick: () => undo(notices) }, durationMs: RAIL_UNDO_WINDOW_MS })
  }
  return { record, dispose: () => void take() }
}

const plural = (count: number, one: string, many: string): string => (count === 1 ? one : many)
const grids = (count: number): string => plural(count, 'grid', 'grids')
const workspaces = (count: number): string => plural(count, 'workspace', 'workspaces')
const views = (count: number): string => plural(count, 'view', 'views')

type Target = { name: string; exists: () => boolean; restore: () => void }

export function gridPinUndo(pinned: boolean, target: Target): RailUndoEntry {
  const verb = pinned ? 'Pinned' : 'Unpinned'
  return { kind: `${verb}-grid`, title: `${verb} ${target.name}`, batchTitle: (n) => `${verb} ${n} ${grids(n)}`, noun: grids, exists: target.exists, restore: target.restore }
}

export function workspacePinUndo(pinned: boolean, target: Target): RailUndoEntry {
  const verb = pinned ? 'Pinned' : 'Unpinned'
  return { kind: `${verb}-workspace`, title: `${verb} workspace ${target.name}`, batchTitle: (n) => `${verb} ${n} ${workspaces(n)}`, noun: workspaces, exists: target.exists, restore: target.restore }
}

export function gridReadUndo(unread: boolean, target: Target): RailUndoEntry {
  const state = unread ? 'unread' : 'read'
  return { kind: `marked-${state}`, title: `Marked ${target.name} ${state}`, batchTitle: (n) => `Marked ${n} ${grids(n)} ${state}`, noun: grids, exists: target.exists, restore: target.restore }
}

export function viewHideUndo(target: Target): RailUndoEntry {
  return { kind: 'hid-view', title: `Hid ${target.name} from the sidebar`, batchTitle: (n) => `Hid ${n} ${views(n)} from the sidebar`, noun: views, exists: target.exists, restore: target.restore }
}
