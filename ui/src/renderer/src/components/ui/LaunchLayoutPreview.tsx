import { launchPreviewTree, preorderLeaves, type LayoutNode } from '../../layout/tree'

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
