import type { IconComponent } from '../icons'
import { HIT_TARGET_28 } from '../hitTarget'
import type { IconRole } from './Icon'
import { Button } from './Button'
import { Icon } from './Icon'

export interface PaneHeaderButtonProps {
  icon: IconComponent
  'aria-label': string
  iconRole?: IconRole
  size?: 'default' | 'mini'
  tone?: 'muted' | 'secondary'
  onClick?: () => void
  disabled?: boolean
  spinning?: boolean
  'data-testid'?: string
}

export function PaneHeaderButton({ icon, iconRole, size = 'default', tone = 'muted', spinning = false, ...props }: PaneHeaderButtonProps): React.JSX.Element {
  const Glyph: IconComponent = iconRole
    ? (iconProps) => <Icon glyph={icon} role={iconRole} className={iconProps.className} />
    : icon
  const sizeClass = size === 'mini' ? 'w-[var(--h-ctl-mini)]' : ''
  const toneClass = tone === 'secondary' ? 'text-[var(--text-secondary)]' : ''
  const miniStateClass = size === 'mini' ? 'disabled:text-[var(--text-faint)] disabled:opacity-55' : ''
  return <Button {...props} variant="icon" icon={Glyph} className={`${HIT_TARGET_28} ${sizeClass} ${toneClass} ${miniStateClass} ${spinning ? 'animate-spin' : ''}`} />
}
