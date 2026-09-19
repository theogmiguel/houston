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

Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
  configurable: true,
  get: () => 400
})
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
  configurable: true,
  get: () => 300
})

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

describe('TerminalPane settled-size reporting', () => {
  let container: HTMLDivElement
  let root: Root
  let resizeSession: ReturnType<typeof vi.fn>
  let fakeClient: HoustonClient

  beforeEach(() => {
    ghosttyMock.reset()
    resizeSession = vi.fn()
    fakeClient = {
      resizeSession,
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

  const render = (): void => {
    const registerOutput: RegisterOutput = () => () => {}
    act(() => {
      root.render(
        <TerminalPane
          client={fakeClient}
          info={makeSession()}
          theme="warm-espresso"
          active={false}
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
  }

  it('reports the size the surface settled on, not the pre-attach placeholder', async () => {
    ghosttyMock.cols = 120
    ghosttyMock.rowCount = 40
    render()
    await act(async () => {
      await flushGhosttyAttach()
    })

    expect(resizeSession).toHaveBeenCalledTimes(1)
    expect(resizeSession).toHaveBeenLastCalledWith(1, 120, 40)
  })

  it('a pane that grew while the engine was still loading reports the grown size', async () => {
    ghosttyMock.cols = 60
    ghosttyMock.rowCount = 18
    ghosttyMock.gate = () => {}
    render()
    await act(async () => {
      await flushGhosttyAttach()
    })
    expect(resizeSession).not.toHaveBeenCalled()

    ghosttyMock.cols = 200
    ghosttyMock.rowCount = 60
    await act(async () => {
      ghosttyMock.gate?.()
      await flushGhosttyAttach()
    })

    expect(resizeSession).toHaveBeenCalledTimes(1)
    expect(resizeSession).toHaveBeenLastCalledWith(1, 200, 60)
  })
})
