import type { ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react'
import { CONTROL_SIZE_SQUARE_CLS } from '../controlSize'
import { RVIEW_CLS } from './panelChrome'
import { Text } from './Text'
import { TextArea } from './TextArea'
import { TextInput } from './TextInput'

const BAR_BASE = 'border-b border-[var(--panel-surface-border)] bg-surface flex-none'

const BAR_VARIANT = {
  title: 'flex items-center justify-between gap-3 pt-4 px-4 pb-[var(--space-panel-section-bottom)]',
  toolbar: 'flex items-center gap-2 py-2.5 px-4',
  edit: 'flex items-center gap-2.5 py-3 px-4'
} as const

export interface PaneViewBarProps extends HTMLAttributes<HTMLDivElement> {
  variant: keyof typeof BAR_VARIANT
}

/** A strip across the top of a pane view: its title, its toolbar or its editor header. */
export function PaneViewBar({ variant, className = '', ...props }: PaneViewBarProps): React.JSX.Element {
  return <div {...props} className={`${BAR_VARIANT[variant]} ${BAR_BASE} ${className}`} />
}

const BODY_VARIANT = {
  list: 'p-4 flex flex-col gap-7',
  form: 'py-4 px-4 flex flex-col gap-4'
} as const

/** The scrolling body of a pane view. */
export function PaneViewBody({ variant, children }: { variant: keyof typeof BODY_VARIANT; children: ReactNode }): React.JSX.Element {
  return <div className={`flex-1 min-h-0 overflow-y-auto ${BODY_VARIANT[variant]}`}>{children}</div>
}

/** The 32px gradient tile that heads a pane view. */
export function PaneViewBadge({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <span className="inline-flex items-center justify-center w-[var(--w-pane-badge)] h-[var(--h-pane-badge)] rounded-[var(--tr-radius-button)] flex-none text-info bg-[image:var(--panel-badge-fill)] border border-[var(--panel-badge-border)]">
      {children}
    </span>
  )
}

export function PaneViewCount({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <Text as="span" size="small" weight="medium" tone="dimmer" tabular className="bg-[var(--panel-count-fill)] border border-[var(--panel-count-border)] rounded-[var(--tr-radius-pill)] py-[var(--space-pane-count-y)] px-[var(--space-pane-count-x)]">
      {children}
    </Text>
  )
}

/** The square button that leaves an editor without saving. */
export function PaneViewCloseButton({ className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  return (
    <button
      type="button"
      {...props}
      className={`btn inline-flex items-center justify-center ${CONTROL_SIZE_SQUARE_CLS.regular} rounded-[var(--tr-radius-md)] flex-none bg-[var(--panel-count-fill)] border border-[var(--panel-count-border)] text-text-muted cursor-pointer hover:text-text-primary hover:bg-[var(--panel-control-hover)] ${className}`}
    />
  )
}

/** The accent-tinted save action of an editor header. */
export function PaneViewSaveButton({ className = '', children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  return (
    <button
      type="button"
      {...props}
      className={`btn inline-flex items-center gap-1.5 py-2 px-3.5 rounded-[var(--tr-radius-md)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-primary bg-[var(--panel-save-fill)] border border-[var(--panel-save-border)] cursor-pointer whitespace-nowrap flex-none [transition:background_var(--transition-pane-save)_ease] hover:bg-[var(--panel-save-hover)] disabled:opacity-60 disabled:cursor-default ${className}`}
    >{children}</button>
  )
}

/** A message above a pane view's form or list, for an error that blocks the action. */
export function PaneViewNotice({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-2 py-[var(--space-pane-notice-y)] px-[var(--space-pane-notice-x)] rounded-[var(--tr-radius-card)] border border-[var(--panel-error-border)] bg-[var(--panel-error-fill)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-danger flex-none">
      {children}
    </div>
  )
}

export function PaneViewInput({ className = '', ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, 'width' | 'size' | 'height'>): React.JSX.Element {
  return <TextInput {...props} variant="pane" className={className} />
}

export function PaneViewTextArea({ className = '', ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>): React.JSX.Element {
  return <TextArea {...props} recipe="pane" className={className} />
}

/** A provider choice in a pane view's form, rendered as a pill. */
export function PaneViewPill({ selected, className = '', children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { selected: boolean }): React.JSX.Element {
  return (
    <button
      type="button"
      {...props}
      className={`btn py-[var(--space-pane-pill-y)] px-[var(--space-pane-pill-x)] rounded-[var(--tr-radius-pill)] border [font-size:var(--tr-text-small-size)] font-medium cursor-pointer disabled:opacity-55 disabled:cursor-default ${
        selected
          ? 'text-primary bg-[var(--panel-save-fill)] border-[var(--panel-pill-selected-border)]'
          : 'text-text-muted bg-[var(--panel-pill-fill)] border-[var(--panel-count-border)] hover:bg-[var(--panel-count-border)] hover:text-text-secondary'
      } ${className}`}
    >{children}</button>
  )
}

/** The root of a view that fills a leaf pane; `scroll` lets the whole view scroll. */
export function PaneViewRoot({ scroll = false, children }: { scroll?: boolean; children: ReactNode }): React.JSX.Element {
  return <div className={`${RVIEW_CLS} relative bg-background ${scroll ? 'overflow-y-auto' : ''}`}>{children}</div>
}
