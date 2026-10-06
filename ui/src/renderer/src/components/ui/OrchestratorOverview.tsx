import type { HTMLAttributes, ReactNode } from 'react'
import { Text } from './Text'
import { Button } from './Button'
import { IconAgent } from '../icons'
import { SEG_ITEM_CLS, SEG_ITEM_OFF_CLS, SEG_ITEM_ON_CLS, SEG_TRACK_CLS } from './segmentedChrome'
import { Tooltip } from './Tooltip'

export function OrchestratorHeader({ children }: { children: ReactNode }): React.JSX.Element {
  return <header className="flex items-center gap-[var(--space-2)] h-[var(--h-overview-head)] min-w-0 border-b border-b-[var(--divider)] px-[var(--space-1-5)] pl-[var(--space-3)] -mx-[var(--space-2-5)]">{children}</header>
}

export function OrchestratorTitle({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text size="small" weight="label" tone="primary" className="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{children}</Text>
}

export function OrchestratorSummary({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex items-center gap-[var(--space-4)] my-[var(--space-overview-summary-block)] mx-[var(--space-overview-summary-inline)] text-[length:var(--tr-text-small-size)] text-[var(--text-muted)]">{children}</div>
}

export function OrchestratorCount({ children, needsInput = false }: { children: ReactNode; needsInput?: boolean }): React.JSX.Element {
  return <Text as="strong" tone={needsInput ? 'warn' : 'muted'} className="text-[length:var(--tr-text-heading-size)] [font-weight:var(--tr-text-heading-weight)] tracking-[var(--tr-text-heading-tracking)] tabular-nums">{children}</Text>
}

export function OrchestratorProgress({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex" style={{ gap: 'var(--space-overview-progress-gap)', height: 'var(--sz-overview-progress)', marginBottom: 'var(--space-overview-progress-end)' }}>{children}</div>
}

export function OrchestratorProgressSegment({ group, weight }: { group: string; weight: number }): React.JSX.Element {
  const backgroundColor = group === 'Needs you' ? 'var(--warn)' : group === 'Settled' || group === 'Done' ? 'var(--ok)' : group === 'Failed' ? 'var(--stop)' : 'var(--info)'
  return <i data-group={group} style={{ flex: weight, minWidth: 'var(--space-1)', height: '100%', borderRadius: 'calc(var(--tr-radius-input) / 2)', backgroundColor }} className="block" />
}

export function OrchestratorChildList({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex flex-col gap-[var(--space-2)]">{children}</div>
}

export function OrchestratorChildCard({ children, needsInput = false, ...props }: HTMLAttributes<HTMLElement> & { needsInput?: boolean }): React.JSX.Element {
  return <article {...props} className={`group/overview-child relative border border-[var(--border)] ${needsInput ? 'border-[color-mix(in_srgb,var(--warn)_55%,var(--border))]' : ''} rounded-[var(--tr-radius-card)] bg-[var(--card-bg)] overflow-hidden flex flex-col gap-[var(--space-2)] pt-[var(--space-overview-child-pt)] px-[var(--space-overview-child-px)] pb-[var(--space-overview-child-pb)]`}>{children}</article>
}

export function OrchestratorChildHeader({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="overview-child-head flex items-center gap-[var(--space-overview-child-head)] text-[length:var(--tr-text-overview-head)] min-w-0">{children}</div>
}

export function OrchestratorChildTitle({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text as="strong" className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{children}</Text>
}

export function OrchestratorIdentity({ children, size = 'small' }: { children: ReactNode; size?: 'xs' | 'small' }): React.JSX.Element {
  return <Text size={size} mono tone="faint">{children}</Text>
}

export function OrchestratorChildState({ children, state }: { children: ReactNode; state: 'needs_input' | 'working' | 'done' | 'failed' | 'other' }): React.JSX.Element {
  const tone = state === 'needs_input' ? 'todo' : state === 'working' ? 'doing' : state === 'done' ? 'done' : state === 'failed' ? 'blocked' : 'other'
  const color = tone === 'todo' ? 'text-[var(--status-todo-text)]' : tone === 'doing' ? 'text-[var(--status-doing-text)]' : tone === 'done' ? 'text-[var(--status-done-text)]' : tone === 'blocked' ? 'text-[var(--status-blocked-text)]' : 'text-[var(--text-secondary)]'
  return <span data-state={state} className={`overview-state ml-auto text-[length:var(--tr-text-overview-state)] font-semibold whitespace-nowrap group-hover/overview-child:invisible ${color}`}>{children}</span>
}

export function OrchestratorAge({ children }: { children: ReactNode }): React.JSX.Element {
  return <span className="min-w-[26px] text-right text-[length:var(--tr-text-xs)] text-[var(--text-faint)] font-mono group-hover/overview-child:invisible">{children}</span>
}

export function OrchestratorStatusDot({ children, state }: { children: ReactNode; state?: 'done' | 'failed' }): React.JSX.Element {
  return <span data-state={state} className="inline-flex flex-none [&[data-state='done']_.agent-dot]:bg-[var(--ok)] [&[data-state='failed']_.agent-dot]:bg-[var(--stop)]">{children}</span>
}

export function OrchestratorTask({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="text-[length:var(--tr-text-overview-head)] leading-[var(--tr-text-small-leading)] min-h-[var(--h-overview-child-task)] text-[var(--text-secondary)] [overflow-wrap:anywhere]">{children}</div>
}

export function OrchestratorMetadata({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex flex-wrap gap-[var(--space-1-5)] text-[length:var(--tr-text-overview-meta)] text-[var(--text-muted)] [overflow-wrap:anywhere] [&>span]:min-w-0 [&>span]:overflow-hidden [&>span]:text-ellipsis [&>span]:whitespace-nowrap">{children}</div>
}

export function OrchestratorBranch({ children }: { children: ReactNode }): React.JSX.Element {
  return <span className="inline-flex items-center gap-[var(--space-overview-branch-gap)] max-w-[var(--w-overview-branch)] px-[var(--space-1-5)] rounded-[var(--tr-radius-sm)] bg-[color-mix(in_srgb,var(--text-primary)_7%,transparent)] text-[var(--text-secondary)] font-mono text-[length:var(--tr-text-xs)]">{children}</span>
}

export function OrchestratorAgentIcon({ agent }: { agent: string }): React.JSX.Element {
  return <IconAgent brand agent={agent} className="w-3.5 h-3.5 flex-none" />
}

export function OrchestratorInlineAction({ children, onClick, summary = false }: { children: ReactNode; onClick: () => void; summary?: boolean }): React.JSX.Element {
  const className = summary ? 'h-[var(--h-overview-filter-item)] px-[var(--space-2)] rounded-[var(--tr-radius-sm)] text-[length:var(--tr-text-overview-state)] bg-transparent text-[var(--text-secondary)]' : ''
  return <Button variant="legacy-ghost" onClick={onClick} className={className}>{children}</Button>
}

export function OrchestratorGroupToggle({ value, onChange }: { value: 'status' | 'worktree'; onChange: (value: 'status' | 'worktree') => void }): React.JSX.Element {
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const next = value === 'status' ? 'worktree' : 'status'
    onChange(next)
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-option="${next}"]`)?.focus()
  }
  return <div role="radiogroup" aria-label="Group children" onKeyDown={handleKeyDown} className={`${SEG_TRACK_CLS} !h-[var(--h-overview-filter-track)] !p-px flex-none`}>
    {(['status', 'worktree'] as const).map((option) => <Tooltip key={option} label="" className="inline-flex flex-none"><button type="button" role="radio" data-option={option} aria-checked={value === option} tabIndex={value === option ? 0 : -1} onClick={() => onChange(option)} className={`${SEG_ITEM_CLS} !h-[var(--h-overview-filter-item)] !min-w-0 !px-[var(--space-2)] !text-[length:var(--tr-text-overview-state)] ${value === option ? SEG_ITEM_ON_CLS : SEG_ITEM_OFF_CLS}`}>{option === 'status' ? 'Status' : 'Worktree'}</button></Tooltip>)}
  </div>
}

export function OrchestratorActionDock({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="absolute top-[var(--space-overview-child-head)] right-[var(--space-overview-child-head)] flex gap-px opacity-0 transition-opacity duration-[var(--animate-t-fast)] bg-[var(--card-bg)] group-hover/overview-child:opacity-100 group-focus-within/overview-child:opacity-100">{children}</div>
}

export function OrchestratorActionRow({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="relative flex flex-wrap gap-[var(--space-1)]">{children}</div>
}

export function OrchestratorSectionLabel({ children }: { children: ReactNode }): React.JSX.Element {
  return <h3 className="flex items-center gap-[var(--space-4)] my-[var(--space-overview-summary-block)] mx-[var(--space-overview-summary-inline)] text-[length:var(--tr-text-small-size)] text-[var(--text-muted)]">{children}</h3>
}

export function OrchestratorResult({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex items-center gap-[var(--space-2)] pt-[var(--space-2)] border-t border-t-[var(--divider)] text-[length:var(--tr-text-overview-meta)] text-[var(--text-muted)] [&>span]:flex-1 [&>span]:min-w-0 [&>span]:overflow-hidden [&>span]:whitespace-nowrap [&>span]:text-ellipsis">{children}</div>
}

export function OrchestratorOverviewSpecimen(): React.JSX.Element {
  return <div className="grid gap-[var(--space-2)]"><OrchestratorHeader><OrchestratorTitle>Orchestrator overview</OrchestratorTitle></OrchestratorHeader><OrchestratorSummary><OrchestratorCount>3</OrchestratorCount><span>children · 1 needs you · 1 working · 1 done</span></OrchestratorSummary><OrchestratorProgress><OrchestratorProgressSegment group="Needs you" weight={1} /><OrchestratorProgressSegment group="Working" weight={1} /><OrchestratorProgressSegment group="Done" weight={1} /></OrchestratorProgress><OrchestratorChildList><OrchestratorChildCard needsInput><OrchestratorChildHeader><OrchestratorChildTitle>Review changes</OrchestratorChildTitle><OrchestratorChildState state="needs_input">Needs you</OrchestratorChildState></OrchestratorChildHeader><OrchestratorTask>Check the source control changes.</OrchestratorTask><OrchestratorMetadata><OrchestratorBranch>feature/ui</OrchestratorBranch></OrchestratorMetadata><OrchestratorResult><span>Ready for review</span></OrchestratorResult><OrchestratorActionDock>Actions</OrchestratorActionDock></OrchestratorChildCard></OrchestratorChildList></div>
}
