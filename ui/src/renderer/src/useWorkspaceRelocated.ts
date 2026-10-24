import { useEffect, type RefObject } from 'react'
import type { Conn } from './App'
import type { NoticeInput } from './notices'
import type { RelocateState } from './workspaceRelocate'

// A relocated workspace moves its renderer-local state (grids, colours, pins) to the new
// path. The module loads on the first relocation, so the boot bundle does not carry it.
export function useWorkspaceRelocated(
  conn: Conn,
  state: RefObject<RelocateState | null>,
  pushNotice: (notice: NoticeInput) => void
): void {
  useEffect(() => {
    if (conn.kind !== 'ready') return
    return conn.client.subscribe('workspace_relocated', (msg) => {
      void import('./workspaceRelocate').then((m) => {
        if (state.current) m.moveWorkspaceLocalState(msg.from, msg.to, state.current)
        pushNotice(m.relocatedNotice(msg))
      })
    })
  }, [conn, state, pushNotice])
}
