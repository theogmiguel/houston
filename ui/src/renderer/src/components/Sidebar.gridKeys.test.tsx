// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Sidebar, preloadRailOptionsMenu } from './Sidebar'
import type { SessionInfo, Workspace } from '../houston/client'
import { GRID_PINNED_KEY, GRID_PINNED_MIGRATION_KEY } from '../railPrefs'
import { preloadTagPopoverSurface } from './tags/TagPopover'

beforeAll(() => Promise.all([preloadTagPopoverSurface(), preloadRailOptionsMenu()]))

const noop = (): void => {}
const ws = (path: string, name: string): Workspace => ({ path, name }) as Workspace

function baseProps(overrides: Partial<React.ComponentProps<typeof Sidebar>> = {}): React.ComponentProps<typeof Sidebar> {
  return {
    workspaces: [ws('/a', 'alpha'), ws('/b', 'bravo')],
    sessions: [] as SessionInfo[],
    selected: '/a',
    selectedGridId: 'g-default',
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
    // Every workspace's first grid shares the id g-default.
    gridsByWorkspace: {
      '/a': [{ id: 'g-default', name: 'Grid 1', sessionIds: [1] }],
      '/b': [{ id: 'g-default', name: 'Grid 1', sessionIds: [2] }],
    },
    ...overrides,
  }
}

describe('Sidebar — grid identity across workspaces', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    localStorage.clear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    localStorage.clear()
  })

  function render(overrides: Partial<React.ComponentProps<typeof Sidebar>> = {}): void {
    act(() => root.render(<Sidebar {...baseProps(overrides)} />))
  }
  const rows = (): HTMLElement[] => [...container.querySelectorAll<HTMLElement>('[data-testid="grid-row"]')]
  const rightClick = (el: Element): void => {
    act(() => {
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 90 }))
    })
  }

  it('pinning one workspace\'s g-default grid pins only that card', async () => {
    localStorage.setItem(GRID_PINNED_MIGRATION_KEY, '1')
    localStorage.setItem(GRID_PINNED_KEY, JSON.stringify(['/a::g-default']))
    render()
    await vi.waitFor(() => expect(rows()).toHaveLength(2))
    rightClick(rows()[0])
    expect(document.querySelector('[data-testid="menu-grid-pin"]')!.textContent).toContain('Unpin')
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    rightClick(rows()[1])
    expect(document.querySelector('[data-testid="menu-grid-pin"]')!.textContent).not.toContain('Unpin')
  })

  it('the pin menu persists a workspace-scoped key', async () => {
    render()
    await vi.waitFor(() => expect(rows()).toHaveLength(2))
    rightClick(rows()[1])
    act(() => document.querySelector<HTMLElement>('[data-testid="menu-grid-pin"]')!.click())
    expect(JSON.parse(localStorage.getItem(GRID_PINNED_KEY)!)).toEqual(['/b::g-default'])
  })

  it('renders each grid exactly once without duplicate React keys', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(noop)
    render()
    await vi.waitFor(() => expect(rows()).toHaveLength(2))
    const duplicateKey = error.mock.calls.some((call) => String(call[0]).includes('same key'))
    expect(duplicateKey).toBe(false)
  })

  it('a collapsed workspace lists none of its grids and the other workspace keeps its own', async () => {
    render()
    await vi.waitFor(() => expect(rows()).toHaveLength(2))
    const header = container.querySelector<HTMLElement>('[data-testid="ws-disclosure"][aria-label="/a"]')!
    expect(header.getAttribute('aria-expanded')).toBe('true')
    act(() => header.click())
    expect(rows()).toHaveLength(1)
    expect(rows()[0].textContent).toContain('Grid 1')
  })

  it('does not render the empty placeholder grid of a workspace that never ran a session', async () => {
    render({
      gridsByWorkspace: {
        '/a': [{ id: 'g-default', name: 'Grid 1', sessionIds: [1] }],
        '/b': [{ id: 'g-default', name: 'Grid 1' }],
      },
    })
    await vi.waitFor(() => expect(rows()).toHaveLength(1))
    expect(container.querySelector('[data-testid="ws-disclosure"][aria-label="/b"]')).toBeNull()
  })

  it('keeps the placeholder grid while it is the selected one', async () => {
    render({
      selected: '/b',
      gridsByWorkspace: { '/a': [{ id: 'g-default', name: 'Grid 1' }], '/b': [{ id: 'g-default', name: 'Grid 1' }] },
    })
    await vi.waitFor(() => expect(rows()).toHaveLength(1))
  })
})
