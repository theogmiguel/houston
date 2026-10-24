import { describe, expect, it } from 'vitest'
import { THREAD_HISTORY_PAGE, THREAD_RETAINED_EVENTS, ThreadSessionStore } from './threadStore'
import type { ThreadClientMsg, ThreadEvent, ThreadEventKind } from './threadTypes'

function ev(seq: number, kind: ThreadEventKind): ThreadEvent {
  return { seq, at_ms: seq, kind }
}

const user = (text: string): ThreadEventKind => ({ type: 'user_message', text })
const delta = (id: string, text: string): ThreadEventKind => ({ type: 'assistant_delta', message_id: id, text })

function store(): { store: ThreadSessionStore; sent: ThreadClientMsg[] } {
  const sent: ThreadClientMsg[] = []
  return { store: new ThreadSessionStore((msg) => { sent.push(msg); return true }, 7), sent }
}

const history = (events: ThreadEvent[], beforeSeq: number | null = null, hasMore = false) =>
  ({ type: 'thread_history' as const, session: 7, before_seq: beforeSeq, events, has_more: hasMore })
const live = (events: ThreadEvent[]) => ({ type: 'thread_events' as const, session: 7, events })

describe('ThreadSessionStore', () => {
  it('drops a message’s deltas once its stored message arrives', () => {
    const { store: s } = store()
    s.attach()
    s.onHistory(history([ev(1, user('hi'))]))
    s.onEvents(live([ev(2, delta('m', 'a')), ev(3, delta('m', 'b'))]))
    s.onEvents(live([ev(4, { type: 'assistant_message', message_id: 'm', text: 'ab', truncated: false })]))
    expect(s.getSnapshot().events.map((event) => event.kind.type)).toEqual(['user_message', 'assistant_message'])
  })

  it('bridges the history request with a bounded buffer', () => {
    const { store: s } = store()
    s.attach()
    s.onEvents(live(Array.from({ length: 3 * THREAD_HISTORY_PAGE }, (_, i) => ev(i + 1, delta('m', 'x')))))
    s.onHistory(history([]))
    expect(s.getSnapshot().events).toHaveLength(THREAD_HISTORY_PAGE)
  })

  it('keeps a bounded number of events and lets older ones be paged back in', () => {
    const { store: s } = store()
    s.attach()
    s.onHistory(history([]))
    for (let seq = 1; seq <= THREAD_RETAINED_EVENTS + 2 * THREAD_HISTORY_PAGE; seq++) s.onEvents(live([ev(seq, user(String(seq)))]))
    const snapshot = s.getSnapshot()
    expect(snapshot.events.length).toBeLessThanOrEqual(THREAD_RETAINED_EVENTS + THREAD_HISTORY_PAGE)
    expect(snapshot.hasMore).toBe(true)
    expect(snapshot.events.at(-1)?.seq).toBe(THREAD_RETAINED_EVENTS + 2 * THREAD_HISTORY_PAGE)
  })

  it('keeps an earlier page the reader loaded until they follow the latest rows again', () => {
    const { store: s } = store()
    s.attach()
    s.onHistory(history(Array.from({ length: THREAD_RETAINED_EVENTS }, (_, i) => ev(i + 1001, user(String(i)))), null, true))
    s.loadEarlier()
    s.onHistory(history(Array.from({ length: THREAD_HISTORY_PAGE }, (_, i) => ev(i + 801, user('old'))), 1001, true))
    s.onEvents(live(Array.from({ length: 2 * THREAD_HISTORY_PAGE }, (_, i) => ev(i + 3001, user('new')))))
    expect(s.getSnapshot().events[0]?.seq).toBe(801)
    s.followLatest()
    expect(s.getSnapshot().events).toHaveLength(THREAD_RETAINED_EVENTS)
    expect(s.getSnapshot().hasMore).toBe(true)
  })

  it('does not misfile the next page after a refused request', () => {
    const { store: s, sent } = store()
    s.attach()
    s.onHistory(history([ev(10, user('ten'))], null, true))
    s.loadEarlier()
    s.refused(10, 'thread_history refused for session 7')
    expect(s.getSnapshot()).toMatchObject({ loadingEarlier: false, failure: 'thread_history refused for session 7' })
    s.retry()
    expect(sent.filter((msg) => msg.type === 'thread_history').map((msg) => (msg as { before_seq: number | null }).before_seq)).toEqual([null, 10, 10])
    s.onHistory(history([ev(9, user('nine'))], 10))
    expect(s.getSnapshot().events.map((event) => event.seq)).toEqual([9, 10])
    expect(s.getSnapshot().failure).toBeNull()
  })
})
