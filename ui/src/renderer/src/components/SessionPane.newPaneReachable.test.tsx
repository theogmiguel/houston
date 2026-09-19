// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HoustonClient, SessionInfo } from '../houston/client'
import { SessionPane } from './SessionPane'
import { flushGhosttyAttach, ghosttyMock, ghosttySurfaceMockModule } from '../test/ghosttySurfaceMock'
import { setWindowFocusedForTests } from '../windowFocus'

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

const HIDE_150 = '[@container_(max-width:150px)]:hidden'

function makeSession(): SessionInfo {
  return {
    id: 1,
    agent: 'claude',
    project_dir: '/tmp/project',
    cwd: '/tmp/project',
    state: 'running',
    title: 'session-1',
    hidden: false
  } as SessionInfo
}

describe('SessionPane header — New pane never sheds', () => {
  let harness: { container: HTMLDivElement; root: Root } | null = null
  const onAddPane = vi.fn()

  beforeEach(() => {
    ghosttyMock.reset()
    setWindowFocusedForTests(true)
    onAddPane.mockClear()
  })

  afterEach(async () => {
    if (harness) {
      await act(async () => {
        await flushGhosttyAttach()
      })
      act(() => harness!.root.unmount())
      harness.container.remove()
      harness = null
    }
  })

  function render(): HTMLDivElement {
    const fakeClient = {
      resizeSession: vi.fn(),
      attachSession: vi.fn(),
      sessionVisibility: vi.fn(),
      sendStdin: vi.fn(),
      respawnSession: vi.fn(),
      closeSession: vi.fn(),
      sessionCwd: vi.fn().mockResolvedValue('/tmp/project')
    } as unknown as HoustonClient
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => {
      root.render(
        <SessionPane
          client={fakeClient}
          info={makeSession()}
          theme="black"
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
          onAddPane={onAddPane}
        />
      )
    })
    harness = { container, root }
    return container
  }

  function button(container: HTMLElement, label: string): HTMLButtonElement {
    const el = container.querySelector(`button[aria-label="${label}"]`)
    if (!(el instanceof HTMLButtonElement)) throw new Error(`no header button "${label}"`)
    return el
  }

  it('the New pane button carries no 150px hide, so it survives every width', () => {
    const container = render()
    expect(button(container, 'New pane').className).not.toContain(HIDE_150)
  })

  it('Expand still sheds at 150px — it has a twin in the Terminal actions menu', () => {
    const container = render()
    expect(button(container, 'Expand').className).toContain(HIDE_150)
  })

  it('the surviving New pane button still opens the picker', () => {
    const container = render()
    act(() => button(container, 'New pane').click())
    expect(onAddPane).toHaveBeenCalledTimes(1)
    expect(onAddPane.mock.calls[0]?.[0]).toBe(1)
  })
})
