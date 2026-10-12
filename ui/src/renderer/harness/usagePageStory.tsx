import React, { useEffect, useMemo, useRef } from 'react'
import { UsageSection, type UsageSummaryMsg } from '../src/components/UsageSection'
import type { UsageActivityDay } from '../src/houston/generated/UsageActivityDay'
import type { UsageBucket } from '../src/houston/generated/UsageBucket'

const NOW = new Date(2026, 9, 11, 12).getTime()
const DAY = 86_400_000
const HOUR = 3_600_000
const DAILY_COST: Record<'claude' | 'codex', number[]> = {
  claude: [240, 300, 282, 331, 318, 362, 238.4],
  codex: [41, 48, 55, 52, 71, 79, 68.9]
}
const DAILY_TOKENS: Record<'claude' | 'codex', number[]> = {
  claude: [500, 610, 540, 680, 590, 700, 480].map((value) => value * 1_000_000),
  codex: [60, 68, 72, 64, 78, 84, 86].map((value) => value * 1_000_000)
}
const MODELS = {
  claude: [{ name: 'claude-opus-5-5', share: 1812.3 / 2071.4, tokenShare: 2.9 / 4.1, sessions: 96 }, { name: 'claude-sonnet-5-5', share: 259.1 / 2071.4, tokenShare: 1.2 / 4.1, sessions: 88 }],
  codex: [{ name: 'gpt-5.5-codex', share: 402.1 / 414.9, tokenShare: 498 / 512, sessions: 39 }, { name: 'gpt-5.5-codex-mini', share: 12.8 / 414.9, tokenShare: 14 / 512, sessions: 3 }]
}

function dayKey(ms: number): string {
  const date = new Date(ms)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function fixtureBuckets(): UsageBucket[] {
  return (['claude', 'codex'] as const).flatMap((provider) => DAILY_COST[provider].flatMap((cost, index) => MODELS[provider].map((model) => {
    const rowCost = cost * model.share
    const rowTokens = Math.round(DAILY_TOKENS[provider][index] * model.tokenShare)
    return {
      hour_start_ms: Math.floor((NOW - (6 - index) * DAY) / HOUR) * HOUR,
      provider,
      model: model.name,
      totals: { uncached_input_tokens: Math.round(rowTokens * (61 / 4608.8)), cached_input_tokens: Math.round(rowTokens * (4300 / 4608.8)), cache_creation_tokens: Math.round(rowTokens * (238 / 4608.8)), output_tokens: Math.round(rowTokens * (9.8 / 4608.8)), reasoning_tokens: 0 },
      cost_usd: rowCost,
      cache_savings_usd: rowCost * (18240.55 / 2486.3),
      cost_source: 'model_priced' as const,
      records: model.sessions * 3,
      unpriced_records: 0,
      sessions: model.sessions,
      workspace_path: null,
      category_cost_usd: { input_usd: rowCost * (112.4 / 2486.3), cache_read_usd: rowCost * (1021.7 / 2486.3), cache_write_usd: rowCost * (846.2 / 2486.3), output_usd: rowCost * (506 / 2486.3), other_usd: 0 },
      fast_cost_usd: rowCost * (200 / 2486.3),
      ultrafast_cost_usd: rowCost * (400 / 2486.3),
      speed_premium_usd: rowCost * (185.2 / 2486.3),
      speed_rate_available: true
    }
  })))
}

export function fixtureSummary(): UsageSummaryMsg {
  const days = Array.from({ length: 7 }, (_, index) => ({ day: dayKey(NOW - (6 - index) * DAY), sessions: 214 }))
  return {
    type: 'usage_summary', since_ms: new Date(2026, 9, 5).getTime(), until_ms: new Date(2026, 9, 11, 23, 59, 59, 999).getTime(),
    read_at_ms: Date.now() - 120_000,
    buckets: fixtureBuckets(),
    sources: [
      { provider: 'claude', path: '~/.claude/projects', profile_name: null, status: 'ok', scanned_files: 172, skipped_files: 0, failed_files: 0, distinct_sessions: 172, message: null },
      { provider: 'codex', path: '~/.codex/sessions', profile_name: null, status: 'ok', scanned_files: 42, skipped_files: 0, failed_files: 0, distinct_sessions: 42, message: null }
    ],
    session_counts: { models: (['claude', 'codex'] as const).flatMap((provider) => MODELS[provider].map((model) => ({ provider, model: model.name, sessions: model.sessions, days: days.map((day) => ({ ...day, sessions: model.sessions })) }))), days },
    pricing: { status: 'cached', source: 'LiteLLM', fetched_at_ms: new Date(2026, 9, 9, 12).getTime(), known_models: 1681, message: null },
    untracked_agents: ['antigravity', 'opencode', 'cursor', 'grok'], scan_duration_ms: 1200
  }
}

export function fixtureActivity(): UsageActivityDay[] {
  const recent = new Map<string, UsageActivityDay>()
  for (const bucket of fixtureBuckets()) {
    const day = dayKey(bucket.hour_start_ms)
    const entry = recent.get(day) ?? { day, cost_usd: 0, totals: { uncached_input_tokens: 0, cached_input_tokens: 0, cache_creation_tokens: 0, output_tokens: 0, reasoning_tokens: 0 } }
    entry.cost_usd += bucket.cost_usd
    for (const key of Object.keys(entry.totals) as (keyof UsageActivityDay['totals'])[]) entry.totals[key] += bucket.totals[key]
    recent.set(day, entry)
  }
  const values = Array.from({ length: 173 }, (_, index) => 100 + ((index * 37) % 420))
  const total = 20_591 - [...recent.values()].reduce((sum, day) => sum + day.cost_usd, 0)
  const scale = total / values.reduce((sum, value) => sum + value, 0)
  const older = values.map((value, index) => ({ day: dayKey(NOW - (179 - index) * DAY), cost_usd: value * scale, totals: { uncached_input_tokens: 20_000_000, cached_input_tokens: 30_000_000, cache_creation_tokens: 4_000_000, output_tokens: 8_000_000, reasoning_tokens: 0 } }))
  return [...older, ...recent.values()]
}

type UsageStoryState = 'normal' | 'error' | 'error-first' | 'stale' | 'reading' | 'empty' | 'loading' | 'unpriced' | 'partial' | 'empty-failed' | 'profile' | 'day' | 'by-day' | 'tokens' | 'hover' | 'retained-day' | 'retained-day-total'

function storySummary(state: UsageStoryState): UsageSummaryMsg {
  const summary = fixtureSummary()
  if (state === 'empty' || state === 'empty-failed') {
    summary.buckets = []
    summary.session_counts = { models: [], days: [] }
    summary.sources = summary.sources.map((source) => ({ ...source, distinct_sessions: 0, scanned_files: 0, failed_files: state === 'empty-failed' ? 1 : 0, status: state === 'empty-failed' ? 'failed' as const : source.provider === 'codex' ? 'missing' as const : 'ok' as const, message: state === 'empty-failed' ? `Could not read ${source.path}; check directory access and refresh.` : null }))
  }
  if (state === 'partial') summary.sources[1] = { ...summary.sources[1], status: 'partial', failed_files: 2, message: 'Two Codex transcript files could not be read.' }
  if (state === 'profile') summary.sources[0] = { ...summary.sources[0], path: '~/agent-profile/projects', profile_name: 'Work' }
  if (state === 'unpriced') {
    summary.pricing = { status: 'unavailable', source: 'model catalog', fetched_at_ms: null, known_models: 0, message: 'The model catalog could not be read. Token totals are still available.' }
    summary.buckets = summary.buckets.map((bucket) => ({ ...bucket, cost_usd: 0, cost_source: 'unpriced', unpriced_records: bucket.records, cache_savings_usd: 0, category_cost_usd: { input_usd: 0, output_usd: 0, cache_read_usd: 0, cache_write_usd: 0, other_usd: 0 }, speed_rate_available: false, speed_premium_usd: 0, fast_cost_usd: 0, ultrafast_cost_usd: 0 }))
  }
  return summary
}

function storyInteraction(host: HTMLElement, state: UsageStoryState, summary: UsageSummaryMsg, activity: UsageActivityDay[]): void {
  const clickLabel = (label: string): void => [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === label)?.click()
  if (state === 'tokens') clickLabel('Tokens')
  if (state === 'by-day' || state === 'retained-day-total') clickLabel('By day')
  if (state === 'day' || state === 'retained-day' || state === 'retained-day-total') {
    const day = state === 'day' ? summary.session_counts?.days[1].day : activity[0].day
    host.querySelector<HTMLButtonElement>(`[data-testid="usage-calendar-day"][aria-label^="${day}:"]`)?.click()
  }
  if (state === 'hover') {
    const chart = host.querySelector<HTMLElement>('[aria-label="Explore daily usage"]')
    if (chart) {
      const bounds = chart.getBoundingClientRect()
      chart.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: bounds.left + bounds.width * 5 / 6 }))
    }
  }
}

export function UsagePageStory({ state = 'normal' }: { state?: UsageStoryState }): React.JSX.Element {
  const summary = useMemo(() => storySummary(state), [state])
  const activity = useMemo(() => {
    const days = fixtureActivity()
    const scannedDays = new Set(summary.session_counts?.days.map((day) => day.day))
    return state === 'unpriced' ? days.map((day) => scannedDays.has(day.day) ? { ...day, cost_usd: 0 } : day) : days
  }, [state, summary])
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => { if (host.current) storyInteraction(host.current, state, summary, activity) }, [state, summary, activity])
  return (
    <div ref={host} data-story-state={state} className="flex h-full min-h-0 bg-[var(--content-bg)]">
      <aside className="grid flex-none content-start gap-[var(--space-3)] px-[var(--space-2)] py-[var(--space-2)] text-[var(--text-secondary)]" style={{ width: 148, background: 'var(--rail-bg)' }}>
        <div className="px-[var(--space-2)] text-[length:var(--tr-text-small-size)] font-semibold tracking-[0.08em] text-[var(--text-faint)]">HOUSTON</div>
        <div className="grid gap-[var(--space-1)] px-[var(--space-2)] text-[length:var(--tr-text-small-size)]">
          <span className="flex items-center gap-[var(--space-2)]"><i className="h-[6px] w-[6px] rounded-full bg-[var(--info)]" />auth-refactor</span>
          <span className="flex items-center gap-[var(--space-2)]"><i className="h-[6px] w-[6px] rounded-full bg-[var(--warn)]" />migrate-db</span>
          <span className="flex items-center gap-[var(--space-2)]"><i className="h-[6px] w-[6px] rounded-full border border-[var(--text-faint)]" />shell</span>
        </div>
        <div className="border-t border-[var(--divider)]" />
        <div className="grid gap-[var(--space-1)] text-[length:var(--tr-text-small-size)]">
          {['Tasks', 'Routines', 'Skills', 'Harness', 'Connections', 'Usage'].map((name) => <div key={name} className={`flex items-center justify-between rounded-[var(--tr-radius-sm)] px-[var(--space-2)] py-[var(--space-1)] ${name === 'Usage' ? 'bg-[var(--hover-fill)] text-[var(--text-primary)]' : ''}`}><span>{name}</span>{name === 'Tasks' ? <span className="text-[var(--warn)]">2</span> : name === 'Harness' ? <span className="text-[var(--warn)]">1</span> : null}</div>)}
        </div>
      </aside>
      <div className="min-h-0 min-w-0 flex-1">
        <UsageSection
          summary={state === 'loading' || state === 'error-first' ? null : summary}
          activity={activity}
          loading={['stale', 'reading', 'loading'].includes(state)}
          error={state === 'error' || state === 'error-first' ? 'The transcript scan failed. Check the agent data directory and refresh.' : null}
          workspaces={[{ path: '/home/dev/code/houston', name: 'houston' }]}
          initialWorkspace="all"
          onRequest={() => {}}
          onActivityRequest={() => {}}
        />
      </div>
    </div>
  )
}
