import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react'
import type { AgentStatus } from '../../houston/client'
import { Text } from './Text'
import { CONTROL_SIZE_SQUARE_CLS } from '../controlSize'
import { BTN_ICO_STRUCTURE } from './buttonChrome'
import { RING_ACCENT_ICON } from './shadowChrome'
import { HIT_TARGET_28 } from '../hitTarget'

export function PaneHeadActions({ children }: { children: ReactNode }): React.JSX.Element {
  return <span className="head-actions ml-auto flex items-center gap-px flex-none">{children}</span>
}

const HEAD_BUTTON_STYLE =
  `rounded-[var(--tr-radius-sm)] [transition:background-color_0.15s,color_0.15s] active:scale-[0.97] focus-visible:bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] focus-visible:text-[var(--text-primary)] focus-visible:shadow-[${RING_ACCENT_ICON}] focus-visible:outline-none`
const HEAD_BUTTON_SIZE = {
  default: CONTROL_SIZE_SQUARE_CLS.mini,
  small: CONTROL_SIZE_SQUARE_CLS.small,
  tabClose: 'w-[16px] h-[16px]',
  tabOverflow: `btn ${CONTROL_SIZE_SQUARE_CLS.small} ${CONTROL_SIZE_SQUARE_CLS.mini} border-l border-[color-mix(in_srgb,var(--divider)_55%,transparent)]`
} as const
/** Session headers shrink their buttons in narrow panes and dim them while a sibling pane holds focus. */
const HEAD_BUTTON_LADDER =
  '[@container_(max-width:280px)]:w-[var(--h-pane-icon-button-compact)] [@container_(max-width:280px)]:h-[var(--h-pane-icon-button-compact)] [@container_(max-width:200px)]:w-[var(--h-pane-icon-button-narrow)] [@container_(max-width:200px)]:h-[var(--h-pane-icon-button-narrow)] [body:has(.pane.focus)_.pane:not(.focus)_&]:text-[color-mix(in_srgb,var(--text-muted)_92%,var(--text-primary))]'

const HEAD_BUTTON_TONE = {
  neutral:
    'bg-transparent text-[color-mix(in_srgb,var(--text-muted)_55%,var(--text-primary))] hover:bg-[color-mix(in_srgb,var(--text-primary)_10%,transparent)] hover:text-[var(--text-primary)]',
  regular:
    'bg-transparent text-[color-mix(in_srgb,var(--text-muted)_55%,var(--text-primary))] hover:bg-[color-mix(in_srgb,var(--text-primary)_11%,transparent)] hover:text-[var(--text-primary)]',
  accent:
    'bg-transparent text-[color-mix(in_srgb,var(--text-muted)_55%,var(--text-primary))] hover:bg-[var(--hover-fill)] hover:text-[var(--text-primary)]',
  danger:
    'bg-transparent text-[color-mix(in_srgb,var(--text-muted)_55%,var(--text-primary))] hover:bg-[var(--hover-fill)] hover:text-[var(--text-primary)]',
  info: 'bg-[color-mix(in_srgb,var(--info)_16%,transparent)] text-[var(--info)] hover:bg-[color-mix(in_srgb,var(--info)_16%,transparent)] hover:text-[var(--info)]'
} as const

export type PaneHeadButtonTone = keyof typeof HEAD_BUTTON_TONE

export function PaneHeadIdentity({ children }: { children: ReactNode }): React.JSX.Element {
  return <span data-testid="head-identity" className="head-identity inline-flex items-center gap-[var(--space-2)] min-w-0 overflow-hidden [flex:0_1_auto]">{children}</span>
}

export function PaneNotice({ children, ...rest }: { children: ReactNode } & HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <Text as="div" {...rest} size="small" weight="small" tone="muted" className="flex items-center gap-[var(--space-2)] flex-none py-[var(--space-pane-notice-block)] px-[var(--space-2)] border-b border-[var(--border)]">
      {children}
    </Text>
  )
}

/** An icon button in a pane header. `className` carries layout only (for example a container-query cut). */
export function PaneHeadButton({
  tone = 'regular',
  ladder = true,
  size = 'default',
  className = '',
  ...rest
}: { tone?: PaneHeadButtonTone; ladder?: boolean; size?: keyof typeof HEAD_BUTTON_SIZE } & ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  const target = size === 'tabClose' || size === 'tabOverflow' ? HIT_TARGET_28 : ''
  const buttonClass = size === 'tabClose' ? 'btn' : ''
  return <button {...rest} className={`${buttonClass} ${BTN_ICO_STRUCTURE} ${HEAD_BUTTON_SIZE[size]} ${target} ${HEAD_BUTTON_STYLE} ${ladder ? HEAD_BUTTON_LADDER : ''} ${HEAD_BUTTON_TONE[tone]} ${className}`.trim()} />
}

/** A label-sized note in a session header, such as the protocol mode or account profile. */
export function PaneHeadBadge(props: Omit<HTMLAttributes<HTMLSpanElement>, 'className'>): React.JSX.Element {
  return <span {...props} className="inline-flex items-center text-[var(--text-secondary)] [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] flex-none whitespace-nowrap cursor-default" />
}

const STATUS_PULSE = 'loop-anim [--dot-pulse-opacity:0.35] motion-safe:animate-[dot-pulse_1.4s_steps(4,end)_infinite]'

function statusDotClass(status: AgentStatus): string {
  switch (status) {
    case 'working':
      return `bg-[var(--info)] ${STATUS_PULSE}`
    case 'spawning':
      return `bg-[var(--accent)] ${STATUS_PULSE}`
    case 'idle':
      return 'bg-[var(--text-muted)]'
    case 'needs-input':
      return 'bg-[var(--warn)]'
    case 'unavailable':
      return 'bg-transparent ring-1 ring-inset ring-[var(--text-faint)]'
  }
}

/** The 7px agent status dot; only the two indeterminate states pulse. */
export function PaneStatusDot({ status, ...rest }: { status: AgentStatus } & HTMLAttributes<HTMLSpanElement>): React.JSX.Element {
  return <span {...rest} className={`agent-dot w-[var(--sz-pane-status-dot)] h-[var(--sz-pane-status-dot)] rounded-full flex-none ${statusDotClass(status)}`} />
}

export function PaneEngineGlyph({ className = '', ...rest }: HTMLAttributes<HTMLSpanElement>): React.JSX.Element {
  return <span {...rest} className={`${className} inline-flex items-center justify-center w-4 h-4 flex-none`.trim()} />
}

export function PaneSubtitle({ className = '', ...rest }: HTMLAttributes<HTMLSpanElement>): React.JSX.Element {
  return (
    <Text
      as="span"
      {...rest}
      size="xs"
      tone="faint"
      className={`${className} whitespace-nowrap overflow-hidden text-ellipsis min-w-0`.trim()}
    />
  )
}

export function PaneBranchChip({ className = '', ...rest }: ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  return (
    <Text
      as="button"
      {...rest}
      size="small" weight="small" tone="secondary" mono
      className={`${className} inline-flex items-center gap-[var(--space-1-5)] min-w-0 flex-none max-w-[var(--w-pane-branch-chip)] px-[var(--space-1-5)] h-[var(--h-tag-chip)] rounded-[var(--tr-radius-sm)] border-0 bg-[color-mix(in_srgb,var(--text-primary)_7%,transparent)] cursor-default`.trim()}
    />
  )
}

/** The ended-session chip beside the header actions. */
export function PaneStateChip({
  state,
  className = '',
  ...rest
}: { state: string } & HTMLAttributes<HTMLSpanElement>): React.JSX.Element {
  return (
    <Text
      as="span"
      {...rest}
      size="label"
      weight="label"
      style={{ letterSpacing: 'var(--tr-text-label-tracking)', textTransform: 'var(--tr-text-label-transform)' }}
      className={`rounded-full py-px px-[var(--space-2)] flex-none ${className} ${state === 'exited' ? 'text-[var(--status-done-text)] bg-[var(--status-done-bg)]' : 'text-[var(--status-blocked-text)] bg-[var(--status-blocked-bg)]'}`.trim()}
    />
  )
}
