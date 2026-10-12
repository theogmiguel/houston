import { Fragment, useEffect, useMemo, useRef, useState } from 'react'

import { IconChartArea, IconFolder, IconRefresh } from './icons'
import { EmptyState } from './ui/EmptyState'
import { StatusLabel } from './ui/StatusLabel'
import { Segmented } from './ui/SegmentedControl'
import { UsageChart, UsageLegend, type UsageSeries } from './ui/UsageChart'
import type { ServerMsg } from '../houston/generated/ServerMsg'
import type { AgentKind } from '../houston/generated/AgentKind'
import { UsageAgentMark, UsageShareCell, UsageSourceRow } from './ui/UsageProviderRow'
import type { UsageSource } from '../houston/generated/UsageSource'
import type { UsageProvider } from '../houston/generated/UsageProvider'
import {
  breakdownRows,
  foldSeries,
  makeDayKey,
  formatRange,
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
import { Tooltip } from './ui/Tooltip'
import { Select } from './ui/Select'
import { Icon } from './ui/Icon'
import { Button, Table, UsageCalendar, UsageModelCell, UsageProviderRow, UsageSectionHeading, UsageShareBar, Text, UsageBody, UsageBreakdownHeading, UsageBreakdownSection, UsageShareGroup } from './ui'
import { Card } from './ui/Card'
import { PageFrame } from './ui/PageFrame'
import { PageHeader } from './ui/PageHeader'
import { Notice } from './ui/Notice'
import { UsageMetaLine, UsageStatCard, UsageChartHeader, UsageTotalsStrip, UsageCardNote, UsageDayFilter, UsageBreakdownActions, UsageSourcesLine } from './ui/UsageChrome'
import { calendarStartMs } from './ui/UsageCalendar'
import type { UsageActivityDay } from '../houston/generated/UsageActivityDay'

export type UsageSummaryMsg = Extract<ServerMsg, { type: 'usage_summary' }>

const PROVIDER_COLOR: Record<UsageProvider, string> = {
  claude: 'var(--claude)',
  codex: 'color-mix(in srgb, var(--text-primary) 55%, transparent)'
}

function UsageDailyChart({ metric, onMetricChange, hourly, points, series, labelFor, costAvailable }: {
  metric: 'cost' | 'tokens'
  onMetricChange: (metric: 'cost' | 'tokens') => void
  hourly: boolean
  costAvailable: boolean
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
      {metric === 'cost' && !costAvailable ? <Text as="p" size="small" tone="muted" flush>Cost per day is unavailable without published model rates. Tokens are still counted.</Text> : <UsageChart points={points} series={series} metric={metric} labelFor={labelFor} />}
    </div>
  </Card>
}

function UsageStats({ totals, sessions, days }: { totals: UsageTotals; sessions: number; days: number }): React.JSX.Element {
  const roundedUsd = (value: number): string => `$${Math.round(value).toLocaleString('en-US')}`
  return <UsageTotalsStrip>
    <UsageStatCard label="API-equivalent cost" value={totals.records > 0 && totals.unpricedRecords === totals.records ? 'Not priced' : formatUsd(totals.cost)} note={totals.records > 0 && totals.unpricedRecords === totals.records ? `${sessions.toLocaleString('en-US')} sessions · model rates unavailable` : `${sessions.toLocaleString('en-US')} sessions · ${roundedUsd(totals.cost / days)} a day`} headline />
    <UsageStatCard label="Tokens processed" value={formatTokens(totals.tokens)} note={`${Math.round(100 * totals.cachedInput / Math.max(1, totals.tokens))}% read from cache`} />
    <UsageStatCard label="Output tokens" value={formatTokens(totals.output)} note={`${formatTokens(totals.uncachedInput)} uncached input`} />
    <UsageStatCard label="Saved by caching" value={totals.records > 0 && totals.unpricedRecords === totals.records ? '—' : roundedUsd(Math.floor(totals.cacheSavings))} note="against full input prices" />
  </UsageTotalsStrip>
}

type DisplayProvider = ReturnType<typeof providerSummaries>[number] & { sessions: number; amount: string; note: string; share: number | null }

function UsageAgentsAndCosts({ providers, untracked, buckets, totals, costAvailable }: {
  providers: DisplayProvider[]
  untracked: AgentKind[]
  buckets: UsageSummaryMsg['buckets']
  totals: UsageTotals
  costAvailable: boolean
}): React.JSX.Element {
  return (
        <UsageShareGroup>
        <Card shape="card" tone="block" data-material="inset" data-testid="usage-by-agent">
          <UsageSectionHeading inset>By agent</UsageSectionHeading>
          {providers.map((p) => <UsageProviderRow key={p.provider} mark={<UsageAgentMark agent={p.provider} />} label={p.label} sessions={p.sessions} amount={p.amount} note={p.note} share={p.share} color={PROVIDER_COLOR[p.provider]} />)}
          {untracked.length > 0 && <UsageCardNote>Not counted: {joinAgentNames(untrackedAgentNames(untracked))}. They do not write token counts Houston can read.</UsageCardNote>}
        </Card>
        <Card shape="card" tone="block" padding="page" data-material="inset">
          {costAvailable ? <UsageShareBar heading="Where the cost goes" segments={categoryTotals(buckets)} note={<>{buckets.length > 0 && buckets.every((bucket) => bucket.speed_rate_available) && <>Fast and Ultrafast modes added {formatUsd(buckets.reduce((sum, bucket) => sum + bucket.speed_premium_usd, 0))}. </>}Caching saved {formatUsd(totals.cacheSavings)} against full input prices.</>} /> : <><UsageSectionHeading>Where the cost goes</UsageSectionHeading><Text as="p" size="small" tone="muted">Cost categories are unavailable without published model rates.</Text></>}
        </Card>
        </UsageShareGroup>
  )
}

function untrackedAgentNames(agents: AgentKind[]): string[] {
  const order: AgentKind[] = ['opencode', 'cursor', 'grok', 'antigravity', 'zcode', 'droid', 'copilot', 'aider', 'custom', 'claude', 'codex', 'shell', 'ssh']
  const names: Partial<Record<AgentKind, string>> = { opencode: 'OpenCode', zcode: 'ZCode', claude: 'Claude Code', ssh: 'SSH' }
  return order.filter((agent) => agents.includes(agent)).map((agent) => names[agent] ?? agent[0].toUpperCase() + agent.slice(1))
}

function joinAgentNames(names: string[]): string {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

function readAge(readAt: number): string {
  const minutes = Math.max(0, Math.floor((Date.now() - readAt) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  if (minutes < 1440) return `${Math.floor(minutes / 60)} h ago`
  return `${Math.floor(minutes / 1440)} days ago`
}

function orderedSources(sources: UsageSource[]): UsageSource[] {
  return [...sources].sort((a, b) => a.provider === b.provider ? 0 : a.provider === 'claude' ? -1 : 1)
}

function sourceStatus(source: UsageSource): string {
  if (source.status === 'missing') return 'Folder not found'
  if (source.status === 'failed') return 'Could not read transcripts'
  if (source.status === 'partial') return `Scan incomplete · ${source.failed_files} files could not be read`
  return source.distinct_sessions === 0 ? 'No sessions in this window' : `${source.distinct_sessions.toLocaleString('en-US')} sessions`
}

function UsageSources({ sources }: { sources: UsageSource[] }): React.JSX.Element {
  const ordered = orderedSources(sources)
  return <UsageSourcesLine>
    Read from {ordered.map((source, index) => <Fragment key={`${source.provider}:${source.path}`}>
      {index > 0 && (index === ordered.length - 1 ? ' and ' : ', ')}<Text mono>{source.path}</Text> ({source.status === 'ok' ? `${source.distinct_sessions.toLocaleString('en-US')} sessions` : sourceStatus(source)}){source.status !== 'ok' && source.message && <> · {source.message}</>}
    </Fragment>)}. Costs are estimates at API list prices; a subscription is billed differently.
  </UsageSourcesLine>
}

function UsageEmpty({ summary, windowLabel }: { summary: UsageSummaryMsg; windowLabel: string }): React.JSX.Element {
  const names = untrackedAgentNames(summary.untracked_agents)
  return <Card shape="card" tone="block" data-material="inset" data-testid="usage-empty">
    <EmptyState copy="summary" icon={IconChartArea} heading={`No sessions in the last ${windowLabel}`} description="Usage appears after a Claude Code or Codex session writes its transcript. Older days are in the 30 and 90 day windows." />
    {orderedSources(summary.sources).map((source) => <UsageSourceRow key={`${source.provider}:${source.path}`} mark={<UsageAgentMark agent={source.provider} />} label={`${source.provider === 'claude' ? 'Claude Code' : 'Codex'}${source.profile_name ? ` · ${source.profile_name}` : ''}`} description={<Text mono>{source.path}</Text>} status={<StatusLabel variant="detail" status={source.status === 'failed' ? 'Failed' : source.status === 'missing' ? 'Missing' : 'Ready'} tone={source.status === 'missing' || source.status === 'partial' ? 'waiting' : source.status === 'failed' ? 'failed' : 'unknown'}>{sourceStatus(source)}</StatusLabel>} message={source.message} />)}
    {names.length > 0 && <UsageSourceRow mark={<UsageAgentMark agent="opencode" inactive />} label={names.join(', ')} description="They do not write token counts Houston can read." status={<StatusLabel variant="detail" status="Off">Not counted</StatusLabel>} />}
  </Card>
}

function UsageBreakdown({
  mode,
  onModeChange,
  rows,
  loading,
  selectedDay,
  onClearDay,
  retainedDay
}: {
  mode: BreakdownMode
  onModeChange: (mode: BreakdownMode) => void
  rows: (BreakdownRow & { sessions: number | null })[]
  loading: boolean
  selectedDay: string | null
  onClearDay: () => void
  retainedDay?: UsageActivityDay
}): React.JSX.Element {
  return (
    <UsageBreakdownSection>
      <UsageBreakdownHeading>
        <UsageSectionHeading>Breakdown</UsageSectionHeading>
        <UsageBreakdownActions>
          {selectedDay && <UsageDayFilter label={new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(`${selectedDay}T12:00:00`))} onClear={onClearDay} />}
          <Segmented aria-label="Breakdown" size="xs" options={[{ value: 'model', label: 'By model' }, { value: 'day', label: 'By day' }]} value={mode} onChange={onModeChange} />
        </UsageBreakdownActions>
      </UsageBreakdownHeading>

      <Card shape="card" tone="block" data-material="inset" data-testid="usage-breakdown">
        <Table
          variant="inset"
          aria-label="Usage breakdown"
          rows={rows}
          getRowId={(row) => row.provider ? `${row.provider}:${row.id}` : row.id}
          empty={{ heading: retainedDay && mode === 'model' ? 'Model details no longer available for this day' : loading ? 'Reading transcripts…' : 'No activity in this window.', description: retainedDay ? `Daily total: ${formatUsd(retainedDay.cost_usd)}. The source transcripts are no longer on disk.` : '' }}
          columns={[
            { key: 'id', header: mode === 'model' ? 'Model' : 'Day', render: (id, row) => mode === 'model' ? <UsageModelCell mark={row.provider ? <UsageAgentMark agent={row.provider} /> : null} name={String(id)} /> : <Text size="ui" tone="secondary">{String(id)}</Text> },
            { key: 'sessions', header: 'Sessions', width: '80px', numeric: true, tone: 'muted', render: (sessions) => sessions === null ? '—' : Number(sessions).toLocaleString('en-US') },
            { key: 'tokens', header: 'Tokens', width: '80px', numeric: true, tone: 'muted', render: (tokens) => formatTokens(Number(tokens)) },
            { key: 'cost', header: 'Cost', width: '100px', numeric: true, render: (cost, row) => row.unpriced ? <Tooltip label="No published rate for this model"><span>not priced</span></Tooltip> : formatUsd(Number(cost)) },
            { key: 'share', header: 'Share', width: '160px', render: (share, row) => row.unpriced ? <Text size="small" tone="muted">—</Text> : <UsageShareCell share={Number(share)} color={row.provider ? PROVIDER_COLOR[row.provider] : 'var(--text-muted)'} /> }
          ]}
        />
      </Card>
    </UsageBreakdownSection>
  )
}

function usageRangeLabel(
  summary: UsageSummaryMsg | null,
  asked: { sinceMs: number; untilMs: number } | null,
  timeZone: string
): string {
  if (!summary) {
    return asked
      ? `${formatRange(asked.sinceMs, asked.untilMs, timeZone)} · reading transcripts…`
      : 'Reading transcripts…'
  }
  return formatRange(summary.since_ms, summary.until_ms, timeZone)
}

function pricingMetadata(summary: UsageSummaryMsg | null): string {
  if (!summary) return 'Prices from the model catalog'
  if (summary.pricing.status === 'unavailable' || !summary.pricing.fetched_at_ms) return 'Model catalog prices unavailable'
  return `Prices from the model catalog, updated ${new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(summary.pricing.fetched_at_ms)}`
}

function UsageMetadata({ summary, asked, timeZone, reading }: {
  summary: UsageSummaryMsg | null
  asked: { sinceMs: number; untilMs: number } | null
  timeZone: string
  reading: boolean
}): React.JSX.Element {
  return <UsageMetaLine range={usageRangeLabel(summary, asked, timeZone).replace(' to ', ' – ')} readAge={summary ? readAge(summary.read_at_ms) : null} duration={summary ? `${(summary.scan_duration_ms / 1000).toFixed(1)} s` : null} reading={reading} pricing={pricingMetadata(summary)} />
}

function UsageScanNotices({ summary, error }: { summary: UsageSummaryMsg | null; error: string | null }): React.JSX.Element {
  return <>
    {error && <Notice tone="danger" data-testid="usage-error">{error}</Notice>}
    {summary?.pricing.message && <Notice tone="warn">{summary.pricing.message}</Notice>}
  </>
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
  const displayProviders = providers.map((provider) => {
    const observed = buckets.filter((bucket) => bucket.provider === provider.provider)
    const unpriced = observed.length > 0 && observed.every((bucket) => bucket.records > 0 && bucket.unpriced_records === bucket.records)
    const unreadSource = summary?.sources.find((source) => source.provider === provider.provider && source.status !== 'ok')
    return { ...provider, sessions: sessionsByProvider.get(provider.provider) ?? 0, amount: unpriced ? 'Not priced' : observed.length === 0 && unreadSource ? '—' : formatUsd(provider.cost), note: observed.length === 0 && unreadSource ? sourceStatus(unreadSource) : `${formatTokens(provider.tokens)} tokens`, share: unpriced ? null : provider.costShare }
  })

  const selectedBuckets = useMemo(() => selectedDay ? buckets.filter((bucket) => makeDayKey(timeZone)(bucket.hour_start_ms) === selectedDay) : buckets, [buckets, selectedDay, timeZone])
  const retainedDay = selectedDay && selectedBuckets.length === 0 ? activity.find((day) => day.day === selectedDay) : undefined
  const rows = useMemo(() => {
    const grouped = breakdownRows(selectedBuckets, mode, timeZone)
    const displayed = mode === 'day' ? dayBreakdown(grouped, selectedDay, activity) : grouped
    return displayed.map((row) => {
      const model = summary?.session_counts?.models.find((item) => item.provider === row.provider && item.model === row.id)
      const sessions = mode === 'day'
        ? summary?.session_counts?.days.find((day) => day.day === row.id)?.sessions
        : selectedDay ? model?.days.find((day) => day.day === selectedDay)?.sessions : model?.sessions
      return { ...row, sessions: sessions ?? null }
    })
  }, [selectedBuckets, mode, timeZone, selectedDay, activity, summary])

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

  const reading = loading || !summary && !error

  const costAvailable = totals.records === 0 || totals.unpricedRecords < totals.records
  const sessions = [...sessionsByProvider.values()].reduce((sum, count) => sum + count, 0)
  const noUsage = summary !== null && sessions === 0

  return (
    <div className="h-full min-h-0 w-full overflow-y-auto" data-testid="nav-surface" data-page="usage">
      <PageFrame width="wide" scroll={false} padding="page">
      <PageHeader heading="Usage" description="What your Claude Code and Codex sessions on this machine would cost at API prices. Houston reads their transcripts locally; nothing is sent anywhere." actions={
        <>
          <Select prefix={<Icon glyph={IconFolder} role="ui" />} aria-label="Usage workspace" data-testid="usage-workspace" value={selectedWorkspace} options={[{ value: 'all', label: 'All workspaces' }, ...workspaces.map((workspace) => ({ value: workspace.path, label: workspace.name }))]} onChange={setSelectedWorkspace} />
          <Segmented aria-label="Window" size="xs" options={USAGE_WINDOWS.map((w) => ({ value: w.id, label: w.id === '24h' ? '24 hours' : w.label }))} value={windowId} onChange={setWindowId} />
          <Tooltip label="Read transcripts again"><Button variant="icon" aria-label="Refresh usage" data-testid="usage-refresh" onClick={refresh} disabled={loading} icon={IconRefresh} /></Tooltip>
        </>
      } />
      <UsageMetadata summary={summary} asked={asked} timeZone={timeZone} reading={reading} />
      <UsageScanNotices summary={summary} error={error} />
      <UsageBody reading={reading}>
        {!summary ? (
          <Text as="p" role="status" size="ui" tone="secondary">{error ? 'No usage result available.' : 'Reading transcripts…'}</Text>
        ) : noUsage ? (
          <UsageEmpty summary={summary} windowLabel={windowDef.id === '24h' ? '24 hours' : windowDef.label} />
        ) : (
          <>
        <UsageStats totals={totals} sessions={sessions} days={windowDef.days} />
        {totals.unpricedRecords > 0 && <Notice tone="warn">{totals.unpricedRecords} records have no published model rate. Their tokens are included; their cost is not priced.</Notice>}
        <UsageDailyChart
          metric={metric}
          onMetricChange={setMetric}
          hourly={windowDef.hourly}
          costAvailable={costAvailable}
          points={points}
          series={series}
          labelFor={labelFor}
        />
        <UsageAgentsAndCosts providers={displayProviders} untracked={summary.untracked_agents} buckets={buckets} totals={totals} costAvailable={costAvailable} />

        <Card shape="card" tone="block" padding="page" data-material="inset" data-testid="usage-calendar-section">
          <UsageCalendar days={activity} metric="cost" selectedDay={selectedDay} caption="Pick a day to see its breakdown below. Days older than the transcripts on disk keep their daily total." onSelect={(day) => setSelectedDay((current) => current === day ? null : day)} />
        </Card>

        <UsageBreakdown mode={mode} onModeChange={setMode} rows={rows} loading={loading} selectedDay={selectedDay} onClearDay={() => setSelectedDay(null)} retainedDay={retainedDay} />
        <UsageSources sources={summary.sources} />
          </>
        )}

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
    { id: 'cache-read', label: 'Cache read', value: buckets.reduce((sum, bucket) => sum + bucket.category_cost_usd.cache_read_usd, 0) },
    { id: 'cache-write', label: 'Cache write', value: buckets.reduce((sum, bucket) => sum + bucket.category_cost_usd.cache_write_usd, 0) },
    { id: 'output', label: 'Output', value: buckets.reduce((sum, bucket) => sum + bucket.category_cost_usd.output_usd, 0) },
    { id: 'input', label: 'Input', value: buckets.reduce((sum, bucket) => sum + bucket.category_cost_usd.input_usd, 0) },
    { id: 'other', label: 'Other', value: buckets.reduce((sum, bucket) => sum + bucket.category_cost_usd.other_usd, 0) }
  ].filter((segment) => segment.id !== 'other' || segment.value > 0)
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
