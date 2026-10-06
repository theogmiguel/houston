export interface WorktreeCleanupRow {
  path: string
  branch: string
  state: 'ready' | 'stale' | 'kept'
  reason: string
  sizeBytes: number | null
  pr: number | null
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
