// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Sidebar } from './Sidebar'
import { resetRailWidthForTests } from '../railWidth'
import type { TagInfo } from '../houston/generated/TagInfo'
import type { SessionInfo, Workspace } from '../houston/client'

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
    unreadByWs: {},
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

describe('the tag quick editor hands over to the manager', () => {
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

  const editor = (): HTMLElement | null => document.querySelector('[data-testid="tag-editor"]')
  const manager = (): HTMLElement | null => document.querySelector('[data-testid="tag-manager"]')

  // Both surfaces are code-split: poll for the chunk rather than guess a tick —
  // under a loaded full-suite run it can take far longer than it does alone.
  const settle = async (selector: string): Promise<void> => {
    for (let i = 0; i < 400; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 5))
      })
      if (document.querySelector(selector) !== null) return
    }
    throw new Error(`${selector} never rendered within 2s of its trigger`)
  }

  const openEditor = async (): Promise<void> => {
    const row = container.querySelector('[data-testid="grid-row"]') as HTMLElement
    act(() => {
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }))
    })
    const item = document.querySelector('[data-testid="menu-new-tag"]') as HTMLButtonElement
    act(() => item.click())
    await settle('[data-testid="tag-editor"]')
  }

  const openManager = async (): Promise<void> => {
    const row = container.querySelector('[data-testid="grid-row"]') as HTMLElement
    act(() => {
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }))
    })
    act(() => (document.querySelector('[data-testid="menu-manage-tags"]') as HTMLButtonElement).click())
    await settle('[data-testid="tag-manager"]')
  }

  const clickAway = (): void => {
    act(() => {
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    })
  }

  it('a click outside the editor closes it and creates nothing', async () => {
    render()
    await openEditor()
    expect(editor()).not.toBeNull()

    clickAway()

    expect(editor()).toBeNull()
    expect(manager()).toBeNull()
    expect(created).toEqual([])
  })

  it('a click inside the editor leaves it open', async () => {
    render()
    await openEditor()

    act(() => {
      editor()!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    })

    expect(editor()).not.toBeNull()
  })

  it('creating a tag closes the editor and lands in the manager with the new row marked', async () => {
    render()
    await openEditor()

    const input = editor()!.querySelector('input') as HTMLInputElement
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    act(() => {
      setValue.call(input, 'renewals')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const swatch = editor()!.querySelector('[data-testid="tag-swatch"]') as HTMLButtonElement
    act(() => swatch.click())
    act(() => (editor()!.querySelector('[data-testid="tag-editor-save"]') as HTMLButtonElement).click())

    expect(editor()).toBeNull()
    expect(created).toEqual([['renewals', swatch.getAttribute('data-color')]])

    // The daemon echoes the new tag back; the manager is already open for it.
    render({ tags: [...TAGS, { id: 2, name: 'renewals', color: '#22d3ee' }] })
    await settle('[data-testid="tag-manager"]')
    expect(manager()).not.toBeNull()
    const marked = document.querySelectorAll('[data-tag-new="true"]')
    expect(marked).toHaveLength(1)
    expect(marked[0].textContent).toContain('renewals')
  })

  it('opened from the menu, the manager marks nothing as new', async () => {
    render()
    await openManager()

    expect(manager()).not.toBeNull()
    expect(document.querySelectorAll('[data-tag-new="true"]')).toHaveLength(0)
  })

  it('a click on the manager\u2019s scrim closes it', async () => {
    render()
    await openManager()
    expect(manager()).not.toBeNull()

    const scrim = manager()!.parentElement as HTMLElement
    act(() => scrim.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))

    expect(manager()).toBeNull()
  })
})
