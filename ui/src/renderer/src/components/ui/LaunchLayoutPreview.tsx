import { launchPreviewTree, preorderLeaves, type LayoutNode } from '../../layout/tree'

export function LaunchPresetOutline({ count }: { count: number }): React.JSX.Element {
  const columns = count <= 1 ? 1 : 2
  const rows = Math.ceil(count / columns)
  const gap = 2
  const width = 34
  const height = 22
  const cellHeight = (height - gap * (rows - 1)) / rows
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" className="flex-none fill-none stroke-[var(--text-muted)] [stroke-width:1.2]">
      {Array.from({ length: count }, (_, index) => {
        const row = Math.floor(index / columns)
        const col = index % columns
        const rowCount = Math.min(columns, count - row * columns)
        const cellW = (width - gap * (rowCount - 1)) / rowCount
        return <rect key={index} x={col * (cellW + gap) + 0.6} y={row * (cellHeight + gap) + 0.6} width={cellW - 1.2} height={cellHeight - 1.2} rx="2" />
      })}
    </svg>
  )
}

export function LaunchPresetOutlineSpecimen(): React.JSX.Element {
  return <div className="flex items-center gap-[var(--space-2)]">{[1, 2, 4].map((count) => <LaunchPresetOutline key={count} count={count} />)}</div>
}

export interface LaunchLayoutPreviewProps {
  tree: LayoutNode | null
  count: number
  target: 'this-grid' | 'new-grid'
}

export function LaunchLayoutPreview({ tree, count, target }: LaunchLayoutPreviewProps): React.JSX.Element {
  const leaves = preorderLeaves(launchPreviewTree(tree, count, target))
  return (
    <section aria-label="Resulting layout" className="flex flex-col gap-[var(--space-2)]">
      <h2 className="m-0 [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] uppercase tracking-[var(--tr-text-label-tracking)] text-[var(--text-secondary)]">Layout preview</h2>
      <div data-testid="launch-layout-preview" className="grid grid-cols-2 gap-[var(--space-1)]">
        {leaves.map((pane, index) => (
          <div key={`${String(pane)}-${index}`} data-layout-slot={pane}
            className="flex h-[44px] items-center justify-center rounded-[var(--tr-radius-sm)] border border-dashed border-[var(--border-hover)] bg-[var(--card-bg)] [font-size:var(--tr-text-small-size)] text-[var(--text-muted)]">
            {typeof pane === 'number' && pane < 0 ? 'New session' : 'Existing pane'}
          </div>
        ))}
      </div>
    </section>
  )
}

export function LaunchLayoutPreviewSpecimen(): React.JSX.Element {
  return <LaunchLayoutPreview tree={null} count={4} target="new-grid" />
}
