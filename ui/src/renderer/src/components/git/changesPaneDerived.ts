import type { ChangeRow } from './changes'
import { pushDisabledReason } from './changes'
import type { PrState } from './usePrSubscription'

export function canCommit(staged: number, message: string, committing: boolean): boolean {
  return staged > 0 && message.trim().length > 0 && !committing
}

export function pushBlockedReason(
  connected: boolean,
  hasDirectory: boolean,
  upstream: string | null,
  ahead: number,
  pushing: boolean
): string | null {
  return !connected || !hasDirectory ? 'Not connected' : pushDisabledReason(upstream, ahead, pushing)
}

export function offerCreatePr(pr: PrState | null): boolean {
  return pr?.gh === 'ready' && pr.hasUpstream && pr.pr === null
}

export function openSelectedFile(
  onOpenFileInEditor: ((absPath: string) => void) | undefined,
  directory: string,
  row: ChangeRow | null
): (() => void) | undefined {
  if (!onOpenFileInEditor || !row) return undefined
  const absPath = `${directory.replace(/\/+$/, '')}/${row.path}`
  return () => onOpenFileInEditor(absPath)
}

export function reviewDisabledReason(connected: boolean, reviewBusy: boolean): string | null {
  return !connected || reviewBusy ? 'Not connected' : null
}
