import type { SessionContext } from '../houston/generated/SessionContext'
import { useContextIndicatorVisible } from '../contextIndicatorPref'
import { ContextMeterButton, type ContextMeterTone } from './ui/ContextMeter'
import { Tooltip } from './ui/Tooltip'

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

function tone(context: SessionContext): ContextMeterTone {
  if (context.used_percent != null && context.used_percent >= 95) return 'danger'
  if (context.state === 'near_limit') return 'warn'
  return 'normal'
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
      <ContextMeterButton
        data-pane-head-control
        data-testid="context-indicator"
        aria-label={label.replaceAll('\n', ' ')}
        tone={tone(context)}
        percent={percent}
      />
    </Tooltip>
  )
}
