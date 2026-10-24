import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { HoustonClient } from '../houston/client'
import { buildThreadItems, type ThreadItem } from './threadModel'
import type { ThreadClientMsg, ThreadEvent, ThreadEventsMsg, ThreadHistoryMsg } from './threadTypes'

/** Events requested per history page, within the daemon's `THREAD_HISTORY_PAGE_MAX`. */
export const THREAD_HISTORY_PAGE = 200

export interface ThreadSnapshot {
  events: readonly ThreadEvent[]
  /** The first history page has arrived. */
  loaded: boolean
  /** The daemon holds events older than the first loaded one. */
  hasMore: boolean
  loadingEarlier: boolean
}

const EMPTY: ThreadSnapshot = { events: [], loaded: false, hasMore: false, loadingEarlier: false }

type HistoryRequest = 'latest' | 'earlier'

/** One session's timeline: the latest history page, earlier pages on demand, then live events. */
export class ThreadSessionStore {
  private snapshot: ThreadSnapshot = EMPTY
  private readonly listeners = new Set<() => void>()
  private readonly pending: HistoryRequest[] = []
  private early: ThreadEvent[] = []
  private lastStoredSeq = -1

  constructor(private readonly send: (msg: ThreadClientMsg) => void, readonly session: number) {}

  getSnapshot = (): ThreadSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  attach(): void {
    if (this.snapshot.loaded || this.pending.includes('latest')) return
    this.pending.push('latest')
    this.send({ type: 'thread_history', session: this.session, before_seq: null, limit: THREAD_HISTORY_PAGE })
  }

  loadEarlier(): void {
    const first = this.snapshot.events.find((event) => event.kind.type !== 'assistant_delta')
    if (!this.snapshot.loaded || !this.snapshot.hasMore || this.snapshot.loadingEarlier || first === undefined) return
    this.pending.push('earlier')
    this.set({ ...this.snapshot, loadingEarlier: true })
    this.send({ type: 'thread_history', session: this.session, before_seq: first.seq, limit: THREAD_HISTORY_PAGE })
  }

  onHistory(msg: ThreadHistoryMsg): void {
    const request = this.pending.shift() ?? 'latest'
    if (request === 'latest') {
      this.lastStoredSeq = -1
      const events = [...msg.events]
      this.noteStored(events)
      const early = this.early
      this.early = []
      this.set({ events: [...events, ...early.filter((event) => this.admit(event))], loaded: true, hasMore: msg.has_more, loadingEarlier: false })
      return
    }
    const first = this.snapshot.events[0]?.seq ?? Number.POSITIVE_INFINITY
    const older = msg.events.filter((event) => event.seq < first)
    this.set({ ...this.snapshot, events: [...older, ...this.snapshot.events], hasMore: msg.has_more, loadingEarlier: false })
  }

  onEvents(msg: ThreadEventsMsg): void {
    if (!this.snapshot.loaded) {
      this.early.push(...msg.events)
      return
    }
    const fresh = msg.events.filter((event) => this.admit(event))
    if (fresh.length > 0) this.set({ ...this.snapshot, events: [...this.snapshot.events, ...fresh] })
  }

  // A stored event at or below the newest stored seq already arrived in a history page.
  private admit(event: ThreadEvent): boolean {
    if (event.kind.type === 'assistant_delta') return true
    if (event.seq <= this.lastStoredSeq) return false
    this.lastStoredSeq = event.seq
    return true
  }

  private noteStored(events: readonly ThreadEvent[]): void {
    for (const event of events) if (event.kind.type !== 'assistant_delta') this.lastStoredSeq = Math.max(this.lastStoredSeq, event.seq)
  }

  private set(next: ThreadSnapshot): void {
    this.snapshot = next
    for (const listener of [...this.listeners]) listener()
  }
}

interface Registry {
  stores: Map<number, { store: ThreadSessionStore; holders: number }>
  off: () => void
}

const registries = new WeakMap<HoustonClient, Registry>()

function registryFor(client: HoustonClient): Registry {
  const existing = registries.get(client)
  if (existing) return existing
  const stores: Registry['stores'] = new Map()
  // Routed once per client by session, so N thread panes cost one handler per message.
  const offEvents = client.subscribe('thread_events', (msg) => stores.get(msg.session)?.store.onEvents(msg))
  const offHistory = client.subscribe('thread_history', (msg) => stores.get(msg.session)?.store.onHistory(msg))
  const off = (): void => { offEvents(); offHistory() }
  const registry = { stores, off }
  registries.set(client, registry)
  return registry
}

/** Holds the session's store while a pane shows it; the last release drops its events. */
export function retainThreadStore(client: HoustonClient, session: number): { store: ThreadSessionStore; release: () => void } {
  const registry = registryFor(client)
  let entry = registry.stores.get(session)
  if (!entry) {
    entry = { store: new ThreadSessionStore((msg) => client.send(msg), session), holders: 0 }
    registry.stores.set(session, entry)
  }
  entry.holders += 1
  const held = entry
  let released = false
  return {
    store: held.store,
    release: () => {
      if (released) return
      released = true
      held.holders -= 1
      if (held.holders > 0 || registry.stores.get(session) !== held) return
      registry.stores.delete(session)
      if (registry.stores.size === 0) {
        registry.off()
        registries.delete(client)
      }
    }
  }
}

export function sendThreadMessage(client: HoustonClient, session: number, text: string): void {
  client.send({ type: 'thread_send', session, text })
}

export function stopThread(client: HoustonClient, session: number): void {
  client.send({ type: 'thread_stop', session })
}

export interface ThreadView extends ThreadSnapshot {
  items: ThreadItem[]
  loadEarlier: () => void
}

export function useThread(client: HoustonClient, session: number, connected: boolean): ThreadView {
  const [store, setStore] = useState<ThreadSessionStore>(() => new ThreadSessionStore(() => {}, session))
  useEffect(() => {
    const held = retainThreadStore(client, session)
    setStore(held.store)
    return held.release
  }, [client, session])
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
  useEffect(() => {
    if (connected) store.attach()
  }, [store, connected])
  const items = useMemo(() => buildThreadItems(snapshot.events), [snapshot.events])
  return { ...snapshot, items, loadEarlier: () => store.loadEarlier() }
}
