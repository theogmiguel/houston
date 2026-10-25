import { useSyncExternalStore } from 'react'

// Kept apart from threadStore so the pane menu reads the count without loading the thread chunk.
const lengths = new WeakMap<object, Map<number, number>>()
const listeners = new Set<() => void>()

/** Records how many messages wait in a session's queue, as its latest snapshot says. */
export function publishQueueLength(client: object, session: number, length: number): void {
  let sessions = lengths.get(client)
  if (!sessions) {
    sessions = new Map()
    lengths.set(client, sessions)
  }
  if ((sessions.get(session) ?? 0) === length) return
  if (length === 0) sessions.delete(session)
  else sessions.set(session, length)
  for (const listener of [...listeners]) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Messages waiting in a thread's queue; 0 until a pane showing it has read the queue. */
export function useThreadQueueLength(client: object, session: number): number {
  return useSyncExternalStore(subscribe, () => lengths.get(client)?.get(session) ?? 0)
}
