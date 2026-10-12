import type { ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, ReactNode, Ref } from 'react'
import { IconCheck, IconChevronDown, IconGitBranch, IconGitFork, IconSearch } from '../icons'
import { Icon } from './Icon'
import { ROW_STATE } from './rowState'
import { FOCUS_HALO_CLS } from './shadowChrome'
import { KeyCap } from './KeyCap'

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

export function BranchSwitcherSearch({ inputRef, ...props }: InputHTMLAttributes<HTMLInputElement> & { inputRef: React.Ref<HTMLInputElement> }): React.JSX.Element {
  return <div className="flex h-[var(--h-ctl)] items-center gap-[var(--space-2)] rounded-[var(--tr-radius-sm)] border border-[var(--border-control)] px-[var(--space-2)] text-[var(--text-muted)] focus-within:border-[var(--accent)] focus-within:ring-2 focus-within:ring-[var(--focus-ring)]">
    <Icon glyph={IconSearch} role="small" />
    <input {...props} ref={inputRef} className="min-w-0 flex-1 border-0 bg-transparent text-[length:var(--tr-text-ui-size)] text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--focus-ring)]" />
    <KeyCap>Esc</KeyCap>
  </div>
}

export function BranchSwitcherGroup({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="px-[var(--space-2)] pt-[var(--space-2)] pb-[var(--space-1)] text-[length:var(--tr-text-label-size)] font-semibold text-[var(--text-faint)]">{children}</div>
}

export function BranchSwitcherRow({ active, current, kind = 'branch', note, shortcut, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { active: boolean; current?: boolean; kind?: 'branch' | 'create' | 'worktree'; note?: string | null; shortcut?: string; children: ReactNode }): React.JSX.Element {
  return <button {...props} type="button" className={`flex h-[var(--h-row)] w-full items-center gap-[var(--space-2)] rounded-[var(--tr-radius-sm)] border-0 px-[var(--space-2)] text-left text-[length:var(--tr-text-small-size)] ${active ? ROW_STATE.selected : ROW_STATE.rest} ${current ? "text-[var(--text-primary)]" : "disabled:opacity-50"} focus-visible:outline-none ${FOCUS_HALO_CLS}`}>
    <span className="flex w-[14px] flex-none">{kind === 'create' ? <Icon glyph={IconGitBranch} role="small" /> : kind === 'worktree' ? <Icon glyph={IconGitFork} role="small" /> : current ? <Icon glyph={IconCheck} role="small" /> : null}</span>
    <span className="min-w-0 flex-1 truncate">{children}</span>
    {note && <span className="flex-none max-w-[190px] truncate text-[var(--text-muted)]">{note}</span>}
    {shortcut && <KeyCap>{shortcut}</KeyCap>}
  </button>
}

export function BranchSwitcherList(props: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div {...props} className="max-h-[300px] overflow-y-auto" />
}

export function BranchSwitcherFooter({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex items-center gap-[var(--space-2)] border-t border-[var(--divider)] px-[var(--space-2)] pt-[var(--space-1-5)] text-[length:var(--tr-text-label-size)] text-[var(--text-muted)]">{children}</div>
}

export function BranchSwitcherSpecimen(): React.JSX.Element {
  return <div className="w-[380px] rounded-[var(--tr-radius-card)] border border-[var(--border)] bg-[var(--card-bg)] p-[var(--space-1)]">
    <BranchSwitcherSearch inputRef={null} value="feat/agents-overview" readOnly aria-label="Find or create a branch" />
    <BranchSwitcherGroup>Create</BranchSwitcherGroup>
    <BranchSwitcherRow active kind="create" shortcut="Enter">Branch feat/agents-overview from main</BranchSwitcherRow>
    <BranchSwitcherRow active={false} kind="worktree" shortcut="Ctrl Enter">Worktree houston/feat-agents-overview in a new pane</BranchSwitcherRow>
    <BranchSwitcherGroup>Branches</BranchSwitcherGroup>
    <BranchSwitcherRow active={false} current note="worktree · this pane">inspector-polish</BranchSwitcherRow>
    <BranchSwitcherRow active={false} note="2 behind">feature/source-control</BranchSwitcherRow>
  </div>
}
