import type { ButtonHTMLAttributes, HTMLAttributes } from 'react'
import { Text } from './Text'

type SpanProps = HTMLAttributes<HTMLSpanElement>

const cx = (...parts: (string | false | null | undefined)[]): string => parts.filter(Boolean).join(' ')

const KEY_CHIP_CLS = cx(
  'inline-flex items-center gap-[var(--task-tag-gap)] h-[var(--h-tag-chip)] px-[var(--space-1-5)] rounded-[var(--tr-radius-sm)] bg-[var(--task-tag-fill)] border-0 flex-none cursor-pointer text-[length:var(--tr-text-xs)] text-[var(--text-secondary)] font-mono [&_svg]:size-[var(--task-key-icon-size)]',
  'hover:bg-[var(--task-tag-hover-fill)] hover:text-[var(--text-primary)]'
)

export interface TaskKeyChipProps {
  /** Tightens the horizontal padding for a roster row. */
  compact?: boolean
}

/** The bound task's status glyph and key, as a button. */
export function TaskKeyChip({ compact = false, className, children, ...props }: TaskKeyChipProps & ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  return <button type="button" {...props} className={cx(KEY_CHIP_CLS, compact && 'px-[var(--task-chip-compact-inset)]', className)}>{children}</button>
}

/** The same chip as static text. */
export function TaskKeyTag({ compact = false, className, children, ...props }: TaskKeyChipProps & SpanProps): React.JSX.Element {
  return (
    <Text
      as="span"
      {...props}
      size="xs"
      tone="secondary"
      mono
      className={cx(KEY_CHIP_CLS, compact && 'px-[var(--task-chip-compact-inset)]', className)}
    >
      {children}
    </Text>
  )
}
