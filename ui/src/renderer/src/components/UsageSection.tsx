import { useEffect, useMemo, useState } from 'react'

import { IconChartArea, IconInfo, IconRefresh } from './icons'
import { EmptyState } from './ui/ActionEmptyState'
import { Segmented } from './ui/SegmentedControl'
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
import { Icon } from './ui/Icon'
import { Tooltip } from './ui/Tooltip'
import { Select } from './ui/Select'
import { Button, Table, UsageCalendar, UsageModelCell, UsageProviderRow, UsageSectionHeading, UsageShareBar, Text, UsageToolbar, UsageContentFrame, UsageStatCell, UsageHeroValue, UsageHeroCaption, UsageChartHeading, UsageBody, UsageError, UsageProviderList, UsageChartHeader, UsageTotalsStrip, UsageTotalsSection, UsageCalendarSectionFrame, UsageBreakdownHeading, UsageBreakdownSection, UsageBreakdownFrame, UsageShareGroup, UsageHeroLayout, UsageHeroColumn, UsageHeroSummary, UsageToolbarActions } from './ui'
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
    <UsageHeroLayout>
      <UsageHeroColumn>
        <UsageHeroSummary>
          <UsageHeroValue data-testid="usage-headline">
            {heroValue}
          </UsageHeroValue>
          <UsageHeroCaption>
            {sessions.toLocaleString('en-US')} sessions · {metric === 'cost' ? 'API estimate' : 'processed tokens'}
            {metric === 'cost' && <Tooltip label="Estimated at the published full API rate. Subscriptions are billed separately."><span aria-label="API estimate details" role="img"><Icon glyph={IconInfo} role="small" /></span></Tooltip>}
          </UsageHeroCaption>
        </UsageHeroSummary>

        <UsageProviderList>
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
        </UsageProviderList>
      </UsageHeroColumn>

      <UsageHeroColumn>
        <UsageChartHeader>
          <UsageChartHeading>
            {windowDef.hourly ? 'Hourly' : 'Daily'} {metric === 'cost' ? 'cost' : 'processed tokens'}
          </UsageChartHeading>
        </UsageChartHeader>
        <UsageChart points={points} series={series} metric={metric} labelFor={labelFor} />
      </UsageHeroColumn>
    </UsageHeroLayout>
  )
}

function UsageTokenStrip({ totals }: { totals: UsageTotals }): React.JSX.Element {
  return (
    <UsageTotalsStrip>
      <UsageStatCell
        label="Processed tokens"
        value={formatTokens(totals.tokens)}
        note={
          totals.activeDays > 0
            ? `${formatTokens(totals.tokens / totals.activeDays)} per active day`
            : 'no active days in this window'
        }
      />
      <UsageStatCell
        label="Cached input"
        value={formatTokens(totals.cachedInput)}
        note={`${formatShare(
          totals.cachedInput / Math.max(1, totals.cachedInput + totals.uncachedInput + totals.cacheCreation)
        )} of observed input`}
      />
      <UsageStatCell
        label="Uncached input"
        value={formatTokens(totals.uncachedInput)}
        note={`${formatTokens(totals.cacheCreation)} cache writes`}
      />
      <UsageStatCell
        label="Output"
        value={formatTokens(totals.output)}
        note={
          totals.reasoning > 0
            ? `includes ${formatTokens(totals.reasoning)} reasoning`
            : 'no reasoning tokens reported'
        }
      />
      <UsageStatCell
        label="Cache savings"
        value={formatUsd(totals.cacheSavings)}
        note={
          totals.cost > 0
            ? `${(totals.cacheSavings / totals.cost).toFixed(1)}× the raw token cost`
            : 'nothing priced in this window'
        }
      />
    </UsageTotalsStrip>
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
      <UsageToolbar>
        <Text as="h1" size="ui" weight="semibold" tone="primary" flush>Usage</Text>
        <Text tone="faint">/</Text>
        <Select
          aria-label="Usage workspace"
          data-testid="usage-workspace"
          value={selectedWorkspace}
          options={[{ value: 'all', label: 'All workspaces' }, ...workspaces.map((workspace) => ({ value: workspace.path, label: workspace.name }))]}
          onChange={setSelectedWorkspace}
        />
        <Text data-testid="usage-range" size="small" tone="muted" tabular>{rangeLabel}</Text>
        <UsageToolbarActions>
          <Segmented aria-label="Usage metric" options={[
            { value: 'cost', label: 'Cost' }, { value: 'tokens', label: 'Tokens' },
            { value: 'limits', label: 'Limits', disabled: true, disabledReason: 'A quota reader is not available yet' }
          ]} value={metric} onChange={(value) => { if (value !== 'limits') setMetric(value) }} />
          <Segmented aria-label="Usage window" options={USAGE_WINDOWS.map((w) => ({ value: w.id, label: w.label }))} value={windowId} onChange={setWindowId} />
          <Tooltip label="Re-scan usage">
            <Button variant="icon" aria-label="Refresh usage" data-testid="usage-refresh" onClick={refresh} disabled={loading} icon={IconRefresh} />
          </Tooltip>
        </UsageToolbarActions>
      </UsageToolbar>

      <UsageContentFrame>
      {error && (
        <UsageError>
          {error}
        </UsageError>
      )}

      {}
      <UsageBody stale={stale}>
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
        <UsageTotalsSection data-testid="usage-totals">
          <UsageSectionHeading>Totals</UsageSectionHeading>
          <UsageTokenStrip totals={totals} />
        </UsageTotalsSection>

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
      </UsageContentFrame>
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
