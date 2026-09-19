import type { SessionContext } from '../houston/generated/SessionContext'
import { Tooltip } from './Tooltip'

function human(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function stateLabel(context: SessionContext): string | null {
  switch (context.state) {
    case 'working':
      return 'working'
    case 'near_limit':
      return 'near limit'
    case 'reset':
      return 'after compact'
    case 'idle': {
      const minutes = Math.max(0, Math.round((Date.now() - context.as_of_ms) / 60_000))
      return `as of ${minutes}m`
    }
    default:
      return null
  }
}

const STATE_CLS =
  'text-[length:var(--tr-text-xs)] text-[var(--text-faint)] whitespace-nowrap'

/** One global strip in the shell's downbar. Never animates. */
export function ContextBar({
  context
}: {
  context?: SessionContext | null
}): React.JSX.Element {
  const label = (
    <span className="flex-none text-[length:var(--tr-text-xs)] text-[var(--text-secondary)]">
      Context
    </span>
  )

  if (!context || context.state === 'unknown') {
    return (
      <div
        data-testid="context-bar"
        className="flex h-[var(--h-downbar)] items-center gap-[var(--space-2)] px-[var(--space-3)] text-[length:var(--tr-text-xs)] text-[var(--text-faint)]"
      >
        {label}
        <span data-testid="context-not-tracked">not tracked</span>
      </div>
    )
  }

  const text =
    context.window_tokens != null && context.used_percent != null
      ? `${human(context.used_tokens)} / ${human(context.window_tokens)} (${context.used_percent}%)`
      : `${human(context.used_tokens)} used`
  const state = stateLabel(context)
  const pct = context.used_percent
  const cells = 10
  const filled = pct == null ? 0 : Math.round((pct / 100) * cells)
  const windowText =
    context.window_tokens != null ? human(context.window_tokens) : 'unknown'
  const source = context.source === 'derived' ? 'model catalog' : 'the provider'

  return (
    <div
      data-testid="context-bar"
      className="flex h-[var(--h-downbar)] items-center gap-[var(--space-2)] px-[var(--space-3)] text-[length:var(--tr-text-xs)]"
    >
      {label}
      <Tooltip
        label={`Used ${human(context.used_tokens)} tokens in the last request (input + cached; output not counted). Window ${windowText} from ${source}.`}
      >
        <span
          data-testid="context-readout"
          className="whitespace-nowrap text-[var(--text-secondary)]"
        >
          {text}
        </span>
      </Tooltip>
      {pct != null && (
        <span
          data-testid="context-meter"
          role="meter"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-valuetext={`${human(context.used_tokens)} of ${windowText} tokens`}
          aria-label="Context used"
          className="flex items-center gap-px"
        >
          {Array.from({ length: cells }, (_, i) => (
            <i
              key={i}
              aria-hidden
              className={`block h-[8px] w-[4px] rounded-[1px] ${
                i < filled ? 'bg-[var(--accent)]' : 'bg-[var(--divider)]'
              }`}
            />
          ))}
        </span>
      )}
      {state && (
        <span
          data-testid="context-state"
          className={`${STATE_CLS} ${context.state === 'near_limit' ? 'text-[var(--warning)]' : ''}`}
        >
          {state}
        </span>
      )}
    </div>
  )
}
