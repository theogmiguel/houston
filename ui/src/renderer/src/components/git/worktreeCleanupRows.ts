import type { ManagedWorktreeInfo } from '../../houston/generated/ManagedWorktreeInfo'
import type { WorktreeKeep } from '../../houston/generated/WorktreeKeep'
import { isRemovable, keepLine, statusLine } from './worktreeCleanup'

export interface WorktreeCleanupRow {
  path: string
  branch: string
  baseBranch: string | null
  state: 'ready' | 'stale' | 'kept'
  reason: string
  sizeBytes: number | null
  pr: number | null
}

type CleanupKeep = WorktreeKeep | { kind: 'not_integrated' } | { kind: 'stale'; idle_days: number; removal_in_days: number }

interface ContractManagedWorktreeInfo {
  path: string
  branch: string
  base_branch?: string | null
  status?: WorktreeCleanupRow['state']
  keep: CleanupKeep | null
  bytes: number | null
  pr: number | null
}

export function toWorktreeCleanupRow(entry: ManagedWorktreeInfo, nowMs: number): WorktreeCleanupRow {
  const contractEntry = entry as unknown as ContractManagedWorktreeInfo
  const state = contractEntry.status ?? (isRemovable(entry) ? 'ready' : 'kept')
  const keep = contractEntry.keep
  let reason = statusLine(entry, nowMs)
  if (keep?.kind === 'stale') reason = `Idle ${keep.idle_days} days · removed in ${keep.removal_in_days} days`
  else if (keep?.kind === 'not_integrated') reason = contractEntry.base_branch
    ? `Kept: not integrated into ${contractEntry.base_branch}`
    : 'Kept: not integrated into its base branch'
  else if (keep) reason = keepLine(keep as WorktreeKeep, nowMs)

  return {
    path: contractEntry.path,
    branch: contractEntry.branch,
    baseBranch: contractEntry.base_branch ?? null,
    state,
    reason,
    sizeBytes: contractEntry.bytes,
    pr: contractEntry.pr
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
