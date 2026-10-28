// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Sidebar, preloadRailChunks } from './Sidebar'
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

beforeAll(() => preloadRailChunks(), 30_000)

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

  function session(id: number): SessionInfo {
    return { id, agent: 'codex', title: `Main ${id}`, cwd: '/a', project_dir: '/a', state: 'running', status: 'idle', live_children: 0, children_waiting: 0, inbox_unread: 0 } as SessionInfo
  }

  it('a selected grid keeps its caption plain and fills its primary session row', async () => {
    render({
      workspaces: [ws('/a', 'alpha')],
      sessions: [session(1)],
      selected: '/a',
      gridsByWorkspace: { '/a': [{ id: 'g1', name: 'Main', sessionIds: [1] }] },
      selectedGridId: 'g1',
      onSelectGrid: noop
    })
    const grid = container.querySelector<HTMLButtonElement>('[data-testid="grid-row"]')
    expect(grid).not.toBeNull()
    expect(grid?.className).not.toContain('bg-[var(--sel)]')
    const selectedRow = await vi.waitFor(() => {
      const row = container.querySelector<HTMLElement>('[data-testid="agent-row"][data-selected="true"]')
      expect(row).not.toBeNull()
      return row!
    }, { timeout: 5000 })
    expect(selectedRow.className).toContain('bg-[var(--sel)]')
    expect(grid?.querySelector('.w-\\[2px\\]')).toBeNull()
  })

  it('keeps the workspace group plain when its selected grid fills a session row', async () => {
    render({ workspaces: [ws('/a', 'alpha')], sessions: [session(1)], selected: '/a',
      gridsByWorkspace: { '/a': [{ id: 'g1', name: 'Main', sessionIds: [1] }] },
      selectedGridId: 'g1', onSelectGrid: noop })
    const row = container.querySelector('[data-testid="ws-disclosure"]')!
    expect(row.className).not.toContain('bg-[var(--sel)]')
    expect(container.querySelector('[data-testid="grid-row"]')?.className).not.toContain('bg-[var(--sel)]')
    await vi.waitFor(() => expect(container.querySelector('[data-testid="agent-row"][data-selected="true"]')).not.toBeNull(), { timeout: 5000 })
    expect(container.querySelector('[data-testid="agent-row"][data-selected="true"]')?.className).toContain('bg-[var(--sel)]')
  })

  it('a selected settings-section row carries the fill', () => {
    setSettingsNavForTests({ open: true, section: 'appearance' })
    render({})
    const section = container.querySelector<HTMLButtonElement>(
      '[data-testid="settings-section-row"][data-section-id="appearance"]'
    )
    expect(section).not.toBeNull()
    expect(section?.className).toContain('bg-[var(--sel)]')
  })

  it('a selected plain workspace row (no grids) carries the achromatic fill, not an identity-colored bar', () => {
    render({ workspaces: [ws('/a', 'alpha')], selected: '/a' })
    const row = container.querySelector<HTMLButtonElement>('.witem[role="button"]')
    expect(row).not.toBeNull()
    expect(row?.className).toContain('bg-[var(--sel)]')
    expect(row?.style.background).toBe('')
  })

  it('keeps the Settings footer unselected while the active section carries the current value', () => {
    setSettingsNavForTests({ open: true })
    render({ onOpenSettings: noop })
    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="rail-settings"]')
    expect(toggle).not.toBeNull()
    expect(toggle?.getAttribute('aria-current')).toBeNull()
    expect(toggle?.getAttribute('aria-pressed')).not.toBe('true')
    expect(toggle?.className).toContain('bg-transparent')
    expect(toggle?.className).not.toContain('bg-[var(--sel)]')
    expect(container.querySelector('[data-testid="settings-section-row"][aria-current="true"]')?.className).toContain('bg-[var(--sel)]')
  })
})
