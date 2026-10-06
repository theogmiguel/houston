import type { ButtonHTMLAttributes, InputHTMLAttributes, LabelHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react'
import { IconChevronDown, IconChevronLeft } from '../icons'
import { Icon } from './Icon'
import { Text } from './Text'
export { PanelFootnote, PanelIconButton, PanelSwitch, type PanelIconButtonProps, type PanelSwitchProps } from './PanelInlineControls'

const BUTTON_BASE = 'btn inline-flex items-center justify-center gap-[var(--space-panel-button-gap)] min-h-[var(--h-ctl)] px-[var(--space-panel-control-x)] rounded-[var(--tr-radius-sm)] border [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] cursor-pointer disabled:cursor-default'

const BUTTON_TONE = {
  primary: 'border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-ink)] hover:brightness-110 disabled:opacity-55',
  secondary: 'border-[var(--border)] bg-[var(--hover-fill)] text-[var(--text-secondary)] hover:bg-[var(--selected-fill)] hover:text-[var(--text-primary)] disabled:opacity-55',
  'secondary-danger': 'border-[var(--border)] bg-[var(--hover-fill)] text-[var(--text-secondary)] hover:bg-[var(--selected-fill)] hover:text-[var(--text-primary)] disabled:opacity-55 hover:not-disabled:text-[var(--danger)]!'
} as const

export interface PanelButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: keyof typeof BUTTON_TONE
}

/** A text button for panel and list chrome, one rung tighter than `Button`. */
export function PanelButton({ tone = 'secondary', type = 'button', className = '', children, ...props }: PanelButtonProps): React.JSX.Element {
  return <button {...props} type={type} className={`${BUTTON_BASE} ${BUTTON_TONE[tone]} ${className}`}>{children}</button>
}

export interface PanelChoiceProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  pressed: boolean
}

/** One option of a small single-choice group, such as the provider picker. */
export function PanelChoice({ pressed, type = 'button', className = '', children, ...props }: PanelChoiceProps): React.JSX.Element {
  return (
    <button
      {...props}
      type={type}
      aria-pressed={pressed}
      className={`btn min-h-[var(--h-panel-choice)] px-[var(--space-panel-choice-x)] rounded-[var(--tr-radius-sm)] border border-[var(--border)] [font-size:var(--tr-text-small-size)] font-medium cursor-pointer disabled:cursor-default disabled:opacity-60 ${
        pressed
          ? 'bg-[var(--selected-fill)] text-[var(--text-primary)]'
          : 'bg-[var(--hover-fill)] text-[var(--text-secondary)] hover:not-disabled:bg-[var(--selected-fill)] hover:not-disabled:text-[var(--text-primary)]'
      } ${className}`}
    >{children}</button>
  )
}

export function PanelFieldLabel({ className = '', ...props }: LabelHTMLAttributes<HTMLLabelElement>): React.JSX.Element {
  return <Text as="label" {...props} size="small" weight="semibold" tone="secondary" className={`block pb-[var(--space-panel-label-bottom)] ${className}`} />
}

const INPUT_BASE = 'w-full px-[var(--space-panel-control-x)] rounded-[var(--tr-radius-sm)] border border-[var(--border)] bg-[var(--card-bg)] [font-size:var(--tr-text-ui-size)] font-medium text-[var(--text-primary)] outline-0 [font-family:inherit] placeholder:text-[var(--text-secondary)] focus-visible:border-[var(--accent)] disabled:opacity-[var(--panel-disabled-opacity)]'

export interface PanelTextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** `control` is the 28px toolbar height; `field` is the 36px form height. */
  size?: never
  height?: 'field' | 'control'
}

export function PanelTextInput({ height = 'field', className = '', ...props }: PanelTextInputProps): React.JSX.Element {
  return <input {...props} className={`${INPUT_BASE} ${height === 'control' ? 'h-[var(--h-ctl)]' : 'h-[var(--h-panel-field)]'} ${className}`} />
}

const TEXTAREA_BASE = 'w-full min-h-[var(--h-panel-textarea-min)] resize-y px-[var(--space-panel-control-x)] py-[var(--space-panel-textarea-y)] rounded-[var(--tr-radius-sm)] border border-[var(--border)] bg-[var(--card-bg)] [font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)] [line-height:var(--tr-text-ui-leading)] text-[var(--text-primary)] outline-0 [font-family:inherit] placeholder:text-[var(--text-secondary)] focus-visible:border-[var(--accent)] disabled:opacity-[var(--panel-disabled-opacity)]'

export interface PanelTextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** Grow to fill the flex column that holds it, in monospace. */
  fill?: boolean
}

export function PanelTextArea({ fill = false, className = '', ...props }: PanelTextAreaProps): React.JSX.Element {
  return <textarea {...props} className={`${TEXTAREA_BASE} ${fill ? 'flex-1 min-h-0 font-mono' : ''} ${className}`} />
}

/** The 42px bar that returns from a detail view to its list, with trailing actions. */
export function PanelBackBar({ label, onClick, children }: { label: string; onClick: () => void; children?: ReactNode }): React.JSX.Element {
  return (
    <div className="flex-none flex items-center gap-[var(--space-2)] h-[var(--h-panel-backbar)] px-[var(--space-panel-detail-x)] border-b border-[var(--divider)]">
      <button
        type="button"
        data-testid="nav-back"
        className="btn inline-flex items-center gap-[var(--space-1)] p-0 border-0 bg-transparent [font-size:var(--tr-text-small-size)] font-semibold text-[var(--text-secondary)] cursor-pointer hover:text-[var(--text-primary)]"
        onClick={onClick}
      >
        <Icon glyph={IconChevronLeft} role="label" />
        <Text as="span" size="small" weight="semibold" tone="secondary">{label}</Text>
      </button>
      <span className="flex-1" />
      {children}
    </div>
  )
}

export interface PanelEmptyProps {
  icon: ReactNode
  title: string
  children: ReactNode
  action?: ReactNode
  testId?: string
}

/** A centred empty or error state with an icon tile, a title, a sentence and an action. */
export function PanelEmpty({ icon, title, children, action, testId }: PanelEmptyProps): React.JSX.Element {
  return (
    <div data-testid={testId ?? 'nav-empty'} className="flex flex-col items-center justify-center min-h-[var(--h-panel-empty)] p-[var(--space-panel-empty)] text-center">
      <span className="flex pb-[var(--space-panel-empty-icon-bottom)]">
        <span className="inline-flex items-center justify-center w-[var(--w-panel-icon)] h-[var(--h-panel-icon)] rounded-[var(--tr-radius-md)] bg-[var(--hover-fill)] text-[var(--text-faint)]">{icon}</span>
      </span>
      <Text as="h1" size="ui" weight="semibold" tight tone="primary" flush>{title}</Text>
      <Text as="p" size="small" weight="small" leading="normal" tone="secondary" className="max-w-[var(--w-panel-empty-copy)] pt-[var(--space-panel-empty-copy-top)] pb-[var(--space-panel-empty-copy-bottom)] text-pretty">{children}</Text>
      {action}
    </div>
  )
}

const NOTICE_TONE = {
  danger: 'border-[var(--panel-notice-danger-border)] bg-[var(--panel-notice-danger-fill)]',
  warn: 'border-[var(--panel-notice-warn-border)] bg-[var(--panel-notice-warn-fill)]'
} as const

export interface PanelNoticeProps {
  /** `bar` is a dismissible strip with trailing actions; `alert` is an inline message in a form. */
  variant: 'bar' | 'alert'
  tone?: keyof typeof NOTICE_TONE
  children: ReactNode
}

export function PanelNotice({ variant, tone = 'danger', children }: PanelNoticeProps): React.JSX.Element {
  if (variant === 'alert') {
    return (
      <Text as="div" role="alert" size="small" leading="normal" tone="primary" className={`py-2 px-3 rounded-[var(--tr-radius-sm)] border ${NOTICE_TONE[tone]}`}>{children}</Text>
    )
  }
  return (
    <div className="pb-[var(--space-2-5)]">
      <Text as="div" size="small" weight="small" leading="normal" tone="primary" className={`flex items-center justify-between gap-[var(--space-2)] min-h-[var(--h-panel-notice)] px-[var(--space-panel-notice-x)] py-[var(--space-panel-notice-y)] rounded-[var(--tr-radius-sm)] border ${NOTICE_TONE[tone]}`}>
        {children}
      </Text>
    </div>
  )
}

/** A titled group of rows that separates from the next group by 14px. */
export function PanelSection({ children }: { children: ReactNode }): React.JSX.Element {
  return <section className="flex flex-col gap-[var(--space-2)] pb-[var(--space-panel-section-bottom)] last:pb-0">{children}</section>
}

export interface PanelSectionToggleProps {
  collapsed: boolean
  onToggle: () => void
  children: ReactNode
}

/** The full-width header button of a collapsible PanelSection, with a trailing chevron. */
export function PanelSectionToggle({ collapsed, onToggle, children }: PanelSectionToggleProps): React.JSX.Element {
  return (
    <button type="button" className="btn group flex items-center gap-[var(--space-2)] w-full p-0 border-0 bg-transparent text-left cursor-pointer" aria-expanded={!collapsed} onClick={onToggle}>
      {children}
      <span className={`inline-flex items-center ml-auto text-[var(--text-faint)] [transition:transform_var(--transition-panel-chevron)_var(--animate-ease-menu,ease)] group-hover:text-[var(--text-primary)] ${collapsed ? '-rotate-90' : ''}`}>
        <Icon glyph={IconChevronDown} role="label" />
      </span>
    </button>
  )
}

/** A centred, dimmed status line such as "Loading skills…". */
export function PanelStatusLine({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <Text as="div" size="small" weight="small" tone="dim" center className="py-12">
      {children}
    </Text>
  )
}

/** Space under the search field that heads a list. */
export function PanelListHead({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="pb-[var(--space-1-5)]">{children}</div>
}

/** The horizontal inset and vertical rhythm of a detail view under a PanelBackBar. */
export function PanelDetailBody({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="min-w-0 px-[var(--space-panel-detail-x)] flex flex-col gap-[var(--space-4)]">{children}</div>
}

/** The vertical frame for a detail view, including its back bar and inset body. */
export function PanelDetailFrame({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex flex-col gap-[var(--space-4)]">{children}</div>
}

/** Two content panes side by side once the surrounding pane is 520px wide, stacked below. */
export function PanelColumns({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="grid grid-cols-1 gap-[var(--space-2)] @[var(--w-panel-columns)]/rpanel:grid-cols-2">{children}</div>
}

/** A 36px tile that frames a provider mark. */
export function PanelBadge({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <span className="inline-flex items-center justify-center w-9 h-9 rounded-[var(--tr-radius-md)] flex-none text-[var(--text-secondary)] bg-[var(--hover-fill)] border border-[var(--border)]">
      {children}
    </span>
  )
}

/** A labelled stack; `fill` lets the control take the rest of a form column, `grow` the rest of a detail column. */
export function PanelField({ fill = false, grow = false, children }: { fill?: boolean; grow?: boolean; children: ReactNode }): React.JSX.Element {
  return <div className={`flex flex-col gap-[var(--space-1-5)] ${fill ? 'flex-1 min-h-[var(--h-panel-field-stack)]' : ''} ${grow ? 'flex-1 min-h-0' : ''}`}>{children}</div>
}

/** A wrapping row of PanelChoice options. */
export function PanelChoiceGroup({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex flex-wrap gap-[var(--space-2)]">{children}</div>
}

/** The growing search slot of a toolbar. */
export function PanelToolbarField({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="relative flex-1 min-w-[var(--w-panel-toolbar-min)]">{children}</div>
}
