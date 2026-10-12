import type { ReactNode } from 'react'
import { PAGE_COLUMN_WIDE_CLS } from './settingsPrimitives'
import { Text } from './Text'
import { Card } from './Card'

export function UsageToolbar({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex min-h-[var(--h-usage-toolbar)] flex-wrap items-center gap-[var(--space-2)] border-b border-[var(--divider)] px-[var(--space-3)] py-[var(--space-2)]" data-testid="usage-toolbar">{children}</div>
}

export function UsageContentFrame({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className={`mx-auto grid w-full gap-[var(--space-4)] ${PAGE_COLUMN_WIDE_CLS} content-start px-[var(--space-5)] py-[var(--space-4)]`}>{children}</div>
}

export function UsageStatCell({ label, value, note }: { label: string; value: string; note: string }): React.JSX.Element {
  return <div className="grid min-w-0 gap-[var(--space-1)]"><Text as="div" size="small" weight="small" tone="muted">{label}</Text><Text as="div" size="large" weight="medium" tone="primary" tabular>{value}</Text><div className="sr-only">{note}</div></div>
}

export function UsageHeroValue({ children, ...props }: { children: ReactNode; 'data-testid'?: string }): React.JSX.Element {
  return <div {...props} className="text-[length:var(--tr-text-title-size)] font-[var(--tr-text-title-weight)] tracking-[var(--tr-text-title-tracking)] tabular-nums text-[var(--text-primary)]">{children}</div>
}

export function UsageHeroCaption({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex items-center gap-[var(--space-1)] text-[length:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] leading-[1.5] text-[var(--text-muted)]">{children}</div>
}

export function UsageChartHeading({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text as="div" size="large" weight="semibold" className="tracking-[var(--tr-text-subhead-tracking)]">{children}</Text>
}

export function UsageBody({ stale, children }: { stale: boolean; children: ReactNode }): React.JSX.Element {
  return <div data-testid="usage-body" aria-busy={stale} style={stale ? { opacity: 'var(--opacity-usage-stale)' } : undefined} className={`grid gap-[var(--space-5)] ${stale ? 'transition-opacity duration-150' : ''}`}>{children}</div>
}

export function UsageError({ children }: { children: ReactNode }): React.JSX.Element {
  return <div role="alert" data-testid="usage-error" className="rounded-[var(--tr-radius-md)] border border-[var(--danger)] bg-[var(--status-blocked-bg)] px-[var(--space-4)] py-[var(--space-3)] text-[length:var(--tr-text-sm)] text-[var(--status-blocked-text)]">{children}</div>
}

export function UsageProviderList({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex flex-col gap-[var(--space-3)]">{children}</div>
}

export function UsageChartHeader({ children, actions }: { children: ReactNode; actions?: ReactNode }): React.JSX.Element {
  return <div className="flex flex-wrap items-center gap-[var(--space-3)]">{children}{actions && <span className="ml-auto">{actions}</span>}</div>
}

export function UsageTotalsStrip({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="grid grid-cols-2 gap-[var(--space-3)] lg:grid-cols-4" data-testid="usage-totals">{children}</div>
}

export function UsageTotalsSection({ children, ...props }: { children: ReactNode; 'data-testid'?: string }): React.JSX.Element {
  return <section {...props} className="grid gap-[var(--space-2)] pt-[var(--space-6)]">{children}</section>
}

export function UsageCalendarSectionFrame({ children, ...props }: { children: ReactNode; 'data-testid'?: string }): React.JSX.Element {
  return <section {...props} className="grid gap-[var(--space-2)] pt-[var(--space-4)]">{children}</section>
}

export function UsageBreakdownHeading({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex items-center justify-between gap-[var(--space-3)]">{children}</div>
}

export function UsageBreakdownSection({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="grid gap-[var(--space-2)] pt-[var(--space-5)]">{children}</div>
}

export function UsageBreakdownFrame({ children, ...props }: { children: ReactNode; 'data-testid'?: string }): React.JSX.Element {
  return <div {...props}>{children}</div>
}

export function UsageShareGroup({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="grid grid-cols-1 gap-[var(--space-4)] pt-[var(--space-6)] md:grid-cols-2">{children}</div>
}

export function UsageHeroColumn({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="grid min-w-0 content-start gap-[var(--space-3)]">{children}</div>
}

export function UsageHeroSummary({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="grid gap-[var(--space-1)] pt-[var(--space-2)]">{children}</div>
}

export function UsageHeroLayout({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="grid grid-cols-1 gap-[var(--space-5)] lg:grid-cols-[minmax(0,var(--w-usage-hero))_minmax(0,1fr)]">{children}</div>
}

export function UsageToolbarActions({ children }: { children: ReactNode }): React.JSX.Element {
  return <span className="ml-auto flex items-center gap-[var(--space-2)]">{children}</span>
}

export function UsageChromeSpecimen(): React.JSX.Element {
  return <div className="grid gap-[var(--space-3)]"><UsageToolbar><Text as="h1" size="ui" weight="semibold" flush>Usage</Text><span className="text-[var(--text-faint)]">/</span><Text size="small" tone="muted" tabular>Last 7 days</Text></UsageToolbar><UsageContentFrame><div className="grid gap-[var(--space-3)]"><UsageHeroColumn><UsageHeroSummary><UsageHeroValue>$14.20</UsageHeroValue><UsageHeroCaption>12 sessions · API estimate</UsageHeroCaption></UsageHeroSummary><UsageProviderList><UsageStatCell label="Sessions" value="12" note="active sessions" /></UsageProviderList></UsageHeroColumn><UsageStatCell label="Processed tokens" value="24,500" note="per active day"/><UsageChartHeading>Daily cost</UsageChartHeading><UsageError>Usage could not be refreshed.</UsageError><UsageBody stale><span>Reading transcripts…</span></UsageBody><UsageBreakdownSection><UsageBreakdownHeading><Text size="large" weight="semibold">Breakdown</Text></UsageBreakdownHeading><UsageBreakdownFrame><Text size="small" tone="muted">Daily model activity</Text></UsageBreakdownFrame></UsageBreakdownSection></div></UsageContentFrame></div>
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
