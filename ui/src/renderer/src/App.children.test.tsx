// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { gridStorageKey, preorderSessions } from './layout/tree'
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
  it('waiting children roll up to the parent header and its workspace', async () => {
    harness = await renderReadyApp({ sessions: [makeSession({ id: 1, status: 'working', children_waiting: 1 }), makeSession({ id: 2, spawned_by: 1, project_dir: '/tmp/other', status: 'needs-input' })], workspaces: [makeWorkspace()] })
    expect(harness.container.querySelector('.pane-head .agent-dot')?.className).toContain('var(--warn)')
    expect(harness.container.querySelector('[aria-label="Children need input"]')).not.toBeNull()
  })
})
