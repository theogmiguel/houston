import { useState } from 'react'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { Text } from '../ui/Text'

type RemoveGrid = (path: string, gridId: string) => void
type ClosingGrid = { id: string; name: string; sessionIds?: readonly number[]; count?: number }

export function gridAgentCount(grid: ClosingGrid): number {
  return grid.sessionIds?.length ?? grid.count ?? 0
}

export function useGridCloseConfirm(
  gridsByWorkspace: Record<string, readonly ClosingGrid[]>,
  onRemoveGrid: RemoveGrid | undefined,
): { removeGrid: RemoveGrid | undefined; closingLastEl: React.JSX.Element | null } {
  const [closing, setClosing] = useState<{ path: string; grid: ClosingGrid; count: number } | null>(null)
  if (!onRemoveGrid) return { removeGrid: undefined, closingLastEl: null }
  const removeGrid: RemoveGrid = (path, gridId) => {
    const grid = gridsByWorkspace[path]?.find((item) => item.id === gridId)
    if (!grid) return
    const count = gridAgentCount(grid)
    if (count > 0) setClosing({ path, grid, count })
    else onRemoveGrid(path, gridId)
  }
  const closingLastEl = closing && (
    <ConfirmDialog
      title={`Close ${closing.grid.name}?`}
      confirmLabel="Close grid"
      onCancel={() => setClosing(null)}
      onConfirm={() => { onRemoveGrid(closing.path, closing.grid.id); setClosing(null) }}
    >
      <Text size="small" tone="muted">
        Closing {closing.grid.name} ends its {closing.count} {closing.count === 1 ? 'agent' : 'agents'}.
        {(gridsByWorkspace[closing.path]?.length ?? 0) <= 1 && ' This workspace will start empty.'}
      </Text>
    </ConfirmDialog>
  )
  return { removeGrid, closingLastEl }
}
