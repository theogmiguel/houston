import { useMemo, useRef, useState } from 'react'
import type { GitBranchInfo } from '../../houston/generated/GitBranchInfo'
import { GitDialogShell } from './GitDialogShell'
import {
  deleteBranchDisabledReason,
  filterBranches,
  nameShapeLooksValid,
  renameTargetLooksValid,
  sortBranches,
  switchBranchDisabledReason
} from './branches'
import { ConfirmModal } from '../ConfirmModal'
import { Select } from '../Select'
import { Toggle } from '../settingsPrimitives'
import { BTN_GHOST, BTN_PRIMARY } from '../buttonChrome'
import { FIELD_INPUT, FIELD_LABEL } from '../nav/navChrome'
import { IconAlertTriangle, IconGitBranch, IconPencil, IconRefresh, IconTrash } from '../icons'
import { Icon } from '../Icon'
import { Tooltip } from '../Tooltip'

export interface BranchesDialogProps {
  branches: GitBranchInfo[]
  remotes: GitBranchInfo[]
  defaultBranch: string | null
  truncated: boolean
  busy: boolean
  error: string | null
  onClose: () => void
  onRefresh: () => void
  onCreate: (name: string, base: string | null, switchTo: boolean) => void
  onSwitch: (name: string) => void
  onRename: (from: string, to: string) => void
  onDelete: (name: string, force: boolean) => void
}

const ROW =
  'group/row flex items-center gap-2 h-7 px-2 rounded-[var(--tr-radius-sm)] text-[length:var(--tr-text-sm)]'

const BADGE =
  'flex-none px-1.5 rounded-[var(--tr-radius-pill)] font-mono text-[length:var(--tr-text-xs)] font-semibold leading-4'

const MENU_ITEM =
  'text-left px-2.5 py-1 text-[length:var(--tr-text-sm)] bg-transparent border-0 '

function BranchBadges({ branch }: { branch: GitBranchInfo }): React.JSX.Element {
  return (
    <>
      {branch.current && (
        <span
          data-testid="branch-current-badge"
          className={`${BADGE} bg-[color-mix(in_srgb,var(--success)_16%,transparent)] text-[var(--success)]`}
        >
          current
        </span>
      )}
      {branch.is_default && !branch.current && (
        <span
          className={`${BADGE} bg-[color-mix(in_srgb,var(--text-muted)_18%,transparent)] text-[var(--text-muted)]`}
        >
          default
        </span>
      )}
      {branch.worktree_path && (
        <span
          className={`${BADGE} bg-[color-mix(in_srgb,var(--info)_16%,transparent)] text-[var(--info)]`}
        >
          worktree
        </span>
      )}
    </>
  )
}

function DeleteBranchControl({
  branch,
  disabled,
  reason,
  open,
  onToggle,
  onChoose
}: {
  branch: GitBranchInfo
  disabled: boolean
  reason: string | null
  open: boolean
  onToggle: () => void
  onChoose: (force: boolean) => void
}): React.JSX.Element {
  return (
    <div className="relative flex-none">
      <Tooltip label={reason ?? 'Delete'} className="inline-flex">
        <button
          type="button"
          data-testid="branch-delete"
          aria-label={`Delete ${branch.name}`}
          aria-expanded={open}
          disabled={disabled}
          onClick={onToggle}
          className={`btn ${BTN_GHOST} p-1 rounded-[var(--tr-radius-sm)] enabled:hover:text-[var(--danger)]`}
        >
          <Icon glyph={IconTrash} role="label" />
        </button>
      </Tooltip>
      {open && (
        <div
          role="menu"
          data-testid="branch-delete-menu"
          className="absolute right-0 top-7 z-[var(--z-sticky)] min-w-[170px] flex flex-col rounded-[var(--tr-radius-sm)] border border-[var(--border)] bg-[var(--card-bg)] py-1 shadow-[var(--shadow-1)]"
        >
          <button
            type="button"
            role="menuitem"
            data-testid="branch-delete-safe"
            className={`${MENU_ITEM} text-[var(--text-secondary)] enabled:hover:bg-[var(--card-hover)]`}
            onClick={() => onChoose(false)}
          >
            Delete
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid="branch-delete-force"
            className={`${MENU_ITEM} text-[var(--danger)] enabled:hover:bg-[color-mix(in_srgb,var(--danger)_14%,transparent)]`}
            onClick={() => onChoose(true)}
          >
            Force delete
          </button>
        </div>
      )}
    </div>
  )
}

interface BranchRowProps {
  branch: GitBranchInfo
  note: string | null
  remote: boolean
  busy: boolean
  localCount: number
  /** The in-progress rename value when this row is the one being renamed. */
  renamingValue: string | null
  deleteMenuOpen: boolean
  onStartRename: () => void
  onRenameChange: (value: string) => void
  onRenameSubmit: () => void
  onRenameCancel: () => void
  onSwitch: () => void
  onToggleDeleteMenu: () => void
  onChooseDelete: (force: boolean) => void
}

function BranchRow({
  branch,
  note,
  remote,
  busy,
  localCount,
  renamingValue,
  deleteMenuOpen,
  onStartRename,
  onRenameChange,
  onRenameSubmit,
  onRenameCancel,
  onSwitch,
  onToggleDeleteMenu,
  onChooseDelete
}: BranchRowProps): React.JSX.Element {
  const switchReason = switchBranchDisabledReason(branch)
  const deleteReason = deleteBranchDisabledReason(branch, localCount)
  const renaming = renamingValue !== null

  return (
    <div
      data-testid="branch-row"
      data-branch={branch.name}
      data-current={branch.current ? 'true' : undefined}
      className={`${ROW} ${
        branch.current
          ? 'bg-[color-mix(in_srgb,var(--text-primary)_8%,transparent)] text-[var(--text-primary)]'
          : 'text-[var(--text-secondary)] hover:bg-[var(--card-hover)]'
      }`}
    >
      <span className="flex-none text-[var(--text-faint)]" aria-hidden>
        <Icon glyph={IconGitBranch} role="label" />
      </span>
      {renaming ? (
        <form
          className="flex flex-1 min-w-0 items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            onRenameSubmit()
          }}
        >
          <input
            autoFocus
            data-testid="branch-rename-input"
            aria-label={`Rename ${branch.name}`}
            className={`${FIELD_INPUT} flex-1 min-w-0`}
            value={renamingValue}
            spellCheck={false}
            onChange={(e) => onRenameChange(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Escape') onRenameCancel()
            }}
          />
          <button
            type="submit"
            data-testid="branch-rename-save"
            className={`btn ${BTN_PRIMARY}`}
            disabled={busy || !renameTargetLooksValid(branch.name, renamingValue.trim())}
          >
            Rename
          </button>
          <button type="button" className={`btn ${BTN_GHOST}`} onClick={onRenameCancel}>
            Cancel
          </button>
        </form>
      ) : (
        <>
          <Tooltip
            label={
              switchReason ??
              (remote ? 'Remote branches cannot be switched to directly' : 'Switch')
            }
            className="inline-flex flex-1 min-w-0"
          >
            <button
              type="button"
              data-testid="branch-select"
              aria-label={`Switch to ${branch.name}`}
              disabled={busy || switchReason !== null || remote}
              onClick={onSwitch}
              className="flex flex-1 min-w-0 items-center gap-2 bg-transparent border-0 p-0 text-left text-inherit disabled:opacity-55 disabled:cursor-not-allowed"
            >
              <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[length:var(--tr-text-xs)]">
                {branch.name}
              </span>
              <BranchBadges branch={branch} />
            </button>
          </Tooltip>
          {note && (
            <Tooltip label={note} className="inline-flex max-w-[40%]">
              <span
                data-testid="branch-note"
                className="flex-none overflow-hidden text-ellipsis whitespace-nowrap text-[length:var(--tr-text-xs)] text-[var(--text-faint)]"
              >
                {note}
              </span>
            </Tooltip>
          )}
          {!remote && (
            <>
              <Tooltip label="Rename" className="inline-flex">
                <button
                  type="button"
                  data-testid="branch-rename"
                  aria-label={`Rename ${branch.name}`}
                  disabled={busy}
                  onClick={onStartRename}
                  className={`btn ${BTN_GHOST} p-1 rounded-[var(--tr-radius-sm)]`}
                >
                  <Icon glyph={IconPencil} role="label" />
                </button>
              </Tooltip>
              <DeleteBranchControl
                branch={branch}
                disabled={busy || deleteReason !== null}
                reason={deleteReason}
                open={deleteMenuOpen}
                onToggle={onToggleDeleteMenu}
                onChoose={onChooseDelete}
              />
            </>
          )}
        </>
      )}
    </div>
  )
}

export function BranchesDialog({
  branches,
  remotes,
  defaultBranch,
  truncated,
  busy,
  error,
  onClose,
  onRefresh,
  onCreate,
  onSwitch,
  onRename,
  onDelete
}: BranchesDialogProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [newName, setNewName] = useState('')
  const [base, setBase] = useState('')
  const [switchToNew, setSwitchToNew] = useState(true)
  const [renaming, setRenaming] = useState<{ from: string; value: string } | null>(null)
  const [deleteMenuFor, setDeleteMenuFor] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<{ branch: GitBranchInfo; force: boolean } | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  const all = useMemo(() => sortBranches([...branches, ...remotes]), [branches, remotes])
  const rows = useMemo(() => filterBranches(all, query), [all, query])
  const localCount = branches.length

  const baseOptions = useMemo(
    () => [
      {
        value: '',
        label: defaultBranch ? `Default (${defaultBranch})` : 'Default base'
      },
      ...sortBranches(branches).map((b) => ({ value: b.name, label: b.name }))
    ],
    [branches, defaultBranch]
  )

  const createDisabled = !nameShapeLooksValid(newName) || busy

  return (
    <>
      <GitDialogShell
        heading="Branches"
        testid="git-branches-dialog"
        onClose={onClose}
        footer={
          <>
            <button
              className={`btn ${BTN_GHOST}`}
              data-testid="branches-refresh"
              disabled={busy}
              onClick={onRefresh}
            >
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
            data-testid="branches-error"
            className="flex items-start gap-1.5 py-2 px-3 rounded-[var(--tr-radius-sm)] border border-[color-mix(in_srgb,var(--danger)_42%,transparent)] bg-[color-mix(in_srgb,var(--danger)_11%,transparent)] text-[length:var(--tr-text-small-size)] text-[var(--text-primary)]"
          >
            <span className="flex-none text-[var(--danger)] pt-0.5">
              <Icon glyph={IconAlertTriangle} role="small" />
            </span>
            <span>{error}</span>
          </div>
        )}

        <div className="flex flex-col gap-2 p-2.5 rounded-[var(--tr-radius-sm)] border border-[var(--border)] bg-[var(--content-bg)]">
          <div className={FIELD_LABEL}>New branch</div>
          <div className="flex items-center gap-2">
            <input
              ref={nameRef}
              data-testid="branch-new-name"
              aria-label="New branch name"
              className={`${FIELD_INPUT} flex-1 min-w-0`}
              placeholder="feat/thing"
              value={newName}
              spellCheck={false}
              onChange={(e) => setNewName(e.target.value)}
            />
            <div className="w-[150px] flex-none">
              <Select
                value={base}
                options={baseOptions}
                onChange={setBase}
                aria-label="Base ref"
                data-testid="branch-new-base"
                disabled={busy}
              />
            </div>
            <button
              className={`btn ${BTN_PRIMARY}`}
              data-testid="branch-new-create"
              disabled={createDisabled}
              onClick={() => {
                if (createDisabled) return
                onCreate(newName.trim(), base.trim() === '' ? null : base.trim(), switchToNew)
                setNewName('')
              }}
            >
              Create
            </button>
          </div>
          <div className="flex items-center gap-1.5 text-[length:var(--tr-text-small-size)] text-[var(--text-secondary)]">
            <Toggle on={switchToNew} onChange={setSwitchToNew} data-testid="branch-new-switch" />
            <span>Switch to it after creating</span>
          </div>
          <p className="m-0 text-[length:var(--tr-text-small-size)] text-[var(--text-muted)]">
            Switching checks the branch out in this workspace. Git refuses when uncommitted changes
            would be overwritten; commit or stash them first.
          </p>
        </div>

        <input
          data-testid="branches-filter"
          aria-label="Filter branches"
          className={FIELD_INPUT}
          placeholder="Filter branches…"
          value={query}
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
        />

        <div role="list" data-testid="branches-list" className="flex flex-col">
          {rows.length === 0 ? (
            <p className="m-0 px-2 py-3 text-[length:var(--tr-text-small-size)] text-[var(--text-muted)]">
              No branch matches “{query}”.
            </p>
          ) : (
            rows.map(({ branch, note, remote }) => (
              <BranchRow
                key={`${remote ? 'r' : 'l'}:${branch.name}`}
                branch={branch}
                note={note}
                remote={remote}
                busy={busy}
                localCount={localCount}
                renamingValue={
                  renaming !== null && renaming.from === branch.name ? renaming.value : null
                }
                deleteMenuOpen={deleteMenuFor === branch.name}
                onStartRename={() => setRenaming({ from: branch.name, value: branch.name })}
                onRenameChange={(value) => setRenaming({ from: branch.name, value })}
                onRenameSubmit={() => {
                  if (renaming === null) return
                  const to = renaming.value.trim()
                  if (!renameTargetLooksValid(branch.name, to)) return
                  onRename(branch.name, to)
                  setRenaming(null)
                }}
                onRenameCancel={() => setRenaming(null)}
                onSwitch={() => onSwitch(branch.name)}
                onToggleDeleteMenu={() =>
                  setDeleteMenuFor((cur) => (cur === branch.name ? null : branch.name))
                }
                onChooseDelete={(force) => {
                  setDeleteMenuFor(null)
                  setDeleting({ branch, force })
                }}
              />
            ))
          )}
        </div>

        {truncated && (
          <p className="m-0 text-[length:var(--tr-text-small-size)] text-[var(--text-muted)]">
            The listing hit the daemon&rsquo;s 200-ref cap; filter to find the rest.
          </p>
        )}
        {remotes.length > 0 && (
          <p className="m-0 text-[length:var(--tr-text-small-size)] text-[var(--text-muted)]">
            Remote-tracking branches are shown for reference. Switching to one with no local twin
            would need a local branch first.
          </p>
        )}
      </GitDialogShell>
      {deleting && (
        <ConfirmModal
          title={deleting.force ? 'FORCE DELETE BRANCH' : 'DELETE BRANCH'}
          message={
            deleting.force
              ? `Force-delete the branch ${deleting.branch.name}? Commits that are not merged anywhere are reachable only through the reflog until git prunes them.`
              : `Delete the branch ${deleting.branch.name}? Git refuses this when the branch is not fully merged; the refusal will name it.`
          }
          confirmLabel={deleting.force ? 'Force delete' : 'Delete'}
          onConfirm={() => {
            onDelete(deleting.branch.name, deleting.force)
            setDeleting(null)
          }}
          onCancel={() => setDeleting(null)}
        />
      )}
    </>
  )
}
