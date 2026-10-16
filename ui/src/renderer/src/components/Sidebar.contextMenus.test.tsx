// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Sidebar, preloadRailChunks } from './Sidebar'
import type { SessionInfo, Workspace } from '../houston/client'

function ws(path: string, name = path): Workspace {
  return { path, name } as Workspace
}

function noop(): void {}

function baseProps(overrides: Partial<React.ComponentProps<typeof Sidebar>> = {}): React.ComponentProps<typeof Sidebar> {
  return {
    workspaces: [ws('/tmp/one', 'one')],
    chromeTheme: 'graphite',
    onToggleChromeTheme: noop,
    sessions: [] as SessionInfo[],
    selected: '/tmp/one',
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
    gridsByWorkspace: { '/tmp/one': [{ id: 'g1', name: 'Grid 1' }] },
    ...overrides
  }
}

beforeAll(() => preloadRailChunks(), 30_000)

describe('Sidebar context menus — reference anatomy', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  function render(overrides: Partial<React.ComponentProps<typeof Sidebar>> = {}): void {
    act(() => {
      root.render(<Sidebar {...baseProps(overrides)} />)
    })
  }

  function rightClick(el: Element): void {
    act(() => {
      el.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 90 })
      )
    })
  }

  it('the workspace menu has a header naming the workspace and its path', () => {
    render()
    rightClick(container.querySelector('[data-testid="ws-disclosure"]')!)
    const menu = document.querySelector('.ctxmenu')!
    expect(menu.getAttribute('role')).toBe('menu')
    const header = menu.querySelector('strong')
    const sub = menu.querySelector('small')
    expect(header?.textContent).toBe('one')
    expect(sub?.textContent).toBe('/tmp/one')
  })

  it('every item carries role="menuitem"', () => {
    render()
    rightClick(container.querySelector('[data-testid="ws-disclosure"]')!)
    const items = [...document.querySelectorAll('.ctxmenu .ctx-item')]
    expect(items.length).toBeGreaterThan(0)
    for (const item of items) expect(item.getAttribute('role')).toBe('menuitem')
  })

  it('Escape closes the open menu', () => {
    render()
    rightClick(container.querySelector('[data-testid="ws-disclosure"]')!)
    expect(document.querySelector('.ctxmenu')).not.toBeNull()
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(document.querySelector('.ctxmenu')).toBeNull()
  })

  it('ArrowDown moves focus to the first item, then the next', () => {
    render()
    rightClick(container.querySelector('[data-testid="ws-disclosure"]')!)
    const menu = document.querySelector('.ctxmenu')!
    const items = [...menu.querySelectorAll('.ctx-item')] as HTMLElement[]
    expect(document.activeElement).toBe(items[0])
    act(() => {
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    })
    expect(document.activeElement).toBe(items[1])
  })

  it('"Change Icon" is gone — no iconpick, no label', () => {
    render()
    rightClick(container.querySelector('[data-testid="ws-disclosure"]')!)
    expect(container.querySelector('[data-testid="iconpick"]')).toBeNull()
    const labels = [...document.querySelectorAll('.ctxmenu .ctx-item')].map((b) => b.textContent)
    expect(labels.some((l) => l?.includes('Change Icon'))).toBe(false)
  })

  it('the workspace menu is where a NEW GRID is born, in the right workspace', () => {
    const onAddGrid = vi.fn()
    render({ onAddGrid })
    rightClick(container.querySelector('[data-testid="ws-disclosure"]')!)
    const item = document.querySelector('[data-testid="ws-new-grid"]')
    expect(item, 'the row\'s "+" is the New-session door; the grid door is here').not.toBeNull()
    expect(item!.textContent).toContain('New grid')
    act(() => {
      ;(item as HTMLElement).click()
    })
    expect(onAddGrid).toHaveBeenCalledWith('/tmp/one')
  })

  it('offers no New grid item when the caller cannot create one', () => {
    render()
    rightClick(container.querySelector('[data-testid="ws-disclosure"]')!)
    expect(document.querySelector('[data-testid="ws-new-grid"]')).toBeNull()
  })

  it('the destructive item carries the danger hook', () => {
    render()
    rightClick(container.querySelector('[data-testid="ws-disclosure"]')!)
    const danger = document.querySelector('.ctxmenu .ctx-item.danger')
    expect(danger).not.toBeNull()
    expect(danger?.textContent).toContain('Remove workspace')
  })

  it('a grid row on a 2-grid workspace shows a hover × that calls onRemoveGrid', () => {
    const onRemoveGrid = vi.fn()
    render({
      gridsByWorkspace: {
        '/tmp/one': [
          { id: 'g1', name: 'Grid 1' },
          { id: 'g2', name: 'Grid 2' }
        ]
      },
      onRemoveGrid
    })
    const rows = [...container.querySelectorAll('[data-testid="grid-row"]')]
    expect(rows).toHaveLength(2)
    const close = rows[0].querySelector('[data-testid="grid-close"]')
    expect(close).not.toBeNull()
    act(() => {
      close!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onRemoveGrid).toHaveBeenCalledWith('/tmp/one', 'g1', 'g2')
  })

  it('closing a populated grid names its agents before removing it', () => {
    const onRemoveGrid = vi.fn()
    render({
      gridsByWorkspace: { '/tmp/one': [{ id: 'g1', name: 'Grid 1', sessionIds: [1, 2] }] },
      onRemoveGrid
    })
    const rows = [...container.querySelectorAll('[data-testid="grid-row"]')]
    expect(rows).toHaveLength(1)
    const close = rows[0].querySelector<HTMLElement>('[data-testid="grid-close"]')
    expect(close).not.toBeNull()
    act(() => close!.click())
    expect(onRemoveGrid).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Close Grid 1?')
    expect(document.body.textContent).toContain('ends its 2 agents')
    const confirm = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Close grid')
    act(() => confirm!.click())
    expect(onRemoveGrid).toHaveBeenCalledWith('/tmp/one', 'g1', undefined)
  })

  it('offers no disabled placeholders when branch, PR, and close actions are unavailable', () => {
    render()
    rightClick(container.querySelector('[data-testid="grid-row"]')!)
    const menu = document.querySelector('.ctxmenu')!
    expect(menu.querySelector('.ctx-item:disabled')).toBeNull()
    expect(menu.textContent).not.toContain('GitHub unavailable')
    expect(menu.textContent).not.toContain('Copy branch')
    expect(menu.textContent).not.toContain('Close grid')
  })

  it('an empty grid menu says Close grid and closes without confirmation', () => {
    const remove = vi.fn()
    render({ onRemoveGrid: remove })
    rightClick(container.querySelector('[data-testid="grid-row"]')!)
    const close = [...document.querySelectorAll<HTMLButtonElement>('.ctx-item')].find((item) => item.textContent === 'Close grid')!
    expect(close).toBeDefined()
    act(() => close.click())
    expect(remove).toHaveBeenCalledExactlyOnceWith('/tmp/one', 'g1', undefined)
    expect(document.body.textContent).not.toContain('Close Grid 1?')
  })

  it('shifts the pointer-anchored grid menu inside the viewport', () => {
    vi.stubGlobal('innerHeight', 200)
    vi.stubGlobal('innerWidth', 320)
    const rect = HTMLElement.prototype.getBoundingClientRect
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('grid-card-menu') ? { width: 244, height: 180 } as DOMRect : rect.call(this)
    })
    render({ onRemoveGrid: noop })
    rightClick(container.querySelector('[data-testid="grid-row"]')!)
    const menu = document.querySelector<HTMLElement>('.grid-card-menu')!
    expect(menu.style.left).toBe('40px')
    expect(menu.style.top).toBe('12px')
  })

  it('names the grid accessibly without a redundant heading and shows its Open binding', () => {
    render({
      gridsByWorkspace: {
        '/tmp/one': [
          { id: 'g1', name: 'Grid 1' },
          { id: 'g2', name: 'Grid 2' }
        ]
      },
      onRemoveGrid: noop
    })
    const rows = [...container.querySelectorAll('[data-testid="grid-row"]')]
    rightClick(rows[0])
    const menu = document.querySelector('.ctxmenu')!
    expect(menu.querySelector('.grid-card-menu-label')).toBeNull()
    expect(menu.getAttribute('aria-label')).toBe('Grid 1 actions')
    expect(menu.querySelector('kbd')?.textContent).toBe('Alt 1')
  })

  describe('grid card menu', () => {
    const gridRow = (): Element => container.querySelector('[data-testid="grid-row"]')!
    const press = (el: Element, key: string): void => {
      act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })) })
    }
    const items = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.grid-card-menu .ctx-item')]

    it('takes focus on its first item when opened and arrow keys move between items', () => {
      render({ onRemoveGrid: noop })
      rightClick(gridRow())
      expect(document.activeElement).toBe(items()[0])
      press(document.activeElement!, 'ArrowDown')
      expect(document.activeElement).toBe(items()[1])
      press(document.activeElement!, 'End')
      expect(document.activeElement).toBe(items().at(-1))
    })

    it('hides the hover preview while open and does not reopen it on pointer re-entry', async () => {
      render({ onRemoveGrid: noop })
      await vi.waitFor(() => expect(container.querySelector('[data-card-mode]')).not.toBeNull())
      vi.useFakeTimers()
      try {
        const row = gridRow()
        act(() => { row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
        act(() => { vi.advanceTimersByTime(200) })
        expect(document.querySelector('[data-testid="grid-hover-card"]')).not.toBeNull()
        rightClick(row)
        act(() => { vi.advanceTimersByTime(400) })
        expect(document.querySelector('[data-testid="grid-hover-card"]')).toBeNull()
        act(() => { row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
        act(() => { vi.advanceTimersByTime(400) })
        expect(document.querySelector('[data-testid="grid-hover-card"]')).toBeNull()
      } finally {
        vi.useRealTimers()
      }
    })

    it('opens the tag picker on pointer hover after a short delay', () => {
      vi.useFakeTimers()
      try {
        render({ onRemoveGrid: noop })
        rightClick(gridRow())
        const entry = document.querySelector('[data-testid="menu-tags-entry"]')!
        act(() => { entry.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })) })
        expect(document.querySelector('[data-testid="tag-popover"]')).toBeNull()
        act(() => { vi.advanceTimersByTime(300) })
        expect(document.querySelector('[data-testid="tag-popover"]')).not.toBeNull()
      } finally {
        vi.useRealTimers()
      }
    })

    it('opens the tag picker on ArrowRight from the Tags entry', () => {
      render({ onRemoveGrid: noop })
      rightClick(gridRow())
      const entry = document.querySelector<HTMLElement>('[data-testid="menu-tags-entry"]')!
      act(() => entry.focus())
      press(entry, 'ArrowRight')
      expect(document.querySelector('[data-testid="tag-popover"]')).not.toBeNull()
    })
  })
})
