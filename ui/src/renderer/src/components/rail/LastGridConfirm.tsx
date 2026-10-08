import { useState } from 'react'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { Text } from '../ui/Text'

type RemoveGrid = (path: string, gridId: string) => void

/// Closing a workspace's last grid ends its panes, so it asks first; other grids close at once.
export function useLastGridConfirm(
  gridsByWorkspace: Record<string, readonly unknown[]>,
  onRemoveGrid: RemoveGrid | undefined
): { removeGrid: RemoveGrid | undefined; closingLastEl: React.JSX.Element | null } {
  const [closing, setClosing] = useState<{ path: string; gridId: string } | null>(null)
  if (!onRemoveGrid) return { removeGrid: undefined, closingLastEl: null }
  const removeGrid: RemoveGrid = (path, gridId) => {
    if ((gridsByWorkspace[path]?.length ?? 0) <= 1) setClosing({ path, gridId })
    else onRemoveGrid(path, gridId)
  }
  const closingLastEl = closing && (
    <ConfirmDialog
      title="Close this grid?"
      confirmLabel="Close grid"
      onCancel={() => setClosing(null)}
      onConfirm={() => {
        onRemoveGrid(closing.path, closing.gridId)
        setClosing(null)
      }}
    >
      <Text size="small" tone="muted">
        It is this workspace&apos;s only grid, so its panes end and the workspace starts empty.
      </Text>
    </ConfirmDialog>
  )
  return { removeGrid, closingLastEl }
}
