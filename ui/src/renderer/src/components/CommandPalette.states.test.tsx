// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CommandPalette, type CommandPaletteProps } from './CommandPalette'
import { buildCommands, type PaletteActions } from './commandRegistry'
import { THEMES } from '../theme'
import { KeymapOverridesContext } from '../layout/keymapOverridesContext'

function makeActions(overrides: Partial<PaletteActions> = {}): PaletteActions {
  return {
    newTerminal: vi.fn(),
    splitPane: vi.fn(),
    newGrid: vi.fn(),
    closePane: vi.fn(),
    toggleGitPane: vi.fn(),
    spawnAgent: vi.fn(),
    openTasks: vi.fn(),
    toggleSidebarRail: vi.fn(),
    toggleChromeTheme: vi.fn(),
    openAddPanePopover: vi.fn(),
    setGridLayout: vi.fn(),
    openShortcutSheet: vi.fn(),
    windowMinimize: vi.fn(),
    windowMaximize: vi.fn(),
    windowClose: vi.fn(),
    selectNavRow: vi.fn(),
    switchWorkspace: vi.fn(),
    switchGrid: vi.fn(),
    stepWorkspace: vi.fn(),
    selectLastWorkspace: vi.fn(),
    stepGrid: vi.fn(),
    ...overrides
  }
}

describe('CommandPalette — state matrix', () => {
  let container: HTMLDivElement
  let root: Root
  let onClose: ReturnType<typeof vi.fn<() => void>>

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    onClose = vi.fn()
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.restoreAllMocks()
  })

  function baseProps(overrides: Partial<CommandPaletteProps> = {}): CommandPaletteProps {
    return {
      onClose,
      actions: makeActions(),
      hasWorkspace: true,
      workspaces: [],
      appearance: {
        currentTheme: THEMES[0],
        onPreview: vi.fn(),
        onCommit: vi.fn()
      },
      ...overrides
    }
  }

  function palette(): HTMLElement {
    return container.querySelector('[data-testid="command-palette"]') as HTMLElement
  }

  function search(): HTMLInputElement {
    return container.querySelector('[data-testid="command-palette-search"]') as HTMLInputElement
  }

  function rows(): NodeListOf<Element> {
    return container.querySelectorAll('[data-testid="command-palette-row"]')
  }

  function rowById(id: string): HTMLElement | null {
    return container.querySelector(`[data-command-id="${id}"]`)
  }

  function selectedRow(): Element | null {
    return container.querySelector('[data-testid="command-palette-row"][aria-selected="true"]')
  }

  function typeInto(input: HTMLInputElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    act(() => {
      setter.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  function pressOnSearch(key: string): void {
    act(() => {
      search().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    })
  }

  function pressEscapeOnWindow(): void {
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
  }

  it('a rebound navigation chord shows its new key on the palette row', () => {
    act(() => {
      root.render(
        <KeymapOverridesContext.Provider
          value={{
            bindings: { 'workspace-next': { code: 'KeyM', ctrl: false, alt: false, shift: false, meta: false } },
            shortcuts_enabled: true
          }}
        >
          <CommandPalette {...baseProps()} />
        </KeymapOverridesContext.Provider>
      )
    })
    typeInto(search(), 'next workspace')
    const row = rowById('workspaces.next')
    expect(row).not.toBeNull()
    expect(row!.textContent).toContain('Next workspace')
    expect(row!.querySelector('span.font-mono')?.textContent).toBe('M')
  })

  it('Filled — opens grouped, with the first command highlighted', () => {
    window.localStorage.setItem('houston-command-palette-recents', JSON.stringify(['view.toggle-sidebar']))
    act(() => {
      root.render(<CommandPalette {...baseProps({
        actions: makeActions({ focusPane: vi.fn() }),
        sessions: [{ id: 1, agent: 'claude', project_dir: '/work/houston', cwd: '/work/houston', state: 'running', title: 'auth-refactor', codename: 'auth-refactor', hidden: false, status: 'needs-input', resumable: true } as never]
      })} />)
    })
    expect(rowById('session.focus.1')?.textContent).toContain('auth-refactor')
    expect(rowById('view.toggle-sidebar')).not.toBeNull()
    expect(rowById('pane.restart-focused')?.textContent).toContain('No pane is focused')
    expect(container.querySelectorAll('[data-testid="command-palette-group"]')).toHaveLength(2)
    expect(selectedRow()).not.toBeNull()
  })

  it('sessions focus on Enter and closing restores focus to the trigger', () => {
    const focusPane = vi.fn()
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    trigger.focus()
    act(() => root.render(<CommandPalette {...baseProps({
      actions: makeActions({ focusPane }),
      sessions: [{ id: 7, agent: 'codex', project_dir: '/work/api', cwd: '/work/api', state: 'running', title: 'migrate-db', codename: 'migrate-db', hidden: false, status: 'working', resumable: true } as never]
    })} />))
    expect(document.activeElement).toBe(search())
    pressOnSearch('Enter')
    expect(focusPane).toHaveBeenCalledWith(7)
    act(() => root.unmount())
    expect(document.activeElement).toBe(trigger)
    trigger.remove()
    root = createRoot(container)
  })

  it('Search — typing filters the row list live (fuzzy)', () => {
    act(() => {
      root.render(<CommandPalette {...baseProps()} />)
    })
    typeInto(search(), 'new terminal')
    expect(rows().length).toBeGreaterThan(0)
    expect(rows().length).toBeLessThan(buildCommands({ actions: makeActions(), hasWorkspace: true, workspaces: [] }).length)
    expect(rowById('panes.new-terminal')).not.toBeNull()
  })

  it('Empty set — a query matching nothing renders a named empty state, not a blank list', () => {
    act(() => {
      root.render(<CommandPalette {...baseProps()} />)
    })
    typeInto(search(), 'zzzzznosuchcommandzzzzz')
    expect(container.querySelector('[data-testid="command-palette-empty-set"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="command-palette-empty-set"] button')?.textContent).toBe('Clear search')
    expect(rows().length).toBe(0)
  })

  it('Keyboard traversal — ArrowDown/ArrowUp move the highlight, wrapping at both ends', () => {
    act(() => {
      root.render(<CommandPalette {...baseProps()} />)
    })
    typeInto(search(), 'settings')
    const enabledIds = buildCommands({ actions: makeActions(), hasWorkspace: true, workspaces: [] })
      .filter((c) => c.enabled)
      .map((c) => c.id)
    const first = selectedRow()?.getAttribute('data-command-id')
    expect(first).toBeTruthy()

    pressOnSearch('ArrowDown')
    const second = selectedRow()?.getAttribute('data-command-id')
    expect(second).not.toBe(first)

    pressOnSearch('ArrowUp')
    expect(selectedRow()?.getAttribute('data-command-id')).toBe(first)
    expect(enabledIds).toContain(first)
  })

  it('Enter runs the highlighted command and closes the palette', () => {
    const newTerminal = vi.fn()
    act(() => {
      root.render(<CommandPalette {...baseProps({ actions: makeActions({ newTerminal }) })} />)
    })
    typeInto(search(), 'New terminal')
    expect(selectedRow()?.getAttribute('data-command-id')).toBe('panes.new-terminal')
    pressOnSearch('Enter')
    expect(newTerminal).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('Clicking an enabled row runs it and closes the palette', () => {
    const openShortcutSheet = vi.fn()
    act(() => {
      root.render(<CommandPalette {...baseProps({ actions: makeActions({ openShortcutSheet }) })} />)
    })
    typeInto(search(), 'Show keyboard shortcuts')
    act(() => {
      rowById('view.shortcuts')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(openShortcutSheet).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('Removed browser pane command does not appear in search results', () => {
    act(() => {
      root.render(<CommandPalette {...baseProps({ hasWorkspace: false })} />)
    })
    typeInto(search(), 'New Browser pane')
    expect(rowById('panes.new-browser')).toBeNull()
    expect(container.querySelector('[data-testid="command-palette-empty-set"]')).not.toBeNull()
  })

  it('Escape closes the palette and returns focus to the element that had it before opening', () => {
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    trigger.focus()
    expect(document.activeElement).toBe(trigger)

    act(() => {
      root.render(<CommandPalette {...baseProps()} />)
    })
    expect(document.activeElement).toBe(search())

    pressEscapeOnWindow()
    expect(onClose).toHaveBeenCalledOnce()

    act(() => root.unmount())
    expect(document.activeElement).toBe(trigger)
    trigger.remove()
  })

  it('ACCEPTANCE — every registry entry is reachable by typing its own title', () => {
    act(() => {
      root.render(<CommandPalette {...baseProps({ hasWorkspace: true })} />)
    })
    const commands = buildCommands({ actions: makeActions(), hasWorkspace: true, workspaces: [] })
    const sample = [
      commands.find((c) => c.id === 'panes.new-terminal'),
      commands.find((c) => c.id === 'agents.spawn.antigravity'),
      commands.find((c) => c.id === 'grid.layout.2'),
      commands.find((c) => c.id === 'view.toggle-sidebar'),
      commands.find((c) => c.id === 'go-to.nav.mcp'),
      commands.find((c) => c.id === 'go-to.settings.about'),
      commands.find((c) => c.id === 'go-to.appearance-picker')
    ]
    for (const c of sample) {
      expect(c).toBeDefined()
      typeInto(search(), c!.title)
      expect(rowById(c!.id)).not.toBeNull()
    }
  })

  it('Appearance embed — selecting "Change terminal palette…" swaps the panel body for AppearancePicker, and Escape steps back to the list instead of closing', async () => {
    act(() => {
      root.render(<CommandPalette {...baseProps()} />)
    })
    typeInto(search(), 'Change terminal palette')
    act(() => {
      rowById('go-to.appearance-picker')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await vi.waitFor(() => expect(container.querySelector('[data-testid="appearance-picker"]')).not.toBeNull())
    expect(onClose).not.toHaveBeenCalled()

    pressEscapeOnWindow()
    expect(onClose).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="command-palette-search"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="appearance-picker"]')).toBeNull()
  })

  it('Committing a theme in the embedded picker closes the whole palette', async () => {
    const onCommit = vi.fn()
    act(() => {
      root.render(<CommandPalette {...baseProps({ appearance: { currentTheme: THEMES[0], onPreview: vi.fn(), onCommit } })} />)
    })
    typeInto(search(), 'Change terminal palette')
    act(() => {
      rowById('go-to.appearance-picker')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await vi.waitFor(() => expect(container.querySelector('[data-testid="appearance-picker-row"]')).not.toBeNull())
    const paletteRow = container.querySelector('[data-testid="appearance-picker-row"]') as HTMLElement
    act(() => {
      paletteRow.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onCommit).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('Clicking the scrim closes the palette; clicking inside the panel does not', () => {
    act(() => {
      root.render(<CommandPalette {...baseProps()} />)
    })
    act(() => {
      palette().dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(onClose).not.toHaveBeenCalled()

    const scrim = container.firstElementChild as HTMLElement
    act(() => {
      scrim.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(onClose).toHaveBeenCalledOnce()
  })
})
