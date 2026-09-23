// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Sidebar } from './Sidebar'
import {
  RAIL_TAG_DOT_AT,
  resetRailWidthForTests,
  setRailWidth
} from '../railWidth'
import type { TagInfo } from '../houston/generated/TagInfo'
import type { SessionInfo, Workspace } from '../houston/client'

function ws(path: string, name = path): Workspace {
  return { path, name } as Workspace
}

function noop(): void {}

function taggedSession(
  id: number,
  path: string,
  tags: number[]
): SessionInfo {
  return {
    id,
    project_dir: path,
    state: 'running',
    tags
  } as unknown as SessionInfo
}

const TAGS: TagInfo[] = [
  { id: 1, name: 'code review', color: '#a78bfa' },
  { id: 2, name: 'wait-human', color: '#f59e0b' },
  { id: 3, name: 'renewals', color: '#22d3ee' }
]

function baseProps(
  overrides: Partial<React.ComponentProps<typeof Sidebar>> = {}
): React.ComponentProps<typeof Sidebar> {
  return {
    workspaces: [],
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
    chromeTheme: 'graphite',
    onToggleChromeTheme: noop,
    ...overrides
  }
}

const TREE = {
  workspaces: [ws('/a', 'alpha'), ws('/b', 'bravo')],
  selected: '/a',
  selectedGridId: 'a1',
  tags: TAGS,
  gridsByWorkspace: {
    '/a': [
      {
        id: 'a1',
        name: 'alpha main',
        sessionIds: [11],
        tagIds: [1],
        count: 1,
        state: 'working'
      },
      {
        id: 'a2',
        name: 'alpha review',
        sessionIds: [12],
        tagIds: [2, 3],
        count: 1,
        state: 'idle'
      }
    ],
    '/b': [
      {
        id: 'b1',
        name: 'bravo main',
        sessionIds: [13],
        tagIds: [],
        count: 1,
        state: 'idle'
      }
    ]
  },
  sessions: [
    taggedSession(11, '/a', [1]),
    taggedSession(12, '/a', [2, 3]),
    taggedSession(13, '/b', [])
  ]
} satisfies Partial<React.ComponentProps<typeof Sidebar>>

describe('Sidebar tag chips and tag filter (v100)', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    localStorage.clear()
    resetRailWidthForTests()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    localStorage.clear()
    resetRailWidthForTests()
  })

  function render(overrides: Partial<React.ComponentProps<typeof Sidebar>> = {}): void {
    act(() => {
      root.render(<Sidebar {...baseProps(overrides)} />)
    })
  }

  const gridRow = (name: string): HTMLElement =>
    [...container.querySelectorAll<HTMLElement>('[data-testid="grid-row"]')].find(
      (r) => r.textContent?.includes(name)
    )!

  const gridRows = (): string[] =>
    [...container.querySelectorAll<HTMLElement>('[data-testid="grid-row"]')].map(
      (r) => r.textContent ?? ''
    )

  const wsRows = (): string[] =>
    [...container.querySelectorAll<HTMLElement>('[data-ws-idx]')].map(
      (r) => r.textContent ?? ''
    )

  const chipsOf = (row: HTMLElement): HTMLElement[] =>
    [...row.querySelectorAll('[data-testid="tag-chip"]')] as HTMLElement[]

  const filterToggle = (): HTMLButtonElement =>
    container.querySelector('[data-testid="tree-filter-toggle"]') as HTMLButtonElement

  const openFilter = (): void => {
    act(() => filterToggle().click())
  }

  const menu = (): HTMLElement | null =>
    document.querySelector('[data-testid="tag-filter-menu"]')

  const options = (): HTMLButtonElement[] => [
    ...document.querySelectorAll<HTMLButtonElement>('[data-testid="tag-filter-option"]')
  ]

  const badge = (): HTMLElement | null =>
    container.querySelector('[data-testid="tree-filter-badge"]')

  it('renders the tag union of a grid\u2019s sessions as ONE named chip plus a count', () => {
    render(TREE)
    const row = gridRow('alpha review')
    const chips = chipsOf(row)
    expect(chips).toHaveLength(1)
    expect(chips[0].textContent).toContain('wait-human')
    expect(row.querySelector('[data-testid="tag-chips-more"]')?.textContent).toBe('+1')
    expect(chipsOf(gridRow('bravo main'))).toHaveLength(0)
  })

  it('a single tag shows no count beside it', () => {
    render(TREE)
    const row = gridRow('alpha main')
    expect(chipsOf(row)).toHaveLength(1)
    expect(row.querySelector('[data-testid="tag-chips-more"]')).toBeNull()
  })

  it('names one chip and counts the rest, whatever the total', () => {
    render({
      ...TREE,
      gridsByWorkspace: {
        '/a': [
          {
            id: 'a1',
            name: 'alpha main',
            sessionIds: [11],
            tagIds: [1, 2, 3],
            count: 1,
            state: 'working'
          }
        ],
        '/b': [{ id: 'b1', name: 'bravo main' }]
      },
      sessions: [taggedSession(11, '/a', [1, 2, 3])]
    })
    const row = gridRow('alpha main')
    expect(chipsOf(row)).toHaveLength(1)
    expect(row.querySelector('[data-testid="tag-chips-more"]')?.textContent).toBe('+2')
  })

  it('clicking a chip filters by it; clicking it again drops the filter', () => {
    render(TREE)
    act(() => {
      chipsOf(gridRow('alpha main'))[0].click()
    })
    expect(badge()?.textContent).toBe('1')
    expect(gridRow('alpha review')).toBeUndefined()

    act(() => {
      chipsOf(gridRow('alpha main'))[0].click()
    })
    expect(badge()).toBeNull()
    expect(gridRow('alpha review')).not.toBeUndefined()
  })

  it('the funnel opens a tag menu, and grid mode has no inline text filter at all', () => {
    render(TREE)
    expect(container.querySelector('input[aria-label="Filter workspaces"]')).toBeNull()
    expect(menu()).toBeNull()

    openFilter()

    expect(menu()).not.toBeNull()
    expect(container.querySelector('input[aria-label="Filter workspaces"]')).toBeNull()
    expect(options().map((o) => o.textContent)).toEqual([
      'code review',
      'wait-human',
      'renewals'
    ])
    const clear = document.querySelector('[data-testid="tag-filter-clear"]') as HTMLButtonElement
    expect(clear.disabled).toBe(true)
  })

  it('a menu row toggles its tag, marks itself checked and keeps the menu open', () => {
    render(TREE)
    openFilter()

    act(() => options()[0].click())

    expect(menu()).not.toBeNull()
    expect(options()[0].getAttribute('aria-checked')).toBe('true')
    expect(badge()?.textContent).toBe('1')

    act(() => options()[1].click())
    expect(badge()?.textContent).toBe('2')
    expect(options()[1].getAttribute('aria-checked')).toBe('true')

    act(() => options()[0].click())
    expect(options()[0].getAttribute('aria-checked')).toBe('false')
    expect(badge()?.textContent).toBe('1')
  })

  it('the funnel badge is absent at zero and names the active count', () => {
    render(TREE)
    expect(badge()).toBeNull()
    expect(filterToggle().getAttribute('aria-label')).toBe('Filter by tag')

    openFilter()
    expect(badge()).toBeNull()

    act(() => options()[0].click())
    expect(badge()?.textContent).toBe('1')
    expect(filterToggle().getAttribute('aria-label')).toBe('Filter by tag (1 active)')
  })

  it('Clear filter empties every active tag and leaves the menu open', () => {
    render(TREE)
    openFilter()
    act(() => options()[0].click())
    act(() => options()[2].click())
    expect(badge()?.textContent).toBe('2')

    const clear = document.querySelector('[data-testid="tag-filter-clear"]') as HTMLButtonElement
    expect(clear.disabled).toBe(false)
    act(() => clear.click())

    expect(badge()).toBeNull()
    expect(gridRows()).toHaveLength(3)
    expect(menu()).not.toBeNull()
  })

  it('hides every tab whose known membership carries none of the active filter, and the workspace left with nothing', () => {
    render(TREE)
    act(() => {
      chipsOf(gridRow('alpha main'))[0].click()
    })
    expect(gridRows().map((t) => t.replace(/\d+$/, ''))).toHaveLength(1)
    expect(gridRow('alpha main')).not.toBeUndefined()
    expect(gridRow('alpha review')).toBeUndefined()
    expect(gridRow('bravo main')).toBeUndefined()
    expect(wsRows().some((t) => t.includes('bravo'))).toBe(false)
    expect(wsRows().some((t) => t.includes('alpha'))).toBe(true)
  })

  it('a tab whose membership is not known yet survives the filter \u2014 a filter never hides what it cannot see', () => {
    render({
      ...TREE,
      gridsByWorkspace: {
        '/a': [
          { id: 'a1', name: 'alpha main', sessionIds: [11], tagIds: [1], count: 1 },
          { id: 'a9', name: 'alpha unknown', sessionIds: [], count: 1 }
        ],
        '/b': [{ id: 'b1', name: 'bravo main', sessionIds: [13], tagIds: [], count: 1 }]
      }
    })
    act(() => {
      chipsOf(gridRow('alpha main'))[0].click()
    })
    expect(gridRow('alpha unknown')).not.toBeUndefined()
    expect(gridRow('bravo main')).toBeUndefined()
  })

  it('a filter that matches nothing says so instead of showing an empty tree', () => {
    render({
      ...TREE,
      gridsByWorkspace: {
        '/a': [{ id: 'a1', name: 'alpha main', sessionIds: [11], tagIds: [2], count: 1 }],
        '/b': [{ id: 'b1', name: 'bravo main', sessionIds: [13], tagIds: [], count: 1 }]
      },
      sessions: [taggedSession(11, '/a', [2]), taggedSession(13, '/b', [])]
    })
    openFilter()
    act(() => options()[0].click())

    expect(gridRows()).toHaveLength(0)
    expect(wsRows()).toHaveLength(0)
    expect(container.textContent).toContain('No tab carries that tag')
  })

  it('a chip is name-and-dot at the default width, dot-only below RAIL_TAG_DOT_AT, and name-and-dot again above it', () => {
    render(TREE)
    const chip = (): HTMLElement => chipsOf(gridRow('alpha main'))[0]

    expect(chip().textContent).toContain('code review')

    act(() => setRailWidth(RAIL_TAG_DOT_AT - 40))
    expect(chip().textContent).toBe('')
    expect(chip().querySelector('span')?.className).toContain('w-[6px]')

    act(() => setRailWidth(RAIL_TAG_DOT_AT + 60))
    expect(chip().textContent).toContain('code review')
  })

  it('survives a filter persisted by an older shape and prunes deleted tags', () => {
    localStorage.setItem('houston.tagFilter', JSON.stringify([1, 99]))
    render(TREE)
    expect(badge()?.textContent).toBe('1')
    expect(gridRow('alpha review')).toBeUndefined()

    render({ ...TREE, tags: TAGS.filter((t) => t.id !== 1) })
    expect(badge()).toBeNull()
  })

  it('the filter persists across a remount', () => {
    render(TREE)
    openFilter()
    act(() => options()[0].click())

    act(() => root.unmount())
    root = createRoot(container)
    render(TREE)

    expect(badge()?.textContent).toBe('1')
  })
})
