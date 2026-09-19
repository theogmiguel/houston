import type { UsageBucket } from './houston/generated/UsageBucket'
import type { UsageProvider } from './houston/generated/UsageProvider'
import { USAGE_MAX_WINDOW_DAYS } from './houston/generated/DEFAULTS'

export const HOUR_MS = 3_600_000
export const DAY_MS = 24 * HOUR_MS

export interface UsageWindowDef {
  id: UsageWindowId
  label: string
  days: number
  hourly: boolean
}

export type UsageWindowId = '24h' | '7d' | '30d' | '90d'

export const USAGE_WINDOWS: readonly UsageWindowDef[] = [
  { id: '24h', label: 'Past 24h', days: 1, hourly: true },
  { id: '7d', label: '7 days', days: 7, hourly: false },
  { id: '30d', label: '30 days', days: 30, hourly: false },
  { id: '90d', label: `${USAGE_MAX_WINDOW_DAYS} days`, days: USAGE_MAX_WINDOW_DAYS, hourly: false }
]

export function windowRange(window: UsageWindowDef, nowMs: number): {
  sinceMs: number
  untilMs: number
} {
  return { sinceMs: nowMs - window.days * DAY_MS, untilMs: nowMs }
}

export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  const units: [number, string][] = [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K']
  ]
  for (const [scale, suffix] of units) {
    if (n >= scale) {
      const v = n / scale
      const digits = v >= 100 ? 0 : v >= 10 ? 1 : 2
      return `${v.toFixed(digits)}${suffix}`
    }
  }
  return String(Math.round(n))
}

export function formatUsd(n: number): string {
  return `$${(Number.isFinite(n) ? n : 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`
}

export function formatAxisUsd(n: number): string {
  if (n === 0) return '0'
  if (n >= 1000) return `$${Math.round(n).toLocaleString('en-US')}`
  return `$${n.toFixed(2)}`
}

export function formatShare(fraction: number): string {
  if (!Number.isFinite(fraction) || fraction <= 0) return '0.0%'
  return `${(fraction * 100).toFixed(1)}%`
}

export const USAGE_PROVIDERS: readonly { id: UsageProvider; label: string }[] = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' }
]

export interface ProviderAmount {
  cost: number
  tokens: number
}

export interface SeriesPoint {
  startMs: number
  key: string
  byProvider: Record<UsageProvider, ProviderAmount>
}

function emptyAmounts(): Record<UsageProvider, ProviderAmount> {
  return {
    claude: { cost: 0, tokens: 0 },
    codex: { cost: 0, tokens: 0 }
  }
}

export function bucketTokens(b: UsageBucket): number {
  return (
    b.totals.uncached_input_tokens +
    b.totals.cached_input_tokens +
    b.totals.cache_creation_tokens +
    b.totals.output_tokens
  )
}

export function makeDayKey(timeZone: string): (ms: number) => string {
  let format: Intl.DateTimeFormat
  try {
    format = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    })
  } catch {
    format = new Intl.DateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    })
  }
  return (ms) => format.format(new Date(ms))
}

export function foldSeries(
  buckets: readonly UsageBucket[],
  opts: { sinceMs: number; untilMs: number; hourly: boolean; timeZone: string }
): SeriesPoint[] {
  const { sinceMs, untilMs, hourly, timeZone } = opts
  const toDay = makeDayKey(timeZone)
  const keyOf = (ms: number): string =>
    hourly ? `${new Date(Math.floor(ms / HOUR_MS) * HOUR_MS).toISOString().slice(0, 13)}` : toDay(ms)

  const slots = new Map<string, SeriesPoint>()
  const step = hourly ? HOUR_MS : DAY_MS
  for (let ms = Math.floor(sinceMs / step) * step; ms <= untilMs; ms += step) {
    const key = keyOf(ms)
    if (!slots.has(key)) slots.set(key, { startMs: ms, key, byProvider: emptyAmounts() })
  }

  for (const b of buckets) {
    const key = keyOf(b.hour_start_ms)
    let slot = slots.get(key)
    if (!slot) {
      slot = { startMs: b.hour_start_ms, key, byProvider: emptyAmounts() }
      slots.set(key, slot)
    }
    const amount = slot.byProvider[b.provider]
    amount.cost += b.cost_usd
    amount.tokens += bucketTokens(b)
  }

  return [...slots.values()].sort((a, b) => a.startMs - b.startMs)
}

export interface ProviderSummary {
  provider: UsageProvider
  label: string
  cost: number
  tokens: number
  costShare: number
  tokenShare: number
}

export function providerSummaries(buckets: readonly UsageBucket[]): ProviderSummary[] {
  const totals = new Map<UsageProvider, ProviderAmount>()
  for (const b of buckets) {
    const acc = totals.get(b.provider) ?? { cost: 0, tokens: 0 }
    acc.cost += b.cost_usd
    acc.tokens += bucketTokens(b)
    totals.set(b.provider, acc)
  }
  const totalCost = [...totals.values()].reduce((a, v) => a + v.cost, 0)
  const totalTokens = [...totals.values()].reduce((a, v) => a + v.tokens, 0)
  return USAGE_PROVIDERS.map(({ id, label }) => {
    const acc = totals.get(id) ?? { cost: 0, tokens: 0 }
    return {
      provider: id,
      label,
      cost: acc.cost,
      tokens: acc.tokens,
      costShare: totalCost > 0 ? acc.cost / totalCost : 0,
      tokenShare: totalTokens > 0 ? acc.tokens / totalTokens : 0
    }
  })
}

export interface UsageTotals {
  cost: number
  tokens: number
  uncachedInput: number
  cachedInput: number
  cacheCreation: number
  output: number
  reasoning: number
  cacheSavings: number
  records: number
  unpricedRecords: number
  activeDays: number
}

export function usageTotals(
  buckets: readonly UsageBucket[],
  timeZone: string
): UsageTotals {
  const toDay = makeDayKey(timeZone)
  const active = new Set<string>()
  const t: UsageTotals = {
    cost: 0,
    tokens: 0,
    uncachedInput: 0,
    cachedInput: 0,
    cacheCreation: 0,
    output: 0,
    reasoning: 0,
    cacheSavings: 0,
    records: 0,
    unpricedRecords: 0,
    activeDays: 0
  }
  for (const b of buckets) {
    t.cost += b.cost_usd
    t.cacheSavings += b.cache_savings_usd
    t.uncachedInput += b.totals.uncached_input_tokens
    t.cachedInput += b.totals.cached_input_tokens
    t.cacheCreation += b.totals.cache_creation_tokens
    t.output += b.totals.output_tokens
    t.reasoning += b.totals.reasoning_tokens
    t.records += b.records
    t.unpricedRecords += b.unpriced_records
    if (bucketTokens(b) > 0) active.add(toDay(b.hour_start_ms))
  }
  t.tokens = t.uncachedInput + t.cachedInput + t.cacheCreation + t.output
  t.activeDays = active.size
  return t
}

export interface BreakdownRow {
  id: string
  provider: UsageProvider | null
  cost: number
  tokens: number
  share: number
  unpriced: boolean
}

export type BreakdownMode = 'model' | 'day'

export function breakdownRows(
  buckets: readonly UsageBucket[],
  mode: BreakdownMode,
  timeZone: string
): BreakdownRow[] {
  const toDay = makeDayKey(timeZone)
  const acc = new Map<
    string,
    { provider: UsageProvider | null; cost: number; tokens: number; records: number; unpriced: number }
  >()
  for (const b of buckets) {
    const key = mode === 'model' ? b.model : toDay(b.hour_start_ms)
    const row = acc.get(key) ?? {
      provider: mode === 'model' ? b.provider : null,
      cost: 0,
      tokens: 0,
      records: 0,
      unpriced: 0
    }
    if (mode === 'model' && row.provider !== b.provider) row.provider = b.provider
    row.cost += b.cost_usd
    row.tokens += bucketTokens(b)
    row.records += b.records
    row.unpriced += b.unpriced_records
    acc.set(key, row)
  }
  const totalCost = [...acc.values()].reduce((a, v) => a + v.cost, 0)
  const rows: BreakdownRow[] = [...acc.entries()].map(([id, v]) => ({
    id,
    provider: v.provider,
    cost: v.cost,
    tokens: v.tokens,
    share: totalCost > 0 ? v.cost / totalCost : 0,
    unpriced: v.records > 0 && v.unpriced === v.records
  }))
  rows.sort((a, b) =>
    mode === 'model' ? b.cost - a.cost || b.tokens - a.tokens : b.id.localeCompare(a.id)
  )
  return rows
}

export function formatRange(sinceMs: number, untilMs: number, timeZone: string): string {
  const fmt = (ms: number): string => {
    try {
      return new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric' }).format(
        new Date(ms)
      )
    } catch {
      return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(ms))
    }
  }
  return `${fmt(sinceMs)} to ${fmt(untilMs - 1)}`
}
