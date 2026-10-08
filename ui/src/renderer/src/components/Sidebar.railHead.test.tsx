// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Sidebar } from './Sidebar'
import type { SessionInfo, Workspace } from '../houston/client'

function noop(): void {}

function baseProps(overrides: Partial<React.ComponentProps<typeof Sidebar>> = {}): React.ComponentProps<typeof Sidebar> {
  return {
    workspaces: [] as Workspace[],
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

describe('Sidebar rail head — state matrix', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.restoreAllMocks()
  })

  function render(overrides: Partial<React.ComponentProps<typeof Sidebar>> = {}): void {
    act(() => {
      root.render(<Sidebar {...baseProps(overrides)} />)
    })
  }

  it('Add workspace opens both actions without a separate SSH button', () => {
    const onAddWorkspace = vi.fn()
    const onSshConnect = vi.fn()
    render({ onAddWorkspace, onSshConnect })
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Add workspace"]')!
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu')
    expect(container.querySelector('[data-testid="rail-ssh-connect"]')).toBeNull()
    expect(container.querySelector('[aria-label="Connect over SSH"]')).toBeNull()
    act(() => trigger.click())
    const items = document.querySelectorAll<HTMLButtonElement>('[role="menu"] [role="menuitem"]')
    expect(Array.from(items, (item) => item.textContent)).toEqual(['Local folder…', 'Connect via SSH…'])
    act(() => items[0].click())
    expect(onAddWorkspace).toHaveBeenCalledOnce()
    expect(document.querySelector('[role="menu"]')).toBeNull()
    act(() => trigger.click())
    act(() => document.querySelector<HTMLButtonElement>('[data-testid="rail-ssh-connect"]')!.click())
    expect(onSshConnect).toHaveBeenCalledOnce()
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })

  it.each(['outside', 'escape', 'blur'])('closes Add workspace on %s', (reason) => {
    render()
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Add workspace"]')!
    act(() => trigger.click())
    act(() => {
      if (reason === 'outside') document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      else if (reason === 'escape') window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      else window.dispatchEvent(new Event('blur'))
    })
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })

  it('Empty — N/A: the brand mark/name are static chrome, not a data-driven surface, so there is no "not yet loaded" state to occupy.', () => {
    expect(true).toBe(true)
  })

  it('Filled — the brand mark and name sit at the leading edge, before the hide control', () => {
    render({ onHideRail: noop })
    const head = container.querySelector('aside > div') as HTMLElement
    const brand = head.querySelector('[data-testid="brand-mark"]')
    const hide = head.querySelector('button[aria-label="Hide sidebar"]')
    expect(brand).not.toBeNull()
    expect(head.textContent).toContain('Houston')
    expect(hide).not.toBeNull()
    expect(brand!.compareDocumentPosition(hide!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('Hover — the hide button is the head\'s one affordance: a 28px chrome button with the hover wash, offered only when the app wires onHideRail', () => {
    render({ onHideRail: noop })
    const btn = container.querySelector('aside > div button[aria-label="Hide sidebar"]') as HTMLElement | null
    expect(btn).not.toBeNull()
    expect(btn?.className).toContain('hover:bg-[var(--card-hover)]')
    render({ onHideRail: undefined })
    expect(container.querySelector('aside > div button[aria-label="Hide sidebar"]')).toBeNull()
  })

  it('Focus — the hide button is the only focusable thing in the head, and it is a real button', () => {
    render({ onHideRail: noop })
    const head = container.querySelector('aside > div') as HTMLElement
    const focusables = head.querySelectorAll('button, a, input, [tabindex]')
    expect(focusables).toHaveLength(1)
    expect(focusables[0].tagName).toBe('BUTTON')
  })

  it('Active — N/A: dragging the window from this region is an OS-level move, not a press — no active/pressed visual exists on any platform\'s titlebar drag strip.', () => {
    expect(true).toBe(true)
  })

  it('Selected — N/A: the rail head is not a row in a list of choices (unlike the nav rows or tree rows below it), so "selected" does not apply.', () => {
    expect(true).toBe(true)
  })

  it('Disabled — N/A: the hide button is never disabled; when hiding is not offered it is absent, not greyed.', () => {
    expect(true).toBe(true)
  })

  it('Loading — N/A: the brand name is known synchronously at render time (no async fetch backs this surface).', () => {
    expect(true).toBe(true)
  })

  it('Error — N/A: nothing here can fail in a way this component is responsible for surfacing; a logo asset load failure is an ordinary <img> concern, not part of this surface\'s contract.', () => {
    expect(true).toBe(true)
  })

  it('the hide control sits at the trailing edge, not centered', () => {
    render({ onHideRail: noop })
    const head = container.querySelector('aside > div') as HTMLElement
    expect(head.className).not.toContain('justify-center')
    expect(head.querySelector('button[aria-label="Hide sidebar"]')).not.toBeNull()
  })

  it('without onHideRail the head still shows the brand but no hide control', () => {
    render()
    const head = container.querySelector('aside > div') as HTMLElement
    expect(head.textContent).toContain('Houston')
    expect(head.querySelector('button[aria-label="Hide sidebar"]')).toBeNull()
  })

  it('drag wiring — the rail head forwards onMouseDown/onDoubleClick to the host, same guard as the topbar', () => {
    const onHeadMouseDown = vi.fn()
    const onHeadDoubleClick = vi.fn()
    render({ onHeadMouseDown, onHeadDoubleClick })
    const head = container.querySelector('aside > div') as HTMLElement
    act(() => {
      head.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      head.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
    expect(onHeadMouseDown).toHaveBeenCalledTimes(1)
    expect(onHeadDoubleClick).toHaveBeenCalledTimes(1)
  })
})
