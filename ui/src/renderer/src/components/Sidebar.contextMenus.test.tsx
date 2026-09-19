// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Sidebar } from './Sidebar'
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
    customColors: {},
    colorIndexByPath: {},
    unreadByWs: {},
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
    act(() => {
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    })
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
    expect(item!.textContent).toContain('New Grid')
    act(() => {
      ;(item as HTMLElement).click()
    })
    expect(onAddGrid).toHaveBeenCalledWith('/tmp/one')
  })

  it('offers no New Grid item when the caller cannot create one', () => {
    render()
    rightClick(container.querySelector('[data-testid="ws-disclosure"]')!)
    expect(document.querySelector('[data-testid="ws-new-grid"]')).toBeNull()
  })

  it('the destructive item carries the danger hook', () => {
    render()
    rightClick(container.querySelector('[data-testid="ws-disclosure"]')!)
    const danger = document.querySelector('.ctxmenu .ctx-item.danger')
    expect(danger).not.toBeNull()
    expect(danger?.textContent).toContain('Remove Workspace')
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
    expect(onRemoveGrid).toHaveBeenCalledWith('/tmp/one', 'g1')
  })

  it('a grid row on a 1-grid workspace has no hover × (removing the last grid is refused)', () => {
    const onRemoveGrid = vi.fn()
    render({
      gridsByWorkspace: { '/tmp/one': [{ id: 'g1', name: 'Grid 1' }] },
      onRemoveGrid
    })
    const rows = [...container.querySelectorAll('[data-testid="grid-row"]')]
    expect(rows).toHaveLength(1)
    expect(rows[0].querySelector('[data-testid="grid-close"]')).toBeNull()
  })

  it('the grid menu header names the grid and its workspace', () => {
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
    expect(menu.querySelector('strong')?.textContent).toBe('Grid 1')
    expect(menu.querySelector('small')?.textContent).toBe('one')
  })

})
