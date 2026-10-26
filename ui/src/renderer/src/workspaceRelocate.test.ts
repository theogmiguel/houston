// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import type { SetStateAction } from 'react'
import { moveWorkspaceLocalState, relocatedNotice, type RelocateState } from './workspaceRelocate'
import type { GridMeta, LayoutState } from './layout/tree'

function holder<T>(initial: T): { value: T; set: (a: SetStateAction<T>) => void } {
  const h = {
    value: initial,
    set: (a: SetStateAction<T>) => {
      h.value = typeof a === 'function' ? (a as (p: T) => T)(h.value) : a
    }
  }
  return h
}

describe('moveWorkspaceLocalState', () => {
  it('moves every piece of client state keyed by the old path and leaves others alone', () => {
    localStorage.clear()
    localStorage.setItem('tr-grids:/a/p', JSON.stringify([{ id: 'g1', name: 'Main' }]))
    localStorage.setItem('tr-layout:/a/p::g1', '{"tree":null}')
    localStorage.setItem('tr-grids:/a/q', '[]')
    const grid = { id: 'g1', name: 'Main' } as GridMeta
    const colors = holder<Record<string, string>>({ '/a/p': '#fff', '/a/q': '#000' })
    const layouts = holder(new Map([['/a/p::g1', { tree: null, cols: 1 } as unknown as LayoutState]]))
    const grids = holder(new Map([['/a/p', [grid]]]))
    const selectedGrid = holder(new Map([['/a/p', 'g1']]))
    const pinned = holder(['/a/q', '/a/p'])
    const order = holder(['/a/p', '/a/q'])
    const renaming = holder<string | null>('/a/p')
    const selected = holder('/a/p')
    const state: RelocateState = {
      gridsByWs: new Map([['/a/p', [grid]]]),
      setWsColors: colors.set,
      setLayouts: layouts.set,
      setGridsByWs: grids.set,
      setSelectedGridByWs: selectedGrid.set,
      setWsPinned: pinned.set,
      setWsOrder: order.set,
      setWsRenaming: renaming.set,
      setSelectedWs: selected.set
    }

    moveWorkspaceLocalState('/a/p', '/b/p', state)

    expect(colors.value).toEqual({ '/b/p': '#fff', '/a/q': '#000' })
    expect([...layouts.value.keys()]).toEqual(['/b/p::g1'])
    expect([...grids.value.keys()]).toEqual(['/b/p'])
    expect(selectedGrid.value.get('/b/p')).toBe('g1')
    expect(pinned.value).toEqual(['/a/q', '/b/p'])
    expect(order.value).toEqual(['/b/p', '/a/q'])
    expect(renaming.value).toBeNull()
    expect(selected.value).toBe('/b/p')
    expect(localStorage.getItem('tr-layout:/b/p::g1')).toBe('{"tree":null}')
    expect(localStorage.getItem('tr-layout:/a/p::g1')).toBeNull()
    expect(localStorage.getItem('tr-grids:/b/p')).not.toBeNull()
    expect(localStorage.getItem('tr-grids:/a/q')).toBe('[]')
  })

  it('says what followed', () => {
    const notice = relocatedNotice({
      type: 'workspace_relocated',
      from: '/a/p',
      to: '/b/p',
      moved: { worktrees: 1, sessions: 2, repaired: 1, notes: ['n'] }
    })
    expect(notice.title).toContain('/b/p')
    expect(notice.body).toBe('2 sessions and 1 worktree followed. n')
  })
})
