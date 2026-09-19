// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Sidebar } from './Sidebar'
import { setSettingsNavForTests } from '../settingsNav'
import type { SessionInfo, Workspace } from '../houston/client'

function ws(path: string, name = path): Workspace {
  return { path, name } as Workspace
}

function noop(): void {}

function baseProps(overrides: Partial<React.ComponentProps<typeof Sidebar>> = {}): React.ComponentProps<typeof Sidebar> {
  return {
    workspaces: [],
    chromeTheme: 'graphite',
    onToggleChromeTheme: noop,
    sessions: [] as SessionInfo[],
    selected: '',
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
    ...overrides
  }
}

describe('Sidebar — D2 full-row selection fill, no SelectionBar', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    setSettingsNavForTests({ open: false })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    setSettingsNavForTests({ open: false })
  })

  function render(overrides: Partial<React.ComponentProps<typeof Sidebar>> = {}): void {
    act(() => {
      root.render(<Sidebar {...baseProps(overrides)} />)
    })
  }

  it('a selected grid (tree) row carries the fill instead of the 2px bar', () => {
    render({
      workspaces: [ws('/a', 'alpha')],
      selected: '/a',
      gridsByWorkspace: { '/a': [{ id: 'g1', name: 'Main' }] },
      selectedGridId: 'g1',
      onSelectGrid: noop
    })
    const grid = container.querySelector<HTMLButtonElement>('[data-testid="grid-row"]')
    expect(grid).not.toBeNull()
    expect(grid?.className).toContain('bg-selected-fill')
    expect(grid?.querySelector('.w-\\[2px\\]')).toBeNull()
  })

  it('a selected settings-section row carries the fill', () => {
    setSettingsNavForTests({ open: true, section: 'appearance' })
    render({})
    const section = container.querySelector<HTMLButtonElement>(
      '[data-testid="settings-section-row"][data-section-id="appearance"]'
    )
    expect(section).not.toBeNull()
    expect(section?.className).toContain('bg-selected-fill')
  })

  it('a selected plain workspace row (no grids) carries the achromatic fill, not an identity-colored bar', () => {
    render({ workspaces: [ws('/a', 'alpha')], selected: '/a' })
    const row = container.querySelector<HTMLButtonElement>('.witem[role="button"]')
    expect(row).not.toBeNull()
    expect(row?.className).toContain('bg-selected-fill')
    expect(row?.style.background).toBe('')
  })

  it('the rail-foot Settings toggle keeps its own visible current value, in the same fill', () => {
    setSettingsNavForTests({ open: true })
    render({ onOpenSettings: noop })
    const toggle = container.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')
    expect(toggle).not.toBeNull()
    expect(toggle?.className).toContain('bg-selected-fill')
  })
})
