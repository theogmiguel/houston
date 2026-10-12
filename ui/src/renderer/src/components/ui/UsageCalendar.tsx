import { formatTokens, formatUsd } from '../../usage'
import type { UsageActivityDay } from '../../houston/generated/UsageActivityDay'
import { Text } from './Text'
import { UsageSectionHeading } from './UsageSectionHeading'
import { Tooltip } from './Tooltip'

const LEVELS = [
  'bg-[var(--divider)]',
  'bg-[color-mix(in_srgb,var(--accent)_30%,var(--card-bg))]',
  'bg-[color-mix(in_srgb,var(--accent)_50%,var(--card-bg))]',
  'bg-[color-mix(in_srgb,var(--accent)_72%,var(--card-bg))]',
  'bg-[var(--accent)]'
] as const

function levelFor(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0
  return Math.min(4, Math.max(1, Math.ceil((value / max) * 4)))
}

export function usageCalendarLevel(value: number, max: number): number {
  return levelFor(value, max)
}

// Seven weekday rows use the compact height of the year-view card.
const CALENDAR_HEIGHT = 104
export const CALENDAR_DAYS = 365

// Local midnight of the first calendar day; the daemon counts local calendar days, not 24h spans.
export function calendarStartMs(nowMs: number): number {
  const start = new Date(nowMs)
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - (CALENDAR_DAYS - 1))
  return start.getTime()
}

export function UsageCalendar({
  days,
  metric,
  selectedDay,
  onSelect,
  caption
}: {
  days: UsageActivityDay[]
  metric: 'cost' | 'tokens'
  selectedDay: string | null
  onSelect: (day: string) => void
  caption?: string
}): React.JSX.Element {
  const start = new Date(calendarStartMs(Date.now()))
  const keyOf = (date: Date): string => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  const byDay = new Map(days.map((day) => [day.day, day]))
  const all = Array.from({ length: CALENDAR_DAYS }, (_, index) => {
    const date = new Date(start)
    date.setDate(date.getDate() + index)
    const key = keyOf(date)
    const item = byDay.get(key)
    const tokens = item
      ? item.totals.uncached_input_tokens + item.totals.cached_input_tokens + item.totals.cache_creation_tokens + item.totals.output_tokens
      : 0
    return { key, amount: metric === 'cost' ? (item?.cost_usd ?? 0) : tokens }
  })
  const max = Math.max(0, ...all.map((day) => day.amount))
  const offset = start.getDay()
  const cells = [...Array.from({ length: offset }, () => null), ...all]
  const monthLabels = all.map((day, index) => {
    const date = new Date(`${day.key}T12:00:00`)
    return date.getDate() === 1 ? { index: index + offset, label: new Intl.DateTimeFormat('en-US', { month: 'short' }).format(date) } : null
  }).filter((item): item is { index: number; label: string } => item !== null)

  const total = all.reduce((sum, day) => sum + day.amount, 0)
  const totalLabel = metric === 'cost' ? `$${Math.round(total).toLocaleString('en-US')}` : formatTokens(total)
  const weeks = Math.ceil(cells.length / 7)
  return <div className="grid gap-[var(--space-3)]" data-testid="usage-calendar" data-days={all.length}>
    <div className="flex flex-wrap items-baseline gap-[var(--space-2)]">
      <UsageSectionHeading>Last 12 months</UsageSectionHeading>
      <Text size="small" tone="muted" data-testid="usage-calendar-meaning">{totalLabel} · colour shows {metric === 'cost' ? 'cost' : 'tokens'} per day</Text>
      <Text size="small" tone="secondary" className="ml-auto flex items-center gap-[var(--space-3)]"><span className="inline-flex items-center gap-[var(--space-1-5)]"><span aria-hidden="true" data-level={0} className={`inline-block size-[var(--space-2)] rounded-[var(--tr-radius-input)] ${LEVELS[0]}`} />Less</span><span className="inline-flex items-center gap-[var(--space-1-5)]"><span aria-hidden="true" data-level={4} className={`inline-block size-[var(--space-2)] rounded-[var(--tr-radius-input)] ${LEVELS[4]}`} />More</span></Text>
    </div>
    <div className="grid grid-cols-[28px_minmax(0,1fr)] gap-[var(--space-2)]">
      <div aria-hidden="true" className="grid grid-rows-7 gap-[var(--space-0-75)] text-[length:var(--tr-text-xs)] text-[var(--text-muted)]" style={{ height: CALENDAR_HEIGHT }}><span /><span>Mon</span><span /><span>Wed</span><span /><span>Fri</span><span /></div>
      <div className="grid min-w-0 gap-[var(--space-1)]">
        <div className="grid grid-flow-col grid-rows-7 gap-[var(--space-0-75)]" style={{ height: CALENDAR_HEIGHT, gridTemplateColumns: `repeat(${weeks}, minmax(0, 1fr))` }} role="group" aria-label="Usage activity by day">
          {cells.map((day, index) => day === null ? <span key={`empty-${index}`} /> : <Tooltip key={day.key} label={`${day.key} · ${metric === 'cost' ? formatUsd(day.amount) : `${formatTokens(day.amount)} tokens`}`}>
            <button type="button" aria-label={`${day.key}: ${metric === 'cost' ? formatUsd(day.amount) : `${formatTokens(day.amount)} tokens`}`} aria-pressed={selectedDay === day.key} data-level={levelFor(day.amount, max)} data-testid="usage-calendar-day" onClick={() => onSelect(day.key)} className={`h-full w-full rounded-[var(--tr-radius-xs)] border-0 ${LEVELS[levelFor(day.amount, max)]} ${selectedDay === day.key ? 'outline outline-1 outline-[var(--text-primary)] outline-offset-1' : ''}`} />
          </Tooltip>)}
        </div>
        <div className="relative h-[var(--space-4)] text-[length:var(--tr-text-xs)] text-[var(--text-muted)]">
          {monthLabels.map((month) => <span key={month.index} className="absolute" style={{ left: `${Math.floor(month.index / 7) / weeks * 100}%` }}>{month.label}</span>)}
        </div>
      </div>
    </div>
    {caption && <Text as="p" flush size="small" tone="muted">{caption}</Text>}
  </div>
}
