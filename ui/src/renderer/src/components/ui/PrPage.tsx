import type { HTMLAttributes, ReactNode } from 'react'
import { Icon } from './Icon'
import { IconFolder, IconSearch } from '../icons'
import { Text } from './Text'
import { Select } from './Select'
import { Segmented } from './SegmentedControl'
import { ROW_STATE } from './rowState'

export function PrPageContent({ children, ...props }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }): React.JSX.Element {
  return <div {...props} className="mx-auto grid w-full max-w-[760px] content-start gap-[var(--space-4)] px-[var(--space-6)] pb-[var(--space-6)] pt-[var(--space-5)]">{children}</div>
}

export function PrPageHeader({ workspace, options, onWorkspaceChange }: { workspace: string; options: { value: string; label: string }[]; onWorkspaceChange: (workspace: string) => void }): React.JSX.Element {
  return <header className="grid gap-[var(--space-1)]"><div className="flex items-center gap-[var(--space-2)]"><Text as="h1" size="heading" weight="subhead" tone="primary" flush className="flex-1">Pull requests</Text><Select aria-label="Workspace" value={workspace} options={options} onChange={onWorkspaceChange} variant="property-field" prefix={<Icon glyph={IconFolder} role="small" />} /></div><Text as="p" size="ui" tone="secondary" flush>Open pull requests in this workspace’s repository, grouped by who has to act next.</Text></header>
}

export function PrPageFilters({ query, onQueryChange, state, openCount, onStateChange }: { query: string; onQueryChange: (query: string) => void; state: 'open' | 'merged' | 'closed'; openCount: number | null; onStateChange: (state: 'open' | 'merged' | 'closed') => void }): React.JSX.Element {
  return <div className="flex items-center gap-[var(--space-2)]"><label className="flex h-[var(--h-ctl)] min-w-0 flex-1 items-center gap-[var(--space-2)] rounded-[var(--tr-radius-sm)] border border-[var(--border)] px-[var(--space-2)] text-[var(--text-faint)]"><Icon glyph={IconSearch} role="small" /><input id="pr-search" aria-label="Search pull requests" value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="Search titles, branches or label:bug" className="min-w-0 w-full bg-transparent border-0 text-[length:var(--tr-text-small-size)] text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus-visible:outline-none" /></label><Segmented aria-label="State" value={state} onChange={onStateChange} options={[{ value: 'open', label: openCount === null ? 'Open' : `Open ${openCount}` }, { value: 'merged', label: 'Merged' }, { value: 'closed', label: 'Closed' }]} /></div>
}

export function PrPageGroupHeading({ label, count }: { label: string; count: number }): React.JSX.Element {
  return <div className="flex items-center gap-[var(--space-2)] px-[var(--space-2)] pb-[var(--space-0-5)] text-[length:var(--tr-text-small-size)] font-semibold text-[var(--text-secondary)]">{label}<span className="font-normal text-[var(--text-muted)]">{count}</span></div>
}

export function PrListEntry({ selected, number, heading, author, age, additions, deletions, status, ...props }: HTMLAttributes<HTMLDivElement> & { selected: boolean; number: number; heading: string; author: string; age: string; additions: number; deletions: number; status: ReactNode }): React.JSX.Element {
  return <div {...props} role="button" tabIndex={0} aria-current={selected || undefined} className={`grid grid-cols-[minmax(0,1fr)_auto] gap-x-[var(--space-3)] gap-y-[var(--space-0-5)] rounded-[var(--tr-radius-sm)] px-[var(--space-2-5)] py-[var(--space-2)] ${selected ? ROW_STATE.selected : ROW_STATE.rest}`} onKeyDown={(event) => {
    if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); event.currentTarget.click() }
  }}><span className="flex min-w-0 items-center gap-[var(--space-2)] text-[length:var(--tr-text-ui-size)] text-[var(--text-primary)]"><span className="font-mono text-[var(--text-muted)]">#{number}</span><span className="truncate">{heading}</span></span><span className="justify-self-end">{status}</span><span className="text-[length:var(--tr-text-small-size)] text-[var(--text-muted)]">{author} · {age}</span><span className="justify-self-end font-mono text-[length:var(--tr-text-small-size)]"><span className="text-[var(--ok)]">+{additions.toLocaleString('en')}</span> <span className="text-[var(--stop)]">−{deletions.toLocaleString('en')}</span></span></div>
}

export function PrPageSpecimen(): React.JSX.Element {
  return <PrPageContent><PrPageHeader workspace="repo" options={[{ value: 'repo', label: 'Houston' }]} onWorkspaceChange={() => {}} /><PrPageFilters query="" onQueryChange={() => {}} state="open" openCount={5} onStateChange={() => {}} /><PrPageGroupHeading label="Waiting on you" count={1} /><PrListEntry selected={false} number={92} heading="Follow and answer agents from a paired phone" author="teammate" age="3h ago" additions={9163} deletions={18} status="Your review" /></PrPageContent>
}
