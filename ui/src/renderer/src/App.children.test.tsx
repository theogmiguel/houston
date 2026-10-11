import { withInputOwner } from './test/inputFixtures'
// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { gridStorageKey, leaf, preorderSessions } from './layout/tree'
import { type AppHarness, deliverControl, makeSession, makeWorkspace, renderReadyApp, resetHarness } from './test/appTestHarness'

let harness: AppHarness | null = null
beforeEach(() => { resetHarness(); localStorage.clear() })
afterEach(() => { harness?.unmount(); harness = null; vi.clearAllMocks() })

function click(label: string): void {
  const button = harness!.container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  expect(button).not.toBeNull()
  act(() => button!.click())
}

function storedSessions(path: string): number[] {
  const grids = JSON.parse(localStorage.getItem(`tr-grids:${path}`) ?? '[]') as { id: string }[]
  return grids.flatMap((grid) => {
    const layout = localStorage.getItem(`tr-layout:${gridStorageKey(path, grid.id)}`)
    return layout ? preorderSessions(JSON.parse(layout).tree) : []
  })
}

describe('orchestrator children', () => {
  it('keeps parent-owned input neutral, shows an escalated reason in the child, and clears it on resolution', async () => {
    const parent = makeSession({ id: 1, status: 'working', children_waiting: 0 })
    const child = makeSession({ id: 2, spawned_by: 1, status: 'needs-input', title: 'worker' })
    harness = await renderReadyApp({ sessions: [parent, child], workspaces: [makeWorkspace()] })
    expect(harness.container.querySelector('[aria-label="Answer 2"]')).toBeNull()
    expect(harness.container.querySelector('.pane-head .agent-dot')?.className).not.toContain('var(--warn)')
    expect(harness.container.querySelector('.children-list')?.textContent).toContain('Asked orchestrator')
    const asked = withInputOwner(child, 'orchestrator', 'Choose the target branch')
    deliverControl({ type: 'delegation_changed', session: 2, delegation: asked.delegation! })
    await act(async () => { await Promise.resolve() })
    expect(harness.container.querySelector('[aria-label="Answer 2"]')).toBeNull()
    const escalated = withInputOwner(child, 'user', 'Choose the target branch')
    deliverControl({ type: 'delegation_changed', session: 2, delegation: escalated.delegation! })
    deliverControl({ type: 'live_children_changed', session: 1, live_children: 1, children_waiting: 1 })
    await act(async () => { await Promise.resolve() })
    click('Answer 2')
    expect(harness.container.querySelector('[data-peek-session="2"] [data-tone="warn"]')?.textContent).toContain('Choose the target branch')
    expect(harness.container.querySelector('[data-panekey="2"]')).toBeNull()
    expect(storedSessions('/tmp/project')).toEqual([1])
    deliverControl({ type: 'delegation_changed', session: 2, delegation: { ...asked.delegation!, input_request: null, state: 'working' } })
    deliverControl({ type: 'agent_status', session: 2, status: 'working' })
    deliverControl({ type: 'live_children_changed', session: 1, live_children: 1, children_waiting: 0 })
    await act(async () => { await Promise.resolve() })
    expect(harness.container.querySelector('[aria-label="Answer 2"]')).toBeNull()
    expect(harness.container.querySelector('[data-peek-session="2"] [data-tone="warn"]')).toBeNull()
    expect(harness.container.textContent).not.toContain('Choose the target branch')
  })
  it('a spawned child does not steal focus and does not enter a grid', async () => {
    harness = await renderReadyApp({ sessions: [makeSession({ id: 1 })] })
    act(() => harness!.container.querySelector('[data-panekey="1"]')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })))
    deliverControl({ type: 'session_created', info: makeSession({ id: 2, spawned_by: 1, title: 'worker' }) })
    await act(async () => { await Promise.resolve() })
    expect(harness.container.querySelector('.pane.focus')?.getAttribute('data-panekey')).toBe('1')
    expect(harness.container.querySelector('[data-panekey="2"]')).toBeNull()
    expect(storedSessions('/tmp/project')).toEqual([1])
    expect(harness.container.querySelector('[aria-label="Children roster"]')).not.toBeNull()
  })
  it('a cross-workspace child peeks in its parent and moves to the parent grid', async () => {
    harness = await renderReadyApp({
      sessions: [makeSession({ id: 1 }), makeSession({ id: 2, spawned_by: 1, project_dir: '/tmp/other', cwd: '/tmp/other/sub', title: 'worker' })],
      workspaces: [makeWorkspace({ path: '/tmp/project' }), makeWorkspace({ path: '/tmp/other' })]
    })
    expect(storedSessions('/tmp/other')).not.toContain(2)
    click('Open 2')
    expect(harness.container.querySelector('[data-peek-session="2"]')?.getAttribute('aria-hidden')).toBe('false')
    click('Move 2 to grid')
    await act(async () => { await Promise.resolve() })
    expect(storedSessions('/tmp/project')).toContain(2)
    expect(storedSessions('/tmp/other')).not.toContain(2)
    expect(harness.container.querySelectorAll('[data-peek-session="2"]')).toHaveLength(1)
    act(() => harness!.container.querySelector<HTMLButtonElement>('[data-panekey="2"] button[aria-label="Terminal actions"]')!.click())
    const row = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Return to roster'))
    expect(row).not.toBeUndefined()
    act(() => row!.click())
    expect(storedSessions('/tmp/project')).not.toContain(2)
  })
  for (const childWorkspace of ['/tmp/project', '/tmp/other']) {
    it(`moves a child from ${childWorkspace} beside its parent in an inactive grid`, async () => {
      localStorage.setItem('tr-grids:/tmp/project', JSON.stringify([
        { id: 'active', name: 'Current', named: true },
        { id: 'parent', name: 'Parent', named: true }
      ]))
      const active = { tree: leaf(4, 'active-pane'), cols: 2 }
      const parentLayout = { tree: {
        kind: 'split', dir: 'row', weights: [65, 35], children: [
          leaf(1, 'parent-pane'), leaf(5, 'reference-pane')
        ]
      }, cols: 2 }
      localStorage.setItem(`tr-layout:${gridStorageKey('/tmp/project', 'active')}`, JSON.stringify(active))
      localStorage.setItem(`tr-layout:${gridStorageKey('/tmp/project', 'parent')}`, JSON.stringify(parentLayout))
      harness = await renderReadyApp({
        sessions: [makeSession({ id: 1 }), makeSession({ id: 4 }), makeSession({ id: 5 }),
          makeSession({ id: 2, spawned_by: 1, project_dir: childWorkspace, title: 'worker' })],
        workspaces: [makeWorkspace(), makeWorkspace({ path: '/tmp/other' })]
      })
      click('Move 2 to grid')
      await act(async () => { await Promise.resolve() })
      const current = JSON.parse(localStorage.getItem(`tr-layout:${gridStorageKey('/tmp/project', 'active')}`)!)
      const destination = JSON.parse(localStorage.getItem(`tr-layout:${gridStorageKey('/tmp/project', 'parent')}`)!)
      expect(current).toEqual(active)
      expect(preorderSessions(destination.tree)).toEqual([1, 2, 5])
      expect(destination.tree.weights).toEqual([65, 35])
      expect(destination.tree.children[1]).toEqual(parentLayout.tree.children[1])
      const selected = harness.container.querySelector('[data-testid="grid-row"][data-selected="true"]')
      expect(selected?.textContent).toContain('Parent')
      expect(harness.container.querySelector('.pane.focus')?.getAttribute('data-panekey')).toBe('2')
      expect(storedSessions('/tmp/other')).not.toContain(2)
    })
  }
  for (const respawn of [false, true]) {
  it(`keeps a nested child in its ancestor grid after ${respawn ? 'respawn' : 'a roster change'}`, async () => {
    localStorage.setItem('tr-grids:/tmp/project', JSON.stringify([{ id: 'family', name: 'Family', named: true }]))
    localStorage.setItem(`tr-layout:${gridStorageKey('/tmp/project', 'family')}`, JSON.stringify({
      tree: { kind: 'split', dir: 'row', weights: [50, 50], children: [leaf(1), leaf(2)] }, cols: 2
    }))
    harness = await renderReadyApp({
      sessions: [makeSession({ id: 1 }),
        makeSession({ id: 2, spawned_by: 1, project_dir: '/tmp/other', title: 'parent' }),
        makeSession({ id: 3, spawned_by: 2, project_dir: '/tmp/third', title: 'worker' })],
      workspaces: [makeWorkspace(), makeWorkspace({ path: '/tmp/other' }), makeWorkspace({ path: '/tmp/third' })]
    })
    click('Move 3 to grid')
    await act(async () => { await Promise.resolve() })
    expect(storedSessions('/tmp/project')).toEqual([1, 2, 3])
    expect(storedSessions('/tmp/other')).not.toContain(3)
    expect(storedSessions('/tmp/third')).not.toContain(3)
    deliverControl({ type: 'session_created', info: respawn
      ? makeSession({ id: 4, session_origin: 3, spawned_by: 2, project_dir: '/tmp/third', title: 'worker' })
      : makeSession({ id: 4, project_dir: '/tmp/third' }) })
    await act(async () => { await Promise.resolve() })
    expect(storedSessions('/tmp/project')).toEqual([1, 2, respawn ? 4 : 3])
    expect(storedSessions('/tmp/other')).not.toContain(respawn ? 4 : 3)
    if (respawn) expect(storedSessions('/tmp/third')).not.toContain(4)
  })
  }
  it('waiting children roll up to the parent header without changing workspace rows', async () => {
    harness = await renderReadyApp({ sessions: [makeSession({ id: 1, status: 'working', children_waiting: 1 }), withInputOwner(makeSession({ id: 2, spawned_by: 1, project_dir: '/tmp/other', status: 'needs-input' }), 'user')], workspaces: [makeWorkspace()] })
    expect(harness.container.querySelector('.pane-head .agent-dot')?.className).toContain('var(--warn)')
    expect(harness.container.querySelector('[aria-label="Children need input"]')).toBeNull()
  })
})
