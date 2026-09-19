import { useState } from 'react'
import { SPIN_CLASS } from './DiffBody'
import { BTN_SECONDARY } from '../buttonChrome'
import { IconEllipsis, IconGitBranch, IconGitFork, IconHistory, IconRefresh, IconArrowDown } from '../icons'
import { Icon } from '../Icon'
import { Tooltip } from '../Tooltip'

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

const ITEM =
  'flex items-center gap-2 w-full text-left px-2.5 py-1.5 text-[length:var(--tr-text-sm)] ' +
  'bg-transparent border-0 text-[var(--text-secondary)] enabled:hover:bg-[var(--card-hover)] ' +
  'disabled:opacity-45 disabled:cursor-not-allowed whitespace-nowrap'

const MENU =
  'absolute right-0 top-[calc(100%+4px)] z-[var(--z-sticky)] min-w-[190px] flex flex-col rounded-[var(--tr-radius-sm)] ' +
  'border border-[var(--border)] bg-[var(--card-bg)] py-1 shadow-[var(--shadow-1)]'

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
        <button
          type="button"
          className={`btn ${BTN_SECONDARY}`}
          data-testid="git-tools-menu"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="Git tools"
          disabled={disabled}
          onClick={() => setOpen((v) => !v)}
        >
          {busy ? (
            <span className={SPIN_CLASS}>
              <Icon glyph={IconRefresh} role="small" />
            </span>
          ) : (
            <Icon glyph={IconEllipsis} role="small" />
          )}
        </button>
      </Tooltip>
      {open && (
        <div role="menu" data-testid="git-tools-items" className={MENU}>
          <Tooltip label={pullDisabledReason ?? undefined} className="w-full">
            <button
              type="button"
              role="menuitem"
              className={ITEM}
              data-testid="git-tools-pull"
              disabled={disabled || busy || pullDisabledReason !== null}
              onClick={() => run(onPull)}
            >
              <Icon glyph={IconArrowDown} role="small" />
              {behind > 0 ? `Pull ${behind} commit${behind === 1 ? '' : 's'}` : 'Pull'}
            </button>
          </Tooltip>
          <Tooltip label={fetchDisabledReason ?? undefined} className="w-full">
            <button
              type="button"
              role="menuitem"
              className={ITEM}
              data-testid="git-tools-fetch"
              disabled={disabled || busy || fetchDisabledReason !== null}
              onClick={() => run(onFetch)}
            >
              <Icon glyph={IconRefresh} role="small" />
              Fetch
            </button>
          </Tooltip>
          <div className="my-1 h-px bg-[var(--divider)]" role="separator" />
          <button
            type="button"
            role="menuitem"
            className={ITEM}
            data-testid="git-tools-branches"
            disabled={disabled}
            onClick={() => run(onBranches)}
          >
            <Icon glyph={IconGitBranch} role="small" />
            Branches…
          </button>
          <button
            type="button"
            role="menuitem"
            className={ITEM}
            data-testid="git-tools-worktrees"
            disabled={disabled}
            onClick={() => run(onWorktrees)}
          >
            <Icon glyph={IconGitFork} role="small" />
            Worktrees…
          </button>
          <button
            type="button"
            role="menuitem"
            className={ITEM}
            data-testid="git-tools-checkpoints"
            disabled={disabled}
            onClick={() => run(onCheckpoints)}
          >
            <Icon glyph={IconHistory} role="small" />
            Checkpoints…
          </button>
        </div>
      )}
    </div>
  )
}
