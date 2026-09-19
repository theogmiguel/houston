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

describe('TerminalPane collapsed-viewport resizing', () => {
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

  it('keeps the last real size while the box cannot hold a cell, then reports the real one', async () => {
    ghosttyMock.fitOk = false
    ghosttyMock.cols = 120
    ghosttyMock.rowCount = 40
    render()
    await act(async () => {
      await flushGhosttyAttach()
    })
    expect(resizeSession).not.toHaveBeenCalled()

    // The wake path re-measures and re-sends -- still collapsed: nothing.
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(resizeSession).not.toHaveBeenCalled()

    // The window comes back: the same measurement now fits and goes out.
    ghosttyMock.fitOk = true
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(resizeSession).toHaveBeenCalledTimes(1)
    expect(resizeSession).toHaveBeenLastCalledWith(1, 120, 40)
  })
})
