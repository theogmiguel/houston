import { createContext, useContext, useMemo, useRef, useSyncExternalStore } from 'react'
import type { SessionInfo } from './houston/client'

export type SessionsSnapshot = Map<number, SessionInfo>
export type SessionsUpdate = SessionsSnapshot | ((previous: SessionsSnapshot) => SessionsSnapshot)

export function createSessionsStore(initial: SessionsSnapshot = new Map()) {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: (): SessionsSnapshot => snapshot,
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set: (update: SessionsUpdate): void => {
      const next = typeof update === 'function' ? update(snapshot) : update
      if (next === snapshot) return
      snapshot = next
      for (const listener of listeners) listener()
    }
  }
}

export type SessionsStore = ReturnType<typeof createSessionsStore>
export const SessionsStoreContext = createContext<SessionsStore | null>(null)
const noSubscription = (): (() => void) => () => {}

export function shallowArrayEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
}

export function useSessionsSelector<T>(
  select: (sessions: SessionsSnapshot) => T,
  equal: (previous: T, next: T) => boolean,
  fallback: T,
  explicitStore?: SessionsStore,
): T {
  const contextStore = useContext(SessionsStoreContext)
  const store = explicitStore ?? contextStore
  const cache = useRef<{ value: T } | null>(null)
  const getSelection = useMemo(() => {
    let previousSnapshot: SessionsSnapshot | undefined
    let selection: T
    let initialized = false
    return (): T => {
      if (!store) return fallback
      const snapshot = store.getSnapshot()
      if (initialized && previousSnapshot === snapshot) return selection
      const next = select(snapshot)
      previousSnapshot = snapshot
      if (!cache.current || !equal(cache.current.value, next)) cache.current = { value: next }
      selection = cache.current.value
      initialized = true
      return selection
    }
  }, [store, select, equal, fallback])
  return useSyncExternalStore(store?.subscribe ?? noSubscription, getSelection, getSelection)
}

const identity = (sessions: SessionsSnapshot): SessionsSnapshot => sessions
const emptySessions = new Map<number, SessionInfo>()
export function useSessions(fallback: ReadonlyMap<number, SessionInfo> = emptySessions): ReadonlyMap<number, SessionInfo> {
  return useSessionsSelector(identity, Object.is, fallback)
}

export function useSession(id: number, fallback?: SessionInfo): SessionInfo | undefined {
  return useSessionsSelector((sessions) => sessions.get(id), Object.is, fallback)
}

export function useSessionFamily(id: number, fallback: ReadonlyMap<number, SessionInfo> = emptySessions): ReadonlyMap<number, SessionInfo> {
  const fallbackMembers = useMemo(() => [...fallback.values()], [fallback])
  const members = useSessionsSelector(
    (sessions) => {
      const parent = sessions.get(id)?.spawned_by
      return [...sessions.values()].filter((session) => session.id === id || session.id === parent || session.spawned_by === id)
    },
    shallowArrayEqual,
    fallbackMembers,
  )
  return useMemo(() => new Map(members.map((session) => [session.id, session])), [members])
}

const emptyIds: number[] = []
export function useSessionIds(filter?: (session: SessionInfo) => boolean): number[] {
  return useSessionsSelector(
    (sessions) => [...sessions.values()].filter((session) => !filter || filter(session)).map((session) => session.id),
    shallowArrayEqual,
    emptyIds,
  )
}

export function useWorkspaceWaiting(path: string, fallback: boolean): boolean {
  return useSessionsSelector(
    (sessions) => [...sessions.values()].some((session) => session.project_dir === path && session.children_waiting > 0),
    Object.is,
    fallback,
  )
}

const leafFields = new Set<keyof SessionInfo>(['status', 'context', 'compactions', 'delegation', 'live_children', 'children_waiting'])

// App owns layout and actions; these fields only affect subscribed leaves.
export function layoutSessionsEqual(previous: SessionsSnapshot, next: SessionsSnapshot): boolean {
  if (previous.size !== next.size) return false
  const nextIds = next.keys()
  for (const [id, session] of previous) {
    if (nextIds.next().value !== id) return false
    const other = next.get(id)
    if (!other) return false
    if (session === other) continue
    const keys = Object.keys(session) as (keyof SessionInfo)[]
    const otherKeys = Object.keys(other) as (keyof SessionInfo)[]
    if (keys.some((key) => !leafFields.has(key) && !Object.is(session[key], other[key])) ||
        otherKeys.some((key) => !leafFields.has(key) && !Object.is(session[key], other[key]))) return false
  }
  return true
}

export function useLayoutSessions(store: SessionsStore): SessionsSnapshot {
  return useSessionsSelector(identity, layoutSessionsEqual, emptySessions, store)
}
