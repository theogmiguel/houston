// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HoustonClient, SessionInfo } from '../houston/client'
import { SessionPane } from './SessionPane'
import type { HandoffSource } from './PaneHandoff'
import { ghosttySurfaceMockModule } from '../test/ghosttySurfaceMock'

vi.mock('../ghostty/surface', () => ghosttySurfaceMockModule())

class FakeResizeObserver {
  observe(): void {}
  disconnect(): void {}
}
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 400 })
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 300 })

const openPath = vi.fn().mockResolvedValue({ ok: true })
;(window as unknown as { houston: Partial<Window['houston']> }).houston = {
  listShells: vi.fn().mockResolvedValue([]),
  pathKind: vi.fn().mockResolvedValue(null),
  openPath
}

const ROWS = [
  'Split Right',
  'Split Down',
  'Swap with Previous Pane',
  'Swap with Next Pane',
  'Bigger Text',
  'Smaller Text',
  'Handoff…',
  'Clear Screen',
  'Interrupt',
  'Restart',
  'Reveal in File Manager',
  'Copy Path',
  'Close Pane'
]

function makeSession(over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 1,
    agent: 'shell',
    project_dir: '/home/tester/project',
    cwd: '/home/tester/project',
    state: 'running',
    title: 'session-1',
    hidden: false,
    ...over
  } as SessionInfo
}

describe('pane ··· menu', () => {
  let container: HTMLDivElement
  let root: Root
  let fakeClient: HoustonClient
  let onHandoff: ReturnType<typeof vi.fn>
  let onSwapAdjacent: ReturnType<typeof vi.fn>
  let onZoom: ReturnType<typeof vi.fn>

  function render(info: SessionInfo = makeSession(), swap: 'wired' | null = 'wired'): void {
    act(() => {
      root.render(
        <SessionPane
          client={fakeClient}
          info={info}
          theme="warm-espresso"
          active={true}
          connected={true}
          fontSize={13}
          copyOnSelect={false}
          stripBoxGlyphs={false}
          showProject={false}
          registerOutput={() => () => {}}
          shellIntegration={false}
          onReconnectSsh={() => {}}
          onActivate={() => {}}
          onExpand={() => {}}
          onZoom={onZoom as unknown as (dir: 0 | 1 | -1) => void}
          onShellZoom={() => {}}
          onSplit={() => {}}
          onHeaderPointerDown={() => {}}
          onHandoff={onHandoff as unknown as (source: HandoffSource) => void}
          onSwapAdjacent={
            swap === null
              ? undefined
              : (onSwapAdjacent as unknown as (id: number, offset: 1 | -1) => void)
          }
          onOpenFile={() => {}}
          onOpenDir={() => {}}
        />
      )
    })
  }

  function openPaneMenu(): void {
    const pane = container.querySelector('.pane') ?? container.querySelector('section')
    if (!(pane instanceof HTMLElement)) throw new Error('no pane section rendered')
    act(() => {
      pane.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })
      )
    })
  }

  function rows(): HTMLButtonElement[] {
    return Array.from(container.querySelectorAll<HTMLButtonElement>('.ctx-item'))
  }

  function row(label: string): HTMLButtonElement {
    const hit = rows().find((b) => b.textContent?.includes(label))
    if (!hit) throw new Error(`no menu row labelled ${label}`)
    return hit
  }

  function click(el: HTMLElement): void {
    act(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))
  }

  beforeEach(() => {
    onHandoff = vi.fn()
    onSwapAdjacent = vi.fn()
    onZoom = vi.fn()
    fakeClient = {
      resizeSession: vi.fn(),
      attachSession: vi.fn(),
      sessionVisibility: vi.fn(),
      sendStdin: vi.fn().mockReturnValue(true),
      respawnSession: vi.fn(),
      closeSession: vi.fn(),
      sessionCwd: vi.fn().mockResolvedValue('/home/tester/project')
    } as unknown as HoustonClient
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('renders exactly the thirteen rows, in order', () => {
    render()
    openPaneMenu()
    expect(rows().map((b) => b.textContent ?? '')).toEqual(
      ROWS.map((label) => expect.stringContaining(label))
    )
  })

  it('heads the menu with the pane title and its home-collapsed cwd', () => {
    render()
    openPaneMenu()
    const head = container.querySelector('[data-testid="pane-menu-head"]')!
    expect(head.textContent).toContain('session-1')
    expect(head.textContent).toContain('~/project')
  })

  it('shows each row its real keymap.ts chord, and nothing where there is no route', () => {
    render()
    openPaneMenu()
    expect(row('Split Right').textContent).toContain('d')
    expect(row('Split Down').textContent).toContain('s')
    expect(row('Swap with Previous Pane').textContent).toContain('{')
    expect(row('Swap with Next Pane').textContent).toContain('}')
    expect(row('Interrupt').textContent).toContain('Ctrl+C')
    expect(row('Handoff…').querySelectorAll('span').length).toBe(1)
    expect(row('Clear Screen').querySelectorAll('span').length).toBe(1)
    expect(row('Restart').querySelectorAll('span').length).toBe(1)
    expect(row('Copy Path').querySelectorAll('span').length).toBe(1)
  })

  it('gives every row its own glyph', () => {
    render()
    openPaneMenu()
    for (const label of ROWS) expect(row(label).querySelector('svg')).not.toBeNull()
  })

  it('swaps this pane, not the focused one', () => {
    render()
    openPaneMenu()
    click(row('Swap with Previous Pane'))
    expect(onSwapAdjacent).toHaveBeenCalledWith(1, -1)
    openPaneMenu()
    click(row('Swap with Next Pane'))
    expect(onSwapAdjacent).toHaveBeenCalledWith(1, 1)
  })

  it('disables both swap rows when the grid has nothing to swap with', () => {
    render(makeSession(), null)
    openPaneMenu()
    expect(row('Swap with Previous Pane').disabled).toBe(true)
    expect(row('Swap with Next Pane').disabled).toBe(true)
  })

  it('drives the text size through the pane zoom handler', () => {
    render()
    openPaneMenu()
    click(row('Bigger Text'))
    expect(onZoom).toHaveBeenCalledWith(1)
    openPaneMenu()
    click(row('Smaller Text'))
    expect(onZoom).toHaveBeenCalledWith(-1)
  })

  it('sends a real Ctrl+C on Interrupt, and disables it once the pane is dead', () => {
    render()
    openPaneMenu()
    click(row('Interrupt'))
    expect(fakeClient.sendStdin).toHaveBeenCalledWith(1, '\x03')

    render(makeSession({ state: 'exited' }))
    openPaneMenu()
    expect(row('Interrupt').disabled).toBe(true)
  })

  it('confirms before restarting a live pane, then forces the respawn', () => {
    render()
    openPaneMenu()
    click(row('Restart'))
    expect(fakeClient.respawnSession).not.toHaveBeenCalled()
    const confirm = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent === 'Restart'
    )!
    click(confirm)
    expect(fakeClient.respawnSession).toHaveBeenCalledWith(1, false, undefined, undefined, true)
  })

  it('restarts a dead pane with no confirmation and no force', () => {
    render(makeSession({ state: 'exited' }))
    openPaneMenu()
    click(row('Restart'))
    expect(fakeClient.respawnSession).toHaveBeenCalledWith(1, false)
  })

  it('hands the pane snapshot up when Handoff… is picked', () => {
    render()
    openPaneMenu()
    click(row('Handoff…'))
    expect(onHandoff).toHaveBeenCalledTimes(1)
    expect(onHandoff.mock.calls[0][0]).toMatchObject({
      session: 1,
      agent: 'shell',
      title: 'session-1',
      cwd: '/home/tester/project'
    })
  })

  it('closes the pane from the last row, and says so while the agent is live', () => {
    render()
    openPaneMenu()
    expect(row('Close Pane').textContent).toContain('stops the agent')
    click(row('Close Pane'))
    expect(fakeClient.closeSession).toHaveBeenCalledWith(1)
  })

  it('re-clamps a right-edge open against the menu’s rendered width, not the 200px guess', () => {
    const innerWidth = window.innerWidth
    const menuWidth = 280
    const orig = HTMLElement.prototype.getBoundingClientRect
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      const rect = orig.call(this)
      if (this.classList.contains('ctx-menu')) {
        return { ...rect, width: menuWidth, toJSON: () => ({}) } as DOMRect
      }
      return rect
    }
    try {
      render()
      const pane = container.querySelector('.pane') ?? container.querySelector('section')
      if (!(pane instanceof HTMLElement)) throw new Error('no pane section rendered')
      act(() => {
        pane.dispatchEvent(
          new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: innerWidth - 10,
            clientY: 10
          })
        )
      })
      const menu = container.querySelector('.ctx-menu') as HTMLElement
      expect(menu).not.toBeNull()
      const left = Number.parseFloat(menu.style.left)
      expect(left).toBeLessThanOrEqual(innerWidth - menuWidth - 8)
    } finally {
      HTMLElement.prototype.getBoundingClientRect = orig
    }
  })
})
