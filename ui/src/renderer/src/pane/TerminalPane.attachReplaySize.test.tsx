// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HoustonClient, SessionInfo } from '../houston/client'
import type { RegisterOutput } from './TerminalPane'
import {
  flushGhosttyAttach,
  ghosttyMock,
  ghosttySurfaceMockModule
} from '../test/ghosttySurfaceMock'

vi.mock('../ghostty/surface', () => ghosttySurfaceMockModule())

class FakeResizeObserver {
  observe(): void {}
  disconnect(): void {}
}
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver

const { TerminalPane } = await import('./TerminalPane')

const FULL_REPLAY_BYTES = 2 * 1024 * 1024
const BACKGROUND_REPLAY_BYTES = 64 * 1024

function makeSession(): SessionInfo {
  return {
    id: 1,
    agent: 'shell',
    project_dir: '/tmp/project',
    cwd: '/tmp/project',
    state: 'running',
    title: 'session-1',
    hidden: false
  } as SessionInfo
}

describe('the replay a pane asks for is sized by whether it is the focused one', () => {
  let container: HTMLDivElement
  let root: Root
  let attachSession: ReturnType<typeof vi.fn>
  let fakeClient: HoustonClient

  beforeEach(() => {
    ghosttyMock.reset()
    attachSession = vi.fn()
    fakeClient = {
      resizeSession: vi.fn(),
      attachSession,
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
  })

  async function mountPane(active: boolean): Promise<void> {
    const registerOutput: RegisterOutput = () => () => {}
    act(() => {
      root.render(
        <TerminalPane
          client={fakeClient}
          info={makeSession()}
          theme="warm-espresso"
          active={active}
          connected={true}
          fontSize={13}
          copyOnSelect={false}
          stripBoxGlyphs={true}
          registerOutput={registerOutput}
          onActivate={() => {}}
          onZoom={() => {}}
          onShellZoom={() => {}}
          onOpenFile={() => {}}
          onOpenDir={() => {}}
        />
      )
    })
    await act(async () => {
      await flushGhosttyAttach()
    })
  }

  function replayBytesAsked(): number | undefined {
    const call = attachSession.mock.calls.find((c) => c[0] === 1)
    if (!call) throw new Error('the pane never called attachSession for session 1')
    return call[1] as number | undefined
  }

  it('the focused pane still asks for the full window', async () => {
    await mountPane(true)
    expect(replayBytesAsked()).toBe(FULL_REPLAY_BYTES)
  })

  it('a background pane asks for one screenful instead', async () => {
    await mountPane(false)
    expect(replayBytesAsked()).toBe(BACKGROUND_REPLAY_BYTES)
  })

  it('twelve background panes cost less than one full replay between them', async () => {
    await mountPane(false)
    const perPane = replayBytesAsked() ?? 0
    expect(perPane * 12).toBeLessThan(FULL_REPLAY_BYTES)
  })
})
