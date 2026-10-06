import { LazyLegacyButton } from '../ui/LazyLegacyButtonRoles'
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
import { Toggle } from '../ui/settingsPrimitives'
import { IconGitBranch, IconPencil, IconRefresh, IconTrash } from '../icons'
import { Icon } from '../ui/Icon'
import { Tooltip } from '../ui/Tooltip'
import { Button, Notice } from '../ui'
import { GitBaseSelect, GitBranchBadge, GitBranchCreateRow, GitBranchCreateSurface, GitBranchDeleteMenu, GitBranchEmptyText, GitBranchHelpText, GitBranchList, GitBranchNameText, GitBranchNote, GitBranchRow, GitBranchSelect, GitRefFieldLabel, GitRefInput } from '../ui'
import { Text } from '../ui/Text'

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

function BranchBadges({ branch }: { branch: GitBranchInfo }): React.JSX.Element {
  return (
    <>
      {branch.current && (
        <GitBranchBadge role="current" data-testid="branch-current-badge">
          current
        </GitBranchBadge>
      )}
      {branch.is_default && !branch.current && (
        <GitBranchBadge role="default">
          default
        </GitBranchBadge>
      )}
      {branch.worktree_path && (
        <GitBranchBadge role="worktree">
          worktree
        </GitBranchBadge>
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
        <LazyLegacyButton
          type="button"
          variant="legacy-ghost-icon-danger"
          data-testid="branch-delete"
          aria-label={`Delete ${branch.name}`}
          aria-expanded={open}
          disabled={disabled}
          onClick={onToggle}
        >
          <Icon glyph={IconTrash} role="label" />
        </LazyLegacyButton>
      </Tooltip>
      {open && (
        <GitBranchDeleteMenu onDelete={() => onChoose(false)} onForceDelete={() => onChoose(true)} />
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
    <GitBranchRow
      current={branch.current}
      data-testid="branch-row"
      data-branch={branch.name}
      data-current={branch.current ? 'true' : undefined}
    >
      <Text as="span" tone="faint" className="flex-none" aria-hidden>
        <Icon glyph={IconGitBranch} role="label" />
      </Text>
      {renaming ? (
        <form
          className="flex flex-1 min-w-0 items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            onRenameSubmit()
          }}
        >
          <GitRefInput
            autoFocus
            data-testid="branch-rename-input"
            aria-label={`Rename ${branch.name}`}
            className="flex-1 min-w-0"
            value={renamingValue}
            spellCheck={false}
            onChange={(e) => onRenameChange(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Escape') onRenameCancel()
            }}
          />
          <Button
            type="submit"
            data-testid="branch-rename-save"
            variant="legacy-primary"
            disabled={busy || !renameTargetLooksValid(branch.name, renamingValue.trim())}
          >
            Rename
          </Button>
          <Button variant="legacy-ghost" onClick={onRenameCancel}>
            Cancel
          </Button>
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
            <GitBranchSelect
              data-testid="branch-select"
              aria-label={`Switch to ${branch.name}`}
              disabled={busy || switchReason !== null || remote}
              onClick={onSwitch}
            >
              <GitBranchNameText>
                {branch.name}
              </GitBranchNameText>
              <BranchBadges branch={branch} />
            </GitBranchSelect>
          </Tooltip>
          {note && (
            <span data-testid="branch-note"><GitBranchNote label={note} /></span>
          )}
          {!remote && (
            <>
              <Tooltip label="Rename" className="inline-flex">
                <LazyLegacyButton
                  type="button"
                  variant="legacy-ghost-icon"
                  data-testid="branch-rename"
                  aria-label={`Rename ${branch.name}`}
                  disabled={busy}
                  onClick={onStartRename}
                >
                  <Icon glyph={IconPencil} role="label" />
                </LazyLegacyButton>
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
    </GitBranchRow>
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
            <Button
              variant="legacy-ghost"
              data-testid="branches-refresh"
              disabled={busy}
              onClick={onRefresh}
            >
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
          <Notice tone="danger" variant="callout" data-testid="branches-error">{error}</Notice>
        )}

        <GitBranchCreateSurface>
          <GitRefFieldLabel>New branch</GitRefFieldLabel>
          <GitBranchCreateRow>
            <GitRefInput
              ref={nameRef}
              data-testid="branch-new-name"
              aria-label="New branch name"
              className="flex-1 min-w-0"
              placeholder="feat/thing"
              value={newName}
              spellCheck={false}
              onChange={(e) => setNewName(e.target.value)}
            />
            <GitBaseSelect value={base} options={baseOptions} onChange={setBase} label="Base ref" disabled={busy} />
            <Button
              variant="legacy-primary"
              data-testid="branch-new-create"
              disabled={createDisabled}
              onClick={() => {
                if (createDisabled) return
                onCreate(newName.trim(), base.trim() === '' ? null : base.trim(), switchToNew)
                setNewName('')
              }}
            >
              Create
            </Button>
          </GitBranchCreateRow>
          <div className="flex items-center gap-1.5">
            <Toggle on={switchToNew} onChange={setSwitchToNew} data-testid="branch-new-switch" />
            <Text size="small" tone="secondary">Switch to it after creating</Text>
          </div>
          <GitBranchHelpText>
            Switching checks the branch out in this workspace. Git refuses when uncommitted changes
            would be overwritten; commit or stash them first.
          </GitBranchHelpText>
        </GitBranchCreateSurface>

        <GitRefInput
          data-testid="branches-filter"
          aria-label="Filter branches"
          placeholder="Filter branches…"
          value={query}
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
        />

        <GitBranchList>
          {rows.length === 0 ? (
            <GitBranchEmptyText>
              No branch matches “{query}”.
            </GitBranchEmptyText>
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
        </GitBranchList>

        {truncated && (
          <GitBranchHelpText>
            The listing hit the daemon&rsquo;s 200-ref cap; filter to find the rest.
          </GitBranchHelpText>
        )}
        {remotes.length > 0 && (
          <GitBranchHelpText>
            Remote-tracking branches are shown for reference. Switching to one with no local twin
            would need a local branch first.
          </GitBranchHelpText>
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
