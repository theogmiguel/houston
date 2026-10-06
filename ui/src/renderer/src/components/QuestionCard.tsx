import { useEffect } from 'react'
import { Tooltip } from './ui/Tooltip'
import {
  FreeTextOption,
  RetryMessage,
  PromptCard,
  FreeTextArea,
  PromptHeader,
  QuestionNote,
  OptionButton,
  OptionList,
  QuestionPager,
  PromptText,
  SkipButton
} from './ui/QuestionOption'

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
    <PromptCard
      data-testid="question-card"
      data-state={error ? 'error' : loading ? 'loading' : 'filled'}
      tone={error ? 'danger' : 'surface'}
      disabled={disabled}
      className={className}
    >
      <PromptHeader>
        <QuestionPager>
          ‹ {questionIndex} of {questionCount} ›
        </QuestionPager>
        <Tooltip label={disabled ? disabledReason : undefined} className="inline-flex">
          <SkipButton disabled={disabled} onClick={onSkip} />
        </Tooltip>
      </PromptHeader>

      <PromptText>{question}</PromptText>

      {error ? (
        <RetryMessage message={error.message} onRetry={error.onRetry} />
      ) : loading ? (
        <QuestionNote data-testid="question-card-loading" role="status" aria-label="Loading">
          Loading…
        </QuestionNote>
      ) : body === 'free-text' ? (
        <Tooltip label={disabled ? disabledReason : undefined} className="flex w-full">
          <FreeTextArea
            data-testid="question-card-freetext"
            disabled={disabled}
            value={freeTextValue}
            onChange={(e) => onFreeTextChange?.(e.target.value)}
            rows={3}
          />
        </Tooltip>
      ) :
        options === undefined ? (
        <QuestionNote data-testid="question-card-empty">–</QuestionNote>
      ) : options.length === 0 ? (
        <QuestionNote data-testid="question-card-empty-set">No options</QuestionNote>
      ) : (
        <OptionList>
          {options.map((opt, i) => {
            const checked = body === 'multi-select' ? selectedIds.includes(opt.id) : selectedId === opt.id
            return (
              <Tooltip
                key={opt.id}
                label={disabled ? disabledReason : undefined}
                className="flex w-full"
              >
                <OptionButton
                  n={i + 1}
                  checked={checked}
                  multi={body === 'multi-select'}
                  disabled={disabled}
                  label={opt.label}
                  onClick={() =>
                    body === 'multi-select' ? onToggleOption?.(opt.id) : onSelectOption?.(opt.id)
                  }
                />
              </Tooltip>
            )
          })}
          <Tooltip label={disabled ? disabledReason : undefined} className="flex w-full">
            <FreeTextOption n={escapeHatchNumber} disabled={disabled} onClick={() => onTypeInstead?.()} />
          </Tooltip>
        </OptionList>
      )}
    </PromptCard>
  )
}
