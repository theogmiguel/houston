import { describe, expect, it } from 'vitest'

import type { UsageBucket } from './houston/generated/UsageBucket'
import {
  breakdownRows,
  bucketTokens,
  DAY_MS,
  foldSeries,
  formatRange,
  formatShare,
  formatTokens,
  formatUsd,
  HOUR_MS,
  providerSummaries,
  usageTotals,
  USAGE_WINDOWS,
  windowRange
} from './usage'

const UTC = 'UTC'

function bucket(over: Partial<UsageBucket> & { hour_start_ms: number }): UsageBucket {
  return {
    provider: 'claude',
    model: 'claude-opus-5',
    totals: {
      uncached_input_tokens: 0,
      cached_input_tokens: 0,
      cache_creation_tokens: 0,
      output_tokens: 0,
      reasoning_tokens: 0
    },
    cost_usd: 0,
    cache_savings_usd: 0,
    cost_source: 'model_priced',
    records: 1,
    unpriced_records: 0,
    sessions: 1,
    ...over
  }
}

describe('formatting', () => {
  it('keeps three significant digits so two models stay comparable', () => {
    expect(formatTokens(3_340_000_000)).toBe('3.34B')
    expect(formatTokens(148_000_000)).toBe('148M')
    expect(formatTokens(10_700_000)).toBe('10.7M')
    expect(formatTokens(234_000)).toBe('234K')
    expect(formatTokens(12_200)).toBe('12.2K')
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(Number.NaN)).toBe('0')
  })

  it('prints money to the cent, with separators', () => {
    expect(formatUsd(12_101.15)).toBe('$12,101.15')
    expect(formatUsd(0)).toBe('$0.00')
  })

  it('never reports a share as a bare zero-denominator NaN', () => {
    expect(formatShare(0)).toBe('0.0%')
    expect(formatShare(Number.NaN)).toBe('0.0%')
    expect(formatShare(0.867)).toBe('86.7%')
  })

  it('names the last day INSIDE a half-open window, not the one after it', () => {
    const since = Date.UTC(2026, 7, 16)
    const until = Date.UTC(2026, 7, 23)
    expect(formatRange(since, until, UTC)).toBe('Aug 16 to Aug 22')
  })
})

describe('windows', () => {
  it('offers only windows the daemon accepts', () => {
    expect(USAGE_WINDOWS.map((w) => w.id)).toEqual(['24h', '7d', '30d', '90d'])
    expect(USAGE_WINDOWS.every((w) => w.days <= 90)).toBe(true)
    expect(USAGE_WINDOWS.filter((w) => w.hourly).map((w) => w.id)).toEqual(['24h'])
  })

  it('turns a window into a half-open instant range ending now', () => {
    const now = 1_700_000_000_000
    const { sinceMs, untilMs } = windowRange(USAGE_WINDOWS[1], now)
    expect(untilMs).toBe(now)
    expect(now - sinceMs).toBe(7 * DAY_MS)
  })
})

describe('bucketTokens', () => {
  it('excludes reasoning, which already sits inside output', () => {
    const b = bucket({
      hour_start_ms: 0,
      totals: {
        uncached_input_tokens: 10,
        cached_input_tokens: 20,
        cache_creation_tokens: 30,
        output_tokens: 40,
        reasoning_tokens: 25
      }
    })
    expect(bucketTokens(b)).toBe(100)
  })
})

describe('foldSeries', () => {
  const day0 = Date.UTC(2026, 7, 20)

  it('emits a point per day INCLUDING days with nothing in them', () => {
    const points = foldSeries([bucket({ hour_start_ms: day0 + 3 * HOUR_MS, cost_usd: 5 })], {
      sinceMs: day0,
      untilMs: day0 + 3 * DAY_MS,
      hourly: false,
      timeZone: UTC
    })
    expect(points).toHaveLength(4)
    expect(points[0].byProvider.claude.cost).toBe(5)
    expect(points[1].byProvider.claude.cost).toBe(0)
    expect(points[3].byProvider.claude.cost).toBe(0)
  })

  it('sums every hour of a day into that day, per provider', () => {
    const points = foldSeries(
      [
        bucket({ hour_start_ms: day0 + HOUR_MS, cost_usd: 2 }),
        bucket({ hour_start_ms: day0 + 20 * HOUR_MS, cost_usd: 3 }),
        bucket({ hour_start_ms: day0 + 5 * HOUR_MS, cost_usd: 7, provider: 'codex' })
      ],
      { sinceMs: day0, untilMs: day0 + DAY_MS - 1, hourly: false, timeZone: UTC }
    )
    expect(points[0].byProvider.claude.cost).toBe(5)
    expect(points[0].byProvider.codex.cost).toBe(7)
  })

  it('plots hours when the window is hourly', () => {
    const points = foldSeries([bucket({ hour_start_ms: day0 + HOUR_MS, cost_usd: 4 })], {
      sinceMs: day0,
      untilMs: day0 + 3 * HOUR_MS,
      hourly: true,
      timeZone: UTC
    })
    expect(points).toHaveLength(4)
    expect(points[1].byProvider.claude.cost).toBe(4)
  })

  it('keeps a bucket that falls outside the walked slots rather than dropping it', () => {
    const points = foldSeries([bucket({ hour_start_ms: day0 + 40 * DAY_MS, cost_usd: 9 })], {
      sinceMs: day0,
      untilMs: day0 + DAY_MS,
      hourly: false,
      timeZone: UTC
    })
    expect(points.some((p) => p.byProvider.claude.cost === 9)).toBe(true)
  })

  it('is ordered by time', () => {
    const points = foldSeries([], {
      sinceMs: day0,
      untilMs: day0 + 5 * DAY_MS,
      hourly: false,
      timeZone: UTC
    })
    const starts = points.map((p) => p.startMs)
    expect([...starts].sort((a, b) => a - b)).toEqual(starts)
  })
})

describe('providerSummaries', () => {
  it('lists every provider, including one that spent nothing', () => {
    const rows = providerSummaries([bucket({ hour_start_ms: 0, cost_usd: 10 })])
    expect(rows.map((r) => r.provider)).toEqual(['claude', 'codex'])
    expect(rows[1].cost).toBe(0)
    expect(rows[1].costShare).toBe(0)
  })

  it('computes cost and token shares independently', () => {
    const rows = providerSummaries([
      bucket({
        hour_start_ms: 0,
        cost_usd: 75,
        totals: {
          uncached_input_tokens: 100,
          cached_input_tokens: 0,
          cache_creation_tokens: 0,
          output_tokens: 0,
          reasoning_tokens: 0
        }
      }),
      bucket({
        hour_start_ms: 0,
        provider: 'codex',
        cost_usd: 25,
        totals: {
          uncached_input_tokens: 300,
          cached_input_tokens: 0,
          cache_creation_tokens: 0,
          output_tokens: 0,
          reasoning_tokens: 0
        }
      })
    ])
    expect(rows[0].costShare).toBeCloseTo(0.75)
    expect(rows[0].tokenShare).toBeCloseTo(0.25)
  })
})

describe('usageTotals', () => {
  it('counts active days, not window days', () => {
    const day0 = Date.UTC(2026, 7, 20)
    const totals = usageTotals(
      [
        bucket({
          hour_start_ms: day0,
          totals: {
            uncached_input_tokens: 1,
            cached_input_tokens: 0,
            cache_creation_tokens: 0,
            output_tokens: 0,
            reasoning_tokens: 0
          }
        }),
        bucket({
          hour_start_ms: day0 + 5 * HOUR_MS,
          totals: {
            uncached_input_tokens: 1,
            cached_input_tokens: 0,
            cache_creation_tokens: 0,
            output_tokens: 0,
            reasoning_tokens: 0
          }
        }),
        bucket({
          hour_start_ms: day0 + 4 * DAY_MS,
          totals: {
            uncached_input_tokens: 1,
            cached_input_tokens: 0,
            cache_creation_tokens: 0,
            output_tokens: 0,
            reasoning_tokens: 0
          }
        })
      ],
      UTC
    )
    expect(totals.activeDays).toBe(2)
  })

  it('sums the four token classes into the headline and keeps reasoning aside', () => {
    const totals = usageTotals(
      [
        bucket({
          hour_start_ms: 0,
          totals: {
            uncached_input_tokens: 1,
            cached_input_tokens: 2,
            cache_creation_tokens: 3,
            output_tokens: 4,
            reasoning_tokens: 2
          }
        })
      ],
      UTC
    )
    expect(totals.tokens).toBe(10)
    expect(totals.reasoning).toBe(2)
  })
})

describe('breakdownRows', () => {
  const day0 = Date.UTC(2026, 7, 20)
  const rows = (): UsageBucket[] => [
    bucket({ hour_start_ms: day0, model: 'claude-opus-5', cost_usd: 80, records: 4 }),
    bucket({ hour_start_ms: day0 + HOUR_MS, model: 'claude-opus-5', cost_usd: 10, records: 1 }),
    bucket({ hour_start_ms: day0 + DAY_MS, model: 'claude-sonnet-5', cost_usd: 10, records: 2 }),
    bucket({
      hour_start_ms: day0 + DAY_MS,
      model: '<synthetic>',
      cost_usd: 0,
      records: 3,
      unpriced_records: 3
    })
  ]

  it('groups by model, sorted by spend', () => {
    const out = breakdownRows(rows(), 'model', UTC)
    expect(out.map((r) => r.id)).toEqual(['claude-opus-5', 'claude-sonnet-5', '<synthetic>'])
    expect(out[0].cost).toBe(90)
    expect(out[0].share).toBeCloseTo(0.9)
  })

  it('marks a model whose every record was unpriced', () => {
    const out = breakdownRows(rows(), 'model', UTC)
    const synthetic = out.find((r) => r.id === '<synthetic>')
    expect(synthetic?.unpriced).toBe(true)
    expect(out[0].unpriced).toBe(false)
  })

  it('groups by day, newest first, with no provider attribution', () => {
    const out = breakdownRows(rows(), 'day', UTC)
    expect(out.map((r) => r.id)).toEqual(['2026-08-21', '2026-08-20'])
    expect(out[0].provider).toBeNull()
    expect(out[1].cost).toBe(90)
  })

  it('returns nothing for an empty scan rather than a zero row', () => {
    expect(breakdownRows([], 'model', UTC)).toEqual([])
  })
})
