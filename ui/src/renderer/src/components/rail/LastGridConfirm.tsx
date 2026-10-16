import { useState } from 'react'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { Text } from '../ui/Text'

// `nextGridId` names the grid to select when the removed one was selected.
type RemoveGrid = (path: string, gridId: string, nextGridId?: string) => void
// `childCount` is the agents spawned (at any depth) by the grid's panes; closing the grid ends them too.
type ClosingGrid = { id: string; name: string; sessionIds?: readonly number[]; count?: number; childCount?: number }

export function gridChildCount(grid: ClosingGrid): number {
  return grid.childCount ?? 0
}

function agentsPhrase(count: number): string {
  return `${count} ${count === 1 ? 'agent' : 'agents'}`
}

export function gridAgentCount(grid: ClosingGrid): number {
  return grid.sessionIds?.length ?? grid.count ?? 0
}

export function useGridCloseConfirm(
  gridsByWorkspace: Record<string, readonly ClosingGrid[]>,
  onRemoveGrid: RemoveGrid | undefined,
): { removeGrid: RemoveGrid | undefined; closingLastEl: React.JSX.Element | null } {
  const [closing, setClosing] = useState<{ path: string; grid: ClosingGrid; count: number; nextGridId?: string } | null>(null)
  if (!onRemoveGrid) return { removeGrid: undefined, closingLastEl: null }
  const removeGrid: RemoveGrid = (path, gridId, nextGridId) => {
    const grid = gridsByWorkspace[path]?.find((item) => item.id === gridId)
    if (!grid) return
    const count = gridAgentCount(grid)
    if (count > 0) setClosing({ path, grid, count, nextGridId })
    else onRemoveGrid(path, gridId, nextGridId)
  }
  const closingLastEl = closing && (
    <ConfirmDialog
      title={`Close ${closing.grid.name}?`}
      confirmLabel="Close grid"
      onCancel={() => setClosing(null)}
      onConfirm={() => { onRemoveGrid(closing.path, closing.grid.id, closing.nextGridId); setClosing(null) }}
    >
      <Text size="small" tone="muted">
        Closing {closing.grid.name} ends its {agentsPhrase(closing.count)}
        {gridChildCount(closing.grid) > 0 && ` and their ${gridChildCount(closing.grid)} child ${gridChildCount(closing.grid) === 1 ? 'agent' : 'agents'}`}.
        {(gridsByWorkspace[closing.path]?.length ?? 0) <= 1 && ' This workspace will start empty.'}
      </Text>
    </ConfirmDialog>
  )
  return { removeGrid, closingLastEl }
}
