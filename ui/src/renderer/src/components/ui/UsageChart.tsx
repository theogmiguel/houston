import { useId, useState } from 'react'
import { Text } from './Text'
import { OVERLAY_RAISED_CLS, OVERLAY_RAISED_ATTRS } from './overlayChrome'

import type { UsageProvider } from '../../houston/generated/UsageProvider'
import { formatAxisUsd, formatUsd, formatTokens, type SeriesPoint } from '../../usage'

// A wide viewBox preserves smooth curves; 180px leaves room for labels in the page card.
const VIEW_W = 1000
const VIEW_H = 180

export interface UsageSeries {
  provider: UsageProvider
  label: string
  color: string
}

export function monotonePath(xs: number[], ys: number[]): string {
  const n = xs.length
  if (n === 0) return ''
  if (n === 1) return `M ${xs[0]} ${ys[0]}`

  const dx: number[] = []
  const slope: number[] = []
  for (let i = 0; i < n - 1; i++) {
    dx.push(xs[i + 1] - xs[i])
    slope.push(dx[i] === 0 ? 0 : (ys[i + 1] - ys[i]) / dx[i])
  }

  const m: number[] = new Array(n).fill(0)
  m[0] = slope[0]
  m[n - 1] = slope[n - 2]
  for (let i = 1; i < n - 1; i++) {
    m[i] = slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2
  }
  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) {
      m[i] = 0
      m[i + 1] = 0
      continue
    }
    const a = m[i] / slope[i]
    const b = m[i + 1] / slope[i]
    const h = Math.hypot(a, b)
    if (h > 3) {
      m[i] = ((3 * a) / h) * slope[i]
      m[i + 1] = ((3 * b) / h) * slope[i]
    }
  }

  let d = `M ${xs[0]} ${ys[0]}`
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3
    d += ` C ${xs[i] + h} ${ys[i] + m[i] * h}, ${xs[i + 1] - h} ${ys[i + 1] - m[i + 1] * h}, ${xs[i + 1]} ${ys[i + 1]}`
  }
  return d
}

export function niceScale(max: number): { top: number; ticks: number[] } {
  if (!Number.isFinite(max) || max <= 0) return { top: 1, ticks: [0, 1] }
  const pow = 10 ** Math.floor(Math.log10(max))
  const step = [1, 2, 2.5, 5, 10].find((s) => max / (s * pow) <= 4) ?? 10
  const size = step * pow
  const top = Number((Math.ceil(max / size) * size).toFixed(10))
  const ticks: number[] = []
  for (let v = 0; v <= top + size / 2; v += size) ticks.push(Number(v.toFixed(10)))
  return { top, ticks }
}

export function UsageLegend({ series }: { series: UsageSeries[] }): React.JSX.Element {
  return <Text size="small" tone="secondary" className="flex flex-wrap items-center gap-x-[var(--space-3)] gap-y-[var(--space-1)]">
    {series.map((item) => <span key={item.provider} className="inline-flex items-center gap-[var(--space-1-5)]"><span aria-hidden="true" className="inline-block size-[var(--space-2)] rounded-[var(--tr-radius-legend-mark)]" style={{ background: item.color }} />{item.label}</span>)}
  </Text>
}

export function UsageChart({ points, series, metric, labelFor }: {
  points: SeriesPoint[]
  series: UsageSeries[]
  metric: 'cost' | 'tokens'
  labelFor: (point: SeriesPoint) => string
}): React.JSX.Element {
  const gradientId = useId()
  const tooltipId = useId()
  const [hoverDay, setHoverDay] = useState<number | null>(null)
  const valueOf = (point: SeriesPoint, provider: UsageProvider): number => metric === 'cost' ? point.byProvider[provider].cost : point.byProvider[provider].tokens
  const max = Math.max(0, ...points.flatMap((point) => series.map((item) => valueOf(point, item.provider))))
  const { top } = niceScale(max)
  const ticks = [top, top / 2, 0]
  const axisFormat = metric === 'cost' ? (value: number): string => value === 0 ? '$0' : formatAxisUsd(value).replace(/\.00$/, '') : formatTokens
  const valueFormat = metric === 'cost' ? formatUsd : formatTokens
  const xAt = (index: number): number => points.length <= 1 ? VIEW_W / 2 : index / (points.length - 1) * VIEW_W
  const yAt = (value: number): number => VIEW_H - value / top * VIEW_H
  const activeIndex = hoverDay === null || !points.length ? null : Math.min(hoverDay, points.length - 1)
  const point = activeIndex === null ? null : points[activeIndex]
  const hx = activeIndex === null ? 0 : xAt(activeIndex) / VIEW_W * 100
  // At most seven labels keep the 30- and 90-day windows legible at the same width.
  const labelIndexes = [...new Set(Array.from({ length: Math.min(7, points.length) }, (_, index) => Math.round(index * (points.length - 1) / Math.max(1, Math.min(7, points.length) - 1))))]
  const hoverLabel = point ? new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'short', day: 'numeric', ...(point.key.includes('T') ? { hour: 'numeric' } : {}) }).format(point.key.includes('T') ? new Date(point.startMs) : new Date(`${point.key}T12:00:00`)) : ''
  return <div data-testid="usage-chart" className="grid min-w-0 grid-cols-[40px_minmax(0,1fr)] gap-[var(--space-2)]">
    <div className="relative" style={{ height: VIEW_H }} aria-hidden="true">
      {ticks.map((tick) => <Text key={tick} size="xs" tone="faint" tabular className="absolute right-0 -translate-y-1/2" style={{ top: `${yAt(tick) / VIEW_H * 100}%` }}>{axisFormat(tick)}</Text>)}
    </div>
    <div className="grid min-w-0 gap-[var(--space-2)]">
      <div className="relative min-w-0" style={{ height: VIEW_H }} tabIndex={0} role="group" aria-label="Explore daily usage" aria-describedby={point ? tooltipId : undefined}
        onPointerMove={(event) => { const bounds = event.currentTarget.getBoundingClientRect(); if (bounds.width > 0 && points.length) setHoverDay(Math.min(points.length - 1, Math.max(0, Math.round((event.clientX - bounds.left) / bounds.width * (points.length - 1))))) }}
        onPointerLeave={() => setHoverDay(null)} onFocus={() => { if (points.length) setHoverDay(0) }} onBlur={() => setHoverDay(null)}
        onKeyDown={(event) => {
          if (!points.length) return
          if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); setHoverDay((day) => Math.min(points.length - 1, Math.max(0, (day ?? 0) + (event.key === 'ArrowRight' ? 1 : -1)))) }
          else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); setHoverDay(event.key === 'Home' ? 0 : points.length - 1) }
          else if (event.key === 'Escape') setHoverDay(null)
        }}>
        <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} width="100%" height={VIEW_H} preserveAspectRatio="none" role="img" aria-label={metric === 'cost' ? 'Cost per day: Claude Code and Codex' : 'Tokens per day: Claude Code and Codex'} className="block h-full w-full overflow-visible">
          <defs><linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--claude)" stopOpacity="0.18" /><stop offset="100%" stopColor="var(--claude)" stopOpacity="0" /></linearGradient></defs>
          {ticks.map((tick) => <line key={tick} x1={0} y1={yAt(tick)} x2={VIEW_W} y2={yAt(tick)} stroke="var(--divider)" strokeWidth={1} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />)}
          {series.map((item) => {
            const xs = points.map((_, index) => xAt(index))
            const line = monotonePath(xs, points.map((day) => yAt(valueOf(day, item.provider))))
            if (!line) return null
            return <g key={item.provider} data-testid={`usage-chart-series-${item.provider}`}>
              {item.provider === 'claude' && <path data-testid="usage-chart-area" d={`${line} L${xs[xs.length - 1]},${VIEW_H} L${xs[0]},${VIEW_H} Z`} fill={`url(#${gradientId})`} />}
              <path d={line} fill="none" stroke={item.color} strokeWidth={2} vectorEffect="non-scaling-stroke" />
              {points.length === 1 && <circle cx={xAt(0)} cy={yAt(valueOf(points[0], item.provider))} r={3} fill={item.color} />}
            </g>
          })}
        </svg>
        {point && <>
          <span aria-hidden="true" data-testid="usage-chart-hover-line" className="absolute inset-y-0 w-px bg-[var(--border)]" style={{ left: `${hx}%` }} />
          {series.map((item) => <span key={item.provider} aria-hidden="true" data-testid="usage-chart-hover-dot" className="absolute size-[var(--space-2)] -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[var(--card-bg)]" style={{ left: `${hx}%`, top: `${yAt(valueOf(point, item.provider)) / VIEW_H * 100}%`, background: item.color }} />)}
          <div {...OVERLAY_RAISED_ATTRS} id={tooltipId} role="tooltip" data-testid="usage-chart-tooltip" className={`${OVERLAY_RAISED_CLS} pointer-events-none absolute top-[var(--space-1)] grid gap-[var(--space-1)] whitespace-nowrap px-[var(--space-2-5)] py-[var(--space-2)]`} style={{ left: `${hx}%`, transform: hx < 50 ? 'translateX(var(--space-3))' : 'translateX(calc(-100% - var(--space-3)))' }}>
            <Text size="small" weight="medium" tone="primary">{hoverLabel}</Text>
            {series.map((item) => <Text key={item.provider} size="small" tone="secondary" className="flex items-center gap-[var(--space-2)]"><span aria-hidden="true" className="inline-block size-[var(--space-1-5)] rounded-[var(--tr-radius-legend-mark)]" style={{ background: item.color }} />{item.label}<Text tabular tone="primary" className="ml-auto pl-[var(--space-4)]">{valueFormat(valueOf(point, item.provider))}</Text></Text>)}
          </div>
        </>}
      </div>
      <div className="relative h-[var(--space-4)]" aria-hidden="true">
        {labelIndexes.map((index) => <Text key={index} size="xs" tone="muted" className={`absolute whitespace-nowrap ${index === 0 ? '' : index === points.length - 1 ? '-translate-x-full' : '-translate-x-1/2'}`} style={{ left: `${xAt(index) / VIEW_W * 100}%` }}>{labelFor(points[index])}</Text>)}
      </div>
    </div>
  </div>
}
