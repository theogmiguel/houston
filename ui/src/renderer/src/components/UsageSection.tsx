import { useEffect, useMemo, useState } from 'react'

import { IconAgentClaude, IconAgentCodex, IconChartArea, IconRefresh, type IconComponent } from './icons'
import { CONTROL_SIZE_SQUARE_CLS } from './controlSize'
import { EmptyState } from './EmptyState'
import { Segmented } from './Segmented'
import { UsageChart, type UsageSeries } from './UsageChart'
import type { AgentKind } from '../houston/generated/AgentKind'
import type { ServerMsg } from '../houston/generated/ServerMsg'
import type { UsageProvider } from '../houston/generated/UsageProvider'
import type { UsageSource } from '../houston/generated/UsageSource'
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
import { ICON_ROLE_CLS, Icon } from './Icon'
import { Tooltip } from './Tooltip'

export type UsageSummaryMsg = Extract<ServerMsg, { type: 'usage_summary' }>

const PROVIDER_COLOR: Record<UsageProvider, string> = {
  claude: 'var(--accent)',
  codex: 'var(--warn)'
}

const PROVIDER_ICON: Record<UsageProvider, IconComponent> = {
  claude: IconAgentClaude,
  codex: IconAgentCodex
}

const AGENT_LABEL: Partial<Record<AgentKind, string>> = {
  antigravity: 'Antigravity',
  opencode: 'opencode',
  cursor: 'Cursor',
  grok: 'Grok',
  droid: 'Droid',
  copilot: 'Copilot',
  aider: 'Aider'
}

function CapsLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="text-[length:var(--tr-text-label-size)] font-[var(--tr-text-label-weight)] tracking-[var(--tr-text-label-tracking)] uppercase text-[var(--text-muted)]">
      {children}
    </div>
  )
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
    <div className="min-w-0 px-[var(--space-4)] py-[var(--space-3)] first:pl-0 last:pr-0 border-l border-[var(--border)] first:border-l-0">
      <div className="[font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-muted)]">{label}</div>
      <div className="mt-[3px] text-[length:var(--tr-text-2xl)] font-semibold tracking-[-0.01em] tabular-nums text-[var(--text-primary)]">
        {value}
      </div>
      <div className="mt-[3px] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] leading-[1.45] text-[var(--text-faint)]">{note}</div>
    </div>
  )
}

function SourceRow({ source }: { source: UsageSource }): React.JSX.Element {
  const tone =
    source.status === 'ok'
      ? 'var(--ok)'
      : source.status === 'missing'
        ? 'var(--text-faint)'
        : 'var(--warn)'
  const detail =
    source.status === 'missing'
      ? (source.message ?? 'never used')
      : `${source.scanned_files.toLocaleString('en-US')} files · ${source.distinct_sessions.toLocaleString('en-US')} sessions${
          source.failed_files > 0 ? ` · ${source.failed_files} unreadable` : ''
        }`
  return (
    <div
      data-testid="usage-source"
      className="flex items-center gap-[var(--space-2)] border-t border-[var(--border)] py-[9px] first:border-t-0 text-[length:var(--tr-text-sm)]"
    >
      <span
        aria-hidden="true"
        className="h-[6px] w-[6px] shrink-0 rounded-full"
        style={{ background: tone }}
      />
      <Tooltip label={source.message ?? source.path}>
        <code className="truncate font-mono [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-primary)]">
          {source.path}
        </code>
      </Tooltip>
      <span className="ml-auto shrink-0 pl-[var(--space-3)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-faint)]">
        {source.profile_name ? `profile “${source.profile_name}” · ` : ''}
        {detail}
      </span>
    </div>
  )
}

function UsageHero({
  metric,
  onMetricChange,
  heroValue,
  sessions,
  providers,
  hidden,
  onToggleProvider,
  windowDef,
  points,
  series,
  labelFor
}: {
  metric: 'cost' | 'tokens'
  onMetricChange: (metric: 'cost' | 'tokens') => void
  heroValue: string
  sessions: number
  providers: ProviderSummary[]
  hidden: UsageProvider[]
  onToggleProvider: (provider: UsageProvider) => void
  windowDef: UsageWindowDef
  points: SeriesPoint[]
  series: UsageSeries[]
  labelFor: (point: SeriesPoint) => string
}): React.JSX.Element {
  return (
    <div className="grid grid-cols-1 gap-[var(--space-6)] lg:grid-cols-[minmax(0,300px)_minmax(0,1fr)]">
      <div className="min-w-0">
        <CapsLabel>{metric === 'cost' ? 'Raw token cost' : 'Processed tokens'}</CapsLabel>
        <div
          data-testid="usage-headline"
          className="mt-[var(--space-2)] text-[length:var(--tr-text-title-size)] font-[var(--tr-text-title-weight)] tracking-[var(--tr-text-title-tracking)] tabular-nums text-[var(--text-primary)]"
        >
          {heroValue}
          {metric === 'cost' && <span className="text-[var(--text-muted)]">*</span>}
        </div>
        <div className="mt-[var(--space-1)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] leading-[1.5] text-[var(--text-muted)]">
          {metric === 'cost' ? (
            <>
              * if billed at full API rate. A subscription bills a flat fee whatever this says.
            </>
          ) : (
            <>
              Input, cache reads and output across {sessions.toLocaleString('en-US')} sessions.
            </>
          )}
        </div>

        <div className="mt-[var(--space-5)] flex flex-col gap-[var(--space-4)]">
          {providers.map((p) => {
            const Icon = PROVIDER_ICON[p.provider]
            const share = metric === 'cost' ? p.costShare : p.tokenShare
            return (
              <div key={p.provider} data-testid={`usage-provider-${p.provider}`} className="min-w-0">
                <div className="flex items-baseline gap-[var(--space-2)]">
                  <span
                    className="shrink-0 translate-y-[2px]"
                    style={{ color: PROVIDER_COLOR[p.provider] }}
                  >
                    <Icon className={ICON_ROLE_CLS.body} />
                  </span>
                  <span className="truncate text-[length:var(--tr-text-md)] text-[var(--text-primary)]">
                    {p.label}
                  </span>
                  <span className="ml-auto shrink-0 tabular-nums text-[length:var(--tr-text-md)] font-medium text-[var(--text-primary)]">
                    {metric === 'cost' ? formatUsd(p.cost) : formatTokens(p.tokens)}
                  </span>
                </div>
                <div className="mt-[var(--space-2)] h-[3px] w-full overflow-hidden rounded-full bg-[var(--card-hover)]">
                  <span
                    className="block h-full rounded-full"
                    style={{
                      width: `${Math.max(share * 100, share > 0 ? 1.5 : 0)}%`,
                      background: PROVIDER_COLOR[p.provider]
                    }}
                  />
                </div>
                <div className="mt-[var(--space-2)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-faint)]">
                  {metric === 'cost'
                    ? `${formatShare(p.costShare)} of cost · ${formatTokens(p.tokens)} tokens`
                    : `${formatShare(p.tokenShare)} of tokens · ${formatUsd(p.cost)}`}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      <div className="min-w-0">
        <div className="mb-[var(--space-3)] flex flex-wrap items-center justify-between gap-[var(--space-2)]">
          <div className="text-[length:var(--tr-text-lg)] font-semibold tracking-[-0.006em] text-[var(--text-primary)]">
            {windowDef.hourly ? 'Hourly' : 'Daily'} {metric === 'cost' ? 'cost' : 'processed tokens'}
          </div>
          <div className="flex items-center gap-[var(--space-3)]">
            <Segmented
              aria-label="Chart metric"
              options={[
                { value: 'cost', label: 'Cost' },
                { value: 'tokens', label: 'Tokens' }
              ]}
              value={metric}
              onChange={onMetricChange}
            />
            {}
            <div className="flex items-center gap-[var(--space-2-5)]">
              {providers.map((p) => {
                const Icon = PROVIDER_ICON[p.provider]
                const on = !hidden.includes(p.provider)
                return (
                  <button
                    key={p.provider}
                    type="button"
                    data-testid={`usage-legend-${p.provider}`}
                    aria-pressed={on}
                    onClick={() => onToggleProvider(p.provider)}
                    className="btn border-0 flex items-center gap-[var(--space-1-5)] rounded-[var(--tr-radius-button)] px-[var(--space-1-5)] py-[2px] text-[length:var(--tr-text-sm)]"
                    style={{
                      color: on ? 'var(--text-primary)' : 'var(--text-faint)',
                      opacity: on ? 1 : 0.6
                    }}
                  >
                    <span style={{ color: on ? PROVIDER_COLOR[p.provider] : 'inherit' }}>
                      <Icon className={ICON_ROLE_CLS.ui} />
                    </span>
                    {p.label}
                  </button>
                )
              })}
            </div>
          </div>
        </div>
        <UsageChart points={points} series={series} metric={metric} labelFor={labelFor} />
      </div>
    </div>
  )
}

function UsageTokenStrip({ totals }: { totals: UsageTotals }): React.JSX.Element {
  return (
    <div className="mt-[var(--space-6)] grid grid-cols-2 border-y border-[var(--border)] py-[var(--space-3)] sm:grid-cols-3 lg:grid-cols-5">
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
        <div className="text-[length:var(--tr-text-lg)] font-semibold tracking-[-0.006em] text-[var(--text-primary)]">
          Breakdown
        </div>
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

      <table data-testid="usage-breakdown" className="mt-[var(--space-3)] w-full border-collapse">
        <thead>
          <tr className="text-[length:var(--tr-text-sm)] text-[var(--text-muted)]">
            <th className="py-[var(--space-2)] text-left font-normal">
              {mode === 'model' ? 'Model' : 'Day'}
            </th>
            <th className="py-[var(--space-2)] text-right font-normal">Cost</th>
            <th className="py-[var(--space-2)] text-right font-normal">Share</th>
            <th className="py-[var(--space-2)] text-right font-normal">Tokens</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td
                colSpan={4}
                className="border-t border-[var(--border)] py-[var(--space-5)] text-center text-[length:var(--tr-text-sm)] text-[var(--text-muted)]"
              >
                {loading ? 'Reading transcripts…' : 'Nothing was recorded in this window.'}
              </td>
            </tr>
          )}
          {rows.map((row) => {
            const Icon = row.provider ? PROVIDER_ICON[row.provider] : null
            return (
              <tr key={row.id} className="border-t border-[var(--border)]">
                <td className="py-[10px] pr-[var(--space-3)]">
                  <div className="flex min-w-0 items-center gap-[var(--space-2)]">
                    {Icon && (
                      <span
                        className="shrink-0"
                        style={{ color: PROVIDER_COLOR[row.provider as UsageProvider] }}
                      >
                        <Icon className={ICON_ROLE_CLS.ui} />
                      </span>
                    )}
                    <span className="truncate font-mono text-[length:var(--tr-text-sm)] text-[var(--text-primary)]">
                      {row.id}
                    </span>
                  </div>
                </td>
                <td className="py-[10px] text-right tabular-nums text-[length:var(--tr-text-sm)] text-[var(--text-primary)]">
                  {}
                  {row.unpriced ? (
                    <Tooltip label="No published rate for this model">
                      <span className="text-[var(--text-faint)]">not priced</span>
                    </Tooltip>
                  ) : (
                    formatUsd(row.cost)
                  )}
                </td>
                <td className="py-[10px] text-right tabular-nums text-[length:var(--tr-text-sm)] text-[var(--text-muted)]">
                  {formatShare(row.share)}
                </td>
                <td className="py-[10px] text-right tabular-nums text-[length:var(--tr-text-sm)] text-[var(--text-muted)]">
                  {formatTokens(row.tokens)}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </>
  )
}

function UsageProvenance({
  summary,
  untracked
}: {
  summary: UsageSummaryMsg
  untracked: string[]
}): React.JSX.Element {
  return (
    <>
      <div className="mt-[var(--space-6)] mb-[var(--space-2)] ml-[2px] text-[length:var(--tr-text-label-size)] font-[var(--tr-text-label-weight)] tracking-[var(--tr-text-label-tracking)] uppercase text-[var(--text-faint)]">
        Where these numbers came from
      </div>
      <div className="rounded-[10px] border border-[var(--border)] bg-[var(--card-bg)] px-[var(--space-4)] py-[2px]">
        {summary.sources.map((s) => (
          <SourceRow key={`${s.provider}:${s.path}`} source={s} />
        ))}
      </div>
      <p className="mx-[2px] mt-[var(--space-2-5)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] leading-[1.7] text-[var(--text-faint)]">
        {untracked.length > 0 && (
          <>
            Not tracked: {untracked.join(', ')} — Houston can run them but does not read their
            transcripts.{' '}
          </>
        )}
        {summary.pricing.status === 'unavailable'
          ? 'No model rate table is available, so every model is reported unpriced.'
          : `Rates from ${summary.pricing.known_models.toLocaleString('en-US')} models in LiteLLM's published table.`}
        {summary.pricing.message ? ` ${summary.pricing.message}` : ''} Scanned in{' '}
        {(summary.scan_duration_ms / 1000).toFixed(1)} s.
      </p>
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

function refreshButtonChrome(loading: boolean): {
  tooltipCls: string | undefined
  iconCls: string | undefined
} {
  return loading
    ? { tooltipCls: 'inline-flex', iconCls: 'animate-spin' }
    : { tooltipCls: undefined, iconCls: undefined }
}

export function UsageSection({
  summary,
  loading,
  error,
  onRequest
}: {
  summary: UsageSummaryMsg | null
  loading: boolean
  error: string | null
  onRequest: (sinceMs: number, untilMs: number, refreshPricing: boolean) => void
}): React.JSX.Element {
  const [windowId, setWindowId] = useState<UsageWindowId>('7d')
  const [metric, setMetric] = useState<'cost' | 'tokens'>('cost')
  const [mode, setMode] = useState<BreakdownMode>('model')
  const [hidden, setHidden] = useState<UsageProvider[]>([])
  const [asked, setAsked] = useState<{ sinceMs: number; untilMs: number } | null>(null)

  const windowDef = USAGE_WINDOWS.find((w) => w.id === windowId) ?? USAGE_WINDOWS[1]
  const timeZone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', [])

  useEffect(() => {
    const { sinceMs, untilMs } = windowRange(windowDef, Date.now())
    setAsked({ sinceMs, untilMs })
    onRequest(sinceMs, untilMs, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowId])

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
  const rows = useMemo(() => breakdownRows(buckets, mode, timeZone), [buckets, mode, timeZone])

  const series: UsageSeries[] = providers
    .filter((p) => !hidden.includes(p.provider))
    .map((p) => ({ provider: p.provider, label: p.label, color: PROVIDER_COLOR[p.provider] }))

  const labelFor = (point: SeriesPoint): string => {
    const opts: Intl.DateTimeFormatOptions = windowDef.hourly
      ? { timeZone, hour: 'numeric' }
      : { timeZone, month: 'short', day: 'numeric' }
    try {
      return new Intl.DateTimeFormat('en-US', opts).format(new Date(point.startMs))
    } catch {
      return ''
    }
  }

  const refresh = (): void => {
    const { sinceMs, untilMs } = windowRange(windowDef, Date.now())
    setAsked({ sinceMs, untilMs })
    onRequest(sinceMs, untilMs, true)
  }

  const stale =
    loading && summary !== null && asked !== null && summary.until_ms - summary.since_ms !== asked.untilMs - asked.sinceMs

  const heroValue = metric === 'cost' ? formatUsd(totals.cost) : formatTokens(totals.tokens)
  const sessions = (summary?.sources ?? []).reduce((a, s) => a + s.distinct_sessions, 0)
  const untracked = (summary?.untracked_agents ?? []).map((k) => AGENT_LABEL[k] ?? k)
  const noUsage = !stale && summary !== null && sessions === 0
  const rangeLabel = usageRangeLabel(stale, summary, asked, timeZone)
  const refreshChrome = refreshButtonChrome(loading)

  return (
    <div data-testid="settings-usage">
      <div className="mb-[var(--space-4)] flex flex-wrap items-center justify-between gap-[var(--space-3)]">
        <div
          data-testid="usage-range"
          className="text-[length:var(--tr-text-md)] text-[var(--text-muted)] tabular-nums"
        >
          {rangeLabel}
        </div>
        <div className="flex items-center gap-[var(--space-2)]">
          <Segmented
            aria-label="Usage window"
            options={USAGE_WINDOWS.map((w) => ({ value: w.id, label: w.label }))}
            value={windowId}
            onChange={(v) => setWindowId(v)}
          />
          <Tooltip
            label="Re-scan the transcripts and re-fetch the model rate table"
            className={refreshChrome.tooltipCls}
          >
            <button
              type="button"
              data-testid="usage-refresh"
              onClick={refresh}
              disabled={loading}
              aria-label="Refresh usage"
              className={`btn grid ${CONTROL_SIZE_SQUARE_CLS.regular} place-items-center rounded-[var(--tr-radius-button)] border border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] hover:text-[var(--text-primary)] disabled:opacity-50`}
            >
              <Icon glyph={IconRefresh} role="ui" className={refreshChrome.iconCls} />
            </button>
          </Tooltip>
        </div>
      </div>

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
        className={stale ? 'opacity-40 transition-opacity duration-150' : undefined}
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
          onMetricChange={setMetric}
          heroValue={heroValue}
          sessions={sessions}
          providers={providers}
          hidden={hidden}
          onToggleProvider={(provider) =>
            setHidden((prev) =>
              prev.includes(provider) ? prev.filter((x) => x !== provider) : [...prev, provider]
            )
          }
          windowDef={windowDef}
          points={points}
          series={series}
          labelFor={labelFor}
        />

        {}
        <UsageTokenStrip totals={totals} />

        {}
        <UsageBreakdown mode={mode} onModeChange={setMode} rows={rows} loading={loading} />
          </>
        )}

        {}
        {summary && <UsageProvenance summary={summary} untracked={untracked} />}
      </div>
    </div>
  )
}
