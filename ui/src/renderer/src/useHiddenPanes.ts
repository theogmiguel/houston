import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { isLive, type HoustonClient, type SessionInfo } from './houston/client'
import { errorSessionIds } from './houston/paneOps'
import {
  loadHiddenPanes,
  newestOfOrigin,
  saveHiddenPanes,
  sessionOrigin,
  type HiddenPane,
  type HiddenPanes
} from './layout/hiddenPanes'
import {
  appendToRoot,
  findPane,
  gridStorageKey,
  leaf,
  loadLayout,
  removeConversationLeaves,
  type GridMeta,
  type LayoutState
} from './layout/tree'

// Sleep persists, then waits up to 15 s for the CLI to exit; a `sleeping` state
// arriving later than this cannot answer the Sleep and hide request.
const SLEEP_AND_HIDE_WINDOW_MS = 30_000

export interface HiddenPanesController {
  hidden: HiddenPanes
  isHidden: (session: number) => boolean
  hide: (session: number) => void
  sleepAndHide: (session: number) => void
  /** Puts a hidden pane back into its grid without waking it; returns where it went. */
  show: (session: number) => HiddenPane | null
  /** `roster` is the store's current snapshot, which can be ahead of the last render. */
  sessionRemoved: (session: number, roster: ReadonlyMap<number, SessionInfo>) => void
  /** Drops entries whose conversation a complete roster no longer lists. */
  rosterReplaced: (roster: readonly SessionInfo[]) => void
}

export function useHiddenPanes({ sessions, client, setLayouts, gridsFor, activeGridId, locate, retainMissing }: {
  sessions: ReadonlyMap<number, SessionInfo>
  client: HoustonClient | null
  setLayouts: Dispatch<SetStateAction<Map<string, LayoutState>>>
  gridsFor: (workspace: string) => GridMeta[]
  activeGridId: (workspace: string) => string
  locate: (session: number) => HiddenPane | null
  retainMissing: (session: number) => boolean
}): HiddenPanesController {
  const [hidden, setHidden] = useState<HiddenPanes>(loadHiddenPanes)
  useEffect(() => saveHiddenPanes(hidden), [hidden])
  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions
  const sleepRequests = useRef(new Map<number, number>())

  const isHidden = useCallback((session: number): boolean => {
    const info = sessionsRef.current.get(session)
    return info !== undefined && hidden.has(sessionOrigin(info))
  }, [hidden])

  const conversation = (origin: number): Set<number> =>
    new Set([origin, ...[...sessionsRef.current.values()].filter((s) => sessionOrigin(s) === origin).map((s) => s.id)])

  const hide = useCallback((session: number): void => {
    const info = sessionsRef.current.get(session)
    if (!info || info.state !== 'sleeping') return
    const origin = sessionOrigin(info)
    const slot = locate(session) ?? { workspace: info.project_dir, gridId: activeGridId(info.project_dir) }
    const ids = conversation(origin)
    const keys = ['all', ...gridsFor(slot.workspace).map((grid) => gridStorageKey(slot.workspace, grid.id))]
    setLayouts((prev) => {
      let next = prev
      for (const key of keys) {
        const state = prev.get(key) ?? loadLayout(key)
        if (!state.tree) continue
        const tree = removeConversationLeaves(state.tree, ids)
        if (tree === state.tree) continue
        if (next === prev) next = new Map(prev)
        next.set(key, { ...state, tree })
      }
      return next
    })
    setHidden((prev) => new Map(prev).set(origin, slot))
  }, [activeGridId, gridsFor, locate, setLayouts])

  const place = useCallback((origin: number, slot: HiddenPane): HiddenPane | null => {
    const newest = newestOfOrigin(sessionsRef.current.values(), origin)
    setHidden((prev) => {
      if (!prev.has(origin)) return prev
      const next = new Map(prev)
      next.delete(origin)
      return next
    })
    if (!newest) return null
    const grids = gridsFor(slot.workspace)
    if (grids.length === 0) return null
    const target = grids.some((grid) => grid.id === slot.gridId) ? slot : { workspace: slot.workspace, gridId: activeGridId(slot.workspace) }
    const key = gridStorageKey(target.workspace, target.gridId)
    setLayouts((prev) => {
      const state = prev.get(key) ?? loadLayout(key)
      if (state.tree && findPane(state.tree, newest.id)) return prev
      return new Map(prev).set(key, { ...state, tree: appendToRoot(state.tree, leaf(newest.id)) })
    })
    return target
  }, [activeGridId, gridsFor, setLayouts])

  const show = useCallback((session: number): HiddenPane | null => {
    const info = sessionsRef.current.get(session)
    const slot = info && hidden.get(sessionOrigin(info))
    return info && slot ? place(sessionOrigin(info), slot) : null
  }, [hidden, place])

  // Wake and Start fresh replace the sleeping session; the conversation returns to its grid.
  useEffect(() => {
    for (const [origin, slot] of hidden) {
      const newest = newestOfOrigin(sessions.values(), origin)
      if (newest && newest.state !== 'sleeping') place(origin, slot)
    }
  }, [hidden, sessions, place])

  const sleepAndHide = useCallback((session: number): void => {
    if (!client) return
    sleepRequests.current.set(session, Date.now())
    client.send({ type: 'session_sleep', session })
  }, [client])

  useEffect(() => {
    if (!client) return
    // A refused or timed-out Sleep names its session; the pane stays where it is.
    return client.subscribe('error', (message) => {
      for (const id of errorSessionIds(message)) sleepRequests.current.delete(id)
    })
  }, [client])

  useEffect(() => {
    for (const [session, requestedAt] of sleepRequests.current) {
      const info = sessions.get(session)
      if (info?.state === 'sleeping' && Date.now() - requestedAt <= SLEEP_AND_HIDE_WINDOW_MS) {
        sleepRequests.current.delete(session)
        hide(session)
      } else if (!info || !isLive(info.state) || Date.now() - requestedAt > SLEEP_AND_HIDE_WINDOW_MS) {
        sleepRequests.current.delete(session)
      }
    }
  }, [sessions, hide])

  const sessionRemoved = useCallback((session: number, roster: ReadonlyMap<number, SessionInfo>): void => {
    const info = roster.get(session)
    if (!info) return
    const origin = sessionOrigin(info)
    // Wake announces the replacement before it removes the sleeping placeholder.
    if ([...roster.values()].some((s) => s.id !== session && sessionOrigin(s) === origin)) return
    setHidden((prev) => {
      if (!prev.has(origin)) return prev
      const next = new Map(prev)
      next.delete(origin)
      return next
    })
  }, [])

  const retainMissingRef = useRef(retainMissing)
  retainMissingRef.current = retainMissing
  const rosterReplaced = useCallback((roster: readonly SessionInfo[]): void => {
    const origins = new Set(roster.map(sessionOrigin))
    setHidden((prev) => {
      const gone = [...prev.keys()].filter((origin) => !origins.has(origin) && !retainMissingRef.current(origin))
      if (gone.length === 0) return prev
      const next = new Map(prev)
      for (const origin of gone) next.delete(origin)
      return next
    })
  }, [])

  return useMemo(
    () => ({ hidden, isHidden, hide, sleepAndHide, show, sessionRemoved, rosterReplaced }),
    [hidden, isHidden, hide, sleepAndHide, show, sessionRemoved, rosterReplaced]
  )
}
