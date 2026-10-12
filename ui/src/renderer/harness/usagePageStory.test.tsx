// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fixtureActivity, fixtureSummary, UsagePageStory } from './usagePageStory'

let host: HTMLDivElement
let root: Root
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 12, 12)); host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); vi.restoreAllMocks() })

it('uses a realizable seven-day fixture with distinct counts and the approved totals', () => {
  const summary = fixtureSummary()
  expect(summary.buckets.every((bucket) => bucket.sessions <= bucket.records)).toBe(true)
  expect(summary.buckets.every((bucket) => bucket.hour_start_ms >= summary.since_ms && bucket.hour_start_ms < summary.until_ms)).toBe(true)
  expect(summary.buckets.reduce((sum, bucket) => sum + bucket.cost_usd, 0)).toBeCloseTo(2486.3)
  expect(summary.sources.reduce((sum, source) => sum + source.distinct_sessions, 0)).toBe(214)
  expect(summary.session_counts?.models.map((model) => model.sessions)).toEqual([96, 88, 39, 3])
})

it('shows the approved ready hierarchy with exact model Sessions', () => {
  act(() => root.render(<UsagePageStory />))
  expect(host.querySelector('[data-testid="usage-meta"]')?.textContent).toContain('read 2 min ago in 1.2 s')
  expect(host.querySelector('[data-testid="usage-headline"]')?.textContent).toBe('$2,486.30')
  expect([...host.querySelectorAll('[data-testid="usage-breakdown"] tbody tr')].map((row) => row.children[1].textContent)).toEqual(['96', '39', '88', '3'])
})

it('keeps the year view consistent with scanned daily costs and the retained total', () => {
  const activity = fixtureActivity()
  expect(activity.reduce((sum, day) => sum + day.cost_usd, 0)).toBeCloseTo(20_591)
  const summary = fixtureSummary()
  for (const day of summary.session_counts?.days ?? []) {
    const costs = summary.buckets.filter((bucket) => {
      const date = new Date(bucket.hour_start_ms)
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` === day.day
    }).reduce((sum, bucket) => sum + bucket.cost_usd, 0)
    expect(activity.find((item) => item.day === day.day)?.cost_usd).toBeCloseTo(costs)
  }
})

const STATES = ['normal', 'reading', 'empty', 'loading', 'error', 'error-first', 'unpriced', 'partial', 'empty-failed', 'profile', 'day', 'by-day', 'tokens', 'hover', 'retained-day', 'retained-day-total', 'stale'] as const
it.each(STATES)('renders the %s capture state without external requests', (state) => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 1000, bottom: 180, width: 1000, height: 180, x: 0, y: 0, toJSON: () => ({}) })
  act(() => root.render(<UsagePageStory state={state} />))
  expect(host.querySelector('h1')?.textContent).toBe('Usage')
  if (state === 'reading' || state === 'stale') {
    expect(host.textContent).toContain('showing the result from 2 min ago')
    expect(host.querySelector('[data-testid="usage-body"]')?.getAttribute('aria-busy')).toBe('true')
    expect(host.querySelector('[data-testid="usage-headline"]')?.textContent).toBe('$2,486.30')
  }
  if (state === 'empty') expect(host.textContent).toContain('Folder not found')
  if (state === 'empty-failed') expect(host.textContent).toContain('Could not read transcripts')
  if (state === 'loading' || state === 'error-first') expect(host.querySelector('[data-testid="usage-headline"]')).toBeNull()
  if (state === 'unpriced') expect(host.querySelector('[data-testid="usage-headline"]')?.textContent).toBe('Not priced')
  if (state === 'partial') expect(host.textContent).toContain('Scan incomplete · 2 files could not be read')
  if (state === 'profile') expect(host.textContent).toContain('~/agent-profile/projects')
  if (state === 'day') expect(host.querySelector('button[aria-label="Show the whole window"]')).not.toBeNull()
  if (state === 'by-day') expect(host.querySelector('[data-testid="usage-breakdown"] th')?.textContent).toBe('Day')
  if (state === 'tokens') expect(host.textContent).toContain('Tokens per day')
  if (state === 'hover') {
    expect(host.querySelector('[data-testid="usage-chart-tooltip"]')?.textContent).toContain('Oct 10')
    expect(host.querySelector('[data-testid="usage-chart-tooltip"]')?.textContent).toContain('$362.00')
  }
  if (state === 'retained-day') expect(host.textContent).toContain('Model details no longer available for this day')
  if (state === 'retained-day-total') expect(host.querySelector('[data-testid="usage-breakdown"] tbody tr')?.children[1].textContent).toBe('—')
})

it('uses weekday-first axis labels', () => {
  act(() => root.render(<UsagePageStory state="hover" />))
  const chart = host.querySelector('[data-testid="usage-chart"]')
  expect(chart?.textContent).toContain('Mon 5')
  expect(chart?.textContent).toContain('Sun 11')
})

it('uses square series keys in chart, hover, category and calendar legends', () => {
  act(() => root.render(<UsagePageStory />))
  act(() => host.querySelector<HTMLElement>('[aria-label="Explore daily usage"]')?.focus())
  const marks = [...host.querySelectorAll<HTMLSpanElement>('span[aria-hidden="true"]')].filter((mark) => mark.className.includes('inline-block') && mark.className.includes('size-'))
  expect(marks).toHaveLength(10)
  expect(marks.every((mark) => mark.className.includes('rounded-[var(--tr-radius-legend-mark)]'))).toBe(true)
})
