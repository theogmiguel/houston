import { useState } from 'react'
import type { GitCheckpointInfo } from '../../houston/generated/GitCheckpointInfo'
import { GitDialogShell } from './GitDialogShell'
import { DiffBody, DIFF_EMPTY_CLASS, SPIN_CLASS } from './DiffBody'
import {
  checkpointDeleteConfirm,
  checkpointRestoreConfirm,
  checkpointSubtitle,
  defaultCheckpointLabel
} from './checkpoints'
import { ConfirmModal } from '../ConfirmModal'
import { BTN_GHOST, BTN_PRIMARY } from '../buttonChrome'
import { FIELD_INPUT } from '../nav/navChrome'
import {
  IconAlertTriangle,
  IconEye,
  IconHistory,
  IconLoaderCircle,
  IconRefresh,
  IconTrash,
  IconUndo
} from '../icons'
import { Icon } from '../Icon'
import { Tooltip } from '../Tooltip'

export interface CheckpointInspect {
  ref: string
  patch: string
  truncated: boolean
  redacted: boolean
  loading: boolean
}

export interface CheckpointsDialogProps {
  checkpoints: GitCheckpointInfo[]
  busy: boolean
  error: string | null
  inspect: CheckpointInspect | null
  onClose: () => void
  onRefresh: () => void
  onCreate: (label: string | null) => void
  onInspect: (ref: string) => void
  onRestore: (ref: string) => void
  onDelete: (ref: string) => void
}

export function CheckpointsDialog({
  checkpoints,
  busy,
  error,
  inspect,
  onClose,
  onRefresh,
  onCreate,
  onInspect,
  onRestore,
  onDelete
}: CheckpointsDialogProps): React.JSX.Element {
  const [label, setLabel] = useState('')
  const [restoring, setRestoring] = useState<GitCheckpointInfo | null>(null)
  const [deleting, setDeleting] = useState<GitCheckpointInfo | null>(null)
  const now = Date.now()

  const submit = (): void => {
    if (busy) return
    const trimmed = label.trim()
    onCreate(trimmed === '' ? defaultCheckpointLabel(Date.now()) : trimmed)
    setLabel('')
  }

  return (
    <>
      <GitDialogShell
        heading="Checkpoints"
        testid="git-checkpoints-dialog"
        onClose={onClose}
        footer={
          <>
            <button className={`btn ${BTN_GHOST}`} data-testid="checkpoints-refresh" disabled={busy} onClick={onRefresh}>
              <Icon glyph={IconRefresh} role="small" />
              Refresh
            </button>
            <button className={`btn ${BTN_GHOST}`} onClick={onClose}>
              Close
            </button>
          </>
        }
      >
        {error && (
          <div
            role="alert"
            data-testid="checkpoints-error"
            className="flex items-start gap-1.5 py-2 px-3 rounded-[var(--tr-radius-sm)] border border-[color-mix(in_srgb,var(--danger)_42%,transparent)] bg-[color-mix(in_srgb,var(--danger)_11%,transparent)] text-[length:var(--tr-text-small-size)] text-[var(--text-primary)]"
          >
            <span className="flex-none text-[var(--danger)] pt-0.5">
              <Icon glyph={IconAlertTriangle} role="small" />
            </span>
            <span>{error}</span>
          </div>
        )}

        <div className="flex items-center gap-2">
          <input
            data-testid="checkpoint-new-label"
            aria-label="Checkpoint label"
            className={`${FIELD_INPUT} flex-1 min-w-0`}
            placeholder="Checkpoint label (optional)"
            value={label}
            spellCheck={false}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') submit()
            }}
          />
          <button className={`btn ${BTN_PRIMARY}`} data-testid="checkpoint-create" disabled={busy} onClick={submit}>
            Capture
          </button>
        </div>
        <p className="m-0 text-[length:var(--tr-text-small-size)] text-[var(--text-muted)]">
          A checkpoint is a hidden git ref holding the whole working copy — tracked edits, staged
          work and untracked files. Capturing one never touches the working tree; restoring
          replaces it. Inspect diffs tracked changes only; untracked captures restore but do not
          appear there.
        </p>

        <div role="list" data-testid="checkpoints-list" className="flex flex-col gap-1">
          {checkpoints.length === 0 ? (
            <p className="m-0 px-2 py-3 text-[length:var(--tr-text-small-size)] text-[var(--text-muted)]">
              No checkpoints yet.
            </p>
          ) : (
            checkpoints.map((c) => (
              <div
                key={c.ref}
                data-testid="checkpoint-row"
                data-ref={c.ref}
                className="group/row flex flex-col gap-1 px-2 py-1.5 rounded-[var(--tr-radius-sm)] hover:bg-[var(--card-hover)]"
              >
                <div className="flex items-center gap-2">
                  <span className="flex-none text-[var(--text-faint)]" aria-hidden>
                    <Icon glyph={IconHistory} role="label" />
                  </span>
                  <div className="flex-1 min-w-0 flex flex-col">
                    <span className="text-[length:var(--tr-text-sm)] text-[var(--text-primary)] overflow-hidden text-ellipsis whitespace-nowrap">
                      {c.label}
                    </span>
                    <span
                      data-testid="checkpoint-subtitle"
                      className="text-[length:var(--tr-text-xs)] text-[var(--text-faint)]"
                    >
                      {checkpointSubtitle(c, now)}
                    </span>
                  </div>
                  <Tooltip label="Inspect changes" className="inline-flex">
                    <button
                      type="button"
                      data-testid="checkpoint-inspect"
                      aria-label={`Inspect ${c.label}`}
                      disabled={busy}
                      onClick={() => onInspect(c.ref)}
                      className={`btn ${BTN_GHOST} p-1 rounded-[var(--tr-radius-sm)]`}
                    >
                      <Icon glyph={IconEye} role="label" />
                    </button>
                  </Tooltip>
                  <Tooltip label="Restore this snapshot" className="inline-flex">
                    <button
                      type="button"
                      data-testid="checkpoint-restore"
                      aria-label={`Restore ${c.label}`}
                      disabled={busy}
                      onClick={() => setRestoring(c)}
                      className={`btn ${BTN_GHOST} p-1 rounded-[var(--tr-radius-sm)]`}
                    >
                      <Icon glyph={IconUndo} role="label" />
                    </button>
                  </Tooltip>
                  <Tooltip label="Delete" className="inline-flex">
                    <button
                      type="button"
                      data-testid="checkpoint-delete"
                      aria-label={`Delete ${c.label}`}
                      disabled={busy}
                      onClick={() => setDeleting(c)}
                      className={`btn ${BTN_GHOST} p-1 rounded-[var(--tr-radius-sm)] enabled:hover:text-[var(--danger)]`}
                    >
                      <Icon glyph={IconTrash} role="label" />
                    </button>
                  </Tooltip>
                </div>
                {inspect && inspect.ref === c.ref && (
                  <div
                    data-testid="checkpoint-diff"
                    className="rounded-[var(--tr-radius-sm)] border border-[var(--border)] bg-[var(--content-bg)] max-h-[300px] overflow-y-auto [scrollbar-width:thin]"
                  >
                    {inspect.loading ? (
                      <div className={DIFF_EMPTY_CLASS}>
                        <span className={SPIN_CLASS}>
                          <Icon glyph={IconLoaderCircle} role="subhead" />
                        </span>
                        Loading the checkpoint diff…
                      </div>
                    ) : inspect.patch.trim().length === 0 ? (
                      <div className={DIFF_EMPTY_CLASS} data-testid="checkpoint-diff-empty">
                        The working tree matches this checkpoint.
                      </div>
                    ) : (
                      <>
                        {inspect.redacted && (
                          <div className="px-2 py-1 text-[length:var(--tr-text-xs)] text-[var(--warning)] border-b border-[var(--divider)]">
                            Secret-shaped values were redacted; sensitive files are withheld.
                          </div>
                        )}
                        <DiffBody patch={inspect.patch} truncated={inspect.truncated} />
                      </>
                    )}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </GitDialogShell>
      {restoring && (
        <ConfirmModal
          title="RESTORE CHECKPOINT"
          message={checkpointRestoreConfirm(restoring)}
          confirmLabel="Restore"
          onConfirm={() => {
            onRestore(restoring.ref)
            setRestoring(null)
          }}
          onCancel={() => setRestoring(null)}
        />
      )}
      {deleting && (
        <ConfirmModal
          title="DELETE CHECKPOINT"
          message={checkpointDeleteConfirm(deleting)}
          confirmLabel="Delete"
          onConfirm={() => {
            onDelete(deleting.ref)
            setDeleting(null)
          }}
          onCancel={() => setDeleting(null)}
        />
      )}
    </>
  )
}
