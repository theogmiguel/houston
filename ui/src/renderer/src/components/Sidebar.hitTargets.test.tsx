// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Sidebar } from './Sidebar'
import { HIT_TARGET_28 } from './hitTarget'
import type { SessionInfo, Workspace } from '../houston/client'

function ws(path: string, name = path): Workspace {
  return { path, name } as Workspace
}

function noop(): void {}

function baseProps(
  overrides: Partial<React.ComponentProps<typeof Sidebar>> = {}
): React.ComponentProps<typeof Sidebar> {
  return {
    workspaces: [],
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
    chromeTheme: 'graphite',
    onToggleChromeTheme: noop,
    ...overrides
  }
}

describe('Sidebar — density floor on small rail actions', () => {
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
    localStorage.clear()
  })

  it("a workspace row's chevron keeps its 18px box and hit-tests to the floor", () => {
    act(() => {
      root.render(
        <Sidebar
          {...baseProps({
            workspaces: [ws('/a', 'alpha')],
            selected: '/a',
            gridsByWorkspace: { '/a': [{ id: 'a1', name: 'alpha main' }, { id: 'a2', name: 'alpha review' }] }
          })}
        />
      )
    })
    const chevron = container.querySelector('[data-testid="ws-chevron"]')
    expect(chevron?.className).toContain('after:h-[var(--h-disclosure-hit)]')
    expect(chevron?.className).toContain('after:min-w-[var(--h-disclosure-hit)]')
    expect(chevron?.className).toContain('after:w-full')
    expect(chevron?.className).toContain('h-[var(--sz-disclosure-icon)]')
  })

  it("the group header's Filter action keeps its 18px box and hit-tests to the floor", () => {
    act(() => {
      root.render(<Sidebar {...baseProps({ workspaces: [ws('/a', 'alpha')], selected: '/a' })} />)
    })
    const filter = container.querySelector('button[aria-label="Filter by tag"]')
    expect(filter?.className).toContain('w-[var(--sz-rail-compact-action)] h-[var(--sz-rail-compact-action)]')
    expect(filter?.className).not.toContain(HIT_TARGET_28)
  })

  it('the group-header actions share one box — filter and the create +', () => {
    act(() => {
      root.render(<Sidebar {...baseProps({ workspaces: [ws('/a', 'alpha')], selected: '/a' })} />)
    })
    for (const label of ['Filter by tag', 'Add workspace']) {
      const el = container.querySelector(`button[aria-label="${label}"]`)
      expect(el, `${label} is missing from the header`).not.toBeNull()
      expect(el?.className, `${label} is not on the 24px box`).toContain('w-[var(--sz-rail-compact-action)] h-[var(--sz-rail-compact-action)]')
    }
  })
})
