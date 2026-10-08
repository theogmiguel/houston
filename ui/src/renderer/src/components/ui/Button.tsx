import { useContext, type ButtonHTMLAttributes, type ReactNode, type Ref } from 'react'
import { BTN_DANGER_SOLID, BTN_GHOST, BTN_GHOST_DANGER_ARM, BTN_GHOST_DANGER_HOVER, BTN_ICO, BTN_PRIMARY } from './buttonChrome'
import type { IconComponent } from '../icons'
import { variants } from './variants'
import { FOCUS_HALO } from './shadowChrome'
import './button.css'
import { CONTROL_SIZE_SQUARE_CLS } from '../controlSize'
import { Tooltip, TooltipContext } from './Tooltip'

export type ButtonVariant = 'primary' | 'secondary' | 'field' | 'ghost' | 'link' | 'danger' | 'danger-solid' | 'icon' | 'icon-selected' | 'icon-structure' | 'text' | 'badge' | 'ghost-icon' | 'ghost-icon-danger' | 'confirm-primary' | 'compact-outline' | 'danger-confirmation' | 'legacy-primary' | 'legacy-ghost' | 'legacy-danger' | 'legacy-danger-solid' | 'legacy-icon' | 'legacy-roster-footer' | 'legacy-icon-warning' | 'legacy-titlebar-icon' | 'legacy-ghost-compact' | 'roster-open' | 'mini-primary-action' | 'action-primary' | 'surface' | 'surface-large' | 'subtle-icon' | 'compact-icon' | 'compact-icon-secondary' | 'disclosure-icon' | 'small-icon' | 'status-chip'
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

type CoreButtonVariant = ButtonVariant

type LabeledButtonProps = ButtonBaseProps & {
  variant?: Exclude<CoreButtonVariant, 'icon' | 'subtle-icon' | 'compact-icon' | 'compact-icon-secondary' | 'disclosure-icon' | 'small-icon' | 'danger-solid'>
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

export type ButtonRecipeProps = ButtonBaseProps & {
  icon?: IconComponent
  children?: ReactNode
  'aria-label'?: string
}

export function ButtonFrame({
  className = '',
  icon,
  iconEnd,
  children,
  type = 'button',
  ref,
  size: _size,
  armed: _armed,
  selected: _selected,
  status: _status,
  contentAlign: _contentAlign,
  noDrag: _noDrag,
  ...buttonProps
}: ButtonRecipeProps): React.JSX.Element {
  const Icon = icon
  const EndIcon = iconEnd
  return (
    <button {...buttonProps} ref={ref} type={type} className={className}>
      {Icon && <Icon />}
      {children}
      {EndIcon && <EndIcon />}
    </button>
  )
}

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
      ghost: `btn ${BTN_GHOST}`,
      link: 'border-transparent bg-transparent !px-0 !py-0 !h-auto min-h-0 align-baseline text-[length:var(--tr-text-small-size)] text-[var(--accent)] hover:enabled:bg-transparent hover:enabled:underline',
      danger: `btn ${BTN_GHOST} ${BTN_GHOST_DANGER_HOVER}`,
      'danger-solid': BTN_DANGER_SOLID,
      icon: BTN_ICO,
      'icon-selected': `${BTN_ICO} bg-[var(--card-hover)] text-[var(--text-primary)]`,
      'icon-structure': `${CONTROL_SIZE_SQUARE_CLS.mini} rounded-[var(--tr-radius-sm)] bg-transparent border-none p-0 leading-none inline-flex items-center justify-center flex-none text-[color-mix(in_srgb,var(--text-muted)_55%,var(--text-primary))] hover:bg-[color-mix(in_srgb,var(--text-primary)_10%,transparent)] hover:text-[var(--text-primary)] focus-visible:bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] focus-visible:text-[var(--text-primary)] focus-visible:outline-none disabled:opacity-45 disabled:cursor-not-allowed [&_svg]:block [&_svg]:flex-none`,
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
      'mini-primary-action': `btn ${BTN_PRIMARY} inline-flex items-center gap-[var(--space-1-5)] h-[var(--h-ctl-mini)] px-[var(--space-1-5)] disabled:opacity-55`,
      'legacy-primary': `btn ${BTN_PRIMARY}`,
      'legacy-ghost': `btn ${BTN_GHOST}`,
      'legacy-danger': `btn ${BTN_GHOST} ${BTN_GHOST_DANGER_HOVER}`,
      'legacy-danger-solid': BTN_DANGER_SOLID,
      'legacy-icon': `btn ${BTN_ICO}`,
      'legacy-icon-warning': `btn ${BTN_ICO} text-warning hover:text-warning`,
      'legacy-titlebar-icon': `btn ${BTN_ICO} [-webkit-app-region:no-drag]`,
      'legacy-ghost-compact': `btn ${BTN_GHOST} px-2 py-1 [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] inline-flex items-center gap-1`,
      'legacy-roster-footer': `btn ${BTN_GHOST} min-h-[var(--h-ctl)]`,
      'roster-open': 'h-auto p-0 border-0 bg-transparent grid-cols-[16px_16px_minmax(0,1fr)_auto] gap-x-[var(--space-1)] [&>*:nth-child(-n+2)]:justify-self-center flex-1 min-w-0 min-h-[19px] text-left text-[var(--text-secondary)] [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] whitespace-nowrap cursor-default [font-variant-numeric:tabular-nums] rounded-[var(--tr-radius-sm)] hover:text-[var(--text-primary)] focus-visible:text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:[outline-offset:2px] [&_strong]:font-semibold [&_strong]:overflow-hidden [&_strong]:text-ellipsis [&_strong]:whitespace-nowrap'
    },
    size: sizeClasses
  },
  { variant: 'secondary', size: 'md' }
)

// Variants that carry their own type and padding: no button chrome, no size padding.
const SELF_SIZED: ReadonlySet<CoreButtonVariant> = new Set<CoreButtonVariant>(['icon', 'icon-selected', 'icon-structure', 'text', 'badge', 'confirm-primary', 'compact-outline', 'danger-confirmation', 'roster-open', 'mini-primary-action', 'subtle-icon', 'compact-icon', 'compact-icon-secondary', 'disclosure-icon', 'small-icon', 'status-chip', 'surface-large'])
const OWN_CHROME: ReadonlySet<CoreButtonVariant> = new Set<CoreButtonVariant>(['badge', 'confirm-primary', 'compact-outline', 'danger-confirmation', 'roster-open', 'mini-primary-action', 'surface-large', 'action-primary', 'subtle-icon', 'compact-icon', 'compact-icon-secondary', 'disclosure-icon', 'small-icon', 'status-chip'])
const isLegacy = (variant: CoreButtonVariant): boolean => variant.startsWith('legacy-')

function buttonSize(variant: CoreButtonVariant, size: ButtonSize): ButtonSize | 'icon' {
  return SELF_SIZED.has(variant) || variant.includes('icon') || isLegacy(variant) ? 'icon' : size
}

function buttonChrome(variant: CoreButtonVariant): string {
  return OWN_CHROME.has(variant) || isLegacy(variant) ? '' : 'rounded-[var(--tr-radius-button)] [font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)]'
}

const BARE_ICON_VARIANTS: ReadonlySet<CoreButtonVariant> = new Set<CoreButtonVariant>(['subtle-icon', 'compact-icon', 'compact-icon-secondary', 'disclosure-icon', 'small-icon', 'status-chip'])
const TOOLTIP_ICON_VARIANTS: ReadonlySet<CoreButtonVariant> = new Set<CoreButtonVariant>([
  'icon', 'icon-selected', 'icon-structure', 'subtle-icon', 'compact-icon', 'compact-icon-secondary',
  'small-icon', 'ghost-icon', 'ghost-icon-danger', 'legacy-icon', 'legacy-icon-warning', 'legacy-titlebar-icon'
])

// Prefix rewrites for variants whose recipe drops part of the shared `btn inline-flex …` head.
const HEAD_REWRITE: Partial<Record<CoreButtonVariant, [RegExp, string]>> = {
  'legacy-roster-footer': [/^btn inline-flex items-center (?:justify-center )?disabled:cursor-not-allowed /, ''],
  'roster-open': [/^btn inline-flex /, 'grid '],
  'legacy-danger-solid': [/^btn inline-flex items-center disabled:cursor-not-allowed /, 'btn ']
}

function structureClasses(variant: CoreButtonVariant, size: ButtonSize, contentAlign: 'center' | 'start'): string {
  const selectedClasses = buttonClasses({ variant, size: buttonSize(variant, size) })
  const aligned = contentAlign === 'start' ? selectedClasses.replace(' justify-center', '') : selectedClasses
  const rewrite = BARE_ICON_VARIANTS.has(variant)
    ? ([/^btn inline-flex items-center justify-center disabled:cursor-not-allowed /, ''] as [RegExp, string])
    : HEAD_REWRITE[variant]
  const classSet = rewrite ? aligned.replace(rewrite[0], rewrite[1]) : aligned
  return variant === 'badge' ? classSet.replace(/\bbtn\b/g, '') : classSet
}

function selectionClasses(variant: CoreButtonVariant, selected: boolean): string {
  if (!selected) return ''
  return variant === 'subtle-icon' ? 'bg-selected-fill text-[var(--text-primary)]' : ''
}

function stateClasses(variant: CoreButtonVariant, selected: boolean, armed: boolean, status: 'available' | 'failed'): string {
  const arm = (variant === 'danger' || variant === 'legacy-danger') && armed ? BTN_GHOST_DANGER_ARM : ''
  const chip = variant !== 'status-chip'
    ? ''
    : status === 'failed'
      ? 'bg-[color-mix(in_srgb,var(--warn)_16%,transparent)] text-[var(--warn)] hover:bg-[color-mix(in_srgb,var(--warn)_24%,transparent)]'
      : 'bg-[var(--accent-muted)] text-[var(--accent)] hover:bg-[color-mix(in_srgb,var(--accent)_22%,transparent)]'
  return `${selectionClasses(variant, selected)} ${arm} ${chip}`
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
  const classes = `${structureClasses(variant, size, contentAlign)} ${variant === 'roster-open' ? 'children-open' : ''} ${buttonChrome(variant)} ${stateClasses(variant, selected, armed, status)} ${noDrag ? '[-webkit-app-region:no-drag]' : ''} ${className}`
  const button = <ButtonFrame {...buttonProps} size={size} armed={armed} selected={selected} status={status} contentAlign={contentAlign} icon={icon} iconEnd={iconEnd} noDrag={noDrag} children={children} type={type} ref={ref} className={classes} />
  const label = buttonProps['aria-label']
  const parentTooltip = useContext(TooltipContext)
  return TOOLTIP_ICON_VARIANTS.has(variant) && label && !parentTooltip ? <Tooltip label={label}>{button}</Tooltip> : button
}
