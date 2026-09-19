// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildCommands, filterCommands, type GridTarget, type PaletteActions } from './commandRegistry'
import { clearGridRecencyForTests, touchGrid } from '../gridRecency'
import type { Workspace } from '../houston/generated/Workspace'

function makeActions(overrides: Partial<PaletteActions> = {}): PaletteActions {
  return {
    newTerminal: vi.fn(),
    insertPane: vi.fn(),
    splitPane: vi.fn(),
    newGrid: vi.fn(),
    closePane: vi.fn(),
    toggleGitPane: vi.fn(),
    spawnAgent: vi.fn(),
    toggleSidebarRail: vi.fn(),
    toggleChromeTheme: vi.fn(),
    openAddPanePopover: vi.fn(),
    setGridLayout: vi.fn(),
    openNotifications: vi.fn(),
    markAllNotificationsRead: vi.fn(),
    openShortcutSheet: vi.fn(),
    windowMinimize: vi.fn(),
    windowMaximize: vi.fn(),
    windowClose: vi.fn(),
    quitAndStopDaemon: vi.fn(),
    selectNavRow: vi.fn(),
    switchWorkspace: vi.fn(),
    switchGrid: vi.fn(),
    ...overrides
  }
}

const WORKSPACES: Workspace[] = [
  { path: '/p/alpha', name: 'alpha' },
  { path: '/p/bravo', name: 'bravo' }
]

const GRIDS: GridTarget[] = [
  { path: '/p/alpha', workspaceName: 'alpha', gridId: 'a1', name: 'main' },
  { path: '/p/alpha', workspaceName: 'alpha', gridId: 'a2', name: 'review' },
  { path: '/p/bravo', workspaceName: 'bravo', gridId: 'b1', name: 'deploy' }
]

const build = (grids: readonly GridTarget[] = GRIDS, actions = makeActions()) =>
  buildCommands({ actions, hasWorkspace: true, workspaces: WORKSPACES, grids })

const tabs = (cmds: ReturnType<typeof build>) => cmds.filter((c) => c.group === 'Tabs')

beforeEach(() => {
  clearGridRecencyForTests()
})

describe('the palette lists open tabs', () => {
  it('one entry per tab, titled by the tab, keyed by workspace + grid', () => {
    const rows = tabs(build())
    expect(rows.map((c) => c.title)).toEqual(['main', 'review', 'deploy'])
    expect(new Set(rows.map((c) => c.id)).size).toBe(3)
  })

  it('the workspace is a keyword, not part of the title — two "main"s stay findable', () => {
    const both: GridTarget[] = [
      { path: '/p/alpha', workspaceName: 'alpha', gridId: 'a1', name: 'main' },
      { path: '/p/bravo', workspaceName: 'bravo', gridId: 'b1', name: 'main' }
    ]
    const rows = tabs(build(both))
    expect(rows.every((c) => c.title === 'main')).toBe(true)
    expect(rows[0].keywords).toContain('alpha')
    expect(rows[1].keywords).toContain('bravo')
  })

  it('opening one selects its workspace AND its tab — never a tab in a workspace you cannot see', () => {
    const switchGrid = vi.fn()
    const rows = tabs(build(GRIDS, makeActions({ switchGrid })))
    rows.find((c) => c.title === 'deploy')!.run()
    expect(switchGrid).toHaveBeenCalledWith('/p/bravo', 'b1')
  })

  it('no tabs is no group, not an empty one', () => {
    expect(tabs(build([]))).toHaveLength(0)
    expect(tabs(buildCommands({ actions: makeActions(), hasWorkspace: true, workspaces: WORKSPACES })))
      .toHaveLength(0)
  })

  it('the ids do not collide with the Grid group that holds the layout actions', () => {
    const all = build()
    expect(new Set(all.map((c) => c.id)).size).toBe(all.length)
    expect(all.some((c) => c.group === 'Grid')).toBe(true)
  })
})

describe('recency decides the order', () => {
  it('most recently opened first', () => {
    touchGrid('/p/bravo', 'b1', 3000)
    touchGrid('/p/alpha', 'a2', 5000)
    expect(tabs(build()).map((c) => c.title)).toEqual(['review', 'deploy', 'main'])
  })

  it('a tab never opened keeps its place behind the visited ones rather than disappearing', () => {
    touchGrid('/p/alpha', 'a2', 5000)
    const rows = tabs(build())
    expect(rows[0].title).toBe('review')
    expect(rows.map((c) => c.title)).toContain('main')
    expect(rows.map((c) => c.title)).toContain('deploy')
  })

  it('re-opening a tab moves it back to the front', () => {
    touchGrid('/p/alpha', 'a1', 1000)
    touchGrid('/p/bravo', 'b1', 2000)
    expect(tabs(build())[0].title).toBe('deploy')
    touchGrid('/p/alpha', 'a1', 3000)
    expect(tabs(build())[0].title).toBe('main')
  })

  it('a query still ranks by match, not by recency — typing a name finds it', () => {
    touchGrid('/p/bravo', 'b1', 9000)
    const hits = filterCommands(build(), 'review')
    expect(hits[0].title).toBe('review')
  })
})
