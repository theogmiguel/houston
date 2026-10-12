import { IconGear } from '../icons'
import { Button } from './Button'
import { Icon } from './Icon'
import { Tooltip } from './Tooltip'

export function SettingsFooterItem({ attention = 0, onClick }: { attention?: number; onClick?: () => void }): React.JSX.Element {
  const label = attention > 0 ? `Settings, ${attention} agent setting${attention === 1 ? ' needs' : 's need'} you` : 'Settings'
  return (
    <Tooltip label={`${label} (Ctrl ,)`}>
      <Button variant="subtle-icon" aria-label={label} data-testid="rail-settings" onClick={onClick} className="relative">
        <Icon glyph={IconGear} role="ui" />
        {attention > 0 && <span aria-hidden data-testid="rail-settings-attention" className="pointer-events-none absolute -right-[var(--space-1)] -top-[var(--space-0-5)] font-mono text-[length:var(--tr-text-label-size)] leading-none text-[var(--text-muted)]">+{attention}</span>}
      </Button>
    </Tooltip>
  )
}
