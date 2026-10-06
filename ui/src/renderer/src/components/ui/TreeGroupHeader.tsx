import type { ReactNode, MouseEvent } from 'react'
import { IconFilter } from '../icons'
import { Button } from './Button'
import { Icon } from './Icon'
import { Text } from './Text'
import { Tooltip } from './Tooltip'

export function TreeGroupHeader({ label, filterOpen, activeFilterCount, filterLabel, onToggleFilter, leadingAction }: {
  label: string
  filterOpen: boolean
  activeFilterCount: number
  filterLabel: string
  onToggleFilter: (event: MouseEvent<HTMLButtonElement>) => void
  leadingAction?: ReactNode
}): React.JSX.Element {
  return (
    <div data-testid="tree-group-header" className="flex items-center gap-[var(--space-1)] px-[var(--space-4)] pt-[var(--space-4)] pb-[var(--space-1-5)] h-[var(--h-tree-group-header)]">
      <Text className="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap" size="ui" weight="semibold" tone="primary">{label}</Text>
      <span className="flex flex-none gap-[var(--space-0-5)]">
        <Tooltip label={filterLabel}>
          <Button type="button" variant="compact-icon" aria-label={filterLabel} aria-expanded={filterOpen} data-testid="tree-filter-toggle" onClick={onToggleFilter}>
            <Icon glyph={IconFilter} role="ui" />
            {activeFilterCount > 0 && <span aria-hidden data-testid="tree-filter-badge" className="top-[var(--offset-filter-badge)] right-[var(--offset-filter-badge)] absolute min-w-[var(--w-filter-badge-min)] h-[var(--h-filter-badge)] px-[var(--space-filter-badge-x)] rounded-full bg-[var(--accent)] text-white [font-size:var(--tr-text-filter-badge-size)] [font-weight:var(--tr-text-label-weight)] leading-[var(--h-filter-badge)] text-center tabular-nums">{activeFilterCount > 9 ? '9+' : activeFilterCount}</span>}
          </Button>
        </Tooltip>
      </span>
      <span className="flex flex-none">{leadingAction}</span>
    </div>
  )
}

export function TreeGroupHeaderSpecimen(): React.JSX.Element {
  return <div className="w-64"><TreeGroupHeader label="Workspaces" filterOpen activeFilterCount={3} filterLabel="Filter by tag (3 active)" onToggleFilter={() => {}} leadingAction={<Button variant="compact-icon-secondary" aria-label="Add workspace"><Icon glyph={IconFilter} role="ui" /></Button>} /></div>
}
