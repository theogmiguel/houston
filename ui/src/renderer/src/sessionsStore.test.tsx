// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import type { SessionInfo } from './houston/client'
import { createSessionsStore, SessionsStoreContext, useSession, useSessionIds, useLayoutSessions } from './sessionsStore'

function session(id: number): SessionInfo {
  return { id, agent: 'claude', project_dir: '/project', cwd: '/project', state: 'running', title: `Pane ${id}`, codename: `pane-${id}`, hidden: false, live_children: 0, children_waiting: 0, inbox_unread: 0, tags: [], resumable: false, status: 'working' }
}

describe('sessions selectors', () => {
  it('keeps unrelated session and membership references stable without rendering', () => {
    const a = session(1)
    const b = session(2)
    const store = createSessionsStore(new Map([[1, a], [2, b]]))
    const counts = { a: 0, b: 0, ids: 0, layout: 0 }
    let ids: number[] = []
    let selectedB: SessionInfo | undefined
    function Row({ id }: { id: 1 | 2 }) {
      const info = useSession(id)
      counts[id === 1 ? 'a' : 'b']++
      if (id === 2) selectedB = info
      return <span>{info?.status}</span>
    }
    function Membership() { ids = useSessionIds(); counts.ids++; return null }
    function Layout() { useLayoutSessions(store); counts.layout++; return null }
    const root = createRoot(document.createElement('div'))
    act(() => root.render(<SessionsStoreContext.Provider value={store}><Row id={1} /><Row id={2} /><Membership /><Layout /></SessionsStoreContext.Provider>))
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
