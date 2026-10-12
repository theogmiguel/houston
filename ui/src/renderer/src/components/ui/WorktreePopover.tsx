import type { ReactNode } from 'react'
import { Button } from './Button'
import { Icon } from './Icon'
import { Text } from './Text'
import type { IconComponent } from '../icons'
import { IconAgent, IconCopy, IconFolderOpen, IconGitBranch } from '../icons'

// Presentation for the list of a pane's child worktrees: a header for this pane's own
// checkout, a group label, and one row per child with hover/focus actions.

export interface WorktreeRowAction {
  label: string
  glyph: IconComponent
  onClick: () => void
}

export function WorktreePopoverHeader({ branch, detail, action }: { branch: string; detail: string; action: ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-start gap-[var(--space-2)] px-[var(--space-2)] pb-[var(--space-2)] pt-[var(--space-1-5)]">
      <span className="pt-[var(--space-0-5)] flex text-[var(--text-muted)]"><Icon glyph={IconGitBranch} role="small" /></span>
      <div className="grid min-w-0 flex-1 gap-[2px]">
        <Text size="small" tone="primary" mono className="truncate">{branch}</Text>
        <Text size="caption" tone="muted" className="truncate">{detail}</Text>
      </div>
      {action}
    </div>
  )
}

export function WorktreePopoverDivider(): React.JSX.Element {
  return <div className="mx-[var(--space-1)] my-[var(--space-1)] h-px bg-[var(--divider)]" />
}

export function WorktreePopoverGroupLabel({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text as="div" size="caption" weight="medium" tone="muted" className="px-[var(--space-2)] pb-[var(--space-1)] pt-[var(--space-1-5)]">{children}</Text>
}

export function WorktreePopoverFooter({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text as="div" size="caption" tone="muted" className="px-[var(--space-2)] pb-[var(--space-1)] pt-[2px]">{children}</Text>
}

export function WorktreePopoverRow({
  agent,
  codename,
  role,
  branch,
  ahead,
  added,
  deleted,
  actions,
  onSelect,
  rowProps
}: {
  agent: ReactNode
  codename: string
  role: string
  branch: string
  ahead?: number
  added?: number
  deleted?: number
  actions: readonly WorktreeRowAction[]
  onSelect: () => void
  rowProps?: Record<string, string>
}): React.JSX.Element {
  const stats = (added ?? 0) + (deleted ?? 0) > 0
  return (
    <div className="group flex items-center rounded-[var(--tr-radius-sm)] hover:bg-hover-fill focus-within:bg-hover-fill">
      <button
        type="button"
        {...rowProps}
        onClick={onSelect}
        className="grid min-w-0 flex-1 grid-cols-[auto_1fr] items-start gap-x-[var(--space-2)] rounded-[var(--tr-radius-sm)] border-0 bg-transparent px-[var(--space-2)] py-[var(--space-1-5)] text-left focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:[outline-offset:-2px]"
      >
        <span className="pt-[var(--space-0-5)] flex flex-none">{agent}</span>
        <span className="grid min-w-0 gap-[2px]">
          <span className="flex min-w-0 items-center gap-[var(--space-1-5)]">
            <Text size="small" tone="primary">{codename}</Text>
            <Text size="small" tone="secondary" className="truncate">{role}</Text>
          </span>
          <span className="flex min-w-0 items-center gap-[var(--space-1-5)]">
            <Text size="caption" tone="muted" mono className="min-w-0 truncate">{branch}</Text>
            {ahead != null && ahead > 0 && <Text size="caption" tone="muted" className="flex-none">↑{ahead}</Text>}
            {stats && (
              <Text size="caption" mono className="flex-none">
                <Text tone="ok">+{added ?? 0}</Text> <Text tone="stop">−{deleted ?? 0}</Text>
              </Text>
            )}
          </span>
        </span>
      </button>
      <span className="flex flex-none items-center pr-[var(--space-1)] opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
        {actions.map((action) => (
          <Button key={action.label} variant="small-icon" icon={action.glyph} aria-label={action.label} onClick={action.onClick} />
        ))}
      </span>
    </div>
  )
}

export function WorktreePopoverSpecimen(): React.JSX.Element {
  const actions = [{ label: 'Copy path', glyph: IconCopy, onClick: () => {} }, { label: 'Reveal in file manager', glyph: IconFolderOpen, onClick: () => {} }]
  return (
    <div className="w-[460px] max-w-full rounded-[var(--tr-radius-card)] border border-[var(--border)] bg-[var(--card-bg)] p-[var(--space-1)]">
      <WorktreePopoverHeader branch="fix/orchestration-explicit-bypass" detail="Primary checkout · ~/work/app" action={<Button variant="small-icon" icon={IconCopy} aria-label="Copy branch name" />} />
      <WorktreePopoverDivider />
      <WorktreePopoverGroupLabel>Child worktrees · 2</WorktreePopoverGroupLabel>
      <WorktreePopoverRow agent={<IconAgent agent="claude" role="small" brand />} codename="Rey" role="recovery-persistence" branch="houston/recovery-persistence" ahead={3} added={184} deleted={22} actions={actions} onSelect={() => {}} />
      <WorktreePopoverRow agent={<IconAgent agent="codex" role="small" brand />} codename="Cruz" role="recovery-hook-metadata" branch="houston/recovery-hook-metadata" actions={actions} onSelect={() => {}} />
      <WorktreePopoverDivider />
      <WorktreePopoverFooter>Select a child to focus its pane</WorktreePopoverFooter>
    </div>
  )
}
