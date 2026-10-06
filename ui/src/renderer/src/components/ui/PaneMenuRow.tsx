import type { IconComponent } from '../icons'
import { Icon } from './Icon'
import { Tooltip } from './Tooltip'
import { Text } from './Text'

const ROW_CLS = 'flex items-center gap-[var(--space-2-5)] px-[var(--space-3)] min-h-[var(--h-ctl)] w-full text-left bg-transparent border-none hover:bg-[color-mix(in_srgb,var(--text-primary)_8%,transparent)] hover:text-[var(--text-primary)] disabled:opacity-40 disabled:hover:bg-transparent'

/** One row of the New pane menu: icon, label and an optional shortcut; `disabledReason` disables it and explains why. */
export function PaneMenuRow({ icon, label, shortcut, disabledReason, onClick, 'data-testid': testId }: {
  icon: IconComponent
  label: string
  shortcut?: string
  disabledReason?: string
  onClick: () => void
  'data-testid'?: string
}): React.JSX.Element {
  return (
    <Tooltip label={disabledReason} className="inline-flex w-full">
      <button type="button" data-testid={testId} disabled={disabledReason !== undefined} className={ROW_CLS} onClick={onClick}>
        <Icon glyph={icon} role="ui" className="text-[var(--text-muted)] flex-none" />
        <Text size="ui" weight="ui" tone="secondary" className="flex-1">{label}</Text>
        {shortcut && <Text size="small" weight="small" tone="faint" mono>{shortcut}</Text>}
      </button>
    </Tooltip>
  )
}
