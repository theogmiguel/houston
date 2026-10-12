import { useEffect, useMemo, useRef, useState } from 'react'

import { IconChartArea, IconRefresh } from './icons'
import { EmptyState } from './ui/ActionEmptyState'
import { Segmented } from './ui/SegmentedControl'
import { UsageChart, UsageLegend, type UsageSeries } from './ui/UsageChart'
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
  type SeriesPoint,
  type UsageTotals,
  type UsageWindowId
} from '../usage'
import { Icon } from './ui/Icon'
import { Tooltip } from './ui/Tooltip'
import { Select } from './ui/Select'
import { Button, Table, UsageCalendar, UsageModelCell, UsageProviderRow, UsageSectionHeading, UsageShareBar, Text, UsageBody, UsageProviderList, UsageCalendarSectionFrame, UsageBreakdownHeading, UsageBreakdownSection, UsageBreakdownFrame, UsageShareGroup } from './ui'
import { Card } from './ui/Card'
import { PageFrame } from './ui/PageFrame'
import { PageHeader } from './ui/PageHeader'
import { Notice } from './ui/Notice'
import { UsageMetaLine, UsageStatCard, UsageChartHeader, UsageTotalsStrip } from './ui/UsageChrome'
import { calendarStartMs } from './ui/UsageCalendar'
import type { UsageActivityDay } from '../houston/generated/UsageActivityDay'

export type UsageSummaryMsg = Extract<ServerMsg, { type: 'usage_summary' }>

const PROVIDER_COLOR: Record<UsageProvider, string> = {
  claude: 'var(--claude)',
  codex: 'color-mix(in srgb, var(--text-primary) 55%, transparent)'
}

const PROVIDER_MARK: Record<UsageProvider, string> = {
  claude: '✳',
  codex: '◎'
}

function UsageDailyChart({ metric, onMetricChange, hourly, points, series, labelFor }: {
  metric: 'cost' | 'tokens'
  onMetricChange: (metric: 'cost' | 'tokens') => void
  hourly: boolean
  points: SeriesPoint[]
  series: UsageSeries[]
  labelFor: (point: SeriesPoint) => string
}): React.JSX.Element {
  return <Card shape="card" tone="block" padding="page" clip={false} data-material="inset">
    <div className="grid gap-[var(--space-4)]">
      <UsageChartHeader actions={<Segmented aria-label="Measure" size="xs" value={metric} onChange={onMetricChange} options={[{ value: 'cost', label: 'Cost' }, { value: 'tokens', label: 'Tokens' }]} />}>
        <UsageSectionHeading>{metric === 'cost' ? 'Cost' : 'Tokens'} per {hourly ? 'hour' : 'day'}</UsageSectionHeading>
        <UsageLegend series={series} />
      </UsageChartHeader>
      <UsageChart points={points} series={series} metric={metric} labelFor={labelFor} />
    </div>
  </Card>
}

function UsageStats({ totals, sessions, days }: { totals: UsageTotals; sessions: number; days: number }): React.JSX.Element {
  const roundedUsd = (value: number): string => `$${Math.round(value).toLocaleString('en-US')}`
  return <UsageTotalsStrip>
    <UsageStatCard label="API-equivalent cost" value={formatUsd(totals.cost)} note={`${sessions.toLocaleString('en-US')} sessions · ${roundedUsd(totals.cost / days)} a day`} headline />
    <UsageStatCard label="Tokens processed" value={formatTokens(totals.tokens)} note={`${Math.round(100 * totals.cachedInput / Math.max(1, totals.tokens))}% read from cache`} />
    <UsageStatCard label="Output tokens" value={formatTokens(totals.output)} note={`${formatTokens(totals.uncachedInput)} uncached input`} />
    <UsageStatCard label="Saved by caching" value={roundedUsd(totals.cacheSavings)} note="against full input prices" />
  </UsageTotalsStrip>
}

function readAge(readAt: number): string {
  const minutes = Math.max(0, Math.floor((Date.now() - readAt) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  if (minutes < 1440) return `${Math.floor(minutes / 60)} h ago`
  return `${Math.floor(minutes / 1440)} days ago`
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
    <UsageBreakdownSection>
      <UsageBreakdownHeading>
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
      </UsageBreakdownHeading>

      <UsageBreakdownFrame data-testid="usage-breakdown">
        <Table
          variant="plain"
          aria-label="Usage breakdown"
          rows={rows.map((row, index) => ({ ...row, rank: index + 1 }))}
          getRowId={(row) => row.id}
          empty={{ heading: loading ? 'Reading transcripts…' : 'No activity in this window.', description: '' }}
          columns={[
            { key: 'rank', header: '#', width: 'var(--w-usage-rank)', tone: 'faint' },
            { key: 'id', header: mode === 'model' ? 'Model' : 'Day', render: (id, row) => {
              const mark = row.provider ? PROVIDER_MARK[row.provider] : null
              return mode === 'model'
                ? <UsageModelCell mark={mark} name={String(id)} share={row.share} color={row.provider ? PROVIDER_COLOR[row.provider] : 'var(--text-muted)'} />
                : <span>{id}</span>
            } },
            { key: 'cost', header: 'Cost', width: 'var(--w-usage-cost)', numeric: true, weight: 'regular', render: (cost, row) => row.unpriced ? <Tooltip label="No published rate for this model"><span>not priced</span></Tooltip> : formatUsd(Number(cost)) },
            { key: 'share', header: 'Share', width: 'var(--w-usage-share)', numeric: true, tone: 'muted', render: (share) => formatShare(Number(share)) },
            { key: 'tokens', header: 'Tokens', width: 'var(--w-usage-tokens)', numeric: true, tone: 'muted', render: (tokens) => formatTokens(Number(tokens)) }
          ]}
        />
      </UsageBreakdownFrame>
    </UsageBreakdownSection>
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
  const scanStartSummary = useRef(summary)
  const scanWorkspace = useRef<string | null>(null)
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
    scanStartSummary.current = summary
    scanWorkspace.current = selectedWorkspace === 'all' ? null : selectedWorkspace
    setAsked({ sinceMs, untilMs })
    setSelectedDay(null)
    onRequest(sinceMs, untilMs, false, selectedWorkspace === 'all' ? null : selectedWorkspace)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowId, selectedWorkspace])

  useEffect(() => {
    if (!summary || summary === scanStartSummary.current) return
    const now = Date.now()
    onActivityRequest(calendarStartMs(now), now, scanWorkspace.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summary])

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
      : { timeZone, weekday: 'short', day: 'numeric' }
    try {
      return new Intl.DateTimeFormat('en-US', opts).format(new Date(windowDef.hourly ? point.startMs : `${point.key}T12:00:00`))
    } catch {
      return ''
    }
  }

  const refresh = (): void => {
    const { sinceMs, untilMs } = windowRange(windowDef, Date.now())
    scanStartSummary.current = summary
    scanWorkspace.current = selectedWorkspace === 'all' ? null : selectedWorkspace
    setAsked({ sinceMs, untilMs })
    onRequest(sinceMs, untilMs, true, selectedWorkspace === 'all' ? null : selectedWorkspace)
  }

  const stale =
    loading && summary !== null && asked !== null && summary.until_ms - summary.since_ms !== asked.untilMs - asked.sinceMs

  const sessions = [...sessionsByProvider.values()].reduce((sum, count) => sum + count, 0)
  const noUsage = !stale && summary !== null && sessions === 0
  const rangeLabel = usageRangeLabel(stale, summary, asked, timeZone)

  return (
    <div className="h-full min-h-0 w-full overflow-y-auto" data-testid="nav-surface" data-page="usage">
      <PageFrame width="wide" scroll={false} padding="page">
      <PageHeader heading="Usage" description="What your Claude Code and Codex sessions on this machine would cost at API prices. Houston reads their transcripts locally; nothing is sent anywhere." actions={
        <>
          <Select aria-label="Usage workspace" data-testid="usage-workspace" value={selectedWorkspace} options={[{ value: 'all', label: 'All workspaces' }, ...workspaces.map((workspace) => ({ value: workspace.path, label: workspace.name }))]} onChange={setSelectedWorkspace} />
          <Segmented aria-label="Window" size="xs" options={USAGE_WINDOWS.map((w) => ({ value: w.id, label: w.id === '24h' ? '24 hours' : w.label }))} value={windowId} onChange={setWindowId} />
          <Tooltip label="Read transcripts again"><Button variant="icon" aria-label="Refresh usage" data-testid="usage-refresh" onClick={refresh} disabled={loading} icon={IconRefresh} /></Tooltip>
        </>
      } />
      <UsageMetaLine range={rangeLabel.replace(' to ', ' – ')} readAge={summary ? readAge(summary.read_at_ms) : null} duration={summary ? `${(summary.scan_duration_ms / 1000).toFixed(1)} s` : null} reading={loading || !summary && !error} pricing={summary?.pricing.fetched_at_ms ? `Prices from the model catalog, updated ${new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(summary.pricing.fetched_at_ms)}` : 'Model catalog prices unavailable'} />
      {error && (
        <Notice tone="danger" data-testid="usage-error">
          {error}
        </Notice>
      )}

      {}
      <UsageBody stale={stale}>
        {!summary ? (
          <Text as="p" role="status" size="ui" tone="secondary">{error ? 'No usage result available.' : 'Reading transcripts…'}</Text>
        ) : noUsage ? (
          <EmptyState
            headline="No usage recorded yet"
            description="Houston hasn't scanned any Claude Code or Codex sessions in this window."
            action={{ label: 'Refresh', onClick: refresh }}
            icon={<Icon glyph={IconChartArea} role="display" />}
          />
        ) : (
          <>
        {}
        <UsageStats totals={totals} sessions={sessions} days={windowDef.days} />
        {totals.unpricedRecords > 0 && <Notice tone="warn">{totals.unpricedRecords} records have no published model rate. Their tokens are included; their cost is not priced.</Notice>}
        <UsageDailyChart
          metric={metric}
          onMetricChange={setMetric}
          hourly={windowDef.hourly}
          points={points}
          series={series}
          labelFor={labelFor}
        />
        <UsageProviderList>{displayProviders.map((p) => <UsageProviderRow key={p.provider} mark={PROVIDER_MARK[p.provider]} label={p.label} sessions={p.sessions} amount={formatUsd(p.cost)} note={`${formatShare(p.costShare)} of cost · ${formatTokens(p.tokens)} tokens`} color={PROVIDER_COLOR[p.provider]} />)}</UsageProviderList>

        {}
        <UsageCalendarSectionFrame data-testid="usage-calendar-section">
          <div className="flex items-center justify-between gap-[var(--space-3)]">
            <UsageSectionHeading fullWidth aside="Follows Cost | Tokens">{activitySummary(metric, activity)}</UsageSectionHeading>
          </div>
          <UsageCalendar days={activity} metric={metric} selectedDay={selectedDay} caption="Houston keeps one total per day, so days older than the transcripts still count. Click a day to see its breakdown." onSelect={(day) => { setSelectedDay((current) => current === day ? null : day); setMode('day') }} />
        </UsageCalendarSectionFrame>

        {metric === 'cost' && totals.tokens > 0 && <UsageShareGroup>
          <UsageShareBar heading="Cost by type" segments={categoryTotals(buckets)} />
          <UsageShareBar heading="Cost by speed" aside={`Premium ${formatUsd(buckets.reduce((sum, bucket) => sum + bucket.speed_premium_usd, 0))}`} segments={speedTotals(buckets)} />
        </UsageShareGroup>}

        {}
        <UsageBreakdown mode={mode} onModeChange={setMode} rows={dayBreakdown(rows, selectedDay, activity)} loading={loading} />
          </>
        )}

        {}
      </UsageBody>
      </PageFrame>
    </div>
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
