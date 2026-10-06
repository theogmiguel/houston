import type { ManagedWorktreeInfo } from '../../houston/generated/ManagedWorktreeInfo'
import { keepLine, statusLine } from './worktreeCleanup'

export interface WorktreeCleanupRow {
  path: string
  branch: string
  baseBranch: string | null
  state: 'ready' | 'stale' | 'kept'
  reason: string
  sizeBytes: number | null
  pr: number | null
}

export function toWorktreeCleanupRow(entry: ManagedWorktreeInfo, nowMs: number): WorktreeCleanupRow {
  const keep = entry.keep
  let reason = statusLine(entry, nowMs)
  if (keep?.kind === 'stale') reason = `Idle ${keep.idle_days} days · removed in ${keep.removal_in_days} days`
  else if (keep?.kind === 'not_integrated') reason = entry.base_branch
    ? `Kept: not integrated into ${entry.base_branch}`
    : 'Kept: not integrated into its base branch'
  else if (keep) reason = keepLine(keep, nowMs)

  return {
    path: entry.path,
    branch: entry.branch,
    baseBranch: entry.base_branch,
    state: entry.status,
    reason,
    sizeBytes: entry.bytes,
    pr: entry.pr
  }
}

const STATE_ORDER: Record<WorktreeCleanupRow['state'], number> = {
  ready: 0,
  stale: 1,
  kept: 2
}

export function sortWorktreeCleanupRows(rows: WorktreeCleanupRow[]): WorktreeCleanupRow[] {
  return [...rows].sort((a, b) =>
    STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
    (b.sizeBytes ?? -1) - (a.sizeBytes ?? -1) ||
    a.path.localeCompare(b.path)
  )
}
