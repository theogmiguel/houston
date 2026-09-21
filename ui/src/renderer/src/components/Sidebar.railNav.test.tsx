// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Sidebar } from './Sidebar'
import { setSettingsNavForTests } from '../settingsNav'
import { RAIL_VIEWS, setRailViewForTests } from '../railView'
import type { TagInfo } from '../houston/generated/TagInfo'
import type { SessionInfo, Workspace } from '../houston/client'

function ws(path: string, name = path): Workspace {
  return { path, name } as Workspace
}

function noop(): void {}

function taggedSession(id: number, path: string, tags: number[]): SessionInfo {
  return { id, project_dir: path, state: 'running', tags } as unknown as SessionInfo
}

const TAGS: TagInfo[] = [
  { id: 1, name: 'code review', color: '#a78bfa' },
  { id: 2, name: 'wait-human', color: '#f59e0b' }
]

function baseProps(
  overrides: Partial<React.ComponentProps<typeof Sidebar>> = {}
): React.ComponentProps<typeof Sidebar> {
  return {
    workspaces: [ws('/a', 'alpha')],
    sessions: [taggedSession(11, '/a', [1, 2])],
    selected: '/a',
    selectedGridId: 'a1',
    tags: TAGS,
    gridsByWorkspace: {
      '/a': [
        { id: 'a1', name: 'alpha main', sessionIds: [11], tagIds: [1, 2], count: 1, state: 'working' }
      ]
    },
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
    ...overrides
  } as React.ComponentProps<typeof Sidebar>
}

let container: HTMLElement
let root: Root

function render(overrides: Partial<React.ComponentProps<typeof Sidebar>> = {}): void {
  act(() => {
    root.render(<Sidebar {...baseProps(overrides)} />)
  })
}

const q = (sel: string): HTMLElement | null => container.querySelector(sel)
const rows = (): HTMLElement[] => [
  ...container.querySelectorAll<HTMLElement>('[data-testid="rail-nav-row"]')
]

beforeEach(() => {
  setRailViewForTests({ view: null, hidden: [] })
  setSettingsNavForTests({ open: false, section: 'appearance' })
  localStorage.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('the rail nav block', () => {
  it('Search is a button onto the palette, not a second text field', () => {
    const onOpenPalette = vi.fn()
    render({ onOpenPalette, paletteChord: 'Ctrl+K' })
    const search = q('[data-testid="rail-search"]') as HTMLButtonElement
    expect(search).not.toBeNull()
    expect(search.tagName).toBe('BUTTON')
    expect(container.querySelector('[data-testid="rail-search"] input')).toBeNull()
    act(() => search.click())
    expect(onOpenPalette).toHaveBeenCalledTimes(1)
  })

  it('the chord rides inside the row, split into caps, and is simply absent when unknown', () => {
    render({ paletteChord: 'Ctrl+K' })
    expect(q('[data-testid="rail-search"]')?.textContent).toContain('Ctrl')
    expect(q('[data-testid="rail-search"]')?.textContent).toContain('K')
    render({ paletteChord: null })
    expect(q('[data-testid="rail-search"]')?.textContent?.trim()).toBe('Search')
  })

  it('all three libraries show by default, in RAIL_VIEWS order', () => {
    render()
    expect(rows().map((r) => r.getAttribute('data-view'))).toEqual([...RAIL_VIEWS])
    expect(rows().map((r) => r.textContent)).toEqual(['Skills', 'Routines', 'Connections'])
  })

  it('the open one is marked, and only it', () => {
    setRailViewForTests({ view: 'routines' })
    render()
    const marked = rows().filter((r) => r.getAttribute('aria-current') === 'page')
    expect(marked.map((r) => r.getAttribute('data-view'))).toEqual(['routines'])
  })

  it('right-click offers Hide from sidebar, and taking it removes the row', () => {
    render()
    const skills = rows().find((r) => r.getAttribute('data-view') === 'skills')!
    act(() => {
      skills.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 90 })
      )
    })
    const hide = document.querySelector('[data-testid="nav-hide-row"]') as HTMLButtonElement
    expect(hide).not.toBeNull()
    expect(hide.textContent).toContain('Hide from sidebar')

    act(() => hide.click())
    expect(rows().map((r) => r.getAttribute('data-view'))).toEqual(['routines', 'mcp'])
    expect(localStorage.getItem('tr-rail-views-hidden')).toContain('skills')
  })

  it('the rows survive Settings mode — they are destinations, not sections', () => {
    render()
    const before = rows().length
    act(() => setSettingsNavForTests({ open: true }))
    expect(q('[aria-label="Settings sections"]')).not.toBeNull()
    expect(rows().length).toBe(before)
  })
})

describe('the group header filter badge', () => {
  const toggle = (): HTMLButtonElement =>
    q('[data-testid="tree-filter-toggle"]') as HTMLButtonElement
  const options = (): HTMLButtonElement[] => [
    ...document.querySelectorAll<HTMLButtonElement>('[data-testid="tag-filter-option"]')
  ]

  it('no badge while nothing is narrowing the tree', () => {
    render()
    expect(q('[data-testid="tree-filter-badge"]')).toBeNull()
  })

  it('counts each active tag filter', () => {
    render()
    act(() => toggle().click())
    act(() => options()[0].click())
    expect(q('[data-testid="tree-filter-badge"]')?.textContent).toBe('1')

    act(() => options()[1].click())
    expect(q('[data-testid="tree-filter-badge"]')?.textContent).toBe('2')
    expect(toggle().getAttribute('aria-label')).toBe('Filter by tag (2 active)')
  })

  it('an open but empty filter menu is not a filter', () => {
    render()
    act(() => toggle().click())
    expect(document.querySelector('[data-testid="tag-filter-menu"]')).not.toBeNull()
    expect(q('[data-testid="tree-filter-badge"]')).toBeNull()
    expect(toggle().getAttribute('aria-label')).toBe('Filter by tag')
  })

  it('the filter and SSH controls are at rest — no hover needed to reach either', () => {
    render()
    for (const sel of ['[data-testid="tree-filter-toggle"]', '[data-testid="rail-ssh-connect"]']) {
      const el = q(sel)
      expect(el, `${sel} is missing`).not.toBeNull()
      expect(el?.closest('span')?.className ?? '').not.toContain('opacity-0')
    }
  })
})
