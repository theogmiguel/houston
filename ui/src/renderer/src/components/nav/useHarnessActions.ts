import { useCallback } from 'react'
import type { Conn } from '../../App'
import { showItemInFolder } from '../../houston/bridge'
import { setRailView } from '../../railView'
import type { HoustonClient } from '../../houston/client'

/// What the Harness view asks of the rest of the app: open a report file or show
/// it in the file manager, bringing the reviewed workspace into view.
export function useHarnessActions({
  conn,
  showWorkspace,
  openEditorFile,
  pushError
}: {
  conn: Conn
  showWorkspace: (dir: string) => void
  openEditorFile: (workspaceDir: string, path: string, anchor: null) => void
  pushError: (message: string) => void
}): {
  client: HoustonClient | null
  openFile: (workspace: string, path: string) => void
  reveal: (path: string) => void
} {
  const client = conn.kind === 'ready' ? conn.client : null
  return {
    client,
    openFile: useCallback(
      (workspace: string, path: string) => {
        setRailView(null)
        showWorkspace(workspace)
        openEditorFile(workspace, path, null)
      },
      [showWorkspace, openEditorFile]
    ),
    reveal: useCallback(
      (path: string) => {
        void showItemInFolder(path).then((res) => {
          if (!res.ok) pushError(res.error)
        })
      },
      [pushError]
    ),
  }
}
