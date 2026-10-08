// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HoustonClient, SessionInfo } from '../houston/client'
import {
  flushGhosttyAttach,
  ghosttyMock,
  ghosttySurfaceMockModule
} from '../test/ghosttySurfaceMock'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('../ghostty/surface', () => ghosttySurfaceMockModule())

const observers = new Set<() => void>()
class FakeResizeObserver {
  constructor(private readonly callback: () => void) {}
  observe(): void {
    observers.add(this.callback)
  }
  disconnect(): void {
    observers.delete(this.callback)
  }
}
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver

Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
  configurable: true,
  get() {
    return 400
  }
})
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
  configurable: true,
  get() {
    return 300
  }
})

const { SessionPane } = await import('../components/SessionPane')

const noop = (): void => {}
const info = (id: number, spawned_by: number | null = null): SessionInfo => ({
  id,
  spawned_by,
  agent: 'claude',
  state: 'running',
  title: `pane ${id}`,
  cwd: `/tmp/child${id}/sub`,
  project_dir: `/tmp/child${id}`,
  codename: `child${id}`,
  tags: [],
  hidden: false,
  live_children: 0,
  children_waiting: 0,
  inbox_unread: 0,
  resumable: false,
  status: 'working'
})

describe('TerminalPane roster peek resize', () => {
  let container: HTMLDivElement
  let root: Root
  let sessions: Map<number, SessionInfo>
  let client: HoustonClient
  const onOpenFile = vi.fn()
  const onOpenDir = vi.fn()
  const onFocusPane = vi.fn()
  const onMoveChildToGrid = vi.fn()

  const renderRoster = (): void => {
    act(() => {
      root.render(
        <SessionPane
          client={client}
          info={sessions.get(1)!}
          roster={{ sessions, maxLiveChildren: 8 }}
          gridSessionIds={new Set([1])}
          theme="black"
          active
          connected
          fontSize={14}
          copyOnSelect={false}
          stripBoxGlyphs={false}
          showProject={false}
          shellIntegration={false}
          registerOutput={() => noop}
          onReconnectSsh={noop}
          onActivate={noop}
          onExpand={noop}
          onZoom={noop}
          onShellZoom={noop}
          onSplit={noop}
          onHeaderPointerDown={noop}
          onHandoff={noop}
          onOpenFile={onOpenFile}
          onOpenDir={onOpenDir}
          onFocusPane={onFocusPane}
          onMoveChildToGrid={onMoveChildToGrid}
        />
      )
    })
  }

  const select = (id: number): void => {
    act(() => {
      container.querySelector<HTMLButtonElement>(`button[aria-label="Open ${id}"]`)!.click()
    })
  }

  beforeEach(() => {
    vi.useFakeTimers()
    ghosttyMock.reset()
    ghosttyMock.cols = 80
    ghosttyMock.rowCount = 24
    sessions = new Map([info(1), info(2, 1), info(3, 1)].map((item) => [item.id, item]))
    client = {
      respawnSession: vi.fn(),
      closeSession: vi.fn(),
      subscribe: () => () => {},
      taskSnapshot: vi.fn(),
      taskQueueRun: vi.fn(),
      resizeSession: vi.fn(),
      attachSession: vi.fn(),
      sessionVisibility: vi.fn(),
      sendStdin: vi.fn()
    } as unknown as HoustonClient
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('does not resize the PTY of a roster terminal hidden behind the peek', async () => {
    renderRoster()
    await act(async () => {
      await flushGhosttyAttach()
    })
    select(2)
    await act(async () => {
      await flushGhosttyAttach()
      await vi.advanceTimersByTimeAsync(500)
    })
    ;(client.resizeSession as ReturnType<typeof vi.fn>).mockClear()

    // The peek bar takes rows from the shared terminal area for every kept-mounted pane.
    ghosttyMock.rowCount = 22
    await act(async () => {
      for (const callback of observers) callback()
      await vi.advanceTimersByTimeAsync(50)
    })

    expect(container.querySelector('[data-peek-session="1"]')?.getAttribute('aria-hidden')).toBe('true')
    expect(client.resizeSession).not.toHaveBeenCalledWith(1, expect.anything(), expect.anything())
    expect(client.resizeSession).toHaveBeenCalledWith(2, 80, 22)
  })
})
