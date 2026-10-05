import { Icon } from '../Icon'
import { IconClose, IconGrid } from '../icons'

export function GridRailRowFallback({ name, selected, jumpNumber, onSelect, onContextMenu, onRemove }: {
  name: string
  selected: boolean
  jumpNumber: number
  onSelect: () => void
  onContextMenu: (event: React.MouseEvent) => void
  onRemove?: () => void
}): React.JSX.Element {
  return <div role="button" tabIndex={0} data-testid="grid-row" data-selected={selected ? 'true' : undefined} aria-current={selected ? 'true' : undefined} aria-label={name} className={`rail-grid-row group relative flex min-h-[var(--h-row)] min-w-0 items-center gap-[var(--space-2)] rounded-[var(--tr-radius-sm)] px-[var(--space-2)] py-[var(--space-1)] pl-[var(--space-6)] [font-weight:var(--tr-text-ui-weight)] ${selected ? 'bg-selected-fill text-[var(--text-primary)]' : 'bg-transparent text-[var(--text-secondary)]'}`} onClick={onSelect} onContextMenu={onContextMenu}>
    <Icon glyph={IconGrid} role="small" className="flex-none text-[var(--text-faint)]" />
    <span data-testid="grid-name" className="min-w-0 flex-1 truncate">{name}</span>
    <span role="img" data-testid="grid-state-dot" data-state="loading" aria-label="Loading status" />
    <span aria-hidden data-testid="rail-jump-number" className="rail-jump absolute left-[var(--space-1)] top-1/2 -translate-y-1/2 hidden font-mono text-[var(--accent)]">{jumpNumber}</span>
    {onRemove && <button type="button" data-testid="grid-close" aria-label={`Remove ${name}`} className="absolute right-[var(--space-1)] top-1/2 hidden h-[var(--h-ctl-mini)] w-[var(--h-ctl-mini)] -translate-y-1/2 items-center justify-center rounded-[var(--tr-radius-sm)] bg-transparent text-[var(--text-muted)] hover:bg-[var(--card-hover)] hover:text-[var(--text-primary)] group-hover:flex" onClick={(event) => { event.stopPropagation(); onRemove() }}><Icon glyph={IconClose} role="small" /></button>}
  </div>
}
