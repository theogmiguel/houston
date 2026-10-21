// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Sidebar, preloadRailChunks } from './Sidebar'
import type { SessionInfo, Workspace } from '../houston/client'
import type { NoticeInput } from '../notices'
import { GRID_PINNED_KEY, GRID_PINNED_MIGRATION_KEY } from '../railPrefs'
import { isRailViewHidden, setRailViewForTests } from '../railView'
import { preloadTagPopoverSurface } from './tags/TagPopover'
import { preloadGridRailRow } from './ui/GridRailRowFallback'

beforeAll(() => Promise.all([preloadTagPopoverSurface(), preloadRailChunks(), preloadGridRailRow()]), 30_000)

const noop = (): void => {}
const ws = (path: string, name: string): Workspace => ({ path, name }) as Workspace
const GRIDS = {
  '/a': [{ id: 'g1', name: 'api work', sessionIds: [1] }, { id: 'g2', name: 'docs pass', sessionIds: [2] }],
}

describe('Sidebar — undo for reversible rail actions', () => {
  let container: HTMLDivElement
  let root: Root
  const push = vi.fn<(input: NoticeInput) => string>((input) => input.code)
  const dismiss = vi.fn<(code: string) => void>()

  function props(overrides: Partial<React.ComponentProps<typeof Sidebar>> = {}): React.ComponentProps<typeof Sidebar> {
    return {
      workspaces: [ws('/a', 'alpha')],
      sessions: [] as SessionInfo[],
      selected: '/a',
      selectedGridId: 'g1',
      customColors: {},
      colorIndexByPath: {},
      renaming: null,
      onSelect: noop,
      onAddWorkspace: noop,
      onRemoveWorkspace: noop,
      onRenameStart: noop,
      onRenameSubmit: noop,
      onRenameCancel: noop,
      onChangeColor: noop,
      onReorderWorkspace: noop,
      pinnedWorkspaces: new Set(),
      onTogglePinWorkspace: noop,
      onSshConnect: noop,
      chromeTheme: 'graphite',
      onToggleChromeTheme: noop,
      gridsByWorkspace: GRIDS,
      notices: { push, dismiss },
      ...overrides,
    }
  }

  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem(GRID_PINNED_MIGRATION_KEY, '1')
    setRailViewForTests({ view: null, hidden: [] })
    push.mockClear()
    dismiss.mockClear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    localStorage.clear()
  })

  const render = (overrides: Partial<React.ComponentProps<typeof Sidebar>> = {}): void => act(() => root.render(<Sidebar {...props(overrides)} />))
  const rows = (): HTMLElement[] => [...container.querySelectorAll<HTMLElement>('[data-testid="grid-row"]')]
  const contextMenu = (el: Element): void => act(() => {
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 90 }))
  })
  const choose = (testId: string): void => act(() => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!.click())
  const pinned = (): string[] => JSON.parse(localStorage.getItem(GRID_PINNED_KEY) ?? '[]')
  const lastNotice = (): NoticeInput => push.mock.calls.at(-1)![0]
  const undo = (): void => act(() => lastNotice().action!.onClick())
  // The undo module loads on the first action, so its notice arrives a tick later.
  const notice = (expected: Partial<NoticeInput>): Promise<void> => vi.waitFor(() => expect(lastNotice()).toMatchObject(expected))

  it('pinning two grids offers one Undo that unpins both', async () => {
    render()
    await vi.waitFor(() => expect(rows()).toHaveLength(2))
    contextMenu(rows()[0])
    choose('menu-grid-pin')
    await notice({ code: 'rail-undo', title: 'Pinned api work' })
    contextMenu(rows().find((row) => row.textContent?.includes('docs pass'))!)
    choose('menu-grid-pin')
    await notice({ title: 'Pinned 2 grids' })
    expect(pinned().sort()).toEqual(['/a::g1', '/a::g2'])
    undo()
    expect(pinned()).toEqual([])
    expect(dismiss).toHaveBeenCalledWith('rail-undo')
  })

  it('skips a grid that closed before Undo and says so', async () => {
    localStorage.setItem(GRID_PINNED_KEY, JSON.stringify(['/a::g1', '/a::g2']))
    render()
    await vi.waitFor(() => expect(rows()).toHaveLength(2))
    contextMenu(rows().find((row) => row.textContent?.includes('docs pass'))!)
    choose('menu-grid-pin')
    await notice({ title: 'Unpinned docs pass' })
    render({ gridsByWorkspace: { '/a': [GRIDS['/a'][0]] } })
    undo()
    expect(pinned()).toEqual(['/a::g1'])
    expect(lastNotice()).toMatchObject({ code: 'rail-undo-missing', title: "Couldn't restore 1 grid: it no longer exists" })
  })

  it('Undo re-pins a workspace that was unpinned', async () => {
    const onTogglePinWorkspace = vi.fn()
    render({ pinnedWorkspaces: new Set(['/a']), onTogglePinWorkspace })
    contextMenu(container.querySelector('[data-testid="ws-disclosure"][aria-label="/a"]')!)
    choose('ws-toggle-pin')
    expect(onTogglePinWorkspace).toHaveBeenCalledTimes(1)
    await notice({ title: 'Unpinned workspace alpha' })
    render({ pinnedWorkspaces: new Set(), onTogglePinWorkspace })
    undo()
    expect(onTogglePinWorkspace).toHaveBeenCalledTimes(2)
    expect(onTogglePinWorkspace).toHaveBeenLastCalledWith('/a')
  })

  it('Undo returns a grid marked unread to its read state', async () => {
    render()
    await vi.waitFor(() => expect(rows()).toHaveLength(2))
    const toggle = (): HTMLElement => rows()[0].querySelector<HTMLElement>('[data-testid="grid-unread-toggle"]')!
    expect(toggle().getAttribute('aria-label')).toBe('Mark as unread')
    act(() => toggle().click())
    expect(toggle().getAttribute('aria-label')).toBe('Mark as read')
    await notice({ title: 'Marked api work unread' })
    undo()
    expect(toggle().getAttribute('aria-label')).toBe('Mark as unread')
  })

  it('Undo shows a hidden sidebar view again', async () => {
    render()
    const routines = container.querySelector('[data-testid="rail-nav-row"][data-view="routines"]')!
    contextMenu(routines)
    choose('nav-hide-row')
    expect(isRailViewHidden('routines')).toBe(true)
    await notice({ title: 'Hid Routines from the sidebar' })
    undo()
    expect(isRailViewHidden('routines')).toBe(false)
  })
})
