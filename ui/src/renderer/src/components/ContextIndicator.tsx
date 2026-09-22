import type { SessionContext } from '../houston/generated/SessionContext'
import { useContextIndicatorVisible } from '../contextIndicatorPref'
import { RING_ACCENT_ICON } from './shadowChrome'
import { CONTROL_SIZE_SQUARE_CLS } from './controlSize'
import { HIT_TARGET_28 } from './hitTarget'
import { Tooltip } from './Tooltip'

const RADIUS = 5
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

function human(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`
  return String(n)
}

function stateLabel(context: SessionContext): string | null {
  if (context.state === 'working') return 'Last response'
  if (context.state === 'reset') return 'Compacted'
  if (context.state === 'near_limit') return 'Almost full'
  return null
}

function tooltipLabel(context: SessionContext): string {
  const summary = context.used_percent != null
    ? `Context · ${context.used_percent}% used`
    : 'Context · limit unknown'
  const tokens = context.window_tokens != null
    ? `${human(context.used_tokens)} / ${human(context.window_tokens)} tokens`
    : `${human(context.used_tokens)} tokens`
  return [summary, tokens, stateLabel(context)].filter(Boolean).join('\n')
}

function tone(context: SessionContext): string {
  if (context.used_percent != null && context.used_percent >= 95) return 'text-[var(--danger)]'
  if (context.state === 'near_limit') return 'text-[var(--warn)]'
  return 'text-[var(--text-primary)]'
}

export function ContextIndicator({
  context
}: {
  context?: SessionContext | null
}): React.JSX.Element | null {
  const visible = useContextIndicatorVisible()
  if (!visible || !context || context.state === 'unknown' || context.as_of_ms <= 0) return null

  const percent = context.used_percent == null ? null : Math.max(0, Math.min(100, context.used_percent))
  const label = tooltipLabel(context)

  return (
    <Tooltip label={label} side="bottom" openOnClick>
      <button
        type="button"
        data-pane-head-control
        data-testid="context-indicator"
        aria-label={label.replaceAll('\n', ' ')}
        className={`inline-flex ${CONTROL_SIZE_SQUARE_CLS.mini} ${HIT_TARGET_28} flex-none items-center justify-center rounded-[var(--tr-radius-sm)] cursor-pointer hover:bg-[var(--hover-fill)] focus-visible:bg-[var(--hover-fill)] outline-none focus-visible:shadow-[${RING_ACCENT_ICON}] ${tone(context)}`}
      >
        <svg
          data-testid="context-meter"
          viewBox="0 0 14 14"
          width="14"
          height="14"
          aria-hidden="true"
        >
          <circle
            cx="7"
            cy="7"
            r={RADIUS}
            fill="none"
            stroke="var(--text-muted)"
            strokeWidth="1.5"
          />
          {percent != null && (
            <circle
              data-testid="context-meter-value"
              cx="7"
              cy="7"
              r={RADIUS}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeDasharray={CIRCUMFERENCE}
              strokeDashoffset={CIRCUMFERENCE * (1 - percent / 100)}
              transform="rotate(-90 7 7)"
            />
          )}
        </svg>
      </button>
    </Tooltip>
  )
}
