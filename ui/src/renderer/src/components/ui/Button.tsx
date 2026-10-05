import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { BTN_DANGER_SOLID, BTN_GHOST, BTN_GHOST_DANGER_ARM, BTN_GHOST_DANGER_HOVER, BTN_ICO } from '../buttonChrome'
import type { IconComponent } from '../icons'
import { variants } from './variants'

export type ButtonVariant = 'primary' | 'secondary' | 'field' | 'ghost' | 'link' | 'danger' | 'danger-solid' | 'icon' | 'text'
export type ButtonSize = 'md' | 'sm'

interface ButtonBaseProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'type'> {
  size?: ButtonSize
  armed?: boolean
  iconEnd?: IconComponent
  /** Layout classes only; visual styles belong in Button variants. */
  className?: string
  type?: ButtonHTMLAttributes<HTMLButtonElement>['type']
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
  'btn inline-flex items-center justify-center rounded-[var(--tr-radius-button)] [font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)] disabled:cursor-not-allowed',
  {
    variant: {
      primary: 'border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-ink)] hover:enabled:bg-[var(--accent-hover)]',
      secondary: 'border-[var(--border)] bg-[var(--hover-fill)] text-[var(--text-secondary)] hover:enabled:border-[var(--border-hover)] hover:enabled:bg-[var(--card-hover)] hover:enabled:text-[var(--text-primary)]',
      field: 'justify-start border-[var(--border)] bg-[var(--card-bg)] text-left font-normal text-[var(--text-secondary)] hover:enabled:border-[var(--border-hover)] hover:enabled:bg-[var(--card-hover)] hover:enabled:text-[var(--text-primary)]',
      ghost: BTN_GHOST,
      link: 'border-transparent bg-transparent !px-0 !py-0 !h-auto min-h-0 align-baseline text-[length:var(--tr-text-small-size)] text-[var(--accent)] hover:enabled:bg-transparent hover:enabled:underline',
      danger: BTN_GHOST + ' ' + BTN_GHOST_DANGER_HOVER,
      'danger-solid': BTN_DANGER_SOLID,
      icon: BTN_ICO,
      text: 'h-auto min-h-0 border-0 bg-transparent p-0 text-left font-semibold text-[var(--text-primary)] hover:enabled:bg-transparent hover:enabled:text-[var(--text-primary)]'
    },
    size: sizeClasses
  },
  { variant: 'secondary', size: 'md' }
)

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
    ...buttonProps
  } = props
  const classes = `${buttonClasses({ variant, size: variant === 'icon' || variant === 'text' ? 'icon' : size })} ${variant === 'danger' && armed ? BTN_GHOST_DANGER_ARM : ''} ${className}`
  const Icon = icon
  const EndIcon = iconEnd

  return (
    <button {...buttonProps} type={type} className={classes}>
      {Icon && <Icon />}
      {children}
      {EndIcon && <EndIcon />}
    </button>
  )
}
