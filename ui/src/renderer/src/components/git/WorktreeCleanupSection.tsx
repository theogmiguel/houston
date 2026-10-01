import { useState } from 'react'
import { ConfirmModal } from '../ConfirmModal'
import { BTN_GHOST } from '../buttonChrome'
import { FIELD_LABEL } from '../nav/navChrome'
import {
  cleanNowConfirm,
  cleanupHeader,
  removablePaths,
  removableSummary,
  sizeLine,
  statusLine,
  type WorktreeCleanupView
} from './worktreeCleanup'

export interface WorktreeCleanupSectionProps {
  view: WorktreeCleanupView
  busy: boolean
  nowMs: number
  onCheck: () => void
  onCleanNow: (paths: string[]) => void
  onRemove: (path: string) => void
}

const MUTED = 'm-0 text-[length:var(--tr-text-small-size)] text-[var(--text-muted)]'

// The worktrees Houston created and may remove once their PR merges. Everything
// here comes from the daemon's last pass; nothing is measured on open. Clean now sends
// the paths its confirmation listed, so the daemon removes nothing the operator did not see.
export function WorktreeCleanupSection({
  view,
  busy,
  nowMs,
  onCheck,
  onCleanNow,
  onRemove
}: WorktreeCleanupSectionProps): React.JSX.Element {
  const [confirming, setConfirming] = useState(false)

  let body: React.JSX.Element
  if (view.status === 'pending') {
    body = <p className={MUTED}>Checking worktrees…</p>
  } else if (view.status === 'refused') {
    body = (
      <p role="alert" data-testid="worktree-cleanup-error" className={MUTED}>
        {view.message}
      </p>
    )
  } else if (view.entries.length === 0) {
    body = <p className={MUTED}>No worktrees created by Houston here</p>
  } else {
    const entries = view.entries
    body = (
      <>
        <div className="flex items-center gap-2">
          <span data-testid="worktree-cleanup-header" className="flex-1 text-[length:var(--tr-text-small-size)] text-[var(--text-primary)]">
            {cleanupHeader(entries)}
          </span>
          <button
            type="button"
            className={`btn ${BTN_GHOST}`}
            data-testid="worktree-cleanup-check"
            disabled={busy}
            onClick={onCheck}
          >
            Check
          </button>
          <button
            type="button"
            className={`btn ${BTN_GHOST}`}
            data-testid="worktree-cleanup-run"
            disabled={busy || removableSummary(entries).count === 0}
            onClick={() => setConfirming(true)}
          >
            Clean now
          </button>
        </div>
        <div role="list" className="flex flex-col gap-1">
          {entries.map((e) => (
            <div
              key={e.path}
              role="listitem"
              data-testid="worktree-cleanup-row"
              data-path={e.path}
              className="flex items-center gap-2 px-2 py-1.5 rounded-[var(--tr-radius-sm)] text-[var(--text-secondary)]"
            >
              <div className="flex-1 min-w-0 flex flex-col">
                <span className="font-mono text-[length:var(--tr-text-xs)] text-[var(--text-primary)] overflow-hidden text-ellipsis whitespace-nowrap">
                  {e.branch}
                  {e.pr !== null && <span className="text-[var(--text-faint)]"> #{e.pr}</span>}
                </span>
                <span className="text-[length:var(--tr-text-xs)] text-[var(--text-faint)] overflow-hidden text-ellipsis whitespace-nowrap">
                  {e.path}
                </span>
                <span className="text-[length:var(--tr-text-xs)] text-[var(--text-faint)]">
                  {sizeLine(e, nowMs)}
                </span>
                <span data-testid="worktree-cleanup-status" className="text-[length:var(--tr-text-xs)] text-[var(--text-muted)]">
                  {statusLine(e, nowMs)}
                </span>
              </div>
              {e.keep?.kind === 'probably_integrated' && (
                <button
                  type="button"
                  className={`btn ${BTN_GHOST}`}
                  data-testid="worktree-cleanup-remove"
                  disabled={busy}
                  onClick={() => onRemove(e.path)}
                >
                  Remove
                </button>
              )}
            </div>
          ))}
        </div>
        {confirming && (
          <ConfirmModal
            title="CLEAN MERGED WORKTREES"
            message={cleanNowConfirm(entries)}
            confirmLabel="Remove"
            onConfirm={() => {
              setConfirming(false)
              onCleanNow(removablePaths(entries))
            }}
            onCancel={() => setConfirming(false)}
          />
        )}
      </>
    )
  }

  return (
    <div
      data-testid="worktree-cleanup"
      className="flex flex-col gap-2 p-2.5 rounded-[var(--tr-radius-sm)] border border-[var(--border)] bg-[var(--content-bg)]"
    >
      <div className={FIELD_LABEL}>Created by Houston</div>
      {body}
    </div>
  )
}
