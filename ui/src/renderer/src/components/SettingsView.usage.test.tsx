// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SettingsView } from './SettingsView'
import type { UsageSummaryMsg } from './UsageSection'
import { monotonePath, niceScale } from './UsageChart'
import { setSettingsNavForTests } from '../settingsNav'
import { baseSettingsViewProps } from './settingsViewTestFixtures'
import type { UsageBucket } from '../houston/generated/UsageBucket'

const DAY = 86_400_000
const HOUR = 3_600_000
const DAY0 = Date.UTC(2026, 7, 20)

function bucket(over: Partial<UsageBucket> & { hour_start_ms: number }): UsageBucket {
  return {
    provider: 'claude',
    model: 'claude-opus-5',
    totals: {
      uncached_input_tokens: 1_000,
      cached_input_tokens: 9_000,
      cache_creation_tokens: 500,
      output_tokens: 2_000,
      reasoning_tokens: 100
    },
    cost_usd: 100,
    cache_savings_usd: 400,
    cost_source: 'model_priced',
    records: 5,
    unpriced_records: 0,
    sessions: 2,
    ...over
  }
}

function summary(over: Partial<UsageSummaryMsg> = {}): UsageSummaryMsg {
  return {
    type: 'usage_summary',
    since_ms: DAY0,
    until_ms: DAY0 + 3 * DAY,
    read_at_ms: DAY0 + 3 * DAY,
    buckets: [
      bucket({ hour_start_ms: DAY0 + HOUR }),
      bucket({
        hour_start_ms: DAY0 + DAY,
        provider: 'codex',
        model: 'gpt-5-codex',
        cost_usd: 25
      }),
      bucket({
        hour_start_ms: DAY0 + DAY,
        model: '<synthetic>',
        cost_usd: 0,
        records: 3,
        unpriced_records: 3,
        cost_source: 'unpriced'
      })
    ],
    sources: [
      {
        provider: 'claude',
        path: '/home/u/.claude/projects',
        profile_name: null,
        status: 'ok',
        scanned_files: 120,
        skipped_files: 8,
        failed_files: 0,
        distinct_sessions: 31,
        message: null
      },
      {
        provider: 'claude',
        path: '/home/u/.claude-personal/projects',
        profile_name: 'personal',
        status: 'ok',
        scanned_files: 90,
        skipped_files: 2,
        failed_files: 0,
        distinct_sessions: 12,
        message: null
      },
      {
        provider: 'codex',
        path: '/home/u/.codex/sessions',
        profile_name: null,
        status: 'missing',
        scanned_files: 0,
        skipped_files: 0,
        failed_files: 0,
        distinct_sessions: 0,
        message: '/home/u/.codex/sessions does not exist'
      }
    ],
    pricing: {
      status: 'cached',
      source: 'https://example.invalid/rates.json',
      fetched_at_ms: DAY0,
      known_models: 1_681,
      message: null
    },
    untracked_agents: ['antigravity', 'opencode', 'cursor', 'grok'],
    scan_duration_ms: 1_800,
    ...over
  }
}

let host: HTMLDivElement
let root: Root

function render(props: Partial<React.ComponentProps<typeof SettingsView>> = {}): void {
  act(() => {
    root.render(<SettingsView {...baseSettingsViewProps()} usage={summary()} {...props} />)
  })
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => setSettingsNavForTests({ section: 'usage' }))
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const text = (): string => host.textContent ?? ''
const q = (sel: string): HTMLElement | null => host.querySelector(sel)

describe('Settings → Usage', () => {
  it('asks for a window as soon as the section opens', () => {
    const onUsageRequest = vi.fn()
    render({ usage: null, onUsageRequest })
    expect(onUsageRequest).toHaveBeenCalledTimes(1)
    const [since, until, refresh] = onUsageRequest.mock.calls[0]
    expect(until - since).toBe(7 * DAY)
    expect(refresh).toBe(false)
  })

  it('shows the headline cost with the "not what you were billed" caveat', () => {
    render()
    expect(q('[data-testid="usage-headline"]')?.textContent).toContain('$125.00')
    expect(text()).toContain('if billed at full API rate')
  })

  it('splits by provider and keeps a provider that spent nothing visible', () => {
    render({ usage: summary({ buckets: [bucket({ hour_start_ms: DAY0 + HOUR })] }) })
    expect(q('[data-testid="usage-provider-codex"]')?.textContent).toContain('$0.00')
    expect(q('[data-testid="usage-provider-claude"]')?.textContent).toContain('100.0% of cost')
  })

  it('names the providers it does not read instead of showing them as zero', () => {
    render()
    expect(text()).toContain('Not tracked')
    expect(text()).toContain('Antigravity')
    expect(text()).toContain('Cursor')
    expect(q('[data-testid="usage-provider-antigravity"]')).toBeNull()
  })

  it('reports an unpriced model as unpriced, never as $0.00', () => {
    render()
    const table = q('[data-testid="usage-breakdown"]')?.textContent ?? ''
    expect(table).toContain('<synthetic>')
    expect(table).toContain('not priced')
  })

  it('pivots the breakdown between models and days', () => {
    render()
    const rows = (): string[] =>
      [...host.querySelectorAll('[data-testid="usage-breakdown"] tbody tr')].map(
        (r) => r.textContent ?? ''
      )
    expect(rows()[0]).toContain('claude-opus-5')

    const dayBtn = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Day')
    act(() => dayBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(rows()[0]).toMatch(/\d{4}-\d{2}-\d{2}/)
  })

  it('hiding a series hides its curve without moving the headline', () => {
    render()
    const before = q('[data-testid="usage-headline"]')?.textContent
    expect(q('[data-testid="usage-chart-series-codex"]')).not.toBeNull()

    const legend = q('[data-testid="usage-legend-codex"]')
    act(() => legend?.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    expect(q('[data-testid="usage-chart-series-codex"]')).toBeNull()
    expect(q('[data-testid="usage-headline"]')?.textContent).toBe(before)
  })

  it('names every directory it read, and which profile produced it', () => {
    render()
    const sources = [...host.querySelectorAll('[data-testid="usage-source"]')].map(
      (n) => n.textContent ?? ''
    )
    expect(sources).toHaveLength(3)
    expect(sources[1]).toContain('.claude-personal/projects')
    expect(sources[1]).toContain('personal')
    expect(sources[2]).toContain('does not exist')
  })

  it('re-scans and re-fetches rates only on the explicit refresh', () => {
    const onUsageRequest = vi.fn()
    render({ onUsageRequest })
    onUsageRequest.mockClear()
    act(() =>
      q('[data-testid="usage-refresh"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    )
    expect(onUsageRequest.mock.calls[0][2]).toBe(true)
  })

  it('changing the window asks again with the new span', () => {
    const onUsageRequest = vi.fn()
    render({ onUsageRequest })
    onUsageRequest.mockClear()
    const btn = [...host.querySelectorAll('button')].find((b) => b.textContent === '30 days')
    act(() => btn?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    const [since, until, refresh] = onUsageRequest.mock.calls[0]
    expect(until - since).toBe(30 * DAY)
    expect(refresh).toBe(false)
  })

  it('shows a refused window in the section, not nowhere', () => {
    render({ usage: null, usageError: 'asked for 120.0 days, limit is 90 days' })
    expect(q('[data-testid="usage-error"]')?.textContent).toContain('limit is 90 days')
  })

  it('says nothing was recorded rather than rendering an empty table', () => {
    render({ usage: summary({ buckets: [] }) })
    expect(text()).toContain('Nothing was recorded in this window')
  })

  it('does not present the previous window as the answer while a wider one loads', () => {
    render({ usageLoading: true })
    const body = q('[data-testid="usage-body"]')
    expect(body?.getAttribute('aria-busy')).toBe('true')
    expect(body?.className).toContain('opacity-40')
    expect(q('[data-testid="usage-range"]')?.textContent).toContain('reading transcripts…')
  })

  it('leaves a plain refresh of the SAME window at full strength', () => {
    const since = Date.now() - 7 * DAY
    render({ usage: summary({ since_ms: since, until_ms: since + 7 * DAY }), usageLoading: true })
    const body = q('[data-testid="usage-body"]')
    expect(body?.getAttribute('aria-busy')).toBe('false')
    expect(body?.className ?? '').not.toContain('opacity-40')
    expect(q('[data-testid="usage-range"]')?.textContent).not.toContain('reading transcripts…')
  })
})

describe('chart maths', () => {
  it('never overshoots below the data between two points', () => {
    const xs = [0, 1, 2, 3]
    const ys = [100, 10, 100, 100]
    const d = monotonePath(xs, ys)
    const control = [...d.matchAll(/C ([\d.-]+) ([\d.-]+), ([\d.-]+) ([\d.-]+)/g)].flatMap((m) => [
      Number(m[2]),
      Number(m[4])
    ])
    expect(control.every((y) => y <= 100.0001)).toBe(true)
  })

  it('degenerates safely for zero and one point', () => {
    expect(monotonePath([], [])).toBe('')
    expect(monotonePath([5], [7])).toBe('M 5 7')
  })

  it('gives an all-zero window a real axis instead of collapsing it', () => {
    expect(niceScale(0).ticks.length).toBeGreaterThan(1)
    expect(niceScale(Number.NaN).top).toBe(1)
  })

  it('rounds the ceiling up to a readable step', () => {
    expect(niceScale(680).top).toBe(750)
    expect(niceScale(2_950).top).toBe(3_000)
    expect(niceScale(0.42).top).toBe(0.6)
    expect(niceScale(0.42).ticks).toEqual([0, 0.2, 0.4, 0.6])
  })
})
