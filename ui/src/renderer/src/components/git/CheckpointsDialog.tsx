import { useState } from 'react'
import type { GitCheckpointInfo } from '../../houston/generated/GitCheckpointInfo'
import { GitDialogShell } from './GitDialogShell'
import { DiffBody } from './DiffBody'
import { DiffEmptyState, DiffLoadingMark, GitCheckpointCreateRow, GitCheckpointDiffPanel, GitCheckpointEmptyText, GitCheckpointIconRow, GitCheckpointIconSlot, GitCheckpointLabel, GitCheckpointLabelColumn, GitCheckpointList, GitCheckpointRedactionNotice, GitCheckpointRow, GitRefInput } from '../ui'
import { Text } from '../ui/Text'
import {
  checkpointDeleteConfirm,
  checkpointRestoreConfirm,
  checkpointSubtitle,
  defaultCheckpointLabel
} from './checkpoints'
import { ConfirmModal } from '../ConfirmModal'
import {
  IconEye,
  IconHistory,
  IconLoaderCircle,
  IconRefresh,
  IconTrash,
  IconUndo
} from '../icons'
import { Icon } from '../ui/Icon'
import { Tooltip } from '../ui/Tooltip'
import { Button, Notice } from '../ui'

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
            <Button variant="legacy-ghost" data-testid="checkpoints-refresh" disabled={busy} onClick={onRefresh}>
              <Icon glyph={IconRefresh} role="small" />
              Refresh
            </Button>
            <Button variant="legacy-ghost" onClick={onClose}>
              Close
            </Button>
          </>
        }
      >
        {error && (
          <Notice tone="danger" variant="callout" data-testid="checkpoints-error">{error}</Notice>
        )}

        <GitCheckpointCreateRow>
          <GitRefInput
            data-testid="checkpoint-new-label"
            aria-label="Checkpoint label"
            className="flex-1 min-w-0"
            placeholder="Checkpoint label (optional)"
            value={label}
            spellCheck={false}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') submit()
            }}
          />
          <Button variant="legacy-primary" data-testid="checkpoint-create" disabled={busy} onClick={submit}>
            Capture
          </Button>
        </GitCheckpointCreateRow>
        <Text as="p" size="small" tone="muted" flush>
          A checkpoint is a hidden git ref holding the whole working copy — tracked edits, staged
          work and untracked files. Capturing one never touches the working tree; restoring
          replaces it. Inspect diffs tracked changes only; untracked captures restore but do not
          appear there.
        </Text>

        <GitCheckpointList>
          {checkpoints.length === 0 ? (
            <GitCheckpointEmptyText>
              No checkpoints yet.
            </GitCheckpointEmptyText>
          ) : (
            checkpoints.map((c) => (
              <GitCheckpointRow
                key={c.ref}
                data-testid="checkpoint-row"
                data-ref={c.ref}
              >
                <GitCheckpointIconRow>
                  <GitCheckpointIconSlot>
                    <Icon glyph={IconHistory} role="label" />
                  </GitCheckpointIconSlot>
                  <GitCheckpointLabelColumn>
                    <GitCheckpointLabel>
                      {c.label}
                    </GitCheckpointLabel>
                    <Text
                      size="xs" tone="faint"
                      data-testid="checkpoint-subtitle"
                    >
                      {checkpointSubtitle(c, now)}
                    </Text>
                  </GitCheckpointLabelColumn>
                  <Tooltip label="Inspect changes" className="inline-flex">
                    <Button
                      type="button"
                      variant="legacy-ghost-icon"
                      data-testid="checkpoint-inspect"
                      aria-label={`Inspect ${c.label}`}
                      disabled={busy}
                      onClick={() => onInspect(c.ref)}
                    >
                      <Icon glyph={IconEye} role="label" />
                    </Button>
                  </Tooltip>
                  <Tooltip label="Restore this snapshot" className="inline-flex">
                    <Button
                      type="button"
                      variant="legacy-ghost-icon"
                      data-testid="checkpoint-restore"
                      aria-label={`Restore ${c.label}`}
                      disabled={busy}
                      onClick={() => setRestoring(c)}
                    >
                      <Icon glyph={IconUndo} role="label" />
                    </Button>
                  </Tooltip>
                  <Tooltip label="Delete" className="inline-flex">
                    <Button
                      type="button"
                      variant="legacy-ghost-icon-danger"
                      data-testid="checkpoint-delete"
                      aria-label={`Delete ${c.label}`}
                      disabled={busy}
                      onClick={() => setDeleting(c)}
                    >
                      <Icon glyph={IconTrash} role="label" />
                    </Button>
                  </Tooltip>
                </GitCheckpointIconRow>
                {inspect && inspect.ref === c.ref && (
                  <GitCheckpointDiffPanel
                    data-testid="checkpoint-diff"
                  >
                    {inspect.loading ? (
                      <DiffEmptyState>
                        <DiffLoadingMark>
                          <Icon glyph={IconLoaderCircle} role="subhead" />
                        </DiffLoadingMark>
                        Loading the checkpoint diff…
                      </DiffEmptyState>
                    ) : inspect.patch.trim().length === 0 ? (
                      <DiffEmptyState data-testid="checkpoint-diff-empty">
                        The working tree matches this checkpoint.
                      </DiffEmptyState>
                    ) : (
                      <>
                        {inspect.redacted && (
                          <GitCheckpointRedactionNotice>
                            Secret-shaped values were redacted; sensitive files are withheld.
                          </GitCheckpointRedactionNotice>
                        )}
                        <DiffBody patch={inspect.patch} truncated={inspect.truncated} />
                      </>
                    )}
                  </GitCheckpointDiffPanel>
                )}
              </GitCheckpointRow>
            ))
          )}
        </GitCheckpointList>
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
