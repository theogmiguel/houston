import { DiffLoadingMark, GitToolMenuItem, GitToolMenuSeparator, GitToolMenuSurface } from '../ui'
import { useState } from 'react'
import { Button } from '../ui/Button'
import { IconEllipsis, IconGitBranch, IconGitFork, IconHistory, IconRefresh, IconArrowDown } from '../icons'
import { Icon } from '../ui/Icon'
import { Tooltip } from '../ui/Tooltip'

export interface GitToolsMenuProps {
  disabled: boolean
  behind: number
  busy: boolean
  pullDisabledReason: string | null
  fetchDisabledReason: string | null
  onPull: () => void
  onFetch: () => void
  onBranches: () => void
  onWorktrees: () => void
  onCheckpoints: () => void
}

export function GitToolsMenu({
  disabled,
  behind,
  busy,
  pullDisabledReason,
  fetchDisabledReason,
  onPull,
  onFetch,
  onBranches,
  onWorktrees,
  onCheckpoints
}: GitToolsMenuProps): React.JSX.Element {
  const [open, setOpen] = useState(false)

  const run = (fn: () => void): void => {
    setOpen(false)
    fn()
  }

  return (
    <div className="relative inline-flex" data-testid="git-tools">
      <Tooltip label="Git tools" className="inline-flex">
        <Button
          variant="legacy-secondary"
          data-testid="git-tools-menu"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="Git tools"
          disabled={disabled}
          onClick={() => setOpen((v) => !v)}
        >
          {busy ? (
            <DiffLoadingMark>
              <Icon glyph={IconRefresh} role="small" />
            </DiffLoadingMark>
          ) : (
            <Icon glyph={IconEllipsis} role="small" />
          )}
        </Button>
      </Tooltip>
      {open && (
        <GitToolMenuSurface>
          <Tooltip label={pullDisabledReason ?? undefined} className="w-full">
            <GitToolMenuItem
              data-testid="git-tools-pull"
              disabled={disabled || busy || pullDisabledReason !== null}
              onClick={() => run(onPull)}
            >
              <Icon glyph={IconArrowDown} role="small" />
              {behind > 0 ? `Pull ${behind} commit${behind === 1 ? '' : 's'}` : 'Pull'}
            </GitToolMenuItem>
          </Tooltip>
          <Tooltip label={fetchDisabledReason ?? undefined} className="w-full">
            <GitToolMenuItem
              data-testid="git-tools-fetch"
              disabled={disabled || busy || fetchDisabledReason !== null}
              onClick={() => run(onFetch)}
            >
              <Icon glyph={IconRefresh} role="small" />
              Fetch
            </GitToolMenuItem>
          </Tooltip>
          <GitToolMenuSeparator />
          <GitToolMenuItem
            data-testid="git-tools-branches"
            disabled={disabled}
            onClick={() => run(onBranches)}
          >
            <Icon glyph={IconGitBranch} role="small" />
            Branches…
          </GitToolMenuItem>
          <GitToolMenuItem
            data-testid="git-tools-worktrees"
            disabled={disabled}
            onClick={() => run(onWorktrees)}
          >
            <Icon glyph={IconGitFork} role="small" />
            Worktrees…
          </GitToolMenuItem>
          <GitToolMenuItem
            data-testid="git-tools-checkpoints"
            disabled={disabled}
            onClick={() => run(onCheckpoints)}
          >
            <Icon glyph={IconHistory} role="small" />
            Checkpoints…
          </GitToolMenuItem>
        </GitToolMenuSurface>
      )}
    </div>
  )
}
