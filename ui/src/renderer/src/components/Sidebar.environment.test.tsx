// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Sidebar } from './Sidebar'
import type { SessionInfo, Workspace } from '../houston/client'
import { wslWorkspaces } from '../houston/environments'

function noop(): void {}

const LINUX = '/home/u/p'
const WINDOWS = 'C:\\work'

function props(overrides: Partial<React.ComponentProps<typeof Sidebar>> = {}): React.ComponentProps<typeof Sidebar> {
  return {
    workspaces: [{ path: WINDOWS, name: 'work' }, { path: LINUX, name: 'p' }] as Workspace[],
    sessions: [] as SessionInfo[],
    selected: WINDOWS,
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

describe('Sidebar environment badge', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    localStorage.clear()
    wslWorkspaces.clear()
    wslWorkspaces.set(LINUX, 'Ubuntu')
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    wslWorkspaces.clear()
  })

  function row(path: string): HTMLElement {
    const found = Array.from(container.querySelectorAll<HTMLElement>('[aria-label]')).find(
      (el) => el.getAttribute('aria-label') === path
    )
    if (!found) throw new Error(`no rail row for ${path}`)
    return found
  }

  it('badges wsl workspaces', () => {
    for (const gridsByWorkspace of [undefined, { [WINDOWS]: [{ id: 'w1', name: 'main' }], [LINUX]: [{ id: 'l1', name: 'main' }] }]) {
      act(() => root.render(<Sidebar {...props({ gridsByWorkspace, selectedGridId: 'w1' })} />))

      expect(row(LINUX).textContent).toContain('WSL: Ubuntu')
      expect(row(WINDOWS).textContent).not.toContain('WSL:')
      expect(row(WINDOWS).querySelector('[data-testid="chip"]')).toBeNull()
    }
  })
})
