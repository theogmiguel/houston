import type { UsageActivityDay } from '../../houston/generated/UsageActivityDay'
import { Tooltip } from './Tooltip'

const LEVELS = [
  'bg-[color-mix(in_srgb,var(--text-primary)_6%,transparent)]',
  'bg-[color-mix(in_srgb,var(--accent)_28%,var(--card-bg))]',
  'bg-[color-mix(in_srgb,var(--accent)_48%,var(--card-bg))]',
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
  const offset = (start.getDay() + 6) % 7
  const cells = [...Array.from({ length: offset }, () => null), ...all]
  const monthLabels = all.map((day, index) => {
    const date = new Date(`${day.key}T12:00:00`)
    return date.getDate() === 1 || index === 0 ? { index: index + offset, label: new Intl.DateTimeFormat('en-US', { month: 'short' }).format(date) } : null
  }).filter((item): item is { index: number; label: string } => item !== null)

  return (
    <div className="grid gap-[var(--space-2)]" data-testid="usage-calendar" data-days={all.length}>
    <div className="rounded-[var(--tr-radius-sm)] border border-[var(--divider)] bg-[var(--card-bg)] px-[var(--space-3)] py-[var(--space-2-5)]">
      <div className="grid grid-cols-[18px_1fr] gap-x-[var(--space-2)]">
        <div aria-hidden="true" className="grid grid-rows-7 gap-[3px] text-[length:var(--tr-text-label-size)] text-[var(--text-faint)]">
          <span />
          <span>Mon</span>
          <span />
          <span>Wed</span>
          <span />
          <span>Fri</span>
          <span />
        </div>
        <div className="min-w-0 overflow-x-auto">
          <div className="grid min-w-[700px] gap-[var(--space-1)]">
            <div className="relative h-[var(--h-ctl-mini)] text-[length:var(--tr-text-label-size)] text-[var(--text-faint)]">
              {monthLabels.map((month) => <span key={month.index} className="absolute" style={{ left: `${(Math.floor(month.index / 7) / 53) * 100}%` }}>{month.label}</span>)}
            </div>
            <div className="grid grid-flow-col grid-rows-7 auto-cols-[minmax(8px,1fr)] gap-[var(--space-1)]" role="group" aria-label="Usage activity by day">
              {cells.map((day, index) => day === null
                ? <span key={`empty-${index}`} />
                : <Tooltip key={day.key} label={`${day.key} · ${metric === 'cost' ? `$${day.amount.toFixed(2)}` : `${day.amount.toLocaleString('en-US')} tokens`}`}>
                    <button
                      type="button"
                      aria-label={`${day.key}: ${metric === 'cost' ? `$${day.amount.toFixed(2)}` : `${day.amount.toLocaleString('en-US')} tokens`}`}
                      aria-pressed={selectedDay === day.key}
                      data-level={levelFor(day.amount, max)}
                      data-testid="usage-calendar-day"
                      onClick={() => onSelect(day.key)}
                      className={`aspect-square min-w-[var(--space-3)] rounded-[var(--tr-radius-input)] border border-[var(--divider)] ${LEVELS[levelFor(day.amount, max)]} ${selectedDay === day.key ? 'outline outline-1 outline-[var(--text-primary)]' : ''}`}
                    />
                  </Tooltip>)}
            </div>
          </div>
        </div>
      </div>
    </div>
      <div className="flex items-center gap-[var(--space-1-5)] text-[length:var(--tr-text-small-size)] text-[var(--text-muted)]">
        {caption && <span>{caption}</span>}
        <span className="ml-auto inline-flex items-center gap-[var(--space-1-5)]">
        <span>Less</span>
        {LEVELS.map((level, index) => <span key={index} aria-hidden="true" data-level={index} className={`h-[10px] w-[10px] border border-[var(--divider)] ${level}`} />)}
        <span>More</span>
        </span>
      </div>
    </div>
  )
}
