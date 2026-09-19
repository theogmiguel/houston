import { Disclosure } from './Disclosure'
import { IconCheck } from './icons'
import { Icon } from './Icon'

export interface TimelineStep {
  id: string
  label: string
  status: 'done' | 'active' | 'error'
  detail?: string
}

export interface TimelineFailure {
  message: string
  onRetry: () => void
}

export interface TimelineProps {
  steps?: TimelineStep[]
  elapsedMs?: number
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  loading?: boolean
  failure?: TimelineFailure
  disabled?: boolean
  disabledReason?: string
  emptySetLabel?: string
  className?: string
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

export function Timeline({
  steps,
  elapsedMs,
  defaultOpen = false,
  open,
  onOpenChange,
  loading = false,
  failure,
  disabled = false,
  disabledReason,
  emptySetLabel = 'No steps yet',
  className = ''
}: TimelineProps): React.JSX.Element {
  const isEmpty = steps === undefined
  const isEmptySet = !isEmpty && steps.length === 0
  const hasFailure = !!failure

  const summaryText = hasFailure
    ? elapsedMs !== undefined
      ? `Worked ${formatElapsed(elapsedMs)}`
      : 'Failed'
    : loading
      ? 'Working…'
      : elapsedMs !== undefined
        ? `Worked for ${formatElapsed(elapsedMs)}`
        : isEmpty
          ? 'Not started'
          : 'Done'

  const summary = (
    <span
      data-testid="timeline-summary"
      className={hasFailure ? 'text-[var(--status-blocked-text)]' : undefined}
    >
      {summaryText}
    </span>
  )

  let body: React.ReactNode = null
  if (isEmpty) {
    body = (
      <div data-testid="timeline-empty" className="text-[length:var(--tr-text-small-size)] text-[var(--text-muted)]">
        Not started
      </div>
    )
  } else if (!isEmptySet) {
    body = (
      <div className="flex flex-col gap-[var(--space-3)]">
        <ol
          data-testid="timeline-rail"
          className="relative flex flex-col gap-[var(--space-2)] pl-[var(--space-4)]"
        >
          <span
            aria-hidden
            className="absolute left-[3px] top-[4px] bottom-[4px] w-px bg-[var(--border)]"
          />
          {steps.map((step, i) => {
            const isTerminal = i === steps.length - 1
            const isRed = step.status === 'error' || (hasFailure && isTerminal)
            return (
              <li
                key={step.id}
                data-testid="timeline-step"
                data-status={step.status}
                className="relative flex items-start gap-[var(--space-2)]"
              >
                <span
                  aria-hidden
                  className={`absolute left-[-13px] top-[3px] h-[7px] w-[7px] rounded-full ${
                    isRed
                      ? 'bg-[var(--danger)]'
                      : step.status === 'done'
                        ? 'bg-[var(--success)]'
                        : step.status === 'active'
                          ? 'bg-[var(--accent)]'
                          : 'bg-[var(--border)]'
                  }`}
                />
                {step.status === 'done' && isTerminal && !hasFailure && (
                  <span aria-hidden className="flex-none text-[var(--success)]">
                    <Icon glyph={IconCheck} role="small" />
                  </span>
                )}
                <span
                  data-testid="timeline-step-label"
                  className={`min-w-0 flex-1 text-[length:var(--tr-text-small-size)] ${
                    isRed ? 'text-[var(--status-blocked-text)]' : 'text-[var(--text-secondary)]'
                  }`}
                >
                  {step.label}
                  {step.detail && (
                    <span className="block text-[var(--text-muted)]">{step.detail}</span>
                  )}
                </span>
              </li>
            )
          })}
        </ol>
      </div>
    )
  }

  return (
    <div data-testid="timeline" className={className}>
      <Disclosure
        summary={summary}
        count={isEmpty ? undefined : steps.length}
        defaultOpen={defaultOpen}
        open={open}
        onOpenChange={onOpenChange}
        loading={loading && !hasFailure}
        error={
          failure && {
            message: failure.message,
            failingStep: steps?.find((st) => st.status === 'error')?.label,
            onRetry: failure.onRetry
          }
        }
        disabled={disabled}
        disabledReason={disabledReason}
        emptySetLabel={emptySetLabel}
      >
        {body}
      </Disclosure>
    </div>
  )
}
