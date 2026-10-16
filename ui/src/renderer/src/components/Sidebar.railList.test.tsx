// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Sidebar, preloadRailChunks } from './Sidebar'
import type { SessionInfo, Workspace } from '../houston/client'
import { GRID_PINNED_KEY, GRID_PINNED_MIGRATION_KEY, RAIL_PREFS_KEY, DEFAULT_RAIL_PREFS } from '../railPrefs'
import { KeymapOverridesContext } from '../layout/keymapOverridesContext'
import { preloadTagPopoverSurface } from './tags/TagPopover'
import { preloadGridRailRow } from './ui/GridRailRowFallback'

beforeAll(() => Promise.all([preloadTagPopoverSurface(), preloadRailChunks(), preloadGridRailRow()]), 30_000)

const noop = (): void => {}
const ws = (path: string, name: string): Workspace => ({ path, name }) as Workspace
const session = (id: number, extra: Record<string, unknown> = {}): SessionInfo => ({
  id, agent: 'claude', state: 'running', status: 'idle', project_dir: '/a', cwd: '/a',
  live_children: 0, children_waiting: 0, inbox_unread: 0, ...extra,
}) as unknown as SessionInfo

const GRIDS = {
  '/a': [
    { id: 'a1', name: 'alpha one', sessionIds: [1] },
    { id: 'a2', name: 'alpha two', sessionIds: [2] },
    { id: 'a3', name: 'alpha three', sessionIds: [3] },
  ],
  '/b': [{ id: 'b1', name: 'bravo one', sessionIds: [4] }],
}

function baseProps(overrides: Partial<React.ComponentProps<typeof Sidebar>> = {}): React.ComponentProps<typeof Sidebar> {
  return {
    workspaces: [ws('/a', 'alpha'), ws('/b', 'bravo')],
    chromeTheme: 'graphite',
    onToggleChromeTheme: noop,
    sessions: [] as SessionInfo[],
    selected: '/a',
    selectedGridId: 'a1',
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
    gridsByWorkspace: GRIDS,
    ...overrides,
  }
}

function rect(top: number, height: number, left = 0, width = 300): DOMRect {
  return { top, height, bottom: top + height, left, right: left + width, width, x: left, y: top, toJSON: () => ({}) }
}

describe('Sidebar rail list', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem(GRID_PINNED_MIGRATION_KEY, '1')
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    Element.prototype.scrollIntoView = vi.fn()
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  function render(overrides: Partial<React.ComponentProps<typeof Sidebar>> = {}, keymap?: React.ComponentProps<typeof KeymapOverridesContext.Provider>['value']): void {
    const element = <Sidebar {...baseProps(overrides)} />
    act(() => root.render(keymap ? <KeymapOverridesContext.Provider value={keymap}>{element}</KeymapOverridesContext.Provider> : element))
  }

  const wsRow = (path: string): HTMLElement =>
    container.querySelector<HTMLElement>(`[data-ws-idx][aria-label="${path}"]`)!
  const chevron = (path: string): HTMLElement => wsRow(path).querySelector<HTMLElement>('[data-testid="ws-chevron"]')!
  const gridRows = (): HTMLElement[] => [...container.querySelectorAll<HTMLElement>('[data-testid="grid-row"]')]
  const gridRow = (name: string): HTMLElement => gridRows().find((row) => row.textContent?.includes(name))!
  const rightClick = (el: Element): void => {
    act(() => { el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 90 })) })
  }
  const altDigit = (digit: number, init: KeyboardEventInit = {}, target: EventTarget = window): void => {
    act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key: String(digit), code: `Digit${digit}`, altKey: true, bubbles: true, cancelable: true, ...init })) })
  }
  const pinGrids = (...keys: string[]): void => localStorage.setItem(GRID_PINNED_KEY, JSON.stringify(keys))

  describe('layout', () => {
    it('has one scroll container for the tree, and the header stays outside it', () => {
      render()
      const list = container.querySelector('[data-rail-grid-list]')!
      expect(container.querySelectorAll('[data-rail-grid-list]')).toHaveLength(1)
      expect(list.contains(container.querySelector('[data-testid="tree-group-header"]'))).toBe(false)
      expect(container.querySelector('[data-testid="rail-tree"]')!.className).toContain('flex-1')
    })

    it('hides the scrollbar of the list and of the rail scroller', () => {
      render()
      expect(container.querySelector('[data-rail-grid-list]')!.className).toContain('[scrollbar-width:none]')
      expect(container.querySelector('.railscroll')!.className).toContain('[scrollbar-width:none]')
    })

    it('renders every card, with no windowing', () => {
      const many = Array.from({ length: 60 }, (_, index) => ({ id: `g${index}`, name: `grid ${index}`, sessionIds: [100 + index] }))
      render({ gridsByWorkspace: { '/a': many }, selectedGridId: 'g0' })
      expect(gridRows()).toHaveLength(60)
    })

    it('keeps the active tag filter row outside the scroller', () => {
      localStorage.setItem('houston.tagFilter', '[1]')
      render({ tags: [{ id: 1, name: 'ui', color: '#fff' }] })
      const filterRow = container.querySelector('[data-testid="rail-active-tag-filter"]')
      expect(filterRow).not.toBeNull()
      expect(container.querySelector('[data-rail-grid-list]')!.contains(filterRow)).toBe(false)
    })
  })

  describe('Alt+1..9', () => {
    beforeEach(() => pinGrids('/a::a3'))

    it('numbers the cards in on-screen order and selects by that number', () => {
      const onSelectGrid = vi.fn()
      render({ onSelectGrid })
      return vi.waitFor(() => expect(gridRows().map((row) => row.querySelector('[data-testid="rail-jump-number"]')?.textContent)).toEqual(['1', '2', '3', '4'])).then(() => {
        expect(gridRows().map((row) => row.getAttribute('data-grid-id') ?? '')).toEqual(['a3', 'a1', 'a2', 'b1'])
        altDigit(2)
        expect(onSelectGrid).toHaveBeenCalledWith('/a', 'a1')
        altDigit(1)
        expect(onSelectGrid).toHaveBeenLastCalledWith('/a', 'a3')
      })
    })

    it('works for a card that has no mounted row of its own yet', () => {
      const onSelectGrid = vi.fn()
      render({ onSelectGrid })
      altDigit(4)
      expect(onSelectGrid).toHaveBeenCalledWith('/b', 'b1')
    })

    it('skips the cards of a collapsed workspace', () => {
      const onSelectGrid = vi.fn()
      render({ onSelectGrid })
      act(() => chevron('/a').click())
      altDigit(2)
      expect(onSelectGrid).toHaveBeenCalledWith('/b', 'b1')
    })

    it('leaves the chord to other handlers when Ctrl, Shift or Meta are held', () => {
      const onSelectGrid = vi.fn()
      render({ onSelectGrid })
      altDigit(1, { ctrlKey: true })
      altDigit(1, { shiftKey: true })
      altDigit(1, { metaKey: true })
      expect(onSelectGrid).not.toHaveBeenCalled()
    })

    it('does not fire from a text field', () => {
      const onSelectGrid = vi.fn()
      render({ onSelectGrid })
      const input = document.createElement('input')
      document.body.appendChild(input)
      altDigit(1, {}, input)
      expect(onSelectGrid).not.toHaveBeenCalled()
    })

    it('stays off while shortcuts are disabled in the keymap', () => {
      const onSelectGrid = vi.fn()
      render({ onSelectGrid }, { bindings: {}, shortcuts_enabled: false })
      altDigit(1)
      expect(onSelectGrid).not.toHaveBeenCalled()
    })

    it('fires once per press however many cards are listed', () => {
      const onSelectGrid = vi.fn()
      render({ onSelectGrid })
      altDigit(3)
      expect(onSelectGrid).toHaveBeenCalledTimes(1)
    })

    it('shows the same number in the grid menu', () => {
      render()
      rightClick(gridRow('alpha two'))
      expect(document.querySelector('.ctxmenu kbd')?.textContent).toBe('Alt 3')
    })
  })

  describe('selection scroll', () => {
    it('scrolls the selected card into view when the selection changes', () => {
      render()
      const scroll = vi.mocked(Element.prototype.scrollIntoView)
      scroll.mockClear()
      render({ selectedGridId: 'a2' })
      const targets = scroll.mock.contexts as HTMLElement[]
      expect(targets.map((node) => node.dataset.railKey)).toEqual(['card:/a::a2'])
    })

    it('does not scroll when an unrelated prop changes', () => {
      render()
      vi.mocked(Element.prototype.scrollIntoView).mockClear()
      render({ sessions: [session(1)] })
      expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled()
    })
  })

  describe('workspace rows', () => {
    it('selects on click and expands a collapsed workspace', () => {
      localStorage.setItem('tr-ws-collapsed', JSON.stringify(['/b']))
      const onSelect = vi.fn()
      render({ onSelect })
      expect(wsRow('/b').getAttribute('aria-expanded')).toBe('false')
      act(() => wsRow('/b').click())
      expect(onSelect).toHaveBeenCalledWith('/b')
      expect(wsRow('/b').getAttribute('aria-expanded')).toBe('true')
      expect(JSON.parse(localStorage.getItem('tr-ws-collapsed') ?? '[]')).toEqual([])
    })

    it('does not collapse the selected workspace on click', () => {
      render()
      act(() => wsRow('/a').click())
      expect(wsRow('/a').getAttribute('aria-expanded')).toBe('true')
    })

    it('collapses and expands only through the chevron', () => {
      render()
      act(() => chevron('/a').click())
      expect(wsRow('/a').getAttribute('aria-expanded')).toBe('false')
      act(() => chevron('/a').click())
      expect(wsRow('/a').getAttribute('aria-expanded')).toBe('true')
    })

    it('Enter selects and expands like a click', () => {
      localStorage.setItem('tr-ws-collapsed', JSON.stringify(['/b']))
      const onSelect = vi.fn()
      render({ onSelect })
      act(() => { wsRow('/b').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
      expect(onSelect).toHaveBeenCalledWith('/b')
      expect(wsRow('/b').getAttribute('aria-expanded')).toBe('true')
    })

    it('ArrowLeft collapses and ArrowRight expands the focused row', () => {
      render()
      act(() => { wsRow('/a').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true })) })
      expect(wsRow('/a').getAttribute('aria-expanded')).toBe('false')
      act(() => { wsRow('/a').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })) })
      expect(wsRow('/a').getAttribute('aria-expanded')).toBe('true')
    })

    it('highlights the selected workspace when it is collapsed, and not while its card is listed', () => {
      render()
      expect(wsRow('/a').className).not.toContain('bg-selected-fill')
      act(() => chevron('/a').click())
      expect(wsRow('/a').className).toContain('bg-selected-fill')
    })

    it('keeps the row of a workspace whose grids are all pinned, without a count or chevron', () => {
      pinGrids('/b::b1')
      render()
      expect(wsRow('/b')).not.toBeNull()
      expect(wsRow('/b').querySelector('[data-testid="ws-chevron"]')).toBeNull()
      expect(wsRow('/b').querySelector('[data-count]')).toBeNull()
    })

    it('derives the chevron from the cards shown: a workspace whose grids a filter hides has none', () => {
      localStorage.setItem(RAIL_PREFS_KEY, JSON.stringify({ ...DEFAULT_RAIL_PREFS, filters: { ...DEFAULT_RAIL_PREFS.filters, hideEmptyGrids: true } }))
      render({ gridsByWorkspace: { ...GRIDS, '/b': [{ id: 'b1', name: 'bravo one' }] }, selected: '/b', selectedGridId: 'zzz' })
      expect(wsRow('/b').querySelector('[data-testid="ws-chevron"]')).toBeNull()
    })

    it('hides a workspace header left with no card by a grid filter', () => {
      localStorage.setItem(RAIL_PREFS_KEY, JSON.stringify({ ...DEFAULT_RAIL_PREFS, filters: { ...DEFAULT_RAIL_PREFS.filters, hideEmptyGrids: true } }))
      render({ gridsByWorkspace: { ...GRIDS, '/b': [{ id: 'b1', name: 'bravo one' }] } })
      expect(container.querySelector('[data-ws-idx][aria-label="/b"]')).toBeNull()
      expect(wsRow('/a')).not.toBeNull()
    })

    it('keeps the selected grid when a filter would hide it', () => {
      localStorage.setItem(RAIL_PREFS_KEY, JSON.stringify({ ...DEFAULT_RAIL_PREFS, filters: { ...DEFAULT_RAIL_PREFS.filters, hideEmptyGrids: true } }))
      render({ gridsByWorkspace: { '/a': [{ id: 'a1', name: 'alpha one' }, { id: 'a2', name: 'alpha two' }], '/b': [] } })
      expect(gridRows().map((row) => row.getAttribute('data-grid-id') ?? row.textContent)).toHaveLength(1)
      expect(gridRow('alpha one')).toBeDefined()
    })
  })

  describe('empty states', () => {
    it('invites a first grid when nothing is filtered', () => {
      localStorage.setItem(RAIL_PREFS_KEY, JSON.stringify({ ...DEFAULT_RAIL_PREFS, groupBy: 'none' }))
      render({ gridsByWorkspace: { '/a': [], '/b': [] } })
      expect(container.textContent).toContain('No grids yet. Create one with New grid.')
    })

    it('names the active filters instead of claiming a mismatch with none', () => {
      localStorage.setItem(RAIL_PREFS_KEY, JSON.stringify({ ...DEFAULT_RAIL_PREFS, groupBy: 'none', filters: { ...DEFAULT_RAIL_PREFS.filters, hideEmptyGrids: true } }))
      render({ gridsByWorkspace: { '/a': [{ id: 'a1', name: 'alpha one' }], '/b': [] }, selected: '/zzz', selectedGridId: null })
      expect(container.textContent).toContain('Hide empty grids')
    })
  })

  describe('header', () => {
    const newGrid = (): HTMLButtonElement => container.querySelector<HTMLButtonElement>('button[aria-label="New grid"]')!

    it('disables New grid unless a real workspace is selected', () => {
      render({ selected: 'all', selectedGridId: null, onAddGrid: vi.fn() })
      expect(newGrid().disabled).toBe(true)
      render({ selected: '/a', onAddGrid: vi.fn() })
      expect(newGrid().disabled).toBe(false)
    })

    it('adds the selected workspace\'s grid', () => {
      const onAddGrid = vi.fn()
      render({ onAddGrid })
      act(() => newGrid().click())
      expect(onAddGrid).toHaveBeenCalledWith('/a')
    })

    it('wraps Add workspace in a single tooltip', () => {
      render()
      const button = container.querySelector('button[aria-label="Add workspace"]')!
      let wrappers = 0
      for (let node = button.parentElement; node && node !== container.querySelector('[data-testid="tree-group-header"]'); node = node.parentElement) {
        if (node.tagName === 'SPAN') wrappers += 1
      }
      expect(wrappers).toBe(1)
    })

    it('counts a tag filter as one filter however many tags it holds', () => {
      localStorage.setItem('houston.tagFilter', '[1,2,3]')
      render({ tags: [1, 2, 3].map((id) => ({ id, name: `t${id}`, color: '#fff' })) })
      expect(container.querySelector('[data-testid="tree-filter-badge"]')?.textContent).toBe('1')
    })
  })

  describe('workspace context menu', () => {
    const menu = (): HTMLElement | null => document.querySelector('.ctxmenu')
    const hints = (): string[] => [...document.querySelectorAll('.ctxmenu kbd')].map((node) => node.textContent ?? '')

    it('focuses its first item on open and returns focus to the row on close', () => {
      render()
      wsRow('/a').focus()
      rightClick(wsRow('/a'))
      expect(document.activeElement).toBe(menu()!.querySelector('.ctx-item'))
      act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
      expect(menu()).toBeNull()
      expect(document.activeElement).toBe(wsRow('/a'))
    })

    it('advertises F2 and the close chord only on the selected workspace', () => {
      render()
      rightClick(wsRow('/b'))
      expect(hints()).toEqual([])
      act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
      rightClick(wsRow('/a'))
      expect(hints()).toEqual(['F2', 'Ctrl+Shift+W'])
    })

    it('takes the hints from the effective keymap', () => {
      render({}, { bindings: { 'rename-workspace': { code: 'F3', ctrl: false, alt: false, shift: false, meta: false } }, shortcuts_enabled: true })
      rightClick(wsRow('/a'))
      expect(hints()).toEqual(['F3', 'Ctrl+Shift+W'])
    })

    it('places itself with the measured menu size, not a fixed clamp', () => {
      vi.stubGlobal('innerHeight', 300)
      vi.stubGlobal('innerWidth', 600)
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        return this.classList.contains('ctxmenu') ? rect(0, 150, 0, 200) : rect(0, 0)
      })
      render()
      act(() => { wsRow('/a').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 250 })) })
      expect(menu()!.style.top).toBe('142px')
    })

    it('closes on window blur', () => {
      render()
      rightClick(wsRow('/a'))
      act(() => { window.dispatchEvent(new Event('blur')) })
      expect(menu()).toBeNull()
    })

    it('closes when the rail scrolls', () => {
      render()
      rightClick(wsRow('/a'))
      act(() => { container.querySelector('[data-rail-grid-list]')!.dispatchEvent(new Event('scroll')) })
      expect(menu()).toBeNull()
    })

    it('opening another menu leaves exactly one open', () => {
      render()
      rightClick(container.querySelector('[data-testid="rail-nav-row"]')!)
      expect(document.querySelectorAll('.ctxmenu')).toHaveLength(1)
      rightClick(wsRow('/a'))
      expect(document.querySelectorAll('.ctxmenu')).toHaveLength(1)
      rightClick(gridRow('alpha one'))
      expect(document.querySelectorAll('.ctxmenu')).toHaveLength(1)
    })
  })

  describe('grid context menu', () => {
    const items = (): string[] => [...document.querySelectorAll('.ctxmenu .ctx-item')].map((node) => node.textContent ?? '')

    it('offers branch and PR facts of the pane the card shows, not the first session in the roster', async () => {
      const writeText = vi.fn(() => Promise.resolve())
      vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
      const checkout = (branch: string, root: string) => ({ checkout: { kind: 'primary', root, branch, head: null }, checkout_root: root, cwd: root })
      const sessions = [session(2, checkout('feat-second', '/y')), session(1, checkout('feat-first', '/x'))]
      render({ sessions, gridsByWorkspace: { '/a': [{ id: 'a1', name: 'alpha one', sessionIds: [1, 2] }], '/b': [] } })
      rightClick(gridRow('alpha one'))
      const copy = [...document.querySelectorAll<HTMLElement>('.ctxmenu .ctx-item')].find((node) => node.textContent === 'Copy branch name')!
      act(() => copy.click())
      expect(writeText).toHaveBeenCalledWith('feat-first')
    })

    it('has no trailing separator when Close grid is absent', async () => {
      render()
      rightClick(gridRow('alpha one'))
      const last = (): Element | undefined => [...document.querySelectorAll('.ctxmenu .ctx-item, .ctxmenu .ctx-sep')].pop()
      await vi.waitFor(() => expect(last()?.classList.contains('ctx-item')).toBe(true))
      expect(last()?.classList.contains('ctx-sep')).toBe(false)
      expect(items()).not.toContain('Close grid')
    })

    it('offers Reset to automatic name only for a user-named grid', () => {
      const onResetGridName = vi.fn()
      render({ onResetGridName, gridsByWorkspace: { '/a': [{ id: 'a1', name: 'alpha one', sessionIds: [1], userNamed: true }, { id: 'a2', name: 'alpha two', sessionIds: [2] }], '/b': [] } })
      rightClick(gridRow('alpha two'))
      expect(items()).not.toContain('Reset to automatic name')
      act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
      rightClick(gridRow('alpha one'))
      const reset = [...document.querySelectorAll<HTMLElement>('.ctxmenu .ctx-item')].find((node) => node.textContent === 'Reset to automatic name')!
      act(() => reset.click())
      expect(onResetGridName).toHaveBeenCalledWith('/a', 'a1')
      expect(document.querySelector('.ctxmenu')).toBeNull()
    })

    it('Esc with the Tags popover open closes the popover and the menu together', async () => {
      render({ tags: [{ id: 1, name: 'ui', color: '#fff' }] })
      rightClick(gridRow('alpha one'))
      act(() => document.querySelector<HTMLElement>('[data-testid="menu-tags-entry"]')!.click())
      await vi.waitFor(() => expect(document.querySelector('[data-testid="tag-popover"]')).not.toBeNull())
      act(() => { (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
      await vi.waitFor(() => expect(document.querySelector('[data-testid="tag-popover"]')).toBeNull())
      expect(document.querySelector('.ctxmenu')).toBeNull()
    })
  })

  describe('closing a grid', () => {
    it('selects the neighbour in the on-screen order when the selected grid closes', () => {
      pinGrids('/a::a3')
      const onRemoveGrid = vi.fn()
      render({ onRemoveGrid, selectedGridId: 'a2' })
      return vi.waitFor(() => expect(gridRow('alpha two').querySelector('[data-testid="grid-close"]')).not.toBeNull()).then(() => {
        act(() => gridRow('alpha two').querySelector<HTMLElement>('[data-testid="grid-close"]')!.click())
        const confirm = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Close grid')
        if (confirm) act(() => confirm.click())
        expect(onRemoveGrid).toHaveBeenCalledWith('/a', 'a2', 'a1')
      })
    })

    it('passes no neighbour when the closed grid is not the selected one', async () => {
      const onRemoveGrid = vi.fn()
      render({ onRemoveGrid, gridsByWorkspace: { '/a': [{ id: 'a1', name: 'alpha one' }, { id: 'a2', name: 'alpha two' }], '/b': [] } })
      await vi.waitFor(() => expect(gridRow('alpha two').querySelector('[data-testid="grid-close"]')).not.toBeNull())
      act(() => gridRow('alpha two').querySelector<HTMLElement>('[data-testid="grid-close"]')!.click())
      expect(onRemoveGrid).toHaveBeenCalledWith('/a', 'a2', undefined)
    })

    it('tells the confirmation about child agents spawned by the grid panes', () => {
      const sessions = [session(1), session(2, { spawned_by: 1 }), session(3, { spawned_by: 2 })]
      render({ sessions, onRemoveGrid: vi.fn() })
      act(() => gridRow('alpha one').querySelector<HTMLElement>('[data-testid="grid-close"]')!.click())
      expect(document.body.textContent).toContain('and their 2 child agents')
    })
  })

  describe('dragging', () => {
    const THREE = [ws('/a', 'alpha'), ws('/b', 'bravo'), ws('/c', 'charlie')]
    const THREE_GRIDS = { ...GRIDS, '/c': [{ id: 'c1', name: 'charlie one', sessionIds: [5] }] }
    beforeEach(() => { document.elementFromPoint = vi.fn(() => null) })
    function layoutRects(): void {
      const rows = [...container.querySelectorAll<HTMLElement>('[data-ws-idx]')]
      rows.forEach((row, index) => { row.getBoundingClientRect = () => rect(index * 100, 32) })
      container.querySelector<HTMLElement>('[data-rail-grid-list]')!.getBoundingClientRect = () => rect(0, 400)
    }
    const move = (x: number, y: number): void => { act(() => { window.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y })) }) }
    const up = (): void => { act(() => { window.dispatchEvent(new PointerEvent('pointerup')) }) }
    const down = (el: Element): void => { act(() => { el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 10, clientY: 10 })) }) }

    it('draws the drop indicator while a workspace is dragged and removes it on release', () => {
      render()
      layoutRects()
      down(wsRow('/a'))
      move(10, 160)
      expect(container.querySelectorAll('[data-testid="ws-drop-indicator"]')).toHaveLength(1)
      up()
      expect(container.querySelector('[data-testid="ws-drop-indicator"]')).toBeNull()
    })

    it('shows the indicator before the target workspace row', () => {
      render({ workspaces: THREE, gridsByWorkspace: THREE_GRIDS })
      layoutRects()
      down(wsRow('/a'))
      move(10, 150)
      const indicator = container.querySelector('[data-testid="ws-drop-indicator"]')!
      expect(indicator).not.toBeNull()
      expect(indicator.parentElement!.nextElementSibling!.querySelector('[data-ws-idx]')).toBe(wsRow('/c'))
      up()
    })

    it('maps a drop over a workspace\'s grid cards to a slot instead of cancelling', () => {
      const onReorderWorkspace = vi.fn()
      render({ onReorderWorkspace, workspaces: THREE, gridsByWorkspace: THREE_GRIDS })
      layoutRects()
      down(wsRow('/c'))
      move(10, 60)
      up()
      expect(onReorderWorkspace).toHaveBeenCalledWith('/c', 1)
    })

    it('shows a refusal cursor when a grid is dragged under a sort that is not manual', () => {
      localStorage.setItem(RAIL_PREFS_KEY, JSON.stringify({ ...DEFAULT_RAIL_PREFS, sort: 'recent' }))
      render()
      down(gridRow('alpha one'))
      move(10, 60)
      expect(container.querySelector('[data-rail-grid-list]')!.className).toContain('cursor-not-allowed')
      up()
      expect(container.querySelector('[data-rail-grid-list]')!.className).not.toContain('cursor-not-allowed')
    })

    it('swallows the click that follows any drag, even one that reordered nothing', () => {
      localStorage.setItem(RAIL_PREFS_KEY, JSON.stringify({ ...DEFAULT_RAIL_PREFS, sort: 'recent' }))
      vi.useFakeTimers()
      const onSelectGrid = vi.fn()
      render({ onSelectGrid })
      const row = gridRow('alpha one')
      down(row)
      move(10, 60)
      up()
      act(() => row.click())
      expect(onSelectGrid).not.toHaveBeenCalled()
      act(() => { vi.advanceTimersByTime(10) })
      act(() => row.click())
      expect(onSelectGrid).toHaveBeenCalledTimes(1)
      vi.useRealTimers()
    })
  })

  describe('persisted state', () => {
    it('drops pins of grids that no longer exist', () => {
      pinGrids('/a::a1', '/a::gone')
      render()
      expect(JSON.parse(localStorage.getItem(GRID_PINNED_KEY) ?? '[]')).toEqual(['/a::a1'])
    })

    it('forgets a removed workspace\'s collapse state so the next toggle does not save it back', () => {
      localStorage.setItem('tr-ws-collapsed', JSON.stringify(['/a']))
      render()
      render({ workspaces: [ws('/b', 'bravo')], gridsByWorkspace: { '/b': GRIDS['/b'] }, selected: '/b', selectedGridId: 'b1' })
      act(() => chevron('/b').click())
      expect(JSON.parse(localStorage.getItem('tr-ws-collapsed') ?? '[]')).toEqual(['/b'])
    })

    it('keeps the pins of a workspace that never loaded its grid list', () => {
      pinGrids('/later::g1')
      render()
      expect(JSON.parse(localStorage.getItem(GRID_PINNED_KEY) ?? '[]')).toEqual(['/later::g1'])
    })
  })

  describe('grid rename', () => {
    it('keeps the footprint of the card it replaces', () => {
      render({ onRenameGrid: vi.fn() })
      rightClick(gridRow('alpha one'))
      const rename = [...document.querySelectorAll<HTMLElement>('.ctxmenu .ctx-item')].find((node) => node.textContent === 'Rename')!
      act(() => rename.click())
      const frame = container.querySelector('[data-testid="grid-row-renaming"]')!
      expect(frame.className).toContain('min-h-9')
      expect(frame.className).toContain('pl-[var(--space-6)]')
    })
  })
})
