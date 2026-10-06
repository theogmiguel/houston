import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react'
import { BTN_DANGER_SOLID, BTN_GHOST, BTN_GHOST_DANGER_ARM, BTN_GHOST_DANGER_HOVER, BTN_ICO, BTN_PRIMARY, BTN_SECONDARY } from './buttonChrome'
import type { IconComponent } from '../icons'
import { variants } from './variants'
import { HIT_TARGET_28 } from '../hitTarget'
import { RING_ACCENT_INSET_18 } from './shadowChrome'
import { FOCUS_HALO } from './shadowChrome'
import './button.css'
import { CONTROL_SIZE_SQUARE_CLS } from '../controlSize'

export type ButtonVariant = 'primary' | 'secondary' | 'field' | 'outline' | 'ghost' | 'label' | 'link' | 'danger' | 'danger-solid' | 'icon' | 'icon-selected' | 'icon-structure' | 'compact-primary-action' | 'text' | 'badge' | 'ghost-icon' | 'ghost-icon-danger' | 'confirm-primary' | 'compact-outline' | 'danger-confirmation' | 'compact-ghost' | 'compact-danger' | 'accent-soft' | 'legacy-primary' | 'legacy-secondary' | 'legacy-ghost' | 'legacy-danger' | 'legacy-danger-solid' | 'legacy-icon' | 'legacy-ghost-icon' | 'legacy-ghost-icon-danger' | 'legacy-focus-lever' | 'legacy-roster-footer' | 'legacy-icon-warning' | 'legacy-titlebar-icon' | 'legacy-ghost-compact' | 'legacy-ghost-disclosure' | 'roster-open' | 'compact-primary' | 'compact-secondary' | 'compact-icon-danger' | 'picker-candidate' | 'picker-apply-action' | 'picker-cancel-action' | 'picker-done-action' | 'repository-list-row' | 'repository-load-more-action' | 'file-retry-action' | 'reaction' | 'reaction-option' | 'agent-option' | 'diff-line-action' | 'compact-action' | 'label-action' | 'mini-primary-action' | 'compact-self-start-action' | 'compact-trailing-action' | 'compact-control' | 'discussion-edit-action' | 'discussion-cancel-action' | 'discussion-reply-action' | 'discussion-submit-action' | 'pull-request-action' | 'pull-request-danger-action' | 'pull-request-primary-action' | 'pull-request-nav-action' | 'pull-request-external-action' | 'action-primary' | 'surface' | 'surface-large' | 'subtle-icon' | 'compact-icon' | 'compact-icon-secondary' | 'disclosure-icon' | 'small-icon' | 'status-chip' | 'legacy-bare-ghost'
export type ButtonSize = 'md' | 'sm' | 'lg'

interface ButtonBaseProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'type'> {
  size?: ButtonSize
  armed?: boolean
  selected?: boolean
  status?: 'available' | 'failed'
  contentAlign?: 'start' | 'center'
  iconEnd?: IconComponent
  /** Layout classes only; visual styles belong in Button variants. */
  className?: string
  noDrag?: boolean
  type?: ButtonHTMLAttributes<HTMLButtonElement>['type']
  ref?: Ref<HTMLButtonElement>
}

type LabeledButtonProps = ButtonBaseProps & {
  variant?: Exclude<ButtonVariant, 'icon' | 'subtle-icon' | 'compact-icon' | 'compact-icon-secondary' | 'disclosure-icon' | 'small-icon' | 'danger-solid'>
  icon?: IconComponent
  children?: ReactNode
  'aria-label'?: string
}

type DangerSolidButtonProps = ButtonBaseProps & {
  variant: 'danger-solid'
  icon: IconComponent
  children?: ReactNode
  'aria-label'?: string
}

type IconButtonProps = ButtonBaseProps & {
  variant: 'icon' | 'subtle-icon' | 'compact-icon' | 'compact-icon-secondary' | 'disclosure-icon' | 'small-icon'
  icon?: IconComponent
  children?: ReactNode
  'aria-label': string
  iconEnd?: never
}

export type ButtonProps = LabeledButtonProps | DangerSolidButtonProps | IconButtonProps

const sizeClasses = {
  md: 'h-[var(--h-ctl)] px-[var(--space-3)] gap-[var(--space-1-5)]',
  sm: 'h-[var(--h-ctl-mini)] px-[var(--space-2)] gap-[var(--space-1-5)]',
  lg: 'h-[var(--h-empty-action)] px-[var(--space-5)] gap-[var(--space-2)]',
  icon: ''
} as const

const buttonClasses = variants(
  'btn inline-flex items-center justify-center disabled:cursor-not-allowed',
  {
    variant: {
      primary: 'border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-ink)] hover:enabled:bg-[var(--accent-hover)]',
      'action-primary': `btn rounded-[var(--tr-radius-button)] [font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)] ${BTN_PRIMARY}`,
      secondary: 'border-[var(--border)] bg-[var(--hover-fill)] text-[var(--text-secondary)] hover:enabled:border-[var(--border-hover)] hover:enabled:bg-[var(--card-hover)] hover:enabled:text-[var(--text-primary)]',
      field: 'justify-start border-[var(--border)] bg-[var(--card-bg)] text-left font-normal text-[var(--text-secondary)] hover:enabled:border-[var(--border-hover)] hover:enabled:bg-[var(--card-hover)] hover:enabled:text-[var(--text-primary)]',
      surface: 'border-[var(--border)] bg-[var(--card-bg)] text-[var(--text-secondary)] font-medium hover:enabled:bg-[var(--surface-hover)] hover:enabled:text-[var(--text-primary)]',
      'surface-large': 'h-[var(--h-empty-action)] px-[var(--space-4)] gap-[var(--space-2)] rounded-[var(--tr-radius-button)] border border-[var(--border)] bg-[var(--card-bg)] [font-size:var(--tr-text-ui-size)] font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]',
      outline: 'border-[var(--border)] bg-transparent text-[var(--text-primary)] hover:enabled:border-[var(--border-hover)] hover:enabled:bg-[var(--hover-fill)]',
      ghost: `btn ${BTN_GHOST}`,
      label: 'h-auto min-h-0 border-0 bg-transparent p-0 text-left [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] [letter-spacing:0.06em] uppercase text-[var(--text-muted)] hover:enabled:bg-transparent hover:enabled:text-[var(--text-primary)]',
      link: 'border-transparent bg-transparent !px-0 !py-0 !h-auto min-h-0 align-baseline text-[length:var(--tr-text-small-size)] text-[var(--accent)] hover:enabled:bg-transparent hover:enabled:underline',
      danger: `btn ${BTN_GHOST} ${BTN_GHOST_DANGER_HOVER}`,
      'compact-primary': 'min-h-[var(--h-ctl)] px-[var(--space-3)] gap-[var(--space-form-button-gap)] rounded-[var(--tr-radius-sm)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] cursor-pointer disabled:cursor-default border border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-ink)] hover:brightness-110 disabled:opacity-55',
      'compact-secondary': 'min-h-[var(--h-ctl)] px-[var(--space-3)] gap-[var(--space-form-button-gap)] rounded-[var(--tr-radius-sm)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] cursor-pointer disabled:cursor-default border border-[var(--border)] bg-[var(--hover-fill)] text-[var(--text-secondary)] hover:bg-[var(--selected-fill)] hover:text-[var(--text-primary)] disabled:opacity-55',
      'compact-icon-danger': `flex-none w-[var(--h-ctl-mini)] h-[var(--h-ctl-mini)] rounded-[var(--tr-radius-sm)] border-0 bg-transparent text-[var(--text-secondary)] cursor-pointer [transition:color_0.1s_ease-out,background-color_0.1s_ease-out] hover:not-disabled:bg-[var(--hover-fill)] hover:not-disabled:text-[var(--danger)] disabled:text-[var(--text-faint)] disabled:opacity-55 disabled:cursor-default ${HIT_TARGET_28}`,
      'danger-solid': BTN_DANGER_SOLID,
      icon: BTN_ICO,
      'icon-selected': `${BTN_ICO} bg-[var(--card-hover)] text-[var(--text-primary)]`,
      'icon-structure': `${CONTROL_SIZE_SQUARE_CLS.mini} rounded-[var(--tr-radius-sm)] bg-transparent border-none p-0 leading-none inline-flex items-center justify-center flex-none text-[color-mix(in_srgb,var(--text-muted)_55%,var(--text-primary))] hover:bg-[color-mix(in_srgb,var(--text-primary)_10%,transparent)] hover:text-[var(--text-primary)] focus-visible:bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] focus-visible:text-[var(--text-primary)] focus-visible:outline-none disabled:opacity-45 disabled:cursor-not-allowed [&_svg]:block [&_svg]:flex-none`,
      'compact-primary-action': `btn ${BTN_PRIMARY} h-[var(--h-overview-answer)] min-h-[var(--h-overview-answer)] px-[var(--space-2-5)] [font-size:var(--tr-text-small-size)] flex-none`,
      'subtle-icon': 'border-none p-0 leading-none inline-flex items-center justify-center flex-none w-[var(--h-ctl)] h-[var(--h-ctl)] rounded-[var(--tr-radius-sm)] bg-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--card-hover)] [&_svg]:block [&_svg]:flex-none',
      'compact-icon': 'relative border-0 bg-transparent w-[var(--sz-rail-compact-action)] h-[var(--sz-rail-compact-action)] p-0 flex-none rounded-[var(--tr-radius-sm)] inline-flex items-center justify-center text-[var(--text-muted)] hover:bg-[var(--card-hover)] hover:text-[var(--text-primary)]',
      'compact-icon-secondary': 'relative w-[var(--sz-rail-compact-action)] h-[var(--sz-rail-compact-action)] flex-none rounded-[var(--tr-radius-sm)] border-0 bg-transparent p-0 inline-flex items-center justify-center text-[var(--text-secondary)] hover:bg-[var(--card-hover)] hover:text-[var(--text-primary)]',
      'disclosure-icon': 'relative -ml-[var(--space-disclosure-nudge)] flex items-center justify-center w-[var(--sz-disclosure-icon)] h-[var(--sz-disclosure-icon)] rounded-[var(--tr-radius-input)] text-current hover:bg-[var(--card-hover)] hover:text-[var(--text-primary)] after:absolute after:left-1/2 after:top-1/2 after:h-[var(--h-disclosure-hit)] after:min-w-[var(--h-disclosure-hit)] after:w-full after:-translate-x-1/2 after:-translate-y-1/2 after:content-[\'\']',
      'small-icon': 'items-center justify-center w-[var(--sz-rail-row-action)] h-[var(--sz-rail-row-action)] p-0 flex-none text-[var(--text-muted)] rounded-[var(--tr-radius-input)] leading-[0] hover:text-[var(--text-primary)] hover:bg-[var(--card-hover)]',
      'status-chip': 'border-none p-0 leading-none inline-flex items-center justify-center flex-none ml-auto h-[var(--h-ctl)] gap-[var(--space-1-5)] px-[var(--space-2-5)] rounded-full whitespace-nowrap [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-update-weight)]',
      text: 'h-auto min-h-0 border-0 bg-transparent p-0 text-left font-semibold text-[var(--text-primary)] hover:enabled:bg-transparent hover:enabled:text-[var(--text-primary)]',
      badge: 'h-auto min-h-0 border-0 bg-transparent p-0 inline-flex items-center text-[var(--text-secondary)] [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] flex-none whitespace-nowrap cursor-default gap-1.5 [font-variant-numeric:tabular-nums] rounded-[var(--tr-radius-sm)] hover:text-[var(--text-primary)] focus-visible:text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:[outline-offset:2px]',
      'ghost-icon': `btn ${BTN_GHOST} p-1 rounded-[var(--tr-radius-sm)]`,
      'ghost-icon-danger': `btn ${BTN_GHOST} p-1 rounded-[var(--tr-radius-sm)] enabled:hover:text-[var(--danger)]`,
      'confirm-primary': `h-[var(--h-ctl)] px-[var(--space-4)] rounded-[var(--tr-radius-button)] border border-[var(--accent)] bg-[var(--accent)] text-[var(--primary-foreground)] [font-size:var(--tr-text-ui-size)] font-semibold hover:opacity-90 active:scale-[0.98] focus-visible:outline-none focus-visible:shadow-[${FOCUS_HALO}] disabled:opacity-40`,
      'compact-outline': `bg-transparent rounded-[var(--tr-radius-button)] px-[var(--space-2)] h-[var(--h-ctl-mini)] border border-current [font-size:var(--tr-text-small-size)] font-semibold focus-visible:outline-none focus-visible:shadow-[${FOCUS_HALO}] relative after:absolute after:left-1/2 after:top-1/2 after:h-[var(--h-ctl)] after:min-w-[var(--h-ctl)] after:w-full after:-translate-x-1/2 after:-translate-y-1/2 after:content-['']`,
      'danger-confirmation': `h-[var(--h-ctl)] px-[var(--space-3)] rounded-[var(--tr-radius-button)] border [font-size:var(--tr-text-ui-size)] font-medium whitespace-nowrap focus-visible:outline-none focus-visible:shadow-[${FOCUS_HALO}] disabled:opacity-50 disabled:cursor-not-allowed`,
      'compact-ghost': `btn ${BTN_GHOST} px-[var(--space-2)]`,
      'compact-danger': `btn ${BTN_GHOST} ${BTN_GHOST_DANGER_HOVER} px-[var(--space-2)]`,
      'picker-candidate': 'w-full min-h-0 flex items-center gap-[var(--space-2)] px-[var(--space-2)] py-[var(--space-1)] bg-transparent border-0 rounded-none text-left [font-size:inherit] [font-weight:inherit] text-[length:var(--tr-text-small-size)] text-[var(--text-primary)] disabled:opacity-55 hover:enabled:bg-[var(--card-hover)] focus-visible:outline-none focus-visible:bg-[var(--card-hover)]',
      'picker-apply-action': `btn ${BTN_PRIMARY} inline-flex items-center gap-[var(--space-1-5)] disabled:opacity-55`,
      'picker-cancel-action': `btn ${BTN_SECONDARY} inline-flex items-center gap-[var(--space-1-5)]`,
      'picker-done-action': `btn ${BTN_SECONDARY} inline-flex items-center gap-[var(--space-1-5)] ml-auto`,
      'repository-list-row': 'w-full min-h-0 flex flex-col items-stretch gap-[var(--space-0-5)] px-[var(--space-2-5)] py-[var(--space-2)] bg-transparent border-0 border-t border-t-[var(--divider)] first:border-t-0 rounded-none text-left [font-size:inherit] [font-weight:inherit] hover:enabled:bg-[var(--card-hover)] focus-visible:outline-none focus-visible:bg-[var(--card-hover)]',
      'repository-load-more-action': `btn ${BTN_SECONDARY} inline-flex items-center gap-[var(--space-1-5)]`,
      'file-retry-action': `btn ${BTN_SECONDARY} inline-flex items-center gap-[var(--space-1-5)] justify-start`,
      reaction: 'inline-flex items-center gap-[var(--space-1)] h-[var(--h-ctl-mini)] px-1.5 rounded-[var(--tr-radius-pill)] border text-[length:var(--tr-text-small-size)] disabled:opacity-55',
      'reaction-option': `btn ${BTN_GHOST} inline-flex items-center justify-center h-[var(--h-ctl-mini)] px-1 leading-none disabled:opacity-55`,
      'agent-option': 'flex h-[var(--tr-agent-option-height)] items-center gap-[var(--tr-agent-option-gap)] rounded-[var(--tr-radius-button)] border text-left px-[var(--space-2-5)] pl-[var(--space-2-5)] pr-[var(--space-2)] transition-[border-color,background-color,color] duration-150',
      'diff-line-action': `btn ${BTN_GHOST} flex-none inline-flex items-center px-1 leading-none text-[var(--text-muted)] hover:enabled:text-[var(--text-primary)] disabled:opacity-55`,
      'compact-action': `btn ${BTN_GHOST} inline-flex items-center gap-[var(--space-1-5)] h-[var(--h-ctl-mini)] px-[var(--space-1-5)] text-[length:var(--tr-text-small-size)] text-[var(--text-muted)] disabled:opacity-55`,
      'mini-primary-action': `btn ${BTN_PRIMARY} inline-flex items-center gap-[var(--space-1-5)] h-[var(--h-ctl-mini)] px-[var(--space-1-5)] disabled:opacity-55`,
      'compact-self-start-action': `btn ${BTN_GHOST} inline-flex items-center gap-[var(--space-1-5)] h-[var(--h-ctl-mini)] self-start px-[var(--space-1)] text-[var(--text-muted)]`,
      'compact-trailing-action': `btn ${BTN_GHOST} inline-flex items-center gap-[var(--space-1-5)] h-[var(--h-ctl-mini)] px-[var(--space-1-5)] ml-auto text-[var(--text-muted)] disabled:opacity-55`,
      'compact-control': `btn ${BTN_SECONDARY} inline-flex items-center gap-[var(--space-1-5)] h-[var(--h-ctl)] px-[var(--space-2)]`,
      'discussion-edit-action': `btn ${BTN_GHOST} inline-flex items-center gap-[var(--space-1-5)] h-[var(--h-ctl-mini)] px-[var(--space-1)] text-[length:var(--tr-text-small-size)] text-[var(--text-muted)] disabled:opacity-55`,
      'discussion-cancel-action': `btn ${BTN_SECONDARY} inline-flex items-center gap-[var(--space-1-5)]`,
      'discussion-reply-action': `btn ${BTN_SECONDARY} inline-flex items-center gap-[var(--space-1-5)] disabled:opacity-55`,
      'discussion-submit-action': `btn ${BTN_PRIMARY} inline-flex items-center gap-[var(--space-1-5)] disabled:opacity-55`,
      'pull-request-action': `btn ${BTN_SECONDARY} inline-flex items-center gap-[var(--space-1-5)] disabled:opacity-45 disabled:cursor-not-allowed`,
      'pull-request-danger-action': `btn ${BTN_SECONDARY} inline-flex items-center gap-[var(--space-1-5)] text-[var(--danger)] border-[color-mix(in_srgb,var(--danger)_42%,var(--border))] disabled:opacity-45 disabled:cursor-not-allowed`,
      'pull-request-primary-action': `btn ${BTN_PRIMARY} inline-flex items-center gap-[var(--space-1-5)] disabled:opacity-45 disabled:cursor-not-allowed`,
      'pull-request-nav-action': `btn ${BTN_GHOST} inline-flex items-center gap-[var(--space-1-5)]`,
      'pull-request-external-action': `btn ${BTN_GHOST} inline-flex items-center gap-[var(--space-1-5)] ml-auto`,
      'legacy-primary': `btn ${BTN_PRIMARY}`,
      'legacy-secondary': BTN_SECONDARY,
      'legacy-ghost': `btn ${BTN_GHOST}`,
      'legacy-bare-ghost': BTN_GHOST,
      'legacy-danger': `btn ${BTN_GHOST} ${BTN_GHOST_DANGER_HOVER}`,
      'legacy-danger-solid': BTN_DANGER_SOLID,
      'legacy-icon': `btn ${BTN_ICO}`,
      'legacy-icon-warning': `btn ${BTN_ICO} text-warning hover:text-warning`,
      'legacy-titlebar-icon': `btn ${BTN_ICO} [-webkit-app-region:no-drag]`,
      'legacy-ghost-disclosure': `btn ${BTN_GHOST} -ml-2.5 flex items-center gap-1 text-[length:var(--tr-text-base)]`,
      'legacy-ghost-compact': `btn ${BTN_GHOST} px-2 py-1 [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] inline-flex items-center gap-1`,
      'legacy-ghost-icon': `btn ${BTN_GHOST} p-1 rounded-[var(--tr-radius-sm)]`,
      'legacy-ghost-icon-danger': `btn ${BTN_GHOST} p-1 rounded-[var(--tr-radius-sm)] enabled:hover:text-[var(--danger)]`,
      'label-action': `btn ${BTN_GHOST} px-1.5 py-0 [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)]`,
      'legacy-focus-lever': 'h-[var(--h-pill)] px-2.5 inline-flex items-center gap-1.5 border border-[var(--border)] rounded-[var(--tr-radius-button)] bg-[var(--surface)] text-[var(--text-secondary)] font-[inherit] [font-size:var(--tr-text-xs)] cursor-pointer transition-[background,border-color] hover:bg-[var(--hover-fill)] hover:border-[var(--border-hover)] hover:text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:[outline-offset:1px]',
      'legacy-roster-footer': `btn ${BTN_GHOST} min-h-[var(--h-ctl)]`,
      'accent-soft': 'rounded-[var(--tr-radius-sm)] border border-[var(--accent)] bg-[var(--accent-muted)] px-[var(--tr-space-profile-action-inline)] py-[var(--tr-space-profile-action-block)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--accent)] hover:brightness-110 disabled:opacity-40 disabled:cursor-default',
      'roster-open': 'h-auto p-0 border-0 bg-transparent gap-[7px] flex-1 min-w-0 min-h-[19px] text-left text-[var(--text-secondary)] [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] whitespace-nowrap cursor-default [font-variant-numeric:tabular-nums] rounded-[var(--tr-radius-sm)] hover:text-[var(--text-primary)] focus-visible:text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:[outline-offset:2px] [&_strong]:font-semibold [&_strong]:overflow-hidden [&_strong]:text-ellipsis [&_strong]:whitespace-nowrap'
    },
    size: sizeClasses
  },
  { variant: 'secondary', size: 'md' }
)

// Variants that carry their own type and padding: no button chrome, no size padding.
const SELF_SIZED: ReadonlySet<ButtonVariant> = new Set<ButtonVariant>(['icon', 'icon-selected', 'icon-structure', 'compact-primary-action', 'text', 'badge', 'label', 'confirm-primary', 'compact-outline', 'danger-confirmation', 'compact-ghost', 'compact-danger', 'accent-soft', 'roster-open', 'picker-candidate', 'picker-apply-action', 'picker-cancel-action', 'picker-done-action', 'repository-list-row', 'repository-load-more-action', 'file-retry-action', 'reaction', 'reaction-option', 'agent-option', 'diff-line-action', 'compact-action', 'mini-primary-action', 'compact-self-start-action', 'compact-trailing-action', 'compact-control', 'discussion-edit-action', 'discussion-cancel-action', 'discussion-reply-action', 'discussion-submit-action', 'pull-request-action', 'pull-request-danger-action', 'pull-request-primary-action', 'pull-request-nav-action', 'pull-request-external-action', 'compact-primary', 'compact-secondary', 'compact-icon-danger', 'subtle-icon', 'compact-icon', 'compact-icon-secondary', 'disclosure-icon', 'small-icon', 'status-chip', 'surface-large'])
const OWN_CHROME: ReadonlySet<ButtonVariant> = new Set<ButtonVariant>(['badge', 'label', 'compact-primary-action', 'confirm-primary', 'compact-outline', 'danger-confirmation', 'accent-soft', 'roster-open', 'picker-candidate', 'picker-apply-action', 'picker-cancel-action', 'picker-done-action', 'repository-list-row', 'repository-load-more-action', 'file-retry-action', 'reaction', 'reaction-option', 'agent-option', 'diff-line-action', 'compact-action', 'mini-primary-action', 'compact-self-start-action', 'compact-trailing-action', 'compact-control', 'discussion-edit-action', 'discussion-cancel-action', 'discussion-reply-action', 'discussion-submit-action', 'pull-request-action', 'pull-request-danger-action', 'pull-request-primary-action', 'pull-request-nav-action', 'pull-request-external-action', 'compact-primary', 'compact-secondary', 'compact-icon-danger', 'surface-large', 'action-primary', 'subtle-icon', 'compact-icon', 'compact-icon-secondary', 'disclosure-icon', 'small-icon', 'status-chip', 'legacy-bare-ghost'])
const isLegacy = (variant: ButtonVariant): boolean => variant.startsWith('legacy-')

function buttonSize(variant: ButtonVariant, size: ButtonSize): ButtonSize | 'icon' {
  return SELF_SIZED.has(variant) || variant.includes('icon') || isLegacy(variant) ? 'icon' : size
}

function buttonChrome(variant: ButtonVariant): string {
  return OWN_CHROME.has(variant) || isLegacy(variant) ? '' : 'rounded-[var(--tr-radius-button)] [font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)]'
}

export function Button(props: ButtonProps): React.JSX.Element {
  const {
    variant = 'secondary',
    size = 'md',
    armed = false,
    selected = false,
    status = 'available',
    contentAlign = 'center',
    icon,
    iconEnd,
    className = '',
    noDrag = false,
    children,
    type = 'button',
    ref,
    ...buttonProps
  } = props
  const selectedClasses = buttonClasses({ variant, size: buttonSize(variant, size) })
  const alignedClasses = contentAlign === 'start' ? selectedClasses.replace(' justify-center', '') : selectedClasses
  const classSet = variant === 'legacy-roster-footer'
    ? alignedClasses.replace(/^btn inline-flex items-center (?:justify-center )?disabled:cursor-not-allowed /, '')
    : variant === 'roster-open'
      ? alignedClasses.replace(/^btn inline-flex /, 'flex ')
      : ['subtle-icon', 'compact-icon', 'compact-icon-secondary', 'disclosure-icon', 'small-icon', 'status-chip', 'legacy-bare-ghost'].includes(variant)
        ? alignedClasses.replace(/^btn inline-flex items-center justify-center disabled:cursor-not-allowed /, '')
        : variant === 'legacy-danger-solid'
          ? alignedClasses.replace(/^btn inline-flex items-center disabled:cursor-not-allowed /, 'btn ')
          : alignedClasses
  const reactionState = variant === 'reaction'
    ? selected ? 'border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] text-[var(--text-primary)]' : 'border-[var(--border)] bg-transparent text-[var(--text-muted)] hover:enabled:text-[var(--text-primary)]'
    : ''
  const agentOptionState = variant === 'agent-option'
    ? selected ? `border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_8%,var(--card-bg))] shadow-[${RING_ACCENT_INSET_18}] text-[var(--text-primary)]` : 'border-[var(--border)] bg-[var(--card-bg)] text-[var(--text-muted)] hover:enabled:border-[var(--text-faint)]'
    : ''
  const diffLineActionState = variant === 'diff-line-action' && selected ? 'text-[var(--accent)]' : ''
  const classes = `${variant === 'badge' ? classSet.replace(/\bbtn\b/g, '') : classSet} ${variant === 'roster-open' ? 'children-open' : ''} ${buttonChrome(variant)} ${reactionState} ${agentOptionState} ${diffLineActionState} ${(variant === 'danger' || variant === 'legacy-danger') && armed ? BTN_GHOST_DANGER_ARM : ''} ${selected && variant === 'subtle-icon' ? 'bg-selected-fill text-[var(--text-primary)]' : ''} ${variant === 'status-chip' ? status === 'failed' ? 'bg-[color-mix(in_srgb,var(--warn)_16%,transparent)] text-[var(--warn)] hover:bg-[color-mix(in_srgb,var(--warn)_24%,transparent)]' : 'bg-[var(--accent-muted)] text-[var(--accent)] hover:bg-[color-mix(in_srgb,var(--accent)_22%,transparent)]' : ''} ${noDrag ? '[-webkit-app-region:no-drag]' : ''} ${className}`
  const Icon = icon
  const EndIcon = iconEnd

  return (
    <button {...buttonProps} ref={ref} type={type} className={classes}>
      {Icon && <Icon />}
      {children}
      {EndIcon && <EndIcon />}
    </button>
  )
}
