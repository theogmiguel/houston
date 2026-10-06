import type { ButtonHTMLAttributes, ComponentType, HTMLAttributes, LabelHTMLAttributes, ReactNode } from 'react'
import { BTN_PRIMARY } from './buttonChrome'
import { OVERLAY_RAISED_ATTRS, OVERLAY_RAISED_CLS } from './overlayChrome'
import { FOCUS_HALO } from './shadowChrome'
import { Text, type TextProps } from './Text'

type NoClass<T> = Omit<T, 'className'>
const TextButton = Text as ComponentType<TextProps & ButtonHTMLAttributes<HTMLButtonElement>>

const PILL_BASE_CLS = `inline-flex items-center h-[var(--h-pill)] px-[var(--space-2)] border border-[var(--border)] bg-[var(--surface)] rounded-[var(--tr-radius-pill)] hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:shadow-[${FOCUS_HALO}]`

const PILL_VARIANT_CLS = {
  dropdown: 'gap-[var(--space-1-5)] max-w-full disabled:opacity-50 disabled:cursor-not-allowed',
  count: ''
} as const

/** Pill trigger for a composer menu: `dropdown` carries an icon, label and chevron; `count` is the "+N" overflow trigger. */
export function ComposerPill({ variant, children, ...rest }: NoClass<ButtonHTMLAttributes<HTMLButtonElement>> & {
  variant: keyof typeof PILL_VARIANT_CLS
  children: ReactNode
  'data-testid'?: string
}): React.JSX.Element {
  return <TextButton
    {...rest}
    as="button"
    type="button"
    size="small"
    weight="medium"
    tone="secondary"
    leading={variant === 'dropdown' ? 'small' : undefined}
    className={`${PILL_BASE_CLS} ${PILL_VARIANT_CLS[variant]}`}
  >{children}</TextButton>
}

/** The number inside a `count` pill, set in tabular figures so the pill does not jitter as it changes. */
export function ComposerPillCount({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text tabular>{children}</Text>
}

const MENU_VARIANT_CLS = {
  options: 'left-0 gap-[var(--space-0-5)] py-[var(--space-1)] min-w-[var(--w-composer-option-menu)]',
  fields: 'right-0 gap-[var(--space-2)] p-[var(--space-2)] min-w-[var(--w-composer-field-menu)]'
} as const

/** Raised menu under a pill: `options` is a left-aligned list of choices, `fields` a right-aligned stack of labelled controls. */
export function ComposerPillMenu({ variant, children, ...rest }: NoClass<HTMLAttributes<HTMLDivElement>> & {
  variant: keyof typeof MENU_VARIANT_CLS
  children: ReactNode
  'data-testid'?: string
}): React.JSX.Element {
  return (
    <div {...rest} {...OVERLAY_RAISED_ATTRS} className={`${OVERLAY_RAISED_CLS} absolute top-[calc(100%+var(--space-1))] z-[var(--z-sticky)] flex flex-col ${MENU_VARIANT_CLS[variant]}`}>
      {children}
    </div>
  )
}

/** One choice in a pill's option list; the selected choice is bolder and primary ink. */
export function ComposerPillOption({ selected, children, ...rest }: NoClass<ButtonHTMLAttributes<HTMLButtonElement>> & {
  selected: boolean
  children: ReactNode
  'data-testid'?: string
}): React.JSX.Element {
  return <TextButton
    {...rest}
    as="button"
    type="button"
    size="small"
    weight={selected ? 'semibold' : 'medium'}
    tone={selected ? 'primary' : 'secondary'}
    role="option"
    aria-selected={selected}
    className="flex items-center px-[var(--space-3)] min-h-[var(--h-ctl)] text-left bg-transparent border-none hover:bg-[var(--surface-hover)]"
  >{children}</TextButton>
}

/** Label wrapper for one control inside the overflow menu. */
export function ComposerPillField({ children, ...rest }: NoClass<LabelHTMLAttributes<HTMLLabelElement>> & { children: ReactNode }): React.JSX.Element {
  return <Text as="label" {...rest} size="small" tone="secondary" className="flex items-center justify-between gap-[var(--space-2)]">{children}</Text>
}

/** Row that lays composer pills out from the start with the send action pushed to the end. */
export function ComposerBar({ className = '', children, ...rest }: Omit<HTMLAttributes<HTMLDivElement>, 'className'> & {
  /** Layout classes only. */
  className?: string
  children: ReactNode
  'data-testid'?: string
}): React.JSX.Element {
  return (
    <div {...rest} className={`flex items-center gap-[var(--space-1-5)] flex-wrap ${className}`}>
      {children}
    </div>
  )
}

/** Primary send action of a composer; `loading` shows a spinner and blocks the click. */
export function ComposerSendButton({ loading, disabled, children, ...rest }: NoClass<ButtonHTMLAttributes<HTMLButtonElement>> & {
  loading: boolean
  children: ReactNode
  'data-testid'?: string
}): React.JSX.Element {
  return (
    <TextButton
      {...rest}
      as="button"
      type="button"
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      size="small"
      className={`btn ${BTN_PRIMARY} ml-auto h-[var(--h-pill)] px-[var(--space-3)] rounded-[var(--tr-radius-pill)] inline-flex items-center gap-[var(--space-1-5)] disabled:opacity-40 disabled:cursor-not-allowed`}
    >
      {loading && (
        <span
          role="status"
          aria-label="Loading"
          className="inline-block h-[var(--tr-icon-small-size)] w-[var(--tr-icon-small-size)] animate-spin rounded-[var(--tr-radius-pill)] [border-width:var(--tr-spinner-border)] border-current border-t-transparent opacity-70"
        />
      )}
      {children}
    </TextButton>
  )
}
