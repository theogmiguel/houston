import { useEffect, useMemo, useState } from 'react'

import { IconChartArea, IconInfo, IconRefresh } from './icons'
import { EmptyState } from './EmptyState'
import { Segmented } from './Segmented'
import { UsageChart, type UsageSeries } from './ui/UsageChart'
import type { ServerMsg } from '../houston/generated/ServerMsg'
import type { UsageProvider } from '../houston/generated/UsageProvider'
import {
  breakdownRows,
  foldSeries,
  formatRange,
  formatShare,
  formatTokens,
  formatUsd,
  providerSummaries,
  usageTotals,
  USAGE_WINDOWS,
  windowRange,
  type BreakdownMode,
  type BreakdownRow,
  type ProviderSummary,
  type SeriesPoint,
  type UsageTotals,
  type UsageWindowDef,
  type UsageWindowId
} from '../usage'
import { Icon } from './Icon'
import { Tooltip } from './Tooltip'
import { Select } from './Select'
import { Button, Table, UsageCalendar, UsageModelCell, UsageProviderRow, UsageSectionHeading, UsageShareBar } from './ui'
import { calendarStartMs } from './ui/UsageCalendar'
import type { UsageActivityDay } from '../houston/generated/UsageActivityDay'

export type UsageSummaryMsg = Extract<ServerMsg, { type: 'usage_summary' }>

const PROVIDER_COLOR: Record<UsageProvider, string> = {
  claude: 'var(--claude)',
  codex: 'var(--text-primary)'
}

const PROVIDER_MARK: Record<UsageProvider, string> = {
  claude: '✳',
  codex: '◎'
}

function StatCell({
  label,
  value,
  note
}: {
  label: string
  value: string
  note: string
}): React.JSX.Element {
  return (
    <div className="grid min-w-0 gap-[var(--space-1)]">
      <div className="[font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-muted)]">{label}</div>
      <div className="text-[length:var(--tr-text-lg)] font-medium tabular-nums text-[var(--text-primary)]">
        {value}
      </div>
      <div className="sr-only">{note}</div>
    </div>
  )
}

function UsageHero({
  metric,
  heroValue,
  sessions,
  providers,
  windowDef,
  points,
  series,
  labelFor
}: {
  metric: 'cost' | 'tokens'
  heroValue: string
  sessions: number
  providers: (ProviderSummary & { sessions: number })[]
  windowDef: UsageWindowDef
  points: SeriesPoint[]
  series: UsageSeries[]
  labelFor: (point: SeriesPoint) => string
}): React.JSX.Element {
  return (
    <div className="grid grid-cols-1 gap-[var(--space-5)] lg:grid-cols-[minmax(0,17rem)_minmax(0,1fr)]">
      <div className="min-w-0">
        <div
          data-testid="usage-headline"
          className="mt-[var(--space-2)] text-[length:var(--tr-text-title-size)] font-[var(--tr-text-title-weight)] tracking-[var(--tr-text-title-tracking)] tabular-nums text-[var(--text-primary)]"
        >
          {heroValue}
        </div>
        <div className="mt-[var(--space-1)] flex items-center gap-[var(--space-1)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] leading-[1.5] text-[var(--text-muted)]">
          {sessions.toLocaleString('en-US')} sessions · {metric === 'cost' ? 'API estimate' : 'processed tokens'}
          {metric === 'cost' && <Tooltip label="Estimated at the published full API rate. Subscriptions are billed separately."><span aria-label="API estimate details" role="img"><Icon glyph={IconInfo} role="small" /></span></Tooltip>}
        </div>

        <div className="mt-[var(--space-3)] flex flex-col gap-[var(--space-3)]">
          {providers.map((p) => {
            return (
              <UsageProviderRow
                key={p.provider}
                mark={PROVIDER_MARK[p.provider]}
                label={p.label}
                sessions={p.sessions}
                amount={metric === 'cost' ? formatUsd(p.cost) : formatTokens(p.tokens)}
                note={metric === 'cost' ? `${formatShare(p.costShare)} of cost · ${formatTokens(p.tokens)} tokens` : `${formatShare(p.tokenShare)} of tokens · ${formatUsd(p.cost)}`}
                color={PROVIDER_COLOR[p.provider]}
              />
            )
          })}
        </div>
      </div>

      <div className="min-w-0">
        <div className="mb-[var(--space-3)] flex flex-wrap items-center justify-between gap-[var(--space-2)]">
          <div className="text-[length:var(--tr-text-lg)] font-semibold tracking-[-0.006em] text-[var(--text-primary)]">
            {windowDef.hourly ? 'Hourly' : 'Daily'} {metric === 'cost' ? 'cost' : 'processed tokens'}
          </div>
        </div>
        <UsageChart points={points} series={series} metric={metric} labelFor={labelFor} />
      </div>
    </div>
  )
}

function UsageTokenStrip({ totals }: { totals: UsageTotals }): React.JSX.Element {
  return (
    <div className="mt-[var(--space-2)] grid grid-cols-2 border-y border-[var(--border)] py-[var(--space-3)] sm:grid-cols-5">
      <StatCell
        label="Processed tokens"
        value={formatTokens(totals.tokens)}
        note={
          totals.activeDays > 0
            ? `${formatTokens(totals.tokens / totals.activeDays)} per active day`
            : 'no active days in this window'
        }
      />
      <StatCell
        label="Cached input"
        value={formatTokens(totals.cachedInput)}
        note={`${formatShare(
          totals.cachedInput / Math.max(1, totals.cachedInput + totals.uncachedInput + totals.cacheCreation)
        )} of observed input`}
      />
      <StatCell
        label="Uncached input"
        value={formatTokens(totals.uncachedInput)}
        note={`${formatTokens(totals.cacheCreation)} cache writes`}
      />
      <StatCell
        label="Output"
        value={formatTokens(totals.output)}
        note={
          totals.reasoning > 0
            ? `includes ${formatTokens(totals.reasoning)} reasoning`
            : 'no reasoning tokens reported'
        }
      />
      <StatCell
        label="Cache savings"
        value={formatUsd(totals.cacheSavings)}
        note={
          totals.cost > 0
            ? `${(totals.cacheSavings / totals.cost).toFixed(1)}× the raw token cost`
            : 'nothing priced in this window'
        }
      />
    </div>
  )
}

function UsageBreakdown({
  mode,
  onModeChange,
  rows,
  loading
}: {
  mode: BreakdownMode
  onModeChange: (mode: BreakdownMode) => void
  rows: BreakdownRow[]
  loading: boolean
}): React.JSX.Element {
  return (
    <>
      <div className="mt-[var(--space-5)] flex items-center justify-between gap-[var(--space-3)]">
        <UsageSectionHeading>Breakdown</UsageSectionHeading>
        <Segmented
          aria-label="Breakdown grouping"
          options={[
            { value: 'model', label: 'Model' },
            { value: 'day', label: 'Day' }
          ]}
          value={mode}
          onChange={onModeChange}
        />
      </div>

      <div data-testid="usage-breakdown" className="mt-[var(--space-2)]">
        <Table
          variant="plain"
          aria-label="Usage breakdown"
          rows={rows.map((row, index) => ({ ...row, rank: index + 1 }))}
          getRowId={(row) => row.id}
          empty={{ heading: loading ? 'Reading transcripts…' : 'No activity in this window.', description: '' }}
          columns={[
            { key: 'rank', header: '#', width: '28px', tone: 'faint' },
            { key: 'id', header: mode === 'model' ? 'Model' : 'Day', render: (id, row) => {
              const mark = row.provider ? PROVIDER_MARK[row.provider] : null
              return mode === 'model'
                ? <UsageModelCell mark={mark} name={String(id)} share={row.share} color={row.provider ? PROVIDER_COLOR[row.provider] : 'var(--text-muted)'} />
                : <span>{id}</span>
            } },
            { key: 'cost', header: 'Cost', width: '100px', numeric: true, weight: 'regular', render: (cost, row) => row.unpriced ? <Tooltip label="No published rate for this model"><span>not priced</span></Tooltip> : formatUsd(Number(cost)) },
            { key: 'share', header: 'Share', width: '76px', numeric: true, tone: 'muted', render: (share) => formatShare(Number(share)) },
            { key: 'tokens', header: 'Tokens', width: '88px', numeric: true, tone: 'muted', render: (tokens) => formatTokens(Number(tokens)) }
          ]}
        />
      </div>
    </>
  )
}

function usageRangeLabel(
  stale: boolean,
  summary: UsageSummaryMsg | null,
  asked: { sinceMs: number; untilMs: number } | null,
  timeZone: string
): string {
  if (stale || !summary) {
    return asked
      ? `${formatRange(asked.sinceMs, asked.untilMs, timeZone)} · reading transcripts…`
      : 'Reading transcripts…'
  }
  return formatRange(summary.since_ms, summary.until_ms, timeZone)
}

function activitySummary(metric: 'cost' | 'tokens', activity: UsageActivityDay[]): string {
  const total = metric === 'cost'
    ? `$${Math.round(activity.reduce((sum, day) => sum + day.cost_usd, 0)).toLocaleString('en-US')}`
    : formatTokens(activity.reduce((sum, day) => sum + day.totals.uncached_input_tokens + day.totals.cached_input_tokens + day.totals.cache_creation_tokens + day.totals.output_tokens, 0))
  return `${total} in the last year`
}

export function UsageSection({
  summary,
  loading,
  error,
  onRequest,
  activity = [],
  workspaces = [],
  initialWorkspace = 'all',
  onActivityRequest = () => {}
}: {
  summary: UsageSummaryMsg | null
  loading: boolean
  error: string | null
  activity?: UsageActivityDay[]
  workspaces?: { path: string; name: string }[]
  initialWorkspace?: string
  onActivityRequest?: (sinceMs: number, untilMs: number, workspace: string | null) => void
  onRequest: (sinceMs: number, untilMs: number, refreshPricing: boolean, workspace: string | null) => void
}): React.JSX.Element {
  const [windowId, setWindowId] = useState<UsageWindowId>('7d')
  const [selectedWorkspace, setSelectedWorkspace] = useState(initialWorkspace)
  const [metric, setMetric] = useState<'cost' | 'tokens'>('cost')
  const [mode, setMode] = useState<BreakdownMode>('model')
  const [asked, setAsked] = useState<{ sinceMs: number; untilMs: number } | null>(null)
  const [selectedDay, setSelectedDay] = useState<string | null>(null)

  const windowDef = USAGE_WINDOWS.find((w) => w.id === windowId) ?? USAGE_WINDOWS[1]
  const timeZone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', [])

  useEffect(() => {
    const { sinceMs, untilMs } = windowRange(windowDef, Date.now())
    setAsked({ sinceMs, untilMs })
    setSelectedDay(null)
    onRequest(sinceMs, untilMs, false, selectedWorkspace === 'all' ? null : selectedWorkspace)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowId, selectedWorkspace])

  useEffect(() => {
    const now = Date.now()
    onActivityRequest(calendarStartMs(now), now, selectedWorkspace === 'all' ? null : selectedWorkspace)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedWorkspace])

  const buckets = summary?.buckets ?? []
  const points = useMemo<SeriesPoint[]>(
    () =>
      summary
        ? foldSeries(buckets, {
            sinceMs: summary.since_ms,
            untilMs: summary.until_ms,
            hourly: windowDef.hourly,
            timeZone
          })
        : [],
    [summary, buckets, windowDef.hourly, timeZone]
  )
  const totals = useMemo(() => usageTotals(buckets, timeZone), [buckets, timeZone])
  const providers = useMemo(() => providerSummaries(buckets), [buckets])
  const sessionsByProvider = useMemo(() => {
    const counts = new Map<UsageProvider, number>()
    for (const source of summary?.sources ?? []) counts.set(source.provider, (counts.get(source.provider) ?? 0) + source.distinct_sessions)
    return counts
  }, [summary])
  const displayProviders = providers
    .map((provider) => ({ ...provider, sessions: sessionsByProvider.get(provider.provider) ?? 0 }))
    .sort((a, b) => a.provider === 'codex' ? -1 : b.provider === 'codex' ? 1 : 0)
  const rows = useMemo(() => breakdownRows(buckets, mode, timeZone), [buckets, mode, timeZone])

  const series: UsageSeries[] = providers
    .map((p) => ({ provider: p.provider, label: p.label, color: PROVIDER_COLOR[p.provider] }))

  const labelFor = (point: SeriesPoint): string => {
    const opts: Intl.DateTimeFormatOptions = windowDef.hourly
      ? { timeZone, hour: 'numeric' }
      : { timeZone, month: 'short', day: 'numeric' }
    try {
      return new Intl.DateTimeFormat('en-US', opts).format(new Date(windowDef.hourly ? point.startMs : `${point.key}T12:00:00`))
    } catch {
      return ''
    }
  }

  const refresh = (): void => {
    const { sinceMs, untilMs } = windowRange(windowDef, Date.now())
    setAsked({ sinceMs, untilMs })
    onRequest(sinceMs, untilMs, true, selectedWorkspace === 'all' ? null : selectedWorkspace)
  }

  const stale =
    loading && summary !== null && asked !== null && summary.until_ms - summary.since_ms !== asked.untilMs - asked.sinceMs

  const heroValue = metric === 'cost' ? formatUsd(totals.cost) : formatTokens(totals.tokens)
  const sessions = [...sessionsByProvider.values()].reduce((sum, count) => sum + count, 0)
  const noUsage = !stale && summary !== null && sessions === 0
  const rangeLabel = usageRangeLabel(stale, summary, asked, timeZone)

  return (
    <main className="h-full min-h-0 w-full overflow-y-auto" data-testid="nav-surface" data-page="usage">
      <div className="flex min-h-[48px] flex-wrap items-center gap-[var(--space-2)] border-b border-[var(--divider)] px-[var(--space-3)] py-[var(--space-2)]" data-testid="usage-toolbar">
        <h1 className="m-0 text-[length:var(--tr-text-ui-size)] font-semibold text-[var(--text-primary)]">Usage</h1>
        <span className="text-[var(--text-faint)]">/</span>
        <Select
          aria-label="Usage workspace"
          data-testid="usage-workspace"
          value={selectedWorkspace}
          options={[{ value: 'all', label: 'All workspaces' }, ...workspaces.map((workspace) => ({ value: workspace.path, label: workspace.name }))]}
          onChange={setSelectedWorkspace}
        />
        <span data-testid="usage-range" className="text-[length:var(--tr-text-small-size)] text-[var(--text-muted)] tabular-nums">{rangeLabel}</span>
        <span className="ml-auto flex items-center gap-[var(--space-2)]">
          <Segmented aria-label="Usage metric" options={[
            { value: 'cost', label: 'Cost' }, { value: 'tokens', label: 'Tokens' },
            { value: 'limits', label: 'Limits', disabled: true, disabledReason: 'A quota reader is not available yet' }
          ]} value={metric} onChange={(value) => { if (value !== 'limits') setMetric(value) }} />
          <Segmented aria-label="Usage window" options={USAGE_WINDOWS.map((w) => ({ value: w.id, label: w.label }))} value={windowId} onChange={setWindowId} />
          <Tooltip label="Re-scan usage">
            <Button variant="icon" aria-label="Refresh usage" data-testid="usage-refresh" onClick={refresh} disabled={loading} icon={IconRefresh} />
          </Tooltip>
        </span>
      </div>

      <div className="mx-auto grid w-full max-w-[1040px] content-start px-[var(--space-5)] py-[var(--space-4)]">
      {error && (
        <div
          role="alert"
          data-testid="usage-error"
          className="mb-[var(--space-4)] rounded-[10px] border border-[var(--danger)] bg-[var(--status-blocked-bg)] px-[var(--space-4)] py-[var(--space-3)] text-[length:var(--tr-text-sm)] text-[var(--status-blocked-text)]"
        >
          {error}
        </div>
      )}

      {}
      <div
        data-testid="usage-body"
        aria-busy={stale}
        className={`grid ${stale ? 'opacity-40 transition-opacity duration-150' : ''}`}
      >
        {noUsage ? (
          <EmptyState
            headline="No usage recorded yet"
            description="Houston hasn't scanned any Claude Code or Codex sessions in this window."
            action={{ label: 'Refresh', onClick: refresh }}
            icon={<Icon glyph={IconChartArea} role="display" />}
          />
        ) : (
          <>
        {}
        <UsageHero
          metric={metric}
          heroValue={heroValue}
          sessions={sessions}
          providers={displayProviders}
          windowDef={windowDef}
          points={points}
          series={series}
          labelFor={labelFor}
        />

        {}
        <section className="mt-[var(--space-6)] grid gap-0" data-testid="usage-totals">
          <UsageSectionHeading>Totals</UsageSectionHeading>
          <UsageTokenStrip totals={totals} />
        </section>

        <section className="mt-[var(--space-2)] grid gap-[var(--space-2)]" data-testid="usage-calendar-section">
          <div className="flex items-center justify-between gap-[var(--space-3)]">
            <UsageSectionHeading fullWidth aside="Follows Cost | Tokens">{activitySummary(metric, activity)}</UsageSectionHeading>
          </div>
          <UsageCalendar days={activity} metric={metric} selectedDay={selectedDay} caption="Houston keeps one total per day, so days older than the transcripts still count. Click a day to see its breakdown." onSelect={(day) => { setSelectedDay((current) => current === day ? null : day); setMode('day') }} />
        </section>

        {metric === 'cost' && totals.tokens > 0 && <div className="mt-[var(--space-6)] grid grid-cols-1 gap-[var(--space-4)] md:grid-cols-2">
          <UsageShareBar heading="Cost by type" segments={categoryTotals(buckets)} />
          {buckets.some((bucket) => bucket.fast_cost_usd + bucket.ultrafast_cost_usd > 0) && <UsageShareBar heading="Cost by speed" aside={`Premium ${formatUsd(buckets.reduce((sum, bucket) => sum + bucket.speed_premium_usd, 0))}`} segments={speedTotals(buckets)} />}
        </div>}

        {}
        <UsageBreakdown mode={mode} onModeChange={setMode} rows={dayBreakdown(rows, selectedDay, activity)} loading={loading} />
          </>
        )}

        {}
      </div>
      </div>
    </main>
  )
}

function dayBreakdown(rows: BreakdownRow[], selectedDay: string | null, activity: UsageActivityDay[]): BreakdownRow[] {
  if (!selectedDay) return rows
  const detailed = rows.filter((row) => row.id === selectedDay)
  if (detailed.length > 0) return detailed
  const day = activity.find((entry) => entry.day === selectedDay)
  if (!day) return []
  return [{
    id: selectedDay,
    provider: null,
    cost: day.cost_usd,
    tokens: day.totals.uncached_input_tokens + day.totals.cached_input_tokens + day.totals.cache_creation_tokens + day.totals.output_tokens,
    share: 1,
    unpriced: false
  }]
}

export function categoryTotals(buckets: UsageSummaryMsg['buckets']): { id: string; label: string; value: number }[] {
  return [
    { id: 'input', label: 'Input', value: buckets.reduce((sum, bucket) => sum + bucket.category_cost_usd.input_usd, 0) },
    { id: 'cache-read', label: 'Cache read', value: buckets.reduce((sum, bucket) => sum + bucket.category_cost_usd.cache_read_usd, 0) },
    { id: 'cache-write', label: 'Cache write', value: buckets.reduce((sum, bucket) => sum + bucket.category_cost_usd.cache_write_usd, 0) },
    { id: 'output', label: 'Output', value: buckets.reduce((sum, bucket) => sum + bucket.category_cost_usd.output_usd, 0) },
    { id: 'other', label: 'Other', value: buckets.reduce((sum, bucket) => sum + bucket.category_cost_usd.other_usd, 0) }
  ].filter((segment) => segment.value > 0)
}

export function speedTotals(buckets: UsageSummaryMsg['buckets']): { id: string; label: string; value: number }[] {
  const fast = buckets.reduce((sum, bucket) => sum + bucket.fast_cost_usd, 0)
  const ultrafast = buckets.reduce((sum, bucket) => sum + bucket.ultrafast_cost_usd, 0)
  const total = buckets.reduce((sum, bucket) => sum + bucket.cost_usd, 0)
  return [
    { id: 'standard', label: 'Standard', value: Math.max(0, total - fast - ultrafast) },
    { id: 'fast', label: 'Fast', value: fast },
    { id: 'ultrafast', label: 'Ultrafast', value: ultrafast }
  ]
}
