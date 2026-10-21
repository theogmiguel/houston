import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoticeInput } from '../../notices'
import { RAIL_UNDO_CODE, RAIL_UNDO_MISSING_CODE, RAIL_UNDO_WINDOW_MS, addToBatch, batchTitle, createRailUndo, gridPinUndo, gridReadUndo, restoreBatch, viewHideUndo, workspacePinUndo, type RailUndoEntry } from './railUndo'

function unpin(name: string, log: string[], exists = true): RailUndoEntry {
  return gridPinUndo(false, { name, exists: () => exists, restore: () => log.push(name) })
}

describe('rail undo batching', () => {
  it('batches identical actions and names the count', () => {
    const log: string[] = []
    let batch = addToBatch(null, unpin('api', log))
    expect(batchTitle(batch)).toBe('Unpinned api')
    batch = addToBatch(batch, unpin('docs', log))
    batch = addToBatch(batch, unpin('web', log))
    expect(batchTitle(batch)).toBe('Unpinned 3 grids')
  })

  it('starts a new batch when the action differs', () => {
    const batch = addToBatch(addToBatch(null, unpin('api', [])), gridPinUndo(true, { name: 'docs', exists: () => true, restore: () => {} }))
    expect(batch.entries).toHaveLength(1)
    expect(batchTitle(batch)).toBe('Pinned docs')
  })

  it('restores newest first and skips targets that no longer exist', () => {
    const log: string[] = []
    const batch = [unpin('api', log), unpin('gone', log, false), unpin('web', log)].reduce<ReturnType<typeof addToBatch> | null>((b, e) => addToBatch(b, e), null)!
    expect(restoreBatch(batch)).toEqual({ restored: 2, missing: 1 })
    expect(log).toEqual(['web', 'api'])
  })

  it('words each reversible action', () => {
    const target = { name: 'alpha', exists: () => true, restore: () => {} }
    expect(workspacePinUndo(true, target).title).toBe('Pinned workspace alpha')
    expect(workspacePinUndo(false, target).batchTitle(2)).toBe('Unpinned 2 workspaces')
    expect(gridReadUndo(false, target).title).toBe('Marked alpha read')
    expect(gridReadUndo(true, target).batchTitle(4)).toBe('Marked 4 grids unread')
    expect(viewHideUndo({ ...target, name: 'Tasks' }).title).toBe('Hid Tasks from the sidebar')
  })
})

describe('createRailUndo', () => {
  let undo: ReturnType<typeof createRailUndo>
  const push = vi.fn<(input: NoticeInput) => string>((input) => input.code)
  const dismiss = vi.fn<(code: string) => void>()
  const record = (entry: RailUndoEntry): void => undo.record(entry, { push, dismiss })

  beforeEach(() => {
    vi.useFakeTimers()
    push.mockClear()
    dismiss.mockClear()
    undo = createRailUndo()
  })

  afterEach(() => {
    undo.dispose()
    vi.useRealTimers()
  })

  const lastNotice = (): NoticeInput => push.mock.calls.at(-1)![0]

  it('offers Undo for the window and replaces the notice as a batch grows', () => {
    const log: string[] = []
    record(unpin('api', log))
    expect(lastNotice()).toMatchObject({ code: RAIL_UNDO_CODE, title: 'Unpinned api', durationMs: RAIL_UNDO_WINDOW_MS, action: { label: 'Undo' } })
    vi.advanceTimersByTime(RAIL_UNDO_WINDOW_MS - 1)
    record(unpin('docs', log))
    expect(lastNotice().title).toBe('Unpinned 2 grids')
    lastNotice().action!.onClick()
    expect(log).toEqual(['docs', 'api'])
    expect(dismiss).toHaveBeenCalledWith(RAIL_UNDO_CODE)
  })

  it('restores a batch once, however often Undo is pressed', () => {
    const log: string[] = []
    record(unpin('api', log))
    const undo = lastNotice().action!.onClick
    undo()
    undo()
    expect(log).toEqual(['api'])
  })

  it('stops batching after the window and forgets the expired batch', () => {
    const log: string[] = []
    record(unpin('api', log))
    vi.advanceTimersByTime(RAIL_UNDO_WINDOW_MS)
    lastNotice().action!.onClick()
    expect(log).toEqual([])
    record(unpin('docs', log))
    expect(lastNotice().title).toBe('Unpinned docs')
  })

  it('names the targets it could not restore', () => {
    const log: string[] = []
    record(unpin('api', log))
    record(unpin('gone', log, false))
    lastNotice().action!.onClick()
    expect(log).toEqual(['api'])
    expect(lastNotice()).toMatchObject({ code: RAIL_UNDO_MISSING_CODE, kind: 'warning', title: "Couldn't restore 1 grid: it no longer exists" })
  })
})
