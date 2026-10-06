// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { UsageSection, categoryTotals, speedTotals } from './UsageSection'
import type { UsageSummaryMsg } from './UsageSection'
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
    cache_savings_usd: 4,
    cost_source: 'model_priced',
    records: 5,
    unpriced_records: 0,
    sessions: 2,
    workspace_path: '/proj',
    category_cost_usd: { input_usd: 10, cache_read_usd: 40, cache_write_usd: 15, output_usd: 35, other_usd: 0 },
    fast_cost_usd: 10,
    ultrafast_cost_usd: 2,
    speed_premium_usd: 8,
    speed_rate_available: true,
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
      bucket({ hour_start_ms: DAY0 + DAY, provider: 'codex', model: 'gpt-5-codex', cost_usd: 25,
        category_cost_usd: { input_usd: 2.5, cache_read_usd: 10, cache_write_usd: 3.75, output_usd: 8.75, other_usd: 0 },
        fast_cost_usd: 0, ultrafast_cost_usd: 0, speed_premium_usd: 0 }),
      bucket({ hour_start_ms: DAY0 + DAY, model: '<synthetic>', cost_usd: 0, records: 3, unpriced_records: 3, cost_source: 'unpriced',
        category_cost_usd: { input_usd: 0, cache_read_usd: 0, cache_write_usd: 0, output_usd: 0, other_usd: 0 } })
    ],
    sources: [{ provider: 'claude', path: '/home/u/.claude/projects', profile_name: null, status: 'ok', scanned_files: 120, skipped_files: 8, failed_files: 0, distinct_sessions: 31, message: null },
      { provider: 'codex', path: '/home/u/.codex/sessions', profile_name: null, status: 'ok', scanned_files: 40, skipped_files: 0, failed_files: 0, distinct_sessions: 12, message: null }],
    pricing: { status: 'cached', source: 'https://example.invalid/rates.json', fetched_at_ms: DAY0, known_models: 1_681, message: null },
    untracked_agents: ['antigravity', 'opencode', 'cursor', 'grok'],
    scan_duration_ms: 1_800,
    ...over
  }
}

let host: HTMLDivElement
let root: Root

function render(props: Partial<React.ComponentProps<typeof UsageSection>> = {}): void {
  act(() => root.render(<UsageSection summary={summary()} loading={false} error={null} activity={[]} workspaces={[{ path: '/proj', name: 'Houston' }]} onRequest={() => {}} onActivityRequest={() => {}} {...props} />))
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const text = (): string => host.textContent ?? ''
const q = (sel: string): HTMLElement | null => host.querySelector(sel)

describe('Usage page', () => {
  it('requests both summary windows and includes the selected workspace', () => {
    const onRequest = vi.fn()
    const onActivityRequest = vi.fn()
    render({ initialWorkspace: '/proj', onRequest, onActivityRequest })
    expect(onRequest).toHaveBeenCalledTimes(1)
    expect(onRequest.mock.calls[0][3]).toBe('/proj')
    expect(onActivityRequest).toHaveBeenCalledTimes(1)
    expect(onActivityRequest.mock.calls[0][2]).toBe('/proj')
    const [since, until] = onActivityRequest.mock.calls[0] as [number, number]
    const first = new Date(since)
    expect([first.getHours(), first.getMinutes(), first.getSeconds(), first.getMilliseconds()]).toEqual([0, 0, 0, 0])
    const last = new Date(until - 1)
    const calendarDays = Math.round((new Date(last.getFullYear(), last.getMonth(), last.getDate()).getTime() - since) / DAY) + 1
    expect(calendarDays).toBe(365)
  })

  it('shows the API estimate and a tooltip with the full-rate caveat', () => {
    render()
    expect(q('[data-testid="usage-headline"]')?.textContent).toContain('$125.00')
    expect(text()).toContain('43 sessions')
    expect(host.querySelector('[aria-label="API estimate details"]')).not.toBeNull()
  })

  it('shows 365 local calendar days with the five-step legend', () => {
    render()
    expect(host.querySelectorAll('[data-testid="usage-calendar-day"]')).toHaveLength(365)
    expect(host.querySelectorAll('[data-testid="usage-calendar"] [data-level]')).toHaveLength(370)
    expect(text()).toContain('Mon')
    expect(text()).toContain('Wed')
    expect(text()).toContain('Fri')
  })

  it('a selected day filters the breakdown to that date', () => {
    vi.useFakeTimers()
    vi.setSystemTime(DAY0 + 2 * DAY)
    render()
    const expectedDay = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(DAY0 + DAY))
    const day = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="usage-calendar-day"]')].find((button) => button.getAttribute('aria-label')?.startsWith(expectedDay))
    act(() => day?.click())
    const rows = [...host.querySelectorAll('[data-testid="usage-breakdown"] tbody tr')]
    expect(rows).toHaveLength(1)
    expect(rows[0].textContent).toContain(expectedDay)
  })

  it('disables Limits and exposes its reason', () => {
    render()
    const limits = [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Limits')
    expect(limits?.disabled).toBe(true)
    expect(limits?.parentElement?.getAttribute('data-tooltip')).toBe('A quota reader is not available yet')
  })

  it('category and speed segments sum to their respective totals', () => {
    const buckets = summary().buckets
    expect(categoryTotals(buckets).reduce((sum, item) => sum + item.value, 0)).toBe(125)
    expect(speedTotals(buckets).reduce((sum, item) => sum + item.value, 0)).toBe(125)
    expect(speedTotals(buckets).map((item) => item.label)).toEqual(['Standard', 'Fast', 'Ultrafast'])
  })

  it('shows Cost by speed beside Cost by type even when every request ran at standard speed', () => {
    const standard = summary().buckets.map((b) => ({ ...b, fast_cost_usd: 0, ultrafast_cost_usd: 0, speed_premium_usd: 0 }))
    render({ summary: summary({ buckets: standard }) })
    expect(text()).toContain('Cost by type')
    expect(text()).toContain('Cost by speed')
    expect(text()).toContain('Premium $0.00')
  })

  it('reports unpriced models without assigning them a zero rate', () => {
    render()
    expect(q('[data-testid="usage-breakdown"]')?.textContent).toContain('<synthetic>')
    expect(q('[data-testid="usage-breakdown"]')?.textContent).toContain('not priced')
  })
})
