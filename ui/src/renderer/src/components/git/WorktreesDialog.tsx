import { useMemo, useState } from 'react'
import type { GitBranchInfo } from '../../houston/generated/GitBranchInfo'
import type { GitWorktreeInfo } from '../../houston/generated/GitWorktreeInfo'
import { GitDialogShell } from './GitDialogShell'
import {
  nameShapeLooksValid,
  sortBranches
} from './branches'
import {
  worktreeActionDisabledReason,
  worktreeRemoveConfirm,
  worktreeSubtitle,
  worktreeTitle
} from './worktrees'
import { ConfirmModal } from '../ConfirmModal'
import { WorktreeCleanupSection } from './WorktreeCleanupSection'
import type { WorktreeCleanupView } from './worktreeCleanup'
import type { WorktreeCleanupRow } from './worktreeCleanupRows'
import { Select } from '../Select'
import { Button, Caption, Card, Chip, Notice, SectionHead, TextInput } from '../ui'
import { IconFolderOpen, IconRefresh, IconTrash } from '../icons'
import { Icon } from '../Icon'
import { Tooltip } from '../Tooltip'

export interface WorktreesDialogProps {
  dir: string | null
  worktrees: GitWorktreeInfo[]
  cleanup: WorktreeCleanupView
  branches: GitBranchInfo[]
  defaultBranch: string | null
  busy: boolean
  error: string | null
  onClose: () => void
  onRefresh: () => void
  onCreate: (name: string, base: string | null) => void
  onRemove: (path: string, force: boolean) => void
  onPrune: () => void
  onCheckCleanup: () => void
  onCleanNow: (paths: string[]) => void
  staleWorktreeRows?: WorktreeCleanupRow[]
  onRemoveStale?: (path: string) => void
  onAddWorkspace: (path: string) => void
  nowMs?: number
}

export function WorktreesDialog({
  dir,
  worktrees,
  cleanup,
  branches,
  defaultBranch,
  busy,
  error,
  onClose,
  onRefresh,
  onCreate,
  onRemove,
  onPrune,
  onCheckCleanup,
  onCleanNow,
  staleWorktreeRows = [],
  onRemoveStale = (path) => onRemove(path, false),
  onAddWorkspace,
  nowMs
}: WorktreesDialogProps): React.JSX.Element {
  const [name, setName] = useState('')
  const [base, setBase] = useState('')
  const [removing, setRemoving] = useState<GitWorktreeInfo | null>(null)
  const [force, setForce] = useState(false)

  const baseOptions = useMemo(
    () => [
      { value: '', label: defaultBranch ? `Default (${defaultBranch})` : 'Default base' },
      ...sortBranches(branches).map((b) => ({ value: b.name, label: b.name }))
    ],
    [branches, defaultBranch]
  )

  const canCreate = nameShapeLooksValid(name) && !busy
  const submit = (): void => {
    if (!canCreate) return
    onCreate(name.trim(), base.trim() === '' ? null : base.trim())
    setName('')
  }

  return (
    <>
      <GitDialogShell
        heading="Worktrees"
        testid="git-worktrees-dialog"
        onClose={onClose}
        footer={
          <>
            <Button variant="ghost" size="sm" data-testid="worktrees-prune" disabled={busy} onClick={onPrune}>
              Prune stale
            </Button>
            <Button variant="ghost" size="sm" data-testid="worktrees-refresh" disabled={busy} onClick={onRefresh}>
              <Icon glyph={IconRefresh} role="small" />
              Refresh
            </Button>
            <Button variant="ghost" size="sm" onClick={onClose}>
              Close
            </Button>
          </>
        }
      >
        {error && (
          <Notice tone="danger" data-testid="worktrees-error">{error}</Notice>
        )}

        <Card tone="inset" padding="md" className="grid gap-[var(--space-2)]">
          <SectionHead title="New worktree" />
          <div className="flex items-center gap-[var(--space-2)]">
            <TextInput
              data-testid="worktree-new-name"
              aria-label="Worktree name"
              className="min-w-0 flex-1"
              placeholder="fix-login"
              value={name}
              spellCheck={false}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter') submit()
              }}
            />
            <Select
                value={base}
                options={baseOptions}
                onChange={setBase}
                aria-label="Base ref"
                data-testid="worktree-new-base"
                disabled={busy}
              />
            <Button variant="primary" data-testid="worktree-new-create" disabled={!canCreate} onClick={submit}>
              Create
            </Button>
          </div>
          <Caption>
            Created under Houston&rsquo;s state directory on a new <code>houston/&lt;name&gt;</code>{' '}
            branch. Add it as a workspace to spawn agents there.
          </Caption>
        </Card>

        {dir && (
          <WorktreeCleanupSection
            view={cleanup}
            staleRows={staleWorktreeRows}
            busy={busy}
            nowMs={nowMs ?? Date.now()}
            onCheck={onCheckCleanup}
            onCleanNow={onCleanNow}
            onRemoveStale={onRemoveStale}
          />
        )}

        <Card tone="inset" data-testid="worktrees-list">
          {worktrees.length === 0 ? (
            <div className="p-[var(--space-3)]">
            <Caption>
              {dir ? 'No worktrees reported.' : 'No workspace selected.'}
            </Caption>
            </div>
          ) : (
            worktrees.map((w) => {
              const reason = worktreeActionDisabledReason(w)
              return (
                <div key={w.path} data-testid="worktree-row" data-path={w.path}>
                <Card.Row
                  heading={worktreeTitle(w)}
                  meta={<Tooltip label={w.path}><Caption tone="faint" variant="code">{worktreeSubtitle(w)}</Caption></Tooltip>}
                  status={w.dirty ? <Chip>Dirty</Chip> : undefined}
                  action={
                    <>
                      <Tooltip label="Add as a Houston workspace">
                        <Button
                          variant="ghost-icon"
                          data-testid="worktree-add-workspace"
                          aria-label={`Add ${w.path} as a workspace`}
                          disabled={busy || w.is_bare}
                          onClick={() => onAddWorkspace(w.path)}
                        ><Icon glyph={IconFolderOpen} role="label" /></Button>
                      </Tooltip>
                      <Tooltip label={reason ?? 'Remove worktree'}>
                        <Button
                          variant="ghost-icon-danger"
                          data-testid="worktree-remove"
                          aria-label={`Remove ${w.path}`}
                          disabled={busy || reason !== null}
                          onClick={() => {
                            setForce(w.dirty)
                            setRemoving(w)
                          }}
                        ><Icon glyph={IconTrash} role="label" /></Button>
                      </Tooltip>
                    </>
                  }
                  className="items-center"
                />
                </div>
              )
            })
          )}
        </Card>
      </GitDialogShell>
      {removing && (
        <ConfirmModal
          title={force ? 'FORCE REMOVE WORKTREE' : 'REMOVE WORKTREE'}
          message={worktreeRemoveConfirm(removing, force)}
          confirmLabel={force ? 'Force remove' : 'Remove'}
          onConfirm={() => {
            onRemove(removing.path, force)
            setRemoving(null)
          }}
          onCancel={() => setRemoving(null)}
        />
      )}
    </>
  )
}
