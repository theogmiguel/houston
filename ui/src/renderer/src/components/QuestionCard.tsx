import { useEffect } from 'react'
import { FOCUS_HALO } from './shadowChrome'
import { IconTile } from './IconTile'
import { IconCheck } from './icons'
import { HIT_TARGET_28 } from './hitTarget'
import { Icon } from './Icon'
import { Tooltip } from './Tooltip'

export type QuestionCardBody = 'free-text' | 'multi-select' | 'single-select'

export interface QuestionCardOption {
  id: string
  label: string
}

export interface QuestionCardError {
  message: string
  onRetry: () => void
}

export interface QuestionCardProps {
  questionIndex: number
  questionCount: number
  question: string
  body: QuestionCardBody
  options?: QuestionCardOption[]
  selectedIds?: string[]
  selectedId?: string
  freeTextValue?: string
  onFreeTextChange?: (value: string) => void
  onToggleOption?: (id: string) => void
  onSelectOption?: (id: string) => void
  onTypeInstead?: () => void
  onSkip?: () => void
  loading?: boolean
  error?: QuestionCardError
  disabled?: boolean
  disabledReason?: string
  className?: string
}

function NumberTile({ n }: { n: number }): React.JSX.Element {
  return (
    <IconTile
      size="sm"
      tone="muted"
      icon={<span className="tabular-nums [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)]">{n}</span>}
    />
  )
}

export function QuestionCard({
  questionIndex,
  questionCount,
  question,
  body,
  options,
  selectedIds = [],
  selectedId,
  freeTextValue = '',
  onFreeTextChange,
  onToggleOption,
  onSelectOption,
  onTypeInstead,
  onSkip,
  loading = false,
  error,
  disabled = false,
  disabledReason,
  className = ''
}: QuestionCardProps): React.JSX.Element {
  const isSelectBody = body === 'multi-select' || body === 'single-select'
  const isEmpty = isSelectBody && options === undefined
  const isEmptySet = isSelectBody && options !== undefined && options.length === 0
  const escapeHatchNumber = (options?.length ?? 0) + 1
  const interactive = isSelectBody && !disabled && !loading && !error && !isEmpty && !isEmptySet

  useEffect(() => {
    if (!interactive) return
    const handler = (e: KeyboardEvent): void => {
      const n = Number(e.key)
      if (!Number.isInteger(n) || n < 1) return
      if (n === escapeHatchNumber) {
        onTypeInstead?.()
        return
      }
      const opt = options?.[n - 1]
      if (!opt) return
      if (body === 'multi-select') onToggleOption?.(opt.id)
      else onSelectOption?.(opt.id)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [interactive, options, body, escapeHatchNumber, onToggleOption, onSelectOption, onTypeInstead])

  return (
    <div
      data-testid="question-card"
      data-state={error ? 'error' : loading ? 'loading' : 'filled'}
      className={`flex flex-col gap-[var(--space-3)] rounded-[var(--tr-radius-card)] border p-[var(--space-3)] ${
        error
          ? 'border-[var(--danger)] bg-[var(--status-blocked-bg)]'
          : 'border-[var(--border)] bg-[var(--surface)]'
      } ${disabled ? 'opacity-50' : ''} ${className}`}
    >
      <div className="flex items-center justify-between text-[length:var(--tr-text-small-size)] text-[var(--text-muted)]">
        <span data-testid="question-card-pager" className="tabular-nums">
          ‹ {questionIndex} of {questionCount} ›
        </span>
        <Tooltip label={disabled ? disabledReason : undefined} className="inline-flex">
          <button
            type="button"
            data-testid="question-card-skip"
            disabled={disabled}
            onClick={onSkip}
            className={`border-0 bg-transparent rounded-[var(--tr-radius-sm)] px-[var(--space-1-5)] hover:bg-[var(--surface-hover)] active:scale-[0.96] focus-visible:outline-none focus-visible:shadow-[${FOCUS_HALO}] disabled:opacity-50 disabled:cursor-not-allowed ${HIT_TARGET_28}`}
          >
            Skip
          </button>
        </Tooltip>
      </div>

      <div
        data-testid="question-card-question"
        className="text-[length:var(--tr-text-ui-size)] font-medium text-[var(--text-primary)]"
      >
        {question}
      </div>

      {error ? (
        <div className="flex items-center gap-[var(--space-2)] text-[length:var(--tr-text-small-size)] text-[var(--status-blocked-text)]">
          <span className="flex-1">{error.message}</span>
          <button
            type="button"
            onClick={error.onRetry}
            className={`bg-transparent rounded-[var(--tr-radius-button)] px-[var(--space-2)] h-[var(--h-ctl-mini)] border border-current font-semibold focus-visible:outline-none focus-visible:shadow-[${FOCUS_HALO}] ${HIT_TARGET_28}`}
          >
            Try again
          </button>
        </div>
      ) : loading ? (
        <div
          data-testid="question-card-loading"
          role="status"
          aria-label="Loading"
          className="text-[length:var(--tr-text-small-size)] text-[var(--text-muted)]"
        >
          Loading…
        </div>
      ) : body === 'free-text' ? (
        <Tooltip label={disabled ? disabledReason : undefined} className="flex w-full">
          <textarea
            data-testid="question-card-freetext"
            disabled={disabled}
            value={freeTextValue}
            onChange={(e) => onFreeTextChange?.(e.target.value)}
            rows={3}
            className={`w-full resize-none rounded-[var(--tr-radius-input)] border border-[var(--border)] bg-[var(--background)] px-[var(--space-2)] py-[var(--space-1-5)] text-[length:var(--tr-text-ui-size)] text-[var(--text-primary)] focus-visible:outline-none focus-visible:shadow-[${FOCUS_HALO}] disabled:opacity-50 disabled:cursor-not-allowed`}
          />
        </Tooltip>
      ) :
        options === undefined ? (
        <div data-testid="question-card-empty" className="text-[length:var(--tr-text-small-size)] text-[var(--text-muted)]">
          –
        </div>
      ) : options.length === 0 ? (
        <div data-testid="question-card-empty-set" className="text-[length:var(--tr-text-small-size)] text-[var(--text-muted)]">
          No options
        </div>
      ) : (
        <div
          data-testid="question-card-options"
          className="flex max-h-[240px] flex-col gap-[var(--space-1-5)] overflow-y-auto"
        >
          {options.map((opt, i) => {
            const n = i + 1
            const checked = body === 'multi-select' ? selectedIds.includes(opt.id) : selectedId === opt.id
            return (
              <Tooltip
                key={opt.id}
                label={disabled ? disabledReason : undefined}
                className="flex w-full"
              >
                <button
                  type="button"
                  data-testid="question-card-option"
                  aria-pressed={checked}
                  disabled={disabled}
                  onClick={() =>
                    body === 'multi-select' ? onToggleOption?.(opt.id) : onSelectOption?.(opt.id)
                  }
                  className={`border-0 flex h-[var(--h-row)] items-center gap-[var(--space-2)] rounded-[var(--tr-radius-sm)] px-[var(--space-1-5)] text-left hover:bg-[var(--surface-hover)] active:scale-[0.995] focus-visible:outline-none focus-visible:shadow-[${FOCUS_HALO}] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent ${
                    checked ? 'bg-[var(--accent-muted)]' : 'bg-transparent'
                  }`}
                >
                  <NumberTile n={n} />
                  {body === 'multi-select' && (
                    <span
                      aria-hidden
                      data-testid="question-card-checkbox"
                      data-checked={checked}
                      className={`inline-flex h-[16px] w-[16px] flex-none items-center justify-center rounded-[4px] border ${
                        checked ? 'border-[var(--accent)] bg-[var(--accent)]' : 'border-[var(--border)] bg-transparent'
                      }`}
                    >
                      {checked && <Icon glyph={IconCheck} role="label" />}
                    </span>
                  )}
                  <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[length:var(--tr-text-ui-size)] text-[var(--text-primary)]">
                    {opt.label}
                  </span>
                </button>
              </Tooltip>
            )
          })}
          <Tooltip label={disabled ? disabledReason : undefined} className="flex w-full">
            <button
              type="button"
              data-testid="question-card-escape-hatch"
              disabled={disabled}
              onClick={() => onTypeInstead?.()}
              className={`border-0 bg-transparent flex h-[var(--h-row)] items-center gap-[var(--space-2)] rounded-[var(--tr-radius-sm)] px-[var(--space-1-5)] text-left hover:bg-[var(--surface-hover)] active:scale-[0.995] focus-visible:outline-none focus-visible:shadow-[${FOCUS_HALO}] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent`}
            >
              <NumberTile n={escapeHatchNumber} />
              <span className="text-[length:var(--tr-text-ui-size)] text-[var(--text-muted)]">Type it your own</span>
            </button>
          </Tooltip>
        </div>
      )}
    </div>
  )
}
