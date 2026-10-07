// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HoustonClient, SessionInfo } from '../houston/client'
import type { ServerMsg } from '../houston/generated/ServerMsg'
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
  'Measure process memory',
  'Split right',
  'Split down',
  'Swap with previous pane',
  'Swap with next pane',
  'Bigger text',
  'Smaller text',
  'Handoff…',
  'Clear screen',
  'Interrupt',
  'Restart',
  'Reveal in file manager',
  'Copy path',
  'Close pane'
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
  let deliver: (message: ServerMsg) => void = () => {}

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
      subscribeAll: vi.fn((handler: (message: ServerMsg) => void) => { deliver = handler; return () => {} }),
      sessionVisibility: vi.fn(),
      sendStdin: vi.fn().mockReturnValue(true),
      send: vi.fn(),
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

  it('renders exactly the fourteen rows, in order', () => {
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
    expect(row('Split right').textContent).toContain('d')
    expect(row('Split down').textContent).toContain('s')
    expect(row('Swap with previous pane').textContent).toContain('{')
    expect(row('Swap with next pane').textContent).toContain('}')
    expect(row('Interrupt').textContent).toContain('Ctrl+C')
    expect(row('Handoff…').querySelectorAll('span').length).toBe(1)
    expect(row('Clear screen').querySelectorAll('span').length).toBe(1)
    expect(row('Restart').querySelectorAll('span').length).toBe(1)
    expect(row('Copy path').querySelectorAll('span').length).toBe(1)
  })

  it('gives every row its own glyph', () => {
    render()
    openPaneMenu()
    for (const label of ROWS) expect(row(label).querySelector('svg')).not.toBeNull()
  })

  it('swaps this pane, not the focused one', () => {
    render()
    openPaneMenu()
    click(row('Swap with previous pane'))
    expect(onSwapAdjacent).toHaveBeenCalledWith(1, -1)
    openPaneMenu()
    click(row('Swap with next pane'))
    expect(onSwapAdjacent).toHaveBeenCalledWith(1, 1)
  })

  it('disables both swap rows when the grid has nothing to swap with', () => {
    render(makeSession(), null)
    openPaneMenu()
    expect(row('Swap with previous pane').disabled).toBe(true)
    expect(row('Swap with next pane').disabled).toBe(true)
  })

  it('drives the text size through the pane zoom handler', () => {
    render()
    openPaneMenu()
    click(row('Bigger text'))
    expect(onZoom).toHaveBeenCalledWith(1)
    openPaneMenu()
    click(row('Smaller text'))
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

  it('keeps a sleeping pane visible and wakes only after an explicit action', () => {
    const sleeping = makeSession({
      agent: 'claude',
      state: 'sleeping',
      title: 'Sleeping conversation',
      latest_prompt: 'Continue the recovery work',
      last_agent_message: 'I saved the current state.',
      slept_at_ms: Date.now() - 90_000,
      sleep_notice: 'A child session was deferred.'
    })

    render(sleeping)
    expect(container.textContent).toContain('Session sleeping')
    expect(container.textContent).toContain('Last prompt')
    expect(container.textContent).toContain('Last agent message')
    expect(container.textContent).toContain('1m')
    expect(container.textContent).toContain('Expiration: unknown')
    expect(container.textContent).toContain('A child session was deferred.')
    expect(fakeClient.send).not.toHaveBeenCalled()

    click(container.querySelector<HTMLButtonElement>('[aria-label="Wake conversation"]')!)
    expect(fakeClient.send).toHaveBeenCalledWith({ type: 'session_wake', session: 1 })

    act(() => deliver({ type: 'error', message: 'Wake refused for session 1: no validated conversation handle', context: null }))
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('no validated conversation handle')

    openPaneMenu()
    click(row('Start fresh conversation'))
    expect(fakeClient.respawnSession).toHaveBeenCalledWith(1, false, undefined, undefined, undefined, true)
  })

  it('measures process memory only after the user asks', () => {
    render()
    expect(fakeClient.send).not.toHaveBeenCalled()
    openPaneMenu()
    click(row('Measure process memory'))
    expect(fakeClient.send).toHaveBeenCalledWith({ type: 'session_memory_get', session: 1 })
    act(() => deliver({ type: 'session_memory', session: 1, bytes: 1_048_576, measured_at_ms: Date.now(), unavailable_reason: null }))
    expect(container.textContent).toContain('Process memory (PSS): 1 MB')
  })

  it('offers Sleep only for an idle top-level Claude or Codex session', () => {
    render(makeSession({ agent: 'claude', state: 'running', status: 'idle' }))
    openPaneMenu()
    click(row('Sleep session'))
    expect(fakeClient.send).toHaveBeenCalledWith({ type: 'session_sleep', session: 1 })

    render(makeSession({ agent: 'codex', state: 'running', status: 'working' }))
    openPaneMenu()
    expect(row('Sleep session').disabled).toBe(true)
  })

  it('closes the pane from the last row, and says so while the agent is live', () => {
    render()
    openPaneMenu()
    expect(row('Close pane').textContent).toContain('stops the agent')
    click(row('Close pane'))
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
