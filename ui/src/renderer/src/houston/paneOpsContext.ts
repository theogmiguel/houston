import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from 'react'
import type { SessionInfo } from './client'
import { PaneOps } from './paneOps'

/** Inert tracker for trees rendered without a connected client. */
export const IDLE_PANE_OPS = new PaneOps()

export const PaneOpsContext = createContext<PaneOps>(IDLE_PANE_OPS)

export function useClosingSessions(ops: PaneOps): ReadonlySet<number> {
  return useSyncExternalStore(ops.subscribe, ops.closingIds)
}

/** What the layout may place and mount: sessions the user asked to close are neither. */
export function useLayoutPlacement(
  ops: PaneOps,
  sessions: Map<number, SessionInfo>,
  hidden: (id: number) => boolean = () => false
): { closingIds: ReadonlySet<number>; placeable: (id: number) => boolean; layoutSessions: Map<number, SessionInfo> } {
  const closingIds = useClosingSessions(ops)
  const placeable = useCallback(
    (id: number): boolean => sessions.get(id)?.spawned_by == null && !closingIds.has(id) && !hidden(id),
    [sessions, closingIds, hidden]
  )
  const layoutSessions = useMemo(
    () => (closingIds.size === 0 ? sessions : new Map([...sessions].filter(([id]) => !closingIds.has(id)))),
    [sessions, closingIds]
  )
  return { closingIds, placeable, layoutSessions }
}

export function usePaneOpState(session: number): { error: string | null; respawning: boolean; clearError: () => void } {
  const ops = useContext(PaneOpsContext)
  const error = useSyncExternalStore(ops.subscribe, () => ops.error(session))
  const respawning = useSyncExternalStore(ops.subscribe, () => ops.isRespawning(session))
  return { error, respawning, clearError: () => ops.clearError(session) }
}
