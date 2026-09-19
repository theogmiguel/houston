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

describe('Sidebar — D9 workspace-tree row heights, copied from the carve', () => {
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

  const ROW = 'h-[var(--h-row)]'

  it('a plain workspace row sits on --h-row', () => {
    render({ workspaces: [ws('/a', 'alpha')] })
    const row = container.querySelector<HTMLButtonElement>('.witem[role="button"]')
    expect(row?.className).toContain(ROW)
    expect(row?.className).not.toContain('h-[38px]')
  })

  it('an expanded workspace disclosure row sits on --h-row too', () => {
    render({
      workspaces: [ws('/a', 'alpha')],
      selected: '/a',
      gridsByWorkspace: { '/a': [{ id: 'g1', name: 'Main' }] }
    })
    const row = container.querySelector<HTMLButtonElement>('[data-testid="ws-disclosure"]')
    expect(row?.className).toContain(ROW)
    expect(row?.className).not.toContain('h-[38px]')
  })

  it('a grid (tab) child row sits on --h-row, not its own h-8 step', () => {
    render({
      workspaces: [ws('/a', 'alpha')],
      selected: '/a',
      gridsByWorkspace: { '/a': [{ id: 'g1', name: 'Main' }] }
    })
    const grid = container.querySelector<HTMLButtonElement>('[data-testid="grid-row"]')
    expect(grid?.className).toContain(ROW)
    expect(grid?.className).not.toContain('h-8')
  })

  it('a settings section row sits on --h-row, not its own h-9 step', () => {
    setSettingsNavForTests({ open: true })
    render({ workspaces: [ws('/a', 'alpha')] })
    const row = container.querySelector<HTMLButtonElement>('[data-testid="settings-section-row"]')
    expect(row?.className).toContain(ROW)
    expect(row?.className).not.toContain('h-9')
  })

  it('every rail row carries the one ui weight — selection is fill and ink, never bold', () => {
    render({
      workspaces: [ws('/a', 'alpha'), ws('/b', 'bravo')],
      selected: '/a',
      gridsByWorkspace: { '/a': [{ id: 'g1', name: 'Main' }] }
    })
    const rows = container.querySelectorAll<HTMLElement>(
      '[data-testid="nav-row"], [data-testid="ws-disclosure"], [data-testid="grid-row"], .witem[role="button"]'
    )
    expect(rows.length).toBeGreaterThan(2)
    for (const row of rows) {
      expect(row.className).toContain('[font-weight:var(--tr-text-ui-weight)]')
      expect(row.outerHTML).not.toMatch(/font-(semibold|bold|normal)\b/)
    }
  })

  it('the tree rows carry a glyph', () => {
    render({
      workspaces: [ws('/a', 'alpha')],
      selected: '/a',
      gridsByWorkspace: { '/a': [{ id: 'g1', name: 'Main' }] }
    })
    for (const sel of ['[data-testid="ws-disclosure"]', '[data-testid="grid-row"]']) {
      const row = container.querySelector<HTMLElement>(sel)
      expect(row?.querySelector('svg')).not.toBeNull()
    }
  })
})
