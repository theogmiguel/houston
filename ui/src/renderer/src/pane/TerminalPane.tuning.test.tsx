// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HoustonClient, SessionInfo } from '../houston/client'
import { ExpandedContext } from '../layout/expandedContext'
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

const { TerminalPane, TerminalTuningContext } = await import('./TerminalPane')

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

describe('TerminalPane terminal-tuning context (settings-11/-14/-15)', () => {
  let container: HTMLDivElement
  let root: Root
  let fakeClient: HoustonClient

  async function render(
    tuning?: { lineHeight: number; cursorBlink: boolean; scrollbackLines: number }
  ): Promise<void> {
    const pane = (
      <ExpandedContext.Provider value={null}>
        <TerminalPane
          client={fakeClient}
          info={makeSession()}
          theme="warm-espresso"
          active={false}
          connected={true}
          fontSize={13}
          copyOnSelect={false}
          stripBoxGlyphs={true}
          registerOutput={() => () => {}}
          onActivate={() => {}}
          onZoom={() => {}}
          onShellZoom={() => {}}
          onOpenFile={() => {}}
          onOpenDir={() => {}}
        />
      </ExpandedContext.Provider>
    )
    act(() => {
      root.render(
        <StrictMode>
          {tuning ? (
            <TerminalTuningContext.Provider value={tuning}>{pane}</TerminalTuningContext.Provider>
          ) : (
            pane
          )}
        </StrictMode>
      )
    })
    await act(async () => {
      await flushGhosttyAttach()
    })
  }

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

  it('constructs the engine with the shipped defaults when no Provider wraps it', async () => {
    await render()
    const options = ghosttyMock.createOptions as {
      font?: { lineHeight?: number }
      cursorBlink?: boolean
      maxScrollbackLines?: number
    } | null
    expect(options?.font?.lineHeight).toBe(1.35)
    expect(options?.cursorBlink).toBe(true)
    expect(options?.maxScrollbackLines).toBe(10_000)
  })

  it('constructs the engine with a Provider-supplied lineHeight/cursorBlink/scrollbackLines', async () => {
    await render({ lineHeight: 1.6, cursorBlink: false, scrollbackLines: 5_000 })
    const options = ghosttyMock.createOptions as {
      font?: { lineHeight?: number }
      cursorBlink?: boolean
      maxScrollbackLines?: number
    } | null
    expect(options?.font?.lineHeight).toBe(1.6)
    expect(options?.cursorBlink).toBe(false)
    expect(options?.maxScrollbackLines).toBe(5_000)
  })

  it('applies a lineHeight change live, without remounting the engine', async () => {
    await render({ lineHeight: 1.35, cursorBlink: true, scrollbackLines: 10_000 })
    const createCountAfterMount = ghosttyMock.createCount
    await act(async () => {
      root.render(
        <StrictMode>
          <TerminalTuningContext.Provider
            value={{ lineHeight: 1.8, cursorBlink: true, scrollbackLines: 10_000 }}
          >
            <ExpandedContext.Provider value={null}>
              <TerminalPane
                client={fakeClient}
                info={makeSession()}
                theme="warm-espresso"
                active={false}
                connected={true}
                fontSize={13}
                copyOnSelect={false}
                stripBoxGlyphs={true}
                registerOutput={() => () => {}}
                onActivate={() => {}}
                onZoom={() => {}}
                onShellZoom={() => {}}
                onOpenFile={() => {}}
                onOpenDir={() => {}}
              />
            </ExpandedContext.Provider>
          </TerminalTuningContext.Provider>
        </StrictMode>
      )
      await flushGhosttyAttach()
    })
    expect(ghosttyMock.createCount).toBe(createCountAfterMount)
    expect(ghosttyMock.fontSpy).toHaveBeenLastCalledWith(expect.any(String), 13, 1.8)
  })

  it('applies a cursorBlink change live, without remounting the engine', async () => {
    await render({ lineHeight: 1.35, cursorBlink: true, scrollbackLines: 10_000 })
    const createCountAfterMount = ghosttyMock.createCount
    await act(async () => {
      root.render(
        <StrictMode>
          <TerminalTuningContext.Provider
            value={{ lineHeight: 1.35, cursorBlink: false, scrollbackLines: 10_000 }}
          >
            <ExpandedContext.Provider value={null}>
              <TerminalPane
                client={fakeClient}
                info={makeSession()}
                theme="warm-espresso"
                active={false}
                connected={true}
                fontSize={13}
                copyOnSelect={false}
                stripBoxGlyphs={true}
                registerOutput={() => () => {}}
                onActivate={() => {}}
                onZoom={() => {}}
                onShellZoom={() => {}}
                onOpenFile={() => {}}
                onOpenDir={() => {}}
              />
            </ExpandedContext.Provider>
          </TerminalTuningContext.Provider>
        </StrictMode>
      )
      await flushGhosttyAttach()
    })
    expect(ghosttyMock.createCount).toBe(createCountAfterMount)
    expect(ghosttyMock.cursorBlinkSpy).toHaveBeenLastCalledWith(false)
  })
})
