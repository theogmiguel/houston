import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react'
import { BTN_DANGER_SOLID, BTN_GHOST, BTN_GHOST_DANGER_ARM, BTN_GHOST_DANGER_HOVER, BTN_ICO, BTN_PRIMARY, BTN_SECONDARY } from '../buttonChrome'
import type { IconComponent } from '../icons'
import { variants } from './variants'

export type ButtonVariant = 'primary' | 'secondary' | 'field' | 'outline' | 'ghost' | 'label' | 'link' | 'danger' | 'danger-solid' | 'icon' | 'text' | 'badge' | 'ghost-icon' | 'ghost-icon-danger' | 'legacy-primary' | 'legacy-secondary' | 'legacy-ghost' | 'legacy-danger' | 'legacy-danger-solid' | 'legacy-icon' | 'legacy-ghost-icon' | 'legacy-ghost-icon-danger'
export type ButtonSize = 'md' | 'sm'

interface ButtonBaseProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'type'> {
  size?: ButtonSize
  armed?: boolean
  iconEnd?: IconComponent
  /** Layout classes only; visual styles belong in Button variants. */
  className?: string
  type?: ButtonHTMLAttributes<HTMLButtonElement>['type']
  ref?: Ref<HTMLButtonElement>
}

type LabeledButtonProps = ButtonBaseProps & {
  variant?: Exclude<ButtonVariant, 'icon' | 'danger-solid'>
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
  variant: 'icon'
  icon: IconComponent
  children?: never
  'aria-label': string
  iconEnd?: never
}

export type ButtonProps = LabeledButtonProps | DangerSolidButtonProps | IconButtonProps

const sizeClasses = {
  md: 'h-[var(--h-ctl)] px-[var(--space-3)] gap-[var(--space-1-5)]',
  sm: 'h-[var(--h-ctl-mini)] px-[var(--space-2)] gap-[var(--space-1-5)]',
  icon: ''
} as const

const buttonClasses = variants(
  'btn inline-flex items-center justify-center disabled:cursor-not-allowed',
  {
    variant: {
      primary: 'border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-ink)] hover:enabled:bg-[var(--accent-hover)]',
      secondary: 'border-[var(--border)] bg-[var(--hover-fill)] text-[var(--text-secondary)] hover:enabled:border-[var(--border-hover)] hover:enabled:bg-[var(--card-hover)] hover:enabled:text-[var(--text-primary)]',
      field: 'justify-start border-[var(--border)] bg-[var(--card-bg)] text-left font-normal text-[var(--text-secondary)] hover:enabled:border-[var(--border-hover)] hover:enabled:bg-[var(--card-hover)] hover:enabled:text-[var(--text-primary)]',
      outline: 'border-[var(--border)] bg-transparent text-[var(--text-primary)] hover:enabled:border-[var(--border-hover)] hover:enabled:bg-[var(--hover-fill)]',
      ghost: `btn ${BTN_GHOST}`,
      label: 'h-auto min-h-0 border-0 bg-transparent p-0 text-left [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] [letter-spacing:0.06em] uppercase text-[var(--text-muted)] hover:enabled:bg-transparent hover:enabled:text-[var(--text-primary)]',
      link: 'border-transparent bg-transparent !px-0 !py-0 !h-auto min-h-0 align-baseline text-[length:var(--tr-text-small-size)] text-[var(--accent)] hover:enabled:bg-transparent hover:enabled:underline',
      danger: `btn ${BTN_GHOST} ${BTN_GHOST_DANGER_HOVER}`,
      'danger-solid': BTN_DANGER_SOLID,
      icon: BTN_ICO,
      text: 'h-auto min-h-0 border-0 bg-transparent p-0 text-left font-semibold text-[var(--text-primary)] hover:enabled:bg-transparent hover:enabled:text-[var(--text-primary)]',
      badge: 'h-auto min-h-0 border-0 bg-transparent p-0 inline-flex items-center text-[var(--text-secondary)] [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] flex-none whitespace-nowrap cursor-default gap-1.5 [font-variant-numeric:tabular-nums] rounded-[var(--tr-radius-sm)] hover:text-[var(--text-primary)] focus-visible:text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:[outline-offset:2px]',
      'ghost-icon': `btn ${BTN_GHOST} p-1 rounded-[var(--tr-radius-sm)]`,
      'ghost-icon-danger': `btn ${BTN_GHOST} p-1 rounded-[var(--tr-radius-sm)] enabled:hover:text-[var(--danger)]`,
      'legacy-primary': `btn ${BTN_PRIMARY}`,
      'legacy-secondary': BTN_SECONDARY,
      'legacy-ghost': `btn ${BTN_GHOST}`,
      'legacy-danger': `btn ${BTN_GHOST} ${BTN_GHOST_DANGER_HOVER}`,
      'legacy-danger-solid': `btn ${BTN_DANGER_SOLID}`,
      'legacy-icon': `btn ${BTN_ICO}`,
      'legacy-ghost-icon': `btn ${BTN_GHOST} p-1 rounded-[var(--tr-radius-sm)]`,
      'legacy-ghost-icon-danger': `btn ${BTN_GHOST} p-1 rounded-[var(--tr-radius-sm)] enabled:hover:text-[var(--danger)]`
    },
    size: sizeClasses
  },
  { variant: 'secondary', size: 'md' }
)

// Variants that carry their own type and padding: no button chrome, no size padding.
const SELF_SIZED: ReadonlySet<ButtonVariant> = new Set<ButtonVariant>(['icon', 'text', 'badge', 'label'])
const OWN_CHROME: ReadonlySet<ButtonVariant> = new Set<ButtonVariant>(['badge', 'label'])
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
    icon,
    iconEnd,
    className = '',
    children,
    type = 'button',
    ref,
    ...buttonProps
  } = props
  const classSet = buttonClasses({ variant, size: buttonSize(variant, size) })
  const classes = `${variant === 'badge' ? classSet.replace(/\bbtn\b/g, '') : classSet} ${buttonChrome(variant)} ${(variant === 'danger' || variant === 'legacy-danger') && armed ? BTN_GHOST_DANGER_ARM : ''} ${className}`
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
