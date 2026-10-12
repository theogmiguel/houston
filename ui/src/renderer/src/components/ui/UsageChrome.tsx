import type { ReactNode } from 'react'
import { Text } from './Text'
import { Card } from './Card'
import { Button } from './Button'
import { Tooltip } from './Tooltip'
import { IconClose } from '../icons'

export function UsageBody({ reading, children }: { reading: boolean; children: ReactNode }): React.JSX.Element {
  return <div data-testid="usage-body" aria-busy={reading} className="grid gap-[var(--space-5)]">{children}</div>
}

export function UsageChartHeader({ children, actions }: { children: ReactNode; actions?: ReactNode }): React.JSX.Element {
  return <div className="flex flex-wrap items-center gap-[var(--space-3)]">{children}{actions && <span className="ml-auto">{actions}</span>}</div>
}

export function UsageTotalsStrip({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="grid grid-cols-2 gap-[var(--space-3)] lg:grid-cols-4" data-testid="usage-totals">{children}</div>
}

export function UsageBreakdownHeading({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex items-center justify-between gap-[var(--space-3)]">{children}</div>
}

export function UsageBreakdownSection({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="grid gap-[var(--space-2)]">{children}</div>
}

export function UsageShareGroup({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="grid grid-cols-1 items-start gap-[var(--space-3)] md:grid-cols-2">{children}</div>
}

export function UsageChromeSpecimen(): React.JSX.Element {
  return <UsageBody reading>
    <UsageMetaLine range="Oct 5 – Oct 11" readAge="2 min ago" duration="1.2 s" pricing="Prices from the model catalog, updated Oct 9" reading />
    <UsageBreakdownSection>
      <UsageBreakdownHeading><Text size="large" weight="semibold">Breakdown</Text><UsageDayFilter label="Oct 6" onClear={() => {}} /></UsageBreakdownHeading>
      <Text size="small" tone="muted">Daily model activity</Text>
    </UsageBreakdownSection>
    <UsageSourcesLine>Read from local agent transcripts. Cost is an API-equivalent estimate.</UsageSourcesLine>
  </UsageBody>
}

export function UsageMetaLine({ range, readAge, duration, pricing, reading }: { range: string; readAge: string | null; duration: string | null; pricing: string; reading: boolean }): React.JSX.Element {
  return <Text as="div" size="small" tone="muted" className="-mt-[var(--space-3)] flex flex-wrap items-center gap-[var(--space-2)]" data-testid="usage-meta">
    {reading ? <><span aria-hidden="true" className="inline-block size-[var(--space-2-5)] rounded-full border-2 border-[var(--accent)] border-r-transparent motion-safe:animate-spin" /><Text tone="secondary">Reading transcripts…</Text>{readAge && <span>showing the result from {readAge}</span>}</> : <span>{range}{readAge && ` · read ${readAge}`}{duration && ` in ${duration}`}</span>}
    <span>·</span><span>{pricing}</span>
  </Text>
}

export function UsageStatCard({ label, value, note, headline = false }: { label: string; value: string; note: string; headline?: boolean }): React.JSX.Element {
  return <Card shape="card" tone="block" padding="page" data-material="inset"><div className="grid gap-[var(--space-1)]">
    <Text size="small" tone="muted">{label}</Text>
    <Text size="title" weight="semibold" tone="primary" leading="tight" tight tabular data-testid={headline ? 'usage-headline' : undefined}>{value}</Text>
    <Text size="small" tone="secondary">{note}</Text>
  </div></Card>
}

export function UsageStatsSpecimen(): React.JSX.Element {
  return <div className="grid gap-[var(--space-3)]"><UsageMetaLine range="Oct 5 – Oct 11" readAge="2 min ago" duration="1.2 s" pricing="Prices from the model catalog, updated Oct 9" reading={false} /><UsageMetaLine range="Oct 5 – Oct 11" readAge="2 min ago" duration="1.2 s" pricing="Prices from the model catalog, updated Oct 9" reading /><UsageTotalsStrip><UsageStatCard label="API-equivalent cost" value="$2,486.30" note="214 sessions · $355 a day" /></UsageTotalsStrip></div>
}

export function UsageCardNote({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text as="div" size="small" leading="small" tone="muted" className="border-t border-[var(--divider)] px-[var(--space-4)] py-[var(--space-2-5)]">{children}</Text>
}

export function UsageDayFilter({ label, onClear }: { label: string; onClear: () => void }): React.JSX.Element {
  return <span className="inline-flex items-center gap-[var(--space-1)] rounded-full border border-[var(--border)] pl-[var(--space-2)] pr-[var(--space-1)]">
    <Text size="small" tone="secondary">{label}</Text><Tooltip label="Show the whole window"><Button variant="ghost-icon" size="sm" icon={IconClose} aria-label="Show the whole window" onClick={onClear} /></Tooltip>
  </span>
}

export function UsageBreakdownActions({ children }: { children: ReactNode }): React.JSX.Element {
  return <span className="flex items-center gap-[var(--space-2)]">{children}</span>
}

export function UsageSourcesLine({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text as="p" flush size="small" leading="small" tone="muted" className="px-[var(--space-1)]" data-testid="usage-sources">{children}</Text>
}
