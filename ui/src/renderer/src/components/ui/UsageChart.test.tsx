// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { UsageChart, type UsageSeries } from './UsageChart'
import type { SeriesPoint } from '../../usage'

const series: UsageSeries[] = [{ provider: 'claude', label: 'Claude Code', color: 'var(--claude)' }, { provider: 'codex', label: 'Codex', color: 'var(--text-primary)' }]
const points: SeriesPoint[] = [240, 300, 282].map((cost, index) => ({ startMs: Date.UTC(2026, 9, 5 + index, 12), key: `2026-10-0${5 + index}`, byProvider: { claude: { cost, tokens: (index + 1) * 1_000_000 }, codex: { cost: 40 + index * 10, tokens: 10_000 } } }))
let host: HTMLDivElement
let root: Root
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks() })
const render = (metric: 'cost' | 'tokens' = 'cost'): void => { act(() => root.render(<UsageChart points={points} series={series} metric={metric} labelFor={(point) => point.key} />)) }

it('draws monotone lines, an area only for Claude, and three dashed gridlines', () => {
  render()
  expect(host.querySelectorAll('[data-testid="usage-chart-area"]')).toHaveLength(1)
  expect(host.querySelector('[data-testid="usage-chart-series-codex"] path')?.getAttribute('fill')).toBe('none')
  expect(host.querySelector('[data-testid="usage-chart-series-claude"] path[fill="none"]')?.getAttribute('d')).toContain(' C ')
  expect(host.querySelectorAll('line[stroke-dasharray]')).toHaveLength(3)
  expect(host.querySelector('[role="tooltip"]')).toBeNull()
})

it('the nearest pointer day drives a vertical guide, two dots and a nowrap tooltip', () => {
  render()
  const plot = host.querySelector('[aria-label="Explore daily usage"]') as HTMLElement
  vi.spyOn(plot, 'getBoundingClientRect').mockReturnValue({ left: 100, width: 1000 } as DOMRect)
  act(() => plot.dispatchEvent(new MouseEvent('pointermove', { clientX: 590, bubbles: true })))
  const tooltip = host.querySelector('[role="tooltip"]') as HTMLElement
  expect(tooltip.textContent).toContain('Tuesday, Oct 6')
  expect(tooltip.textContent).toContain('$300.00')
  expect(tooltip.textContent).toContain('$50.00')
  expect(tooltip.classList.contains('whitespace-nowrap')).toBe(true)
  expect((host.querySelector('[data-testid="usage-chart-hover-line"]') as HTMLElement).style.left).toBe('50%')
  expect(host.querySelectorAll('[data-testid="usage-chart-hover-dot"]')).toHaveLength(2)
  act(() => plot.dispatchEvent(new MouseEvent('pointerout', { bubbles: true })))
  expect(host.querySelector('[role="tooltip"]')).toBeNull()
})

it('keyboard exploration and a metric change keep the highlighted day and correct values', () => {
  render()
  const plot = host.querySelector('[aria-label="Explore daily usage"]') as HTMLElement
  act(() => plot.focus())
  act(() => plot.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })))
  expect(host.querySelector('[role="tooltip"]')?.textContent).toContain('$282.00')
  render('tokens')
  expect(host.querySelector('[role="tooltip"]')?.textContent).toContain('3M')
  expect(host.querySelector('[role="tooltip"]')?.textContent).not.toContain('$282.00')
  act(() => plot.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(host.querySelector('[role="tooltip"]')).toBeNull()
})
