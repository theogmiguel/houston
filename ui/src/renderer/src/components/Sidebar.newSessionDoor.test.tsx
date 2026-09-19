// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Sidebar } from './Sidebar'
import type { SessionInfo, Workspace } from '../houston/client'

function noop(): void {}

function props(
  overrides: Partial<React.ComponentProps<typeof Sidebar>> = {}
): React.ComponentProps<typeof Sidebar> {
  return {
    workspaces: [{ path: '/a', name: 'alpha' } as Workspace],
    sessions: [] as SessionInfo[],
    selected: '/a',
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
    chromeTheme: 'graphite',
    onToggleChromeTheme: noop,
    gridsByWorkspace: { '/a': [{ id: 'g1', name: 'main', count: 1, state: 'online' }] },
    selectedGridId: 'g1',
    onSelectGrid: noop,
    ...overrides
  }
}

describe('Sidebar — the workspace row’s doors match the reference', () => {
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
  })

  it('the row’s "+" is "New session in {name}" and opens the composer for that workspace', () => {
    const onNewWorkspaceSession = vi.fn()
    const onAddGrid = vi.fn()
    act(() => {
      root.render(<Sidebar {...props({ onNewWorkspaceSession, onAddGrid })} />)
    })
    const plus = container.querySelector<HTMLElement>('[data-testid="ws-new-session"]')
    expect(plus).not.toBeNull()
    expect(plus!.getAttribute('aria-label')).toBe('New session in alpha')
    act(() => plus!.click())
    expect(onNewWorkspaceSession).toHaveBeenCalledWith('/a')
    expect(onAddGrid).not.toHaveBeenCalled()
    expect(container.querySelector('[aria-label="New tab"]')).toBeNull()
  })

  it('the row’s context menu is New Grid · Rename · Reveal · Open Workspace In · Remove', () => {
    act(() => {
      root.render(<Sidebar {...props({ onNewWorkspaceSession: noop, onAddGrid: noop })} />)
    })
    const row = container.querySelector<HTMLElement>('[data-testid="ws-disclosure"]')!
    act(() => {
      row.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 90 })
      )
    })
    const labels = [...document.querySelectorAll('.ctxmenu .ctx-item')].map((b) =>
      (b.textContent ?? '').replace(/F2|Ctrl\+Shift\+W/g, '').trim()
    )
    expect(labels).toEqual([
      'New Grid',
      'Rename Workspace',
      'Pin Workspace',
      'Reveal in Files',
      'Open Workspace In',
      'Remove Workspace'
    ])
    expect(container.querySelector('[data-testid="swatch"]')).toBeNull()
    expect(container.querySelector('[data-testid="grid-add"]')).toBeNull()
  })
})
