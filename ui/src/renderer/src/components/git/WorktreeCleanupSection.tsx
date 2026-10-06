import { useMemo, useState } from 'react'
import { ConfirmModal } from '../ConfirmModal'
import { Button, Caption, Card, SectionHead, StatusLabel, Table } from '../ui'
import type { TableColumn } from '../ui'
import { cleanNowConfirm, formatBytes, isRemovable, removablePaths, statusLine } from './worktreeCleanup'
import type { WorktreeCleanupView } from './worktreeCleanup'
import { sortWorktreeCleanupRows, type WorktreeCleanupRow } from './worktreeCleanupRows'

export interface WorktreeCleanupSectionProps {
  view: WorktreeCleanupView
  staleRows?: WorktreeCleanupRow[]
  busy: boolean
  nowMs: number
  onCheck: () => void
  onCleanNow: (paths: string[]) => void
  onRemoveStale: (path: string) => void
}

// Ready paths are included in the confirmation payload as a snapshot so a later
// cleanup pass cannot remove a row the operator did not see.
export function WorktreeCleanupSection({
  view,
  staleRows = [],
  busy,
  nowMs,
  onCheck,
  onCleanNow,
  onRemoveStale
}: WorktreeCleanupSectionProps): React.JSX.Element {
  const [confirmingClean, setConfirmingClean] = useState(false)
  const [confirmingStale, setConfirmingStale] = useState<WorktreeCleanupRow | null>(null)
  const readyEntries = view.status === 'ready' ? view.entries : []
  const rows = useMemo(() => sortWorktreeCleanupRows([
    ...readyEntries.map((entry): WorktreeCleanupRow => ({
      path: entry.path,
      branch: entry.branch,
      state: isRemovable(entry) ? 'ready' : 'kept',
      reason: statusLine(entry, nowMs),
      sizeBytes: entry.bytes,
      pr: entry.pr
    })),
    ...staleRows
  ]), [nowMs, readyEntries, staleRows])
  const readyCount = rows.filter((row) => row.state === 'ready').length

  const columns: TableColumn<WorktreeCleanupRow>[] = [
    {
      key: 'state' as const,
      header: 'Status',
      width: '6rem',
      render: (_state, row) =>
        <StatusLabel status={row.state === 'ready' ? 'Ready' : row.state === 'stale' ? 'Stale' : 'Kept'} size="small" />
    },
    {
      key: 'branch' as const,
      header: 'Worktree',
      render: (_branch, row) => (
        <span>
          <Caption variant="code">{row.branch}{row.pr !== null && ` #${row.pr}`}</Caption>
          <br />
          <Caption tone="faint" variant="code">{row.path}</Caption>
          <br />
          <Caption tone="faint">{row.reason}</Caption>
        </span>
      )
    },
    {
      key: 'sizeBytes' as const,
      header: 'Size',
      numeric: true,
      width: '6.5rem',
      render: (_sizeBytes, row) => row.sizeBytes === null ? 'Not measured' : formatBytes(row.sizeBytes)
    }
  ]

  return (
    <Card tone="inset" padding="md" className="grid gap-[var(--space-2)]" data-testid="worktree-cleanup">
      <SectionHead
        title="Created by Houston"
        action={view.status === 'ready' ? (
          <>
            <Button variant="ghost" size="sm" data-testid="worktree-cleanup-check" disabled={busy} onClick={onCheck}>Check</Button>
            <Button variant="ghost" size="sm" data-testid="worktree-cleanup-run" disabled={busy || readyCount === 0} onClick={() => setConfirmingClean(true)}>Clean now</Button>
          </>
        ) : undefined}
      />
      {view.status === 'pending' ? (
        <Caption>Checking worktrees…</Caption>
      ) : view.status === 'refused' ? (
        <div role="alert" data-testid="worktree-cleanup-error"><Caption>{view.message}</Caption></div>
      ) : rows.length === 0 ? (
        <Caption>No worktrees created by Houston here</Caption>
      ) : (
        <Table
          aria-label="Worktrees created by Houston"
          columns={columns}
          rows={rows}
          getRowId={(row) => row.path}
          rowTone={(row) => row.state === 'kept' ? 'muted' : 'default'}
          rowAction={(row) => row.state === 'stale' ? (
            <Button variant="ghost" size="sm" data-testid="worktree-cleanup-remove" disabled={busy} onClick={() => setConfirmingStale(row)}>Remove…</Button>
          ) : null}
          density="compact"
          variant="framed"
          className="w-full"
        />
      )}
      {confirmingClean && (
        <ConfirmModal
          title="Clean ready worktrees"
          message={cleanNowConfirm(readyEntries)}
          confirmLabel="Remove"
          onConfirm={() => {
            setConfirmingClean(false)
            onCleanNow(removablePaths(readyEntries))
          }}
          onCancel={() => setConfirmingClean(false)}
        />
      )}
      {confirmingStale && (
        <ConfirmModal
          title="Remove stale worktree"
          message={`Remove ${confirmingStale.branch} at ${confirmingStale.path}? Its branch is kept, and no unpushed work is lost.`}
          confirmLabel="Remove"
          onConfirm={() => {
            onRemoveStale(confirmingStale.path)
            setConfirmingStale(null)
          }}
          onCancel={() => setConfirmingStale(null)}
        />
      )}
    </Card>
  )
}
