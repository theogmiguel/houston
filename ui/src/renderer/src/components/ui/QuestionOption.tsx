import type { HTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react'
import { HIT_TARGET_28 } from '../hitTarget'
import { IconCheck } from '../icons'
import { Card } from './Card'
import { Icon } from './Icon'
import { IconTile } from './IconTile'
import { Text } from './Text'
import { FOCUS_HALO } from './shadowChrome'

// The pieces of a QuestionCard: pager, prompt, option rows and their states.

export function PromptCard({
  tone,
  className = '',
  ...props
}: { tone: 'danger' | 'surface'; disabled: boolean; className?: string; children: ReactNode } & HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <Card
      {...props}
      tone={tone}
      shape="card"
      padding="md"
      clip={false}
      className={`flex flex-col gap-[var(--space-3)] ${className}`}
    />
  )
}

export function PromptHeader({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text as="div" size="small" tone="muted" className="flex items-center justify-between">{children}</Text>
}

export function QuestionPager({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <span data-testid="question-card-pager" className="tabular-nums">
      {children}
    </span>
  )
}

export function SkipButton({ disabled, onClick }: { disabled: boolean; onClick?: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid="question-card-skip"
      disabled={disabled}
      onClick={onClick}
      className={`border-0 bg-transparent rounded-[var(--tr-radius-sm)] px-[var(--space-1-5)] hover:bg-[var(--surface-hover)] active:scale-[0.96] focus-visible:outline-none focus-visible:shadow-[${FOCUS_HALO}] disabled:opacity-50 disabled:cursor-not-allowed ${HIT_TARGET_28}`}
    >
      Skip
    </button>
  )
}

export function PromptText({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <Text
      data-testid="question-card-question"
      as="div"
      size="ui"
      weight="medium"
      tone="primary"
    >
      {children}
    </Text>
  )
}

export function RetryMessage({ message, onRetry }: { message: string; onRetry: () => void }): React.JSX.Element {
  return (
    <div className="flex items-center gap-[var(--space-2)]">
      <Text className="flex-1" size="small" tone="blocked">{message}</Text>
      <button
        type="button"
        onClick={onRetry}
        className={`bg-transparent rounded-[var(--tr-radius-button)] px-[var(--space-2)] h-[var(--h-ctl-mini)] border border-current text-[length:var(--tr-text-small-size)] font-semibold focus-visible:outline-none focus-visible:shadow-[${FOCUS_HALO}] ${HIT_TARGET_28}`}
      >
        Try again
      </button>
    </div>
  )
}

export function QuestionNote(props: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <Text as="div" {...props} size="small" tone="muted" />
}

export function FreeTextArea(props: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'className'>): React.JSX.Element {
  return (
    <textarea
      {...props}
      className={`w-full resize-none rounded-[var(--tr-radius-input)] border border-[var(--border)] bg-[var(--background)] px-[var(--space-2)] py-[var(--space-1-5)] text-[length:var(--tr-text-ui-size)] text-[var(--text-primary)] focus-visible:outline-none focus-visible:shadow-[${FOCUS_HALO}] disabled:opacity-50 disabled:cursor-not-allowed`}
    />
  )
}

export function OptionList({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div
      data-testid="question-card-options"
      className="flex max-h-[var(--h-question-options-max)] flex-col gap-[var(--space-1-5)] overflow-y-auto"
    >
      {children}
    </div>
  )
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

export function OptionButton({
  n,
  checked,
  multi,
  disabled,
  label,
  onClick
}: {
  n: number
  checked: boolean
  multi: boolean
  disabled: boolean
  label: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid="question-card-option"
      aria-pressed={checked}
      disabled={disabled}
      onClick={onClick}
      className={`border-0 flex h-[var(--h-row)] items-center gap-[var(--space-2)] rounded-[var(--tr-radius-sm)] px-[var(--space-1-5)] text-left hover:bg-[var(--surface-hover)] active:scale-[0.995] focus-visible:outline-none focus-visible:shadow-[${FOCUS_HALO}] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent ${
        checked ? 'bg-[var(--accent-muted)]' : 'bg-transparent'
      }`}
    >
      <NumberTile n={n} />
      {multi && (
        <span
          aria-hidden
          data-testid="question-card-checkbox"
          data-checked={checked}
          className={`inline-flex h-[var(--h-tag-chip)] w-[var(--h-tag-chip)] flex-none items-center justify-center rounded-[var(--tr-radius-input)] border ${
            checked ? 'border-[var(--accent)] bg-[var(--accent)]' : 'border-[var(--border)] bg-transparent'
          }`}
        >
          {checked && <Icon glyph={IconCheck} role="label" />}
        </span>
      )}
      <Text className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap" size="ui" tone="primary">
        {label}
      </Text>
    </button>
  )
}

export function FreeTextOption({ n, disabled, onClick }: { n: number; disabled: boolean; onClick: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid="question-card-escape-hatch"
      disabled={disabled}
      onClick={onClick}
      className={`border-0 bg-transparent flex h-[var(--h-row)] items-center gap-[var(--space-2)] rounded-[var(--tr-radius-sm)] px-[var(--space-1-5)] text-left hover:bg-[var(--surface-hover)] active:scale-[0.995] focus-visible:outline-none focus-visible:shadow-[${FOCUS_HALO}] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent`}
    >
      <NumberTile n={n} />
      <Text size="ui" tone="muted">Type it your own</Text>
    </button>
  )
}

export function OptionButtonSpecimen(): React.JSX.Element {
  return (
    <PromptCard tone="surface" disabled={false}>
      <PromptHeader>
        <QuestionPager>‹ 1 of 2 ›</QuestionPager>
        <SkipButton disabled={false} />
      </PromptHeader>
      <PromptText>Which change should land first?</PromptText>
      <OptionList>
        <OptionButton n={1} checked multi disabled={false} label="Add regression tests" onClick={() => {}} />
        <OptionButton n={2} checked={false} multi={false} disabled={false} label="Update the docs" onClick={() => {}} />
        <FreeTextOption n={3} disabled={false} onClick={() => {}} />
      </OptionList>
      <FreeTextArea rows={2} defaultValue="Free text" />
      <QuestionNote>No options</QuestionNote>
      <RetryMessage message="Could not load the options." onRetry={() => {}} />
    </PromptCard>
  )
}
