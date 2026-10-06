import { BTN_ICO } from './ui/buttonChrome'
import { Icon } from './ui/Icon'
import { IconPanelRight } from './icons'
import { Tooltip } from './ui/Tooltip'

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
    <Tooltip label={open ? 'Hide side panel' : `Show side panel (${chord})`}>
      <button
        type="button"
        data-testid="scm-toggle"
        data-open={open ? 'true' : undefined}
        aria-label={open ? 'Hide side panel' : 'Show side panel'}
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
