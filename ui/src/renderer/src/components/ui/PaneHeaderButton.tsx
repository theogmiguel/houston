import type { IconComponent } from '../icons'
import { HIT_TARGET_28 } from '../hitTarget'
import { Button } from './Button'

export interface PaneHeaderButtonProps {
  icon: IconComponent
  'aria-label': string
  onClick?: () => void
  disabled?: boolean
}

export function PaneHeaderButton({ icon, ...props }: PaneHeaderButtonProps): React.JSX.Element {
  return <Button {...props} variant="icon" icon={icon} className={HIT_TARGET_28} />
}
