import { Button } from './ui/Button'
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
      <Button
        variant={open ? 'icon-selected' : 'icon'}
        icon={IconPanelRight}
        className="relative"
        noDrag
        data-testid="scm-toggle"
        data-open={open ? 'true' : undefined}
        aria-label={open ? 'Hide side panel' : 'Show side panel'}
        aria-pressed={open}
        onClick={onToggle}
      />
    </Tooltip>
  )
}
