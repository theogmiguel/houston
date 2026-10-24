import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { HoustonClient } from '../houston/client'
import { buildThreadItems, type ThreadItem } from './threadModel'
import { THREAD_HISTORY_REFUSAL, type ThreadClientMsg, type ThreadEvent, type ThreadEventsMsg, type ThreadHistoryMsg } from './threadTypes'

/** Events requested per history page, within the daemon's `THREAD_HISTORY_PAGE_MAX`. */
export const THREAD_HISTORY_PAGE = 200
/** Events kept in memory: the 400-row window plus a few pages; older ones are paged back in. */
export const THREAD_RETAINED_EVENTS = 5 * THREAD_HISTORY_PAGE
/** Stored message ids remembered to drop late deltas; deltas only trail the newest messages. */
const SUPERSEDED_MEMORY = 64

export interface ThreadSnapshot {
  events: readonly ThreadEvent[]
  /** The first history page has arrived. */
  loaded: boolean
  /** The daemon holds events older than the first loaded one. */
  hasMore: boolean
  loadingEarlier: boolean
  /** Why the last history request failed, until a retry. */
  failure: string | null
}

const EMPTY: ThreadSnapshot = { events: [], loaded: false, hasMore: false, loadingEarlier: false, failure: null }

/** `beforeSeq: null` is the latest page. */
interface HistoryRequest { beforeSeq: number | null }

/** One session's timeline: the latest history page, earlier pages on demand, then live events. */
export class ThreadSessionStore {
  private snapshot: ThreadSnapshot = EMPTY
  private readonly listeners = new Set<() => void>()
  private pending: HistoryRequest[] = []
  private early: ThreadEvent[] = []
  private lastStoredSeq = -1
  private superseded: string[] = []

  constructor(private readonly send: (msg: ThreadClientMsg) => boolean, readonly session: number) {}

  getSnapshot = (): ThreadSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  attach(): void {
    if (this.snapshot.loaded || this.pending.some((request) => request.beforeSeq === null)) return
    this.request(null)
  }

  retry(): void {
    this.set({ ...this.snapshot, failure: null })
    if (this.snapshot.loaded) this.loadEarlier()
    else this.attach()
  }

  loadEarlier(): void {
    const first = this.snapshot.events.find((event) => event.kind.type !== 'assistant_delta')
    if (!this.snapshot.loaded || !this.snapshot.hasMore || this.snapshot.loadingEarlier || first === undefined) return
    this.set({ ...this.snapshot, loadingEarlier: true })
    this.request(first.seq)
  }

  private request(beforeSeq: number | null): void {
    this.pending.push({ beforeSeq })
    if (!this.send({ type: 'thread_history', session: this.session, before_seq: beforeSeq, limit: THREAD_HISTORY_PAGE })) {
      this.refused(beforeSeq, 'Thread history was not requested: the connection to the daemon is closed.')
    }
  }

  /** The daemon refused (or the client could not send) the request for this page. */
  refused(beforeSeq: number | null, reason: string): void {
    const at = this.pending.findIndex((request) => request.beforeSeq === beforeSeq)
    if (at < 0) return
    this.pending.splice(at, 1)
    this.set({ ...this.snapshot, loadingEarlier: beforeSeq === null && this.snapshot.loadingEarlier, failure: reason })
  }

  /** A refusal carries no `before_seq`; the daemon answers in request order, so it is the oldest request's. */
  refusedOldest(reason: string): void {
    const oldest = this.pending[0]
    if (oldest) this.refused(oldest.beforeSeq, reason)
  }

  // `before_seq` echoes the request; a reply without one is matched in send order.
  private take(beforeSeq: number | null | undefined): HistoryRequest | null {
    const at = beforeSeq === undefined ? 0 : this.pending.findIndex((request) => request.beforeSeq === beforeSeq)
    if (at < 0 || at >= this.pending.length) return null
    return this.pending.splice(at, 1)[0] ?? null
  }

  onHistory(msg: ThreadHistoryMsg): void {
    const request = this.take(msg.before_seq)
    if (request === null) return
    if (request.beforeSeq === null) {
      this.lastStoredSeq = -1
      this.superseded = []
      const events = [...msg.events]
      this.noteStored(events)
      const early = this.early
      this.early = []
      this.set({ events: this.merge(events, early), loaded: true, hasMore: msg.has_more, loadingEarlier: false, failure: null })
      return
    }
    const first = this.snapshot.events[0]?.seq ?? Number.POSITIVE_INFINITY
    const older = msg.events.filter((event) => event.seq < first)
    this.set({ ...this.snapshot, events: [...older, ...this.snapshot.events], hasMore: msg.has_more, loadingEarlier: false, failure: null })
  }

  onEvents(msg: ThreadEventsMsg): void {
    if (!this.snapshot.loaded) {
      // The history reply supersedes stored events, so the buffer only bridges the request.
      this.early = [...this.early, ...msg.events].slice(-THREAD_HISTORY_PAGE)
      return
    }
    const events = this.merge(this.snapshot.events, msg.events)
    if (events === this.snapshot.events) return
    const overflow = events.length - THREAD_RETAINED_EVENTS
    if (overflow > THREAD_HISTORY_PAGE) this.set({ ...this.snapshot, events: events.slice(overflow), hasMore: true })
    else this.set({ ...this.snapshot, events })
  }

  /** Appends live events without stored duplicates, and drops the deltas a stored message supersedes. */
  private merge(base: readonly ThreadEvent[], fresh: readonly ThreadEvent[]): readonly ThreadEvent[] {
    let events: ThreadEvent[] | null = null
    for (const event of fresh) {
      const kind = event.kind
      if (kind.type === 'assistant_delta') {
        if (this.superseded.includes(kind.message_id)) continue
      } else {
        if (event.seq <= this.lastStoredSeq) continue
        this.lastStoredSeq = event.seq
      }
      events ??= [...base]
      if (kind.type === 'assistant_message') {
        this.supersede(kind.message_id)
        events = events.filter((prior) => prior.kind.type !== 'assistant_delta' || prior.kind.message_id !== kind.message_id)
      }
      events.push(event)
    }
    return events ?? base
  }

  private supersede(messageId: string): void {
    this.superseded.push(messageId)
    if (this.superseded.length > SUPERSEDED_MEMORY) this.superseded.shift()
  }

  private noteStored(events: readonly ThreadEvent[]): void {
    for (const event of events) {
      if (event.kind.type === 'assistant_delta') continue
      this.lastStoredSeq = Math.max(this.lastStoredSeq, event.seq)
      if (event.kind.type === 'assistant_message') this.supersede(event.kind.message_id)
    }
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
  const offError = client.subscribe('error', (msg) => {
    const refused = THREAD_HISTORY_REFUSAL.exec(msg.message)
    if (refused) stores.get(Number(refused[1]))?.store.refusedOldest(msg.message)
  })
  const off = (): void => { offEvents(); offHistory(); offError() }
  const registry = { stores, off }
  registries.set(client, registry)
  return registry
}

/** Holds the session's store while a pane shows it; the last release drops its events. */
export function retainThreadStore(client: HoustonClient, session: number): { store: ThreadSessionStore; release: () => void } {
  const registry = registryFor(client)
  let entry = registry.stores.get(session)
  if (!entry) {
    entry = { store: new ThreadSessionStore((msg) => client.trySend(msg), session), holders: 0 }
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

/** Whether the message was written to the socket; a closed socket drops it. */
export function sendThreadMessage(client: HoustonClient, session: number, text: string): boolean {
  return client.trySend({ type: 'thread_send', session, text })
}

export function stopThread(client: HoustonClient, session: number): void {
  client.send({ type: 'thread_stop', session })
}

export interface ThreadView extends ThreadSnapshot {
  items: ThreadItem[]
  loadEarlier: () => void
  retry: () => void
}

export function useThread(client: HoustonClient, session: number, connected: boolean): ThreadView {
  const [store, setStore] = useState<ThreadSessionStore>(() => new ThreadSessionStore(() => true, session))
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
  return { ...snapshot, items, loadEarlier: () => store.loadEarlier(), retry: () => store.retry() }
}
