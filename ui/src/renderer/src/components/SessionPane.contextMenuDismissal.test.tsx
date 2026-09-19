// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HoustonClient, SessionInfo } from '../houston/client'
import { SessionPane } from './SessionPane'
import { flushGhosttyAttach, ghosttyMock, ghosttySurfaceMockModule } from '../test/ghosttySurfaceMock'

vi.mock('../ghostty/surface', () => ghosttySurfaceMockModule())

class FakeResizeObserver {
  observe(): void {}
  disconnect(): void {}
}
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 400 })
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 300 })

;(window as unknown as { houston: Partial<Window['houston']> }).houston = {
  listShells: vi.fn().mockResolvedValue([]),
  pathKind: vi.fn().mockResolvedValue(null),
  openPath: vi.fn().mockResolvedValue({ ok: true })
}

function makeSession(id: number, title: string): SessionInfo {
  return {
    id,
    agent: 'shell',
    project_dir: '/home/tester/project',
    cwd: '/home/tester/project',
    state: 'running',
    title,
    hidden: false
  } as SessionInfo
}

function fakeClient(): HoustonClient {
  return {
    resizeSession: vi.fn(),
    attachSession: vi.fn(),
    sessionVisibility: vi.fn(),
    sendStdin: vi.fn().mockReturnValue(true),
    respawnSession: vi.fn(),
    closeSession: vi.fn(),
    sessionCwd: vi.fn().mockResolvedValue('/home/tester/project')
  } as unknown as HoustonClient
}

function openMenu(pane: HTMLElement): void {
  act(() => {
    pane.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })
    )
  })
}

function menuClosing(container: HTMLElement): boolean {
  return container.querySelector('.ctx-menu')?.closest('.anim-out') !== null
}

async function nextFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  })
}

describe('pane menu dismissal', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ghosttyMock.reset()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => {
      await flushGhosttyAttach()
    })
    act(() => root.unmount())
    container.remove()
  })

  it('closes on Escape even though the focused terminal stops the key from ever reaching window', async () => {
    act(() => {
      root.render(
        <SessionPane
          client={fakeClient()}
          info={makeSession(1, 'session-1')}
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
          onZoom={() => {}}
          onShellZoom={() => {}}
          onSplit={() => {}}
          onHeaderPointerDown={() => {}}
          onHandoff={() => {}}
          onOpenFile={() => {}}
          onOpenDir={() => {}}
        />
      )
    })
    await act(async () => {
      await flushGhosttyAttach()
    })

    const stopsEscape = (e: KeyboardEvent): void => e.stopPropagation()
    ghosttyMock.input.addEventListener('keydown', stopsEscape)
    ghosttyMock.input.focus()
    expect(document.activeElement).toBe(ghosttyMock.input)

    const pane = container.querySelector('.pane') as HTMLElement
    openMenu(pane)
    expect(container.querySelector('[data-testid="pane-menu-head"]')).not.toBeNull()
    expect(document.activeElement).not.toBe(ghosttyMock.input)

    act(() => {
      document.activeElement!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      )
    })
    expect(menuClosing(container)).toBe(true)

    ghosttyMock.input.removeEventListener('keydown', stopsEscape)
  })

  it('does not flash open-then-shut when the opening press dispatches its own mousedown afterwards', async () => {
    act(() => {
      root.render(
        <SessionPane
          client={fakeClient()}
          info={makeSession(1, 'session-1')}
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
          onZoom={() => {}}
          onShellZoom={() => {}}
          onSplit={() => {}}
          onHeaderPointerDown={() => {}}
          onHandoff={() => {}}
          onOpenFile={() => {}}
          onOpenDir={() => {}}
        />
      )
    })
    const pane = container.querySelector('.pane') as HTMLElement
    openMenu(pane)
    expect(container.querySelector('[data-testid="pane-menu-head"]')).not.toBeNull()

    act(() => {
      window.dispatchEvent(new Event('mousedown'))
    })
    expect(menuClosing(container)).toBe(false)
    expect(container.querySelector('[data-testid="pane-menu-head"]')).not.toBeNull()

    await nextFrame()
    const layer = container.querySelector('[data-testid="menu-dismiss-layer"]') as HTMLElement
    act(() => {
      layer.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(menuClosing(container)).toBe(true)
  })

  it('returns focus to the pane terminal once the menu closes', async () => {
    act(() => {
      root.render(
        <SessionPane
          client={fakeClient()}
          info={makeSession(1, 'session-1')}
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
          onZoom={() => {}}
          onShellZoom={() => {}}
          onSplit={() => {}}
          onHeaderPointerDown={() => {}}
          onHandoff={() => {}}
          onOpenFile={() => {}}
          onOpenDir={() => {}}
        />
      )
    })
    await act(async () => {
      await flushGhosttyAttach()
    })
    ghosttyMock.input.focus()

    const pane = container.querySelector('.pane') as HTMLElement
    openMenu(pane)
    expect(document.activeElement).not.toBe(ghosttyMock.input)

    act(() => {
      document.activeElement!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      )
    })
    expect(document.activeElement).toBe(ghosttyMock.input)
  })

  it('a press on another pane closes the menu without that pane ever seeing it', async () => {
    const onActivateB = vi.fn()
    act(() => {
      root.render(
        <>
          <SessionPane
            client={fakeClient()}
            info={makeSession(1, 'session-1')}
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
            onZoom={() => {}}
            onShellZoom={() => {}}
            onSplit={() => {}}
            onHeaderPointerDown={() => {}}
            onHandoff={() => {}}
            onOpenFile={() => {}}
            onOpenDir={() => {}}
          />
          <SessionPane
            client={fakeClient()}
            info={makeSession(2, 'session-2')}
            theme="warm-espresso"
            active={false}
            connected={true}
            fontSize={13}
            copyOnSelect={false}
            stripBoxGlyphs={false}
            showProject={false}
            registerOutput={() => () => {}}
            shellIntegration={false}
            onReconnectSsh={() => {}}
            onActivate={onActivateB}
            onExpand={() => {}}
            onZoom={() => {}}
            onShellZoom={() => {}}
            onSplit={() => {}}
            onHeaderPointerDown={() => {}}
            onHandoff={() => {}}
            onOpenFile={() => {}}
            onOpenDir={() => {}}
          />
        </>
      )
    })
    const panes = container.querySelectorAll('.pane')
    const paneA = panes[0] as HTMLElement
    openMenu(paneA)
    expect(container.querySelector('[data-testid="pane-menu-head"]')).not.toBeNull()
    await nextFrame()

    const layer = container.querySelector('[data-testid="menu-dismiss-layer"]') as HTMLElement
    act(() => {
      layer.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(menuClosing(container)).toBe(true)
    expect(onActivateB).not.toHaveBeenCalled()
  })
})
