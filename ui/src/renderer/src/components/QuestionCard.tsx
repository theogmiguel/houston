import type { ReactNode } from 'react'
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
import { useQuestionKeys } from './questionKeys'

export type QuestionCardBody = 'free-text' | 'multi-select' | 'single-select'

export interface QuestionCardOption {
  id: string
  label: string
  /** Shown as the option's tooltip. */
  description?: string
}

export interface QuestionCardError {
  message: string
  onRetry: () => void
}

export interface QuestionCardProps {
  questionIndex: number
  questionCount: number
  question: string
  /** A short name for the question, shown beside the pager. */
  header?: string
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
  /** A row under the body, for example Back, Next and Submit. */
  actions?: ReactNode
  /** Whether this card takes a number key now; several cards can be mounted at once. */
  ownsShortcuts?: () => boolean
  className?: string
}

interface ChoiceListProps {
  options: QuestionCardOption[]
  multi: boolean
  selectedIds: string[]
  selectedId?: string
  disabled: boolean
  disabledReason?: string
  onToggleOption?: (id: string) => void
  onSelectOption?: (id: string) => void
  onTypeInstead?: () => void
}

function ChoiceList({
  options,
  multi,
  selectedIds,
  selectedId,
  disabled,
  disabledReason,
  onToggleOption,
  onSelectOption,
  onTypeInstead
}: ChoiceListProps): React.JSX.Element {
  return (
    <OptionList>
      {options.map((opt, i) => (
        <Tooltip
          key={opt.id}
          label={disabled ? disabledReason : opt.description || undefined}
          className="flex w-full"
        >
          <OptionButton
            n={i + 1}
            checked={multi ? selectedIds.includes(opt.id) : selectedId === opt.id}
            multi={multi}
            disabled={disabled}
            label={opt.label}
            onClick={() => (multi ? onToggleOption?.(opt.id) : onSelectOption?.(opt.id))}
          />
        </Tooltip>
      ))}
      <Tooltip label={disabled ? disabledReason : undefined} className="flex w-full">
        <FreeTextOption n={options.length + 1} disabled={disabled} onClick={() => onTypeInstead?.()} />
      </Tooltip>
    </OptionList>
  )
}

export function QuestionCard({
  questionIndex,
  questionCount,
  question,
  header,
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
  actions,
  ownsShortcuts,
  className = ''
}: QuestionCardProps): React.JSX.Element {
  const isSelectBody = body === 'multi-select' || body === 'single-select'
  const isEmpty = isSelectBody && options === undefined
  const isEmptySet = isSelectBody && options !== undefined && options.length === 0
  const interactive = isSelectBody && !disabled && !loading && !error && !isEmpty && !isEmptySet

  useQuestionKeys({
    active: interactive,
    multi: body === 'multi-select',
    options,
    ownsShortcuts,
    onToggleOption,
    onSelectOption,
    onTypeInstead
  })

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
          ‹ {questionIndex} of {questionCount} ›{header ? ` · ${header}` : ''}
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
        <QuestionNote data-testid="question-card-empty" role="status">Loading options…</QuestionNote>
      ) : options.length === 0 ? (
        <QuestionNote data-testid="question-card-empty-set">No options</QuestionNote>
      ) : (
        <ChoiceList
          options={options}
          multi={body === 'multi-select'}
          selectedIds={selectedIds}
          selectedId={selectedId}
          disabled={disabled}
          disabledReason={disabledReason}
          onToggleOption={onToggleOption}
          onSelectOption={onSelectOption}
          onTypeInstead={onTypeInstead}
        />
      )}
      {actions}
    </PromptCard>
  )
}
