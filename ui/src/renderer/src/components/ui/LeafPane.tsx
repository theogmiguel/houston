import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react'
import { CONTROL_SIZE_SQUARE_CLS } from '../controlSize'
import { BTN_ICO_STRUCTURE } from './buttonChrome'
import { RING_ACCENT_ICON } from './shadowChrome'
import { Text } from './Text'

export interface LeafPaneProps extends HTMLAttributes<HTMLElement> {
  /** Extra marker classes the layout and tests address the leaf by. */
  marker?: string
}

/** The bordered surface of a leaf pane that hosts a view under a draggable header. */
export function LeafPane({ marker = '', className = '', ...props }: LeafPaneProps): React.JSX.Element {
  return (
    <section
      {...props}
      className={`pane ${marker} @container/rpanel flex-1 min-w-0 min-h-0 relative flex flex-col border border-[var(--border)] bg-[var(--pane-bg)] overflow-hidden rounded-[var(--tr-radius-md)] [@container_(max-width:var(--w-pane-narrow))]:rounded-[var(--tr-radius-sm)] ${className}`}
    />
  )
}

export interface LeafPaneHeaderProps extends HTMLAttributes<HTMLElement> {
  icon: ReactNode
  title: string
}

/** The 28px drag handle of a leaf pane: icon, title and trailing actions. */
export function LeafPaneHeader({ icon, title, children, className = '', ...props }: LeafPaneHeaderProps): React.JSX.Element {
  return (
    <Text
      as="header"
      {...props}
      size="small"
      weight="small"
      tone="primary"
      className={`group pane-head touch-none flex items-center gap-2 pr-1 pl-[var(--space-panel-header-inset)] h-[var(--h-pane-head)] min-h-[var(--h-pane-head)] bg-[var(--session-terminal-header-bg)] border-b border-b-[var(--panel-leaf-header-border)] tracking-[var(--tr-pane-header-tracking)] flex-none cursor-grab active:cursor-grabbing [transition:background_var(--transition-leaf-header),border-color_var(--transition-leaf-header)] @container ${className}`}
    >
      <span className="flex-none text-[var(--text-muted)]">{icon}</span>
      <Text as="span" size="small" weight="medium" tone="primary" tight leading="tight" className="pane-title whitespace-nowrap overflow-hidden text-ellipsis min-w-[var(--w-pane-title-min)]">{title}</Text>
      <span className="head-actions flex items-center gap-px flex-none ml-auto">{children}</span>
    </Text>
  )
}

const HEAD_BUTTON_BASE = `btn ${BTN_ICO_STRUCTURE} ${CONTROL_SIZE_SQUARE_CLS.mini} rounded-[var(--tr-radius-sm)] [transition:background_var(--transition-leaf-button)_var(--ease-panel-standard),color_var(--transition-leaf-button)_ease,transform_var(--transition-leaf-transform)_var(--ease-panel-bounce)] hover:-translate-y-px active:translate-y-0 active:scale-90 focus-visible:bg-[var(--panel-focus-fill)] focus-visible:text-[var(--text-primary)] focus-visible:shadow-[${RING_ACCENT_ICON}] focus-visible:outline-none`

const HEAD_BUTTON_TONE = {
  regular: 'bg-transparent text-[var(--panel-leaf-quiet)] hover:bg-[var(--panel-leaf-hover)] hover:text-[var(--text-primary)]',
  danger: 'bg-transparent text-[var(--panel-leaf-quiet)] hover:bg-[var(--panel-leaf-danger-hover)] hover:text-[var(--danger)]',
  info: 'bg-[var(--panel-leaf-info)] text-[var(--info)] hover:bg-[var(--panel-leaf-info)] hover:text-[var(--info)]'
} as const

export interface LeafPaneButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: keyof typeof HEAD_BUTTON_TONE
}

/** An icon action in a LeafPaneHeader; `info` marks a toggle that is on, `danger` closes. */
export function LeafPaneButton({ tone = 'regular', className = '', type = 'button', ...props }: LeafPaneButtonProps): React.JSX.Element {
  return <button {...props} type={type} className={`${HEAD_BUTTON_BASE} ${HEAD_BUTTON_TONE[tone]} ${className}`} />
}
