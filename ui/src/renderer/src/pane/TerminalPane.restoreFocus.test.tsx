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

describe('a pane already active at mount focuses once its surface attaches', () => {
  let container: HTMLDivElement
  let root: Root
  let fakeClient: HoustonClient

  beforeEach(() => {
    ghosttyMock.reset()
    fakeClient = {
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
  })

  it('calls surface.focus() once the surface attaches, even though it was active before that', async () => {
    ghosttyMock.gate = () => {}
    const registerOutput: RegisterOutput = () => () => {}
    act(() => {
      root.render(
        <TerminalPane
          client={fakeClient}
          info={makeSession()}
          theme="warm-espresso"
          active={true}
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
    expect(ghosttyMock.focusSpy).not.toHaveBeenCalled()

    const releaseSurface = ghosttyMock.gate
    await act(async () => {
      releaseSurface?.()
      await flushGhosttyAttach()
    })

    expect(ghosttyMock.focusSpy).toHaveBeenCalled()
  })
})
