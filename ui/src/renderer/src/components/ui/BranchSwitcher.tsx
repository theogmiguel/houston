import type { ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, ReactNode, Ref } from 'react'
import { IconCheck, IconChevronDown, IconGitBranch, IconGitFork } from '../icons'
import { Icon } from './Icon'
import { ROW_STATE } from './rowState'
import { FOCUS_HALO_CLS } from './shadowChrome'
import { HintKey } from './ShortcutHint'
import { SearchField } from './Field'
import { ContextMenuItem } from './ContextMenu'
import { Tooltip } from './Tooltip'

export function ChangesBranchLine({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex flex-none items-center gap-[var(--space-2)] px-[var(--space-3)] pt-[var(--space-2-5)]">{children}</div>
}

export function ChangesBranchChip({ branch, worktree, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { ref?: Ref<HTMLButtonElement>; branch: string; worktree?: boolean }): React.JSX.Element {
  return <button {...props} type="button" className={`flex h-[var(--h-ctl)] min-w-0 items-center gap-[var(--space-1-5)] rounded-[var(--tr-radius-sm)] border border-[var(--border)] px-[var(--space-2)] text-[length:var(--tr-text-small-size)] text-[var(--text-primary)] ${props['aria-expanded'] ? ROW_STATE.selected : ROW_STATE.rest} focus-visible:outline-none ${FOCUS_HALO_CLS}`}>
    <Icon glyph={worktree ? IconGitFork : IconGitBranch} role="small" /><span className="truncate font-medium">{branch}</span><Icon glyph={IconChevronDown} role="small" />
  </button>
}

export function BranchSwitcherSurface({ children, ...props }: HTMLAttributes<HTMLDivElement> & { ref?: Ref<HTMLDivElement> }): React.JSX.Element {
  return <div {...props} className="fixed z-[var(--z-popover)] rounded-[var(--tr-radius-card)] border border-[var(--border)] bg-[var(--card-bg)] p-[var(--space-1)] shadow-[var(--shadow-1)]">{children}</div>
}

export function BranchSwitcherSearch({ inputRef, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, 'width' | 'size' | 'height'> & { inputRef: React.Ref<HTMLInputElement> }): React.JSX.Element {
  return <SearchField {...props} inputRef={inputRef} hint="Esc" />
}

export function BranchSwitcherGroup({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="px-[var(--space-2)] pt-[var(--space-2)] pb-[var(--space-1)] text-[length:var(--tr-text-label-size)] font-semibold text-[var(--text-faint)]">{children}</div>
}

export function BranchSwitcherRow({ active, current, kind = 'branch', note, shortcut, worktreeLabel, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { active: boolean; current?: boolean; kind?: 'branch' | 'create' | 'worktree'; note?: string | null; shortcut?: string; worktreeLabel?: string | null; children: ReactNode }): React.JSX.Element {
  return <ContextMenuItem {...props} variant="picker" active={active}>
    <span className="flex w-[14px] flex-none">{kind === 'create' ? <Icon glyph={IconGitBranch} role="small" /> : kind === 'worktree' ? <Icon glyph={IconGitFork} role="small" /> : current ? <Icon glyph={IconCheck} role="small" /> : null}</span>
    <span className="min-w-0 flex-1 truncate">{children}</span>
    {worktreeLabel && <Tooltip label={worktreeLabel}><span className="flex flex-none text-[var(--text-muted)]" aria-label={worktreeLabel}><Icon glyph={IconGitFork} role="small" /></span></Tooltip>}
    {note && <span className="flex-none max-w-[190px] truncate text-[var(--text-muted)]">{note}</span>}
    {shortcut && <HintKey size="compact">{shortcut}</HintKey>}
  </ContextMenuItem>
}

export function BranchSwitcherList(props: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div {...props} className="max-h-[300px] overflow-y-auto pb-[var(--space-1)]" />
}

export function BranchSwitcherFooter({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex items-center gap-[var(--space-2)] [&>span]:min-w-0 [&>button]:flex-none border-t border-[var(--divider)] px-[var(--space-2)] pt-[var(--space-1-5)] text-[length:var(--tr-text-label-size)] text-[var(--text-muted)]">{children}</div>
}

export function BranchSwitcherSpecimen(): React.JSX.Element {
  return <div className="w-[380px] rounded-[var(--tr-radius-card)] border border-[var(--border)] bg-[var(--card-bg)] p-[var(--space-1)]">
    <BranchSwitcherSearch inputRef={null} value="feat/agents-overview" readOnly aria-label="Find or create a branch" />
    <BranchSwitcherGroup>Create</BranchSwitcherGroup>
    <BranchSwitcherRow active kind="create" shortcut="Enter">Branch feat/agents-overview from main</BranchSwitcherRow>
    <BranchSwitcherRow active={false} kind="worktree" shortcut="Ctrl Enter">Worktree houston/feat-agents-overview in a new pane</BranchSwitcherRow>
    <BranchSwitcherGroup>Branches</BranchSwitcherGroup>
    <BranchSwitcherRow active={false} current worktreeLabel="Worktree in this pane" note="1h">inspector-polish</BranchSwitcherRow>
    <BranchSwitcherRow active={false} note="2 behind · 3h">feature/source-control</BranchSwitcherRow>
  </div>
}
