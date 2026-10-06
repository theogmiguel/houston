import type { ButtonHTMLAttributes, HTMLAttributes, LabelHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react'
import { BTN_PRIMARY } from './buttonChrome'
import { MATERIAL_CLS, materialAttrs } from './material'
import { Text } from './Text'

type NoClass<T> = Omit<T, 'className'>

/** Docked panel that holds the new-session composer: header row, scrolling body, footer row. */
export function DockedFormPanel({ children, ...rest }: NoClass<HTMLAttributes<HTMLDivElement>> & {
  children: ReactNode
  'data-testid'?: string
}): React.JSX.Element {
  return (
    <div
      {...rest}
      {...materialAttrs('base')}
      className={`flex-none min-w-0 h-full w-[var(--w-docked-form-panel)] max-w-[var(--w-docked-form-viewport-max)] grid grid-rows-[var(--h-top)_minmax(0,1fr)_var(--h-action-footer)] rounded-tl-[var(--r-content)] rounded-bl-[var(--r-content)] ${MATERIAL_CLS.base}`}
    >
      {children}
    </div>
  )
}

/** Scrolling body of the composer: a centred column of sections. */
export function ScrollableFormBody({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div className="min-h-0 overflow-y-auto px-[var(--space-4-5)]">
      <div className="mx-auto flex w-full max-w-[var(--w-form-body)] flex-col gap-[var(--space-3)] pb-[var(--space-6)] pt-[calc(var(--space-3)+var(--space-0-5))]">{children}</div>
    </div>
  )
}

/** Fieldset whose legend is a small uppercase label. */
export function OptionFieldset({ legend, children }: { legend: string; children: ReactNode }): React.JSX.Element {
  return (
    <fieldset className="m-0 flex flex-col gap-[var(--space-2)] border-0 p-0">
      <Text as="legend" size="label" weight="label" tone="faint" leading="label" className="block p-0">{legend}</Text>
      {children}
    </fieldset>
  )
}

export function PresetGrid({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="grid grid-cols-4 gap-[var(--space-card-grid-gap)]">{children}</div>
}

export function SlotList({ children, ...rest }: { children: ReactNode; 'data-testid'?: string }): React.JSX.Element {
  return <div {...rest} className="grid grid-cols-1 gap-[var(--space-card-grid-gap)]">{children}</div>
}

/** Row for the default-agent select with the slot counter beside it, aligned on the control baseline. */
export function InlineControlRow({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-[var(--space-3)]">{children}</div>
}

/** A labelled control: `label` wraps the control in a `<label>`, `group` uses a plain container. */
export function LabeledControl({ label, as, className = '', children }: {
  label: string
  as: 'label' | 'group'
  /** Layout classes only. */
  className?: string
  children: ReactNode
}): React.JSX.Element {
  const Tag = as === 'label' ? 'label' : 'div'
  return (
    <Tag className={`flex flex-col gap-[var(--space-1)] ${className}`}>
      <Text size="label" weight="label" tone="faint" leading="label" className="block">{label}</Text>
      {children}
    </Tag>
  )
}

/** Minus, count and plus control; the buttons disable at `min` and `max`. */
export function CountStepper({ value, min, max, onChange }: {
  value: number
  min: number
  max: number
  onChange: (next: number) => void
}): React.JSX.Element {
  return (
    <div className="flex h-[var(--h-ctl)] items-center rounded-[var(--tr-radius-sm)] border border-[var(--border)]">
      <button type="button" aria-label="Fewer" disabled={value <= min} onClick={() => onChange(Math.max(min, value - 1))} className="h-full w-[var(--w-stepper-button)] border-0 bg-transparent disabled:opacity-40"><Text tone="secondary">−</Text></button>
      <Text data-testid="new-session-count" size="small" tabular className="min-w-[var(--h-ctl-mini)] text-center">{value}</Text>
      <button type="button" aria-label="More" disabled={value >= max} onClick={() => onChange(Math.min(max, value + 1))} className="h-full w-[var(--w-stepper-button)] border-0 bg-transparent disabled:opacity-40"><Text tone="secondary">+</Text></button>
    </div>
  )
}

/** Titled block of the composer body. */
export function FormSection({ children, ...rest }: NoClass<HTMLAttributes<HTMLElement>> & { children: ReactNode }): React.JSX.Element {
  return <section {...rest} className="flex flex-col gap-[var(--space-2)]">{children}</section>
}

export function SectionHeading({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text as="h2" size="label" weight="label" tone="faint" leading="label" flush>{children}</Text>
}

/** Vertical group for one input with its label, error and counter. */
export function FieldGroup({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex flex-col gap-[var(--space-1-5)]">{children}</div>
}

export function FormLabel({ children, ...rest }: NoClass<LabelHTMLAttributes<HTMLLabelElement>> & { children: ReactNode }): React.JSX.Element {
  return <Text as="label" {...rest} size="label" weight="label" tone="faint" leading="label" className="block">{children}</Text>
}

/** Multi-line task input: one line tall at rest, user-resizable between the composer input height tokens. */
export function TaskInput(props: NoClass<TextareaHTMLAttributes<HTMLTextAreaElement>> & { 'data-testid'?: string }): React.JSX.Element {
  return (
    <Text as="div" size="ui" weight="ui" tone="primary" leading="composer" className="contents">
      <textarea
        {...props}
        className="block w-full min-h-[var(--h-task-input-min)] max-h-[var(--h-task-input-max)] resize-y rounded-[var(--tr-radius-button)] border border-[var(--border)] bg-[var(--card-bg)] px-[var(--space-3)] py-[var(--space-task-field-block)] [font:inherit] leading-[inherit] text-inherit placeholder:text-[var(--text-muted)] focus:[border-color:var(--accent)] focus:outline-none focus-visible:[border-color:var(--accent)]"
      />
    </Text>
  )
}

export function FieldError({ children, ...rest }: NoClass<HTMLAttributes<HTMLParagraphElement>> & { children: ReactNode; 'data-testid'?: string }): React.JSX.Element {
  return (
    <Text as="p" {...rest} size="small" weight="small" tone="danger" flush>
      {children}
    </Text>
  )
}

/** Mono readout under a field, aligned to its end. */
export function FieldCounter({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text size="xs" tone="faint" mono className="self-end">{children}</Text>
}

/** Muted small text for a routing note or one route. */
export function RouteNote({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text size="small" tone="muted">{children}</Text>
}

export function RouteList({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex flex-wrap gap-[var(--space-2)]">{children}</div>
}

/** Footer row: a summary on the start side and the launch action on the end. */
export function ActionFooter({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex items-center gap-[var(--space-action-footer-gap)] border-t border-[var(--border)] px-[var(--space-action-footer-inline)]">{children}</div>
}

export function InlineSummary({ children, ...rest }: NoClass<HTMLAttributes<HTMLSpanElement>> & { children: ReactNode; 'data-testid'?: string }): React.JSX.Element {
  return (
    <Text as="span" {...rest} size="small" weight="small" tone="muted" className="flex-1 min-w-0 truncate">
      {children}
    </Text>
  )
}

export function PrimaryAction({ children, ...rest }: NoClass<ButtonHTMLAttributes<HTMLButtonElement>> & { children: ReactNode; 'data-testid'?: string }): React.JSX.Element {
  return (
    <button
      {...rest}
      type="button"
      className={`btn ${BTN_PRIMARY} inline-flex h-[var(--h-primary-action)] items-center rounded-[var(--tr-radius-button)] px-[var(--space-5)] disabled:opacity-40 disabled:cursor-not-allowed`}
    >
      <Text size="ui" weight="ui" className="contents">{children}</Text>
    </button>
  )
}
