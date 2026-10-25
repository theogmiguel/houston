import { useEffect, type RefObject } from 'react'
import type { Conn } from './App'
import type { NoticeInput } from './notices'
import type { RelocateState } from './workspaceRelocate'

// A relocated workspace moves its renderer-local state (grids, colours, pins) to the new
// path. Locate loads the module before its request, keeping it out of the boot bundle
// while the move still lands before the panes' `session_reparented`.
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
