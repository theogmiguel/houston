import { useSyncExternalStore } from 'react'
import type { HoustonClient, PrInfo, SessionInfo } from '../../houston/client'

export type PrsView = 'requests' | 'queue'

/** A request from outside the page, such as the command palette, to show a
 *  view and optionally add a pull request to the merge queue once it is shown. */
export interface PrsViewRequest {
  view: PrsView
  enqueue?: number
}

let request: PrsViewRequest | null = null
const listeners = new Set<() => void>()

export function requestPrsView(next: PrsViewRequest): void {
  request = next
  for (const listener of listeners) listener()
}

export function clearPrsViewRequest(): void {
  if (request === null) return
  request = null
  for (const listener of listeners) listener()
}

export function usePrsViewRequest(): PrsViewRequest | null {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    () => request,
    () => request,
  )
}

/** The palette's merge queue commands: open the view, and add the pull request of
 *  the focused pane's checkout, offered only while it is open. */
export function mergeQueuePaletteActions(
  prByDir: ReadonlyMap<string, { pr: PrInfo | null }>,
  sessions: ReadonlyMap<number, Pick<SessionInfo, 'cwd'>>,
  activeId: number | null,
  selectNavRow: (row: 'prs') => void
): { openMergeQueue: () => void; addToMergeQueue?: () => void } {
  const open = (enqueue?: number): void => { requestPrsView({ view: 'queue', enqueue }); selectNavRow('prs') }
  const cwd = activeId === null ? undefined : sessions.get(activeId)?.cwd
  const focused = cwd === undefined ? null : prByDir.get(cwd)?.pr ?? null
  const number = focused && focused.state.toUpperCase() === 'OPEN' ? focused.number : null
  return { openMergeQueue: () => open(), addToMergeQueue: number === null ? undefined : () => open(number) }
}

/** The palette's "Pause merge queue": the selected workspace's queue, absent while
 *  every workspace is shown. */
export function mergeQueuePauseAction(client: Pick<HoustonClient, 'mergeQueuePause'>, selected: string): { pauseMergeQueue?: () => void } {
  return selected === 'all' ? {} : { pauseMergeQueue: () => { client.mergeQueuePause(selected, true) } }
}
