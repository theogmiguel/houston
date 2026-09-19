import { useId } from 'react'

import type { UsageProvider } from '../houston/generated/UsageProvider'
import { formatAxisUsd, formatTokens, type SeriesPoint } from '../usage'

const VIEW_W = 600
const VIEW_H = 170

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
  const step = [1, 2, 2.5, 5, 10].find((s) => max / (s * pow) <= 3) ?? 10
  const size = step * pow
  const top = Number((Math.ceil(max / size) * size).toFixed(10))
  const ticks: number[] = []
  for (let v = 0; v <= top + size / 2; v += size) ticks.push(Number(v.toFixed(10)))
  return { top, ticks }
}

export function UsageChart({
  points,
  series,
  metric,
  labelFor
}: {
  points: SeriesPoint[]
  series: UsageSeries[]
  metric: 'cost' | 'tokens'
  labelFor: (point: SeriesPoint) => string
}): React.JSX.Element {
  const gradientId = useId()
  const valueOf = (p: SeriesPoint, provider: UsageProvider): number =>
    metric === 'cost' ? p.byProvider[provider].cost : p.byProvider[provider].tokens

  const max = Math.max(0, ...points.flatMap((p) => series.map((s) => valueOf(p, s.provider))))
  const { top, ticks } = niceScale(max)
  const format = metric === 'cost' ? formatAxisUsd : formatTokens

  const xAt = (i: number): number =>
    points.length <= 1 ? VIEW_W / 2 : (i / (points.length - 1)) * VIEW_W
  const yAt = (v: number): number => VIEW_H - (v / top) * VIEW_H

  const first = points[0]
  const middle = points[Math.floor((points.length - 1) / 2)]
  const last = points[points.length - 1]

  return (
    <div data-testid="usage-chart" className="min-w-0">
      <div className="flex min-w-0">
        {}
        <div
          className="relative w-[54px] shrink-0 text-right"
          style={{ height: VIEW_H }}
          aria-hidden="true"
        >
          {ticks.map((t) => (
            <span
              key={t}
              className="absolute right-[8px] -translate-y-1/2 [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] tabular-nums text-[var(--text-faint)]"
              style={{ top: `${(yAt(t) / VIEW_H) * 100}%` }}
            >
              {format(t)}
            </span>
          ))}
        </div>

        <svg
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          width="100%"
          height={VIEW_H}
          preserveAspectRatio="none"
          role="img"
          aria-label={`${metric === 'cost' ? 'Cost' : 'Tokens'} over ${points.length} points`}
          className="block min-w-0 flex-1"
        >
          <defs>
            {series.map((s) => (
              <linearGradient
                key={s.provider}
                id={`${gradientId}-${s.provider}`}
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop offset="0%" stopColor={s.color} stopOpacity="0.32" />
                <stop offset="100%" stopColor={s.color} stopOpacity="0.02" />
              </linearGradient>
            ))}
          </defs>

          {ticks.map((t) => (
            <line
              key={t}
              x1={0}
              y1={yAt(t)}
              x2={VIEW_W}
              y2={yAt(t)}
              stroke="var(--border)"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
              opacity={t === 0 ? 1 : 0.5}
            />
          ))}

          {series.map((s) => {
            const xs = points.map((_, i) => xAt(i))
            const ys = points.map((p) => yAt(valueOf(p, s.provider)))
            const line = monotonePath(xs, ys)
            if (!line) return null
            const area = `${line} L ${xs[xs.length - 1]} ${VIEW_H} L ${xs[0]} ${VIEW_H} Z`
            return (
              <g key={s.provider} data-testid={`usage-chart-series-${s.provider}`}>
                <path d={area} fill={`url(#${gradientId}-${s.provider})`} stroke="none" />
                <path
                  d={line}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={1.7}
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            )
          })}
        </svg>
      </div>

      {}
      <div className="ml-[54px] mt-[6px] flex justify-between [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] [letter-spacing:var(--tr-text-label-tracking)] uppercase text-[var(--text-faint)]">
        <span>{first ? labelFor(first) : ''}</span>
        <span>{middle && middle !== first && middle !== last ? labelFor(middle) : ''}</span>
        <span>{last && last !== first ? labelFor(last) : ''}</span>
      </div>
    </div>
  )
}
