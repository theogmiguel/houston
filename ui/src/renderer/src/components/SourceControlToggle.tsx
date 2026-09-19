import { BTN_ICO } from './buttonChrome'
import { Icon } from './Icon'
import { IconPanelRight } from './icons'
import { Tooltip } from './Tooltip'

export interface SourceControlToggleProps {
  open: boolean
  chord: string
  onToggle: () => void
}

// The top bar's panel toggle, mirroring the rail toggle on the far left: the
// filled state is the open one, and the tooltip carries the chord.
export function SourceControlToggle({
  open,
  chord,
  onToggle
}: SourceControlToggleProps): React.JSX.Element {
  return (
    <Tooltip label={open ? 'Hide source control' : `Show source control (${chord})`}>
      <button
        type="button"
        data-testid="scm-toggle"
        data-open={open ? 'true' : undefined}
        aria-label={open ? 'Hide source control' : 'Show source control'}
        aria-pressed={open}
        className={`relative ${BTN_ICO} [-webkit-app-region:no-drag] ${
          open ? 'bg-[var(--card-hover)] text-[var(--text-primary)]' : ''
        }`}
        onClick={onToggle}
      >
        <Icon glyph={IconPanelRight} role="ui" />
      </button>
    </Tooltip>
  )
}
