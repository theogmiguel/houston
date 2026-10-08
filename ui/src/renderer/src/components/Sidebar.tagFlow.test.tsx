// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MANAGE_TAGS_EVENT, Sidebar } from './Sidebar'
import { resetRailWidthForTests } from '../railWidth'
import type { TagInfo } from '../houston/generated/TagInfo'
import type { SessionInfo, Workspace } from '../houston/client'
import { preloadTagPopoverSurface } from './tags/TagPopover'

beforeAll(() => preloadTagPopoverSurface())

function ws(path: string, name = path): Workspace {
  return { path, name } as Workspace
}

function noop(): void {}

const TAGS: TagInfo[] = [{ id: 1, name: 'code review', color: '#a78bfa' }]

const created: [string, string][] = []

function props(
  overrides: Partial<React.ComponentProps<typeof Sidebar>> = {}
): React.ComponentProps<typeof Sidebar> {
  return {
    workspaces: [ws('/a', 'alpha')],
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
    onReorderWorkspace: noop,
    pinnedWorkspaces: new Set(),
    onTogglePinWorkspace: noop,
    onSshConnect: noop,
    chromeTheme: 'graphite',
    onToggleChromeTheme: noop,
    tags: TAGS,
    gridsByWorkspace: {
      '/a': [{ id: 'a1', name: 'alpha main', sessionIds: [], tagIds: [], count: 1 }]
    },
    onTagCreate: (name: string, color: string) => created.push([name, color]),
    onTagUpdate: noop,
    onTagDelete: noop,
    onSetGridTags: noop,
    onRenameGrid: noop,
    onRemoveGrid: noop,
    onSelectGrid: noop,
    ...overrides
  } as React.ComponentProps<typeof Sidebar>
}

describe('tags are created and managed in one anchored popover', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    localStorage.clear()
    resetRailWidthForTests()
    created.length = 0
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    localStorage.clear()
    resetRailWidthForTests()
  })

  const render = (o: Partial<React.ComponentProps<typeof Sidebar>> = {}): void => {
    act(() => root.render(<Sidebar {...props(o)} />))
  }

  const popover = (): HTMLElement | null => document.querySelector('[data-testid="tag-popover"]')
  const view = (): string | undefined =>
    popover()?.querySelector<HTMLElement>('[data-view]')?.dataset.view

  const openGridTags = (): void => {
    const row = container.querySelector('[data-testid="grid-row"]') as HTMLElement
    act(() => {
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }))
    })
    act(() => (document.querySelector('[data-testid="menu-tags-entry"]') as HTMLButtonElement).click())
  }

  const buttonNamed = (name: string): HTMLButtonElement =>
    [...popover()!.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === name)!

  it('New tag from the card menu edits in the same popover and creates the tag', () => {
    render()
    openGridTags()
    expect(view()).toBe('pick')

    act(() => buttonNamed('New tag…').click())
    expect(view()).toBe('edit')
    const name = popover()!.querySelector<HTMLInputElement>('input[aria-label="Tag name"]')!
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    act(() => {
      setter.call(name, 'release')
      name.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => popover()!.querySelector<HTMLButtonElement>('button[aria-label^="Color "]')!.click())
    act(() => buttonNamed('Create').click())

    expect(created.map(([tagName]) => tagName)).toEqual(['release'])
    expect(document.querySelector('[role="dialog"][aria-modal="true"]')).toBeNull()
  })

  it('the Manage tags command opens the manage view anchored to the rail options', () => {
    render()
    act(() => {
      window.dispatchEvent(new Event(MANAGE_TAGS_EVENT))
    })
    expect(view()).toBe('manage')
    expect(popover()?.textContent).toContain('code review')
  })
})
