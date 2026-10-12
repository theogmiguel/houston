// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import type { SessionInfo } from './houston/client'
import { createSessionsStore, SessionsStoreContext, useSession, useSessionIds, useLayoutSessions } from './sessionsStore'

function session(id: number): SessionInfo {
  return { id, agent: 'claude', project_dir: '/project', cwd: '/project', state: 'running', title: `Pane ${id}`, title_source: 'prompt' as const, codename: `pane-${id}`, hidden: false, live_children: 0, children_waiting: 0, inbox_unread: 0, tags: [], resumable: false, status: 'working' }
}

describe('sessions selectors', () => {
  it.each([1, 6, 12])('does not re-read %i mounted panes for background session events', (panes) => {
    const store = createSessionsStore(new Map(Array.from({ length: panes + 1 }, (_, index) => {
      const info = session(index + 1)
      return [info.id, { ...info, project_dir: index === panes ? '/background' : '/visible' }]
    })))
    const getSnapshot = vi.spyOn(store, 'getSnapshot')
    let renders = 0
    function Pane({ id }: { id: number }) { useSession(id); renders++; return null }
    const root = createRoot(document.createElement('div'))
    act(() => root.render(<SessionsStoreContext.Provider value={store}>
      {Array.from({ length: panes }, (_, index) => <Pane key={index} id={index + 1} />)}
    </SessionsStoreContext.Provider>))
    getSnapshot.mockClear()
    renders = 0
    for (let event = 0; event < 100; event++) {
      act(() => store.set((previous) => new Map(previous).set(panes + 1, { ...previous.get(panes + 1)!, title: `Background ${event}` })))
    }
    expect(getSnapshot.mock.calls.length).toBe(0)
    expect(renders).toBe(0)
    act(() => store.set((previous) => new Map(previous).set(1, { ...previous.get(1)!, status: 'idle' })))
    expect(renders).toBe(1)
    act(() => root.unmount())
  })

  it('switches session ids and stores, observes removal, and releases unmounted ids', () => {
    const first = createSessionsStore(new Map([[1, session(1)], [2, session(2)]]))
    const second = createSessionsStore(new Map([[2, { ...session(2), title: 'Second store' }]]))
    const firstReads = vi.spyOn(first, 'getSnapshot')
    let selected: SessionInfo | undefined
    function Pane({ id }: { id: number }) { selected = useSession(id); return null }
    const root = createRoot(document.createElement('div'))
    const render = (store: typeof first, id: number) => act(() => root.render(
      <SessionsStoreContext.Provider value={store}><Pane id={id} /></SessionsStoreContext.Provider>
    ))
    render(first, 1)
    render(first, 2)
    firstReads.mockClear()
    act(() => first.set((previous) => new Map(previous).set(1, { ...session(1), title: 'Old id' })))
    expect(firstReads.mock.calls.length).toBe(0)
    expect(selected?.id).toBe(2)
    render(second, 2)
    firstReads.mockClear()
    act(() => first.set((previous) => new Map(previous).set(2, { ...session(2), title: 'Old store' })))
    expect(firstReads.mock.calls.length).toBe(0)
    expect(selected?.title).toBe('Second store')
    act(() => second.set(new Map()))
    expect(selected).toBeUndefined()
    act(() => second.set(new Map([[2, session(2)]])))
    expect(selected?.id).toBe(2)
    act(() => root.unmount())
    const next = new Map([[2, { ...session(2), title: 'Unmounted' }]])
    const get = vi.spyOn(next, 'get')
    second.set(next)
    expect(get.mock.calls.length).toBe(0)
    const oldNext = new Map([[1, session(1)], [2, session(2)]])
    const oldGet = vi.spyOn(oldNext, 'get')
    first.set(oldNext)
    expect(oldGet.mock.calls.length).toBe(0)
  })

  it('notifies multiple consumers of an id and preserves whole-roster subscriptions', () => {
    const store = createSessionsStore(new Map([[1, session(1)], [2, session(2)]]))
    const a = vi.fn()
    const b = vi.fn()
    const roster = vi.fn()
    const offA = store.subscribeSession(1, a)
    const offB = store.subscribeSession(1, b)
    const offRoster = store.subscribe(roster)
    store.set((previous) => new Map(previous))
    expect(a).not.toHaveBeenCalled()
    expect(b).not.toHaveBeenCalled()
    expect(roster).toHaveBeenCalledTimes(1)
    store.set((previous) => new Map(previous).set(1, { ...session(1), status: 'idle' }))
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    offA()
    store.set(new Map([[2, session(2)]]))
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(2)
    offB()
    // Reusing an id after cleanup must survive a repeated old unsubscribe.
    const offNew = store.subscribeSession(1, a)
    offB()
    store.set((previous) => new Map(previous).set(1, session(1)))
    expect(a).toHaveBeenCalledTimes(2)
    offNew()
    offRoster()
    store.set(new Map())
    expect(roster).toHaveBeenCalledTimes(4)
  })

  it('keeps unrelated session and membership references stable without rendering', () => {
    const a = session(1)
    const b = session(2)
    const store = createSessionsStore(new Map([[1, a], [2, b]]))
    const counts = { a: 0, b: 0, ids: 0, layout: 0 }
    let ids: number[] = []
    let selectedB: SessionInfo | undefined
    function SessionRow({ id }: { id: 1 | 2 }) {
      const info = useSession(id)
      counts[id === 1 ? 'a' : 'b']++
      if (id === 2) selectedB = info
      return <span>{info?.status}</span>
    }
    function Membership() { ids = useSessionIds(); counts.ids++; return null }
    function Layout() { useLayoutSessions(store); counts.layout++; return null }
    const root = createRoot(document.createElement('div'))
    act(() => root.render(<SessionsStoreContext.Provider value={store}><SessionRow id={1} /><SessionRow id={2} /><Membership /><Layout /></SessionsStoreContext.Provider>))
    const initialIds = ids
    act(() => store.set((previous) => new Map(previous).set(1, { ...a, status: 'idle' })))
    expect(counts).toEqual({ a: 2, b: 1, ids: 1, layout: 1 })
    expect(selectedB).toBe(b)
    expect(ids).toBe(initialIds)
    expect(store.getSnapshot().get(1)?.status).toBe('idle')
    act(() => store.set((previous) => new Map(previous).set(3, session(3))))
    expect(ids).toEqual([1, 2, 3])
    expect(counts.layout).toBe(2)
    act(() => root.unmount())
  })

  it('preserves selector results across parent renders and updates changed filters', () => {
    const store = createSessionsStore(new Map([[1, session(1)], [2, session(2)]]))
    let ids: number[] = []
    let info: SessionInfo | undefined
    function Selection({ id }: { id: number }) {
      ids = useSessionIds((item) => item.id === id)
      info = useSession(id)
      return null
    }
    const root = createRoot(document.createElement('div'))
    const render = (id: number) => act(() => root.render(<SessionsStoreContext.Provider value={store}><Selection id={id} /></SessionsStoreContext.Provider>))
    render(1)
    const first = ids
    render(1)
    expect(ids).toBe(first)
    render(2)
    expect(ids).toEqual([2])
    expect(info).toBe(store.getSnapshot().get(2))
    act(() => store.set((previous) => new Map(previous).set(1, { ...previous.get(1)!, title: 'renamed' })))
    const second = ids
    expect(ids).toEqual([2])
    act(() => store.set((previous) => { const next = new Map(previous); next.delete(2); return next }))
    expect(info).toBeUndefined()
    expect(ids).toEqual([])
    expect(ids).not.toBe(second)
    act(() => root.unmount())
  })

  it('applies sequential updates immediately and releases subscriptions', () => {
    const store = createSessionsStore(new Map([[1, session(1)]]))
    const seen: string[] = []
    const off = store.subscribe(() => seen.push(store.getSnapshot().get(1)!.title))
    store.set((previous) => new Map(previous).set(1, { ...previous.get(1)!, title: 'first' }))
    store.set((previous) => new Map(previous).set(1, { ...previous.get(1)!, title: 'second' }))
    off()
    store.set(store.getSnapshot())
    expect(seen).toEqual(['first', 'second'])
  })
})
