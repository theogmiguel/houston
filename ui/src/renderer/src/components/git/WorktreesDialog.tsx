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
import { Select } from '../Select'
import { BTN_GHOST, BTN_PRIMARY } from '../buttonChrome'
import { FIELD_INPUT, FIELD_LABEL } from '../nav/navChrome'
import { IconAlertTriangle, IconFolderOpen, IconGitFork, IconRefresh, IconTrash } from '../icons'
import { Icon } from '../Icon'
import { Tooltip } from '../Tooltip'

export interface WorktreesDialogProps {
  dir: string | null
  worktrees: GitWorktreeInfo[]
  branches: GitBranchInfo[]
  defaultBranch: string | null
  busy: boolean
  error: string | null
  onClose: () => void
  onRefresh: () => void
  onCreate: (name: string, base: string | null) => void
  onRemove: (path: string, force: boolean) => void
  onPrune: () => void
  onAddWorkspace: (path: string) => void
}

export function WorktreesDialog({
  dir,
  worktrees,
  branches,
  defaultBranch,
  busy,
  error,
  onClose,
  onRefresh,
  onCreate,
  onRemove,
  onPrune,
  onAddWorkspace
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
            <button className={`btn ${BTN_GHOST}`} data-testid="worktrees-prune" disabled={busy} onClick={onPrune}>
              Prune stale
            </button>
            <button className={`btn ${BTN_GHOST}`} data-testid="worktrees-refresh" disabled={busy} onClick={onRefresh}>
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
            data-testid="worktrees-error"
            className="flex items-start gap-1.5 py-2 px-3 rounded-[var(--tr-radius-sm)] border border-[color-mix(in_srgb,var(--danger)_42%,transparent)] bg-[color-mix(in_srgb,var(--danger)_11%,transparent)] text-[length:var(--tr-text-small-size)] text-[var(--text-primary)]"
          >
            <span className="flex-none text-[var(--danger)] pt-0.5">
              <Icon glyph={IconAlertTriangle} role="small" />
            </span>
            <span>{error}</span>
          </div>
        )}

        <div className="flex flex-col gap-2 p-2.5 rounded-[var(--tr-radius-sm)] border border-[var(--border)] bg-[var(--content-bg)]">
          <div className={FIELD_LABEL}>New worktree</div>
          <div className="flex items-center gap-2">
            <input
              data-testid="worktree-new-name"
              aria-label="Worktree name"
              className={`${FIELD_INPUT} flex-1 min-w-0`}
              placeholder="fix-login"
              value={name}
              spellCheck={false}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter') submit()
              }}
            />
            <div className="w-[150px] flex-none">
              <Select
                value={base}
                options={baseOptions}
                onChange={setBase}
                aria-label="Base ref"
                data-testid="worktree-new-base"
                disabled={busy}
              />
            </div>
            <button className={`btn ${BTN_PRIMARY}`} data-testid="worktree-new-create" disabled={!canCreate} onClick={submit}>
              Create
            </button>
          </div>
          <p className="m-0 text-[length:var(--tr-text-small-size)] text-[var(--text-muted)]">
            Created under Houston&rsquo;s state directory on a new <code>houston/&lt;name&gt;</code>{' '}
            branch. Add it as a workspace to spawn agents there.
          </p>
        </div>

        <div role="list" data-testid="worktrees-list" className="flex flex-col gap-1">
          {worktrees.length === 0 ? (
            <p className="m-0 px-2 py-3 text-[length:var(--tr-text-small-size)] text-[var(--text-muted)]">
              {dir ? 'No worktrees reported.' : 'No workspace selected.'}
            </p>
          ) : (
            worktrees.map((w) => {
              const reason = worktreeActionDisabledReason(w)
              return (
                <div
                  key={w.path}
                  data-testid="worktree-row"
                  data-path={w.path}
                  className="group/row relative flex items-center gap-2 px-2 py-1.5 rounded-[var(--tr-radius-sm)] text-[var(--text-secondary)] hover:bg-[var(--card-hover)]"
                >
                  <span className="flex-none text-[var(--text-faint)]" aria-hidden>
                    <Icon glyph={IconGitFork} role="label" />
                  </span>
                  <div className="flex-1 min-w-0 flex flex-col">
                    <span className="inline-flex items-center gap-1.5 min-w-0 font-mono text-[length:var(--tr-text-xs)] text-[var(--text-primary)]">
                      <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{worktreeTitle(w)}</span>
                      {w.dirty && (
                        <span
                          data-testid="worktree-dirty"
                          className="flex-none px-1.5 rounded-[var(--tr-radius-pill)] text-[length:var(--tr-text-xs)] font-semibold bg-[color-mix(in_srgb,var(--warning)_18%,transparent)] text-[var(--warning)]"
                        >
                          dirty
                        </span>
                      )}
                    </span>
                    <Tooltip label={w.path} className="inline-flex min-w-0">
                      <span
                        data-testid="worktree-subtitle"
                        className="text-[length:var(--tr-text-xs)] text-[var(--text-faint)] overflow-hidden text-ellipsis whitespace-nowrap"
                      >
                        {worktreeSubtitle(w)}
                      </span>
                    </Tooltip>
                  </div>
                  <Tooltip label="Add as a Houston workspace" className="inline-flex">
                    <button
                      type="button"
                      data-testid="worktree-add-workspace"
                      aria-label={`Add ${w.path} as a workspace`}
                      disabled={busy || w.is_bare}
                      onClick={() => onAddWorkspace(w.path)}
                      className={`btn ${BTN_GHOST} p-1 rounded-[var(--tr-radius-sm)]`}
                    >
                      <Icon glyph={IconFolderOpen} role="label" />
                    </button>
                  </Tooltip>
                  <Tooltip label={reason ?? 'Remove worktree'} className="inline-flex">
                    <button
                      type="button"
                      data-testid="worktree-remove"
                      aria-label={`Remove ${w.path}`}
                      disabled={busy || reason !== null}
                      onClick={() => {
                        setForce(w.dirty)
                        setRemoving(w)
                      }}
                      className={`btn ${BTN_GHOST} p-1 rounded-[var(--tr-radius-sm)] enabled:hover:text-[var(--danger)]`}
                    >
                      <Icon glyph={IconTrash} role="label" />
                    </button>
                  </Tooltip>
                </div>
              )
            })
          )}
        </div>
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
