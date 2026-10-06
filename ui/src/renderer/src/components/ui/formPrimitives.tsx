import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react'
import { Select, type SelectProps } from './Select'
import { Text } from './Text'

// A form field is taller than a toolbar control (--h-ctl is 28px): 36px for a
// single-line input, 88px for the shortest textarea.
const FIELD_INPUT_HEIGHT_CLS = 'h-[var(--h-form-control)]'
const FIELD_TEXTAREA_MIN_CLS = 'min-h-[var(--h-form-textarea-min)]'

const BUTTON_BASE =
  'btn inline-flex items-center justify-center gap-[var(--space-form-button-gap)] min-h-[var(--h-ctl)] px-[var(--space-field-control-inline)] rounded-[var(--tr-radius-sm)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] cursor-pointer disabled:cursor-default'
const BUTTON_TONE = {
  primary: 'border border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-ink)] hover:brightness-110 disabled:opacity-55',
  secondary: 'border border-[var(--border)] bg-[var(--hover-fill)] text-[var(--text-secondary)] hover:bg-[var(--selected-fill)] hover:text-[var(--text-primary)] disabled:opacity-55'
} as const
const BUTTON_MIN_WIDTH = { sm: 'min-w-[var(--w-form-button-sm)]', md: 'min-w-[var(--w-form-button-md)]' } as const

export interface FieldActionButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: keyof typeof BUTTON_TONE
  minWidth?: keyof typeof BUTTON_MIN_WIDTH
}

/** A compact text button for forms, dialogs and report toolbars. */
export function FieldActionButton({ tone = 'secondary', minWidth, type = 'button', className = '', children, ...rest }: FieldActionButtonProps): React.JSX.Element {
  return (
    <button
      {...rest}
      type={type}
      className={`${BUTTON_BASE} ${BUTTON_TONE[tone]} ${minWidth ? BUTTON_MIN_WIDTH[minWidth] : ''} ${className}`}
    ><Text as="span" size="small" weight="small">{children}</Text></button>
  )
}

const FIELD_INPUT_CLS =
  `w-full ${FIELD_INPUT_HEIGHT_CLS} px-[var(--space-field-control-inline)] rounded-[var(--tr-radius-sm)] border border-[var(--border)] bg-[var(--card-bg)] [font-size:var(--tr-text-ui-size)] font-medium text-[var(--text-primary)] outline-0 [font-family:inherit] placeholder:text-[var(--text-secondary)] focus-visible:border-[var(--accent)] disabled:opacity-[0.72]`
const FIELD_INPUT_WIDTH = { full: '', md: 'w-[var(--w-field-control-md)]', sm: 'w-[var(--w-field-control-sm)]' } as const

export interface FieldControlProps extends InputHTMLAttributes<HTMLInputElement> {
  width?: keyof typeof FIELD_INPUT_WIDTH
}

export function FieldControl({ width = 'full', className = '', ...rest }: FieldControlProps): React.JSX.Element {
  return <input {...rest} className={`${FIELD_INPUT_CLS} ${FIELD_INPUT_WIDTH[width]} ${className}`} />
}

const FIELD_TEXTAREA_CLS =
  `w-full ${FIELD_TEXTAREA_MIN_CLS} resize-y px-[var(--space-field-control-inline)] py-[var(--space-form-textarea-block)] rounded-[var(--tr-radius-sm)] border border-[var(--border)] bg-[var(--card-bg)] [font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)] leading-[1.5] text-[var(--text-primary)] outline-0 [font-family:inherit] placeholder:text-[var(--text-secondary)] focus-visible:border-[var(--accent)] disabled:opacity-[0.72]`

export function FormTextarea({ className = '', ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>): React.JSX.Element {
  return <textarea {...rest} className={`${FIELD_TEXTAREA_CLS} ${className}`} />
}

/** A Select used as a full-width field control. */
export function FormSelect(props: Omit<SelectProps, 'className' | 'width'>): React.JSX.Element {
  return <Select {...props} className="w-full" />
}

const FIELD_LABEL_CLS =
  'block pb-[var(--space-field-label-after)]'

/** A labelled form row. Consecutive rows are separated by the field rhythm. */
export function FormField({ label, htmlFor, children }: { label?: string; htmlFor?: string; children: ReactNode }): React.JSX.Element {
  return (
      <div className="min-w-0">
      {label !== undefined && (htmlFor ? (
        <Text as="label" className={FIELD_LABEL_CLS} size="small" weight="semibold" tone="secondary" htmlFor={htmlFor}>{label}</Text>
      ) : (
        <Text as="span" className={FIELD_LABEL_CLS} size="small" weight="semibold" tone="secondary">{label}</Text>
      ))}
      {children}
    </div>
  )
}

/** One-line hint under a field's control. */
export function FormHint({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <Text as="p" size="small" weight="small" leading="small" tone="faint" className="-mt-[var(--space-form-hint-overlap)]">
      {children}
    </Text>
  )
}

/** Controls that sit on one line under a field label, below the field's own control. */
export function FormSubRow({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div className="pt-[var(--space-form-subrow-top)]">
      <div className="flex items-center gap-[var(--space-form-subrow-gap)]">{children}</div>
    </div>
  )
}

/** A wrapping row of choice chips. */
export function ChipGroup({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex flex-wrap gap-[var(--space-choice-group-gap)]">{children}</div>
}

const CHOICE_CHIP_BASE =
  'btn min-h-[var(--h-ctl)] px-[var(--space-choice-chip-inline)] rounded-[var(--tr-radius-sm)] border border-[var(--border)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] cursor-pointer disabled:cursor-default disabled:opacity-60'
const CHOICE_CHIP_ON = 'bg-[var(--selected-fill)] font-semibold text-[var(--text-primary)]'
const CHOICE_CHIP_OFF =
  'bg-[var(--hover-fill)] font-medium text-[var(--text-secondary)] hover:not-disabled:bg-[var(--selected-fill)] hover:not-disabled:text-[var(--text-primary)]'

/** A toggle button in a chip group; `pressed` marks the current choice. */
export function ChoiceChip({ pressed, className = '', type = 'button', children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { pressed: boolean }): React.JSX.Element {
  return (
    <button
      {...rest}
      type={type}
      aria-pressed={pressed}
      className={`${CHOICE_CHIP_BASE} ${pressed ? CHOICE_CHIP_ON : CHOICE_CHIP_OFF} ${className}`}
    ><Text as="span" size="small" weight="small">{children}</Text></button>
  )
}

/** A secondary-coloured underlined action that sits at the end of an inline row. */
export function InlineLinkButton({ className = '', type = 'button', children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  return (
    <button
      {...rest}
      type={type}
      className={`btn ml-auto border-0 bg-transparent p-0 [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-secondary)] underline cursor-pointer hover:text-[var(--text-primary)] ${className}`}
    ><Text as="span" size="small" weight="small" tone="secondary">{children}</Text></button>
  )
}

const TOGGLE_ROW_MIN_CLS = 'min-h-[var(--h-form-toggle-row)]'

/** A bordered row with a label on the start and a switch on the end. */
export function FormToggleRow({ label, children }: { label: ReactNode; children: ReactNode }): React.JSX.Element {
  return (
    <div className={`flex items-center gap-[var(--space-form-toggle-gap)] ${TOGGLE_ROW_MIN_CLS} px-[var(--space-form-toggle-inline)] py-[var(--space-form-toggle-block)] rounded-[var(--tr-radius-button)] border border-[var(--border)] bg-[var(--content-bg)]`}>
      <Text className="flex-1 min-w-0" size="small" tone="secondary">{label}</Text>
      {children}
    </div>
  )
}

const FOOTER_MIN_CLS = 'min-h-[var(--h-form-panel-footer)]'

/** A full-height form: scrolling body above a footer bar. */
export function FormPanel({ children, ...rest }: React.FormHTMLAttributes<HTMLFormElement>): React.JSX.Element {
  return <form {...rest} className="flex-1 min-h-0 flex flex-col overflow-hidden">{children}</form>
}

export function FormPanelBody({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex-1 min-h-0 overflow-y-auto px-[var(--space-form-panel-inset)] py-[var(--space-form-panel-block)] grid content-start gap-[var(--space-form-row-top)]">{children}</div>
}

export function FormPanelFooter({ note, children }: { note: ReactNode; children: ReactNode }): React.JSX.Element {
  return (
    <div className={`flex-none flex items-center gap-[var(--space-form-footer-gap)] ${FOOTER_MIN_CLS} px-[var(--space-form-footer-inline)] py-[var(--space-form-footer-block)] border-t border-[var(--divider)]`}>
      <Text className="flex-1" size="small" weight="small" tone="secondary">{note}</Text>
      {children}
    </div>
  )
}
