import { IconGear } from '../icons'
import { Count } from './Count'
import { NavigationRailItem } from './NavigationRail'
import { HintKey } from './ShortcutHint'

export function SettingsFooterItem({ attention = 0, onClick }: { attention?: number; onClick?: () => void }): React.JSX.Element {
  return <NavigationRailItem icon={IconGear} label="Settings" aria-label="Settings" data-testid="rail-settings" selected={false} onClick={onClick} trailing={<span className="flex items-center gap-[var(--space-1)]">{attention > 0 && <span aria-label={`${attention} agent settings need you`}><Count value={attention} from="warn" /></span>}<HintKey size="compact">Ctrl ,</HintKey></span>} />
}
