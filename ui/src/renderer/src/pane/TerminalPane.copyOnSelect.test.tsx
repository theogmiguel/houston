// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HoustonClient, SessionInfo } from '../houston/client'
import { ExpandedContext } from '../layout/expandedContext'
import type { TermActions } from './TerminalPane'
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

describe('TerminalPane copy-on-select + box-glyph stripping (P4 #20)', () => {
  let container: HTMLDivElement
  let root: Root
  let fakeClient: HoustonClient
  let writeText: ReturnType<typeof vi.fn>
  let actionsRef: { current: TermActions | null }

  async function render(copyOnSelect: boolean, stripBoxGlyphs: boolean): Promise<void> {
    act(() => {
      root.render(
        <StrictMode>
          <ExpandedContext.Provider value={null}>
            <TerminalPane
              client={fakeClient}
              info={makeSession()}
              theme="warm-espresso"
              active={false}
              connected={true}
              fontSize={13}
              copyOnSelect={copyOnSelect}
              stripBoxGlyphs={stripBoxGlyphs}
              registerOutput={() => () => {}}
              onActivate={() => {}}
              onZoom={() => {}}
              onShellZoom={() => {}}
              onOpenFile={() => {}}
              onOpenDir={() => {}}
              actions={actionsRef}
            />
          </ExpandedContext.Provider>
        </StrictMode>
      )
    })
    await act(async () => {
      await flushGhosttyAttach()
    })
  }

  beforeEach(() => {
    vi.useFakeTimers()
    ghosttyMock.reset()
    writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText }
    })
    actionsRef = { current: null }
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
    vi.useRealTimers()
  })

  it('off: a settled selection never writes the clipboard', async () => {
    await render(false, true)
    expect(ghosttyMock.createCount).toBeGreaterThan(0)
    ghosttyMock.selection = 'hello'
    act(() => ghosttyMock.emitSelectionChange())
    act(() => vi.advanceTimersByTime(1000))
    expect(writeText).not.toHaveBeenCalled()
  })

  it('on: writes exactly once per settled selection, debounced across repeated ticks', async () => {
    await render(true, true)
    ghosttyMock.selection = 'hello'
    act(() => ghosttyMock.emitSelectionChange())
    act(() => vi.advanceTimersByTime(100))
    act(() => ghosttyMock.emitSelectionChange())
    act(() => vi.advanceTimersByTime(100))
    expect(writeText).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(200))
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText).toHaveBeenCalledWith('hello')
  })

  it('on: an empty/cleared selection never writes (a plain click must not clobber the clipboard)', async () => {
    await render(true, true)
    ghosttyMock.selection = ''
    act(() => ghosttyMock.emitSelectionChange())
    act(() => vi.advanceTimersByTime(1000))
    expect(writeText).not.toHaveBeenCalled()
  })

  it('on: toggling the setting off mid-debounce suppresses the pending write', async () => {
    await render(true, true)
    ghosttyMock.selection = 'hello'
    act(() => ghosttyMock.emitSelectionChange())
    await render(false, true)
    act(() => vi.advanceTimersByTime(1000))
    expect(writeText).not.toHaveBeenCalled()
  })

  it('copy-on-select strips box glyphs when the strip toggle is on', async () => {
    await render(true, true)
    ghosttyMock.selection = '│ boxed │'
    act(() => ghosttyMock.emitSelectionChange())
    act(() => vi.advanceTimersByTime(1000))
    expect(writeText).toHaveBeenCalledWith('boxed')
  })

  it('copy-on-select leaves box glyphs alone when the strip toggle is off', async () => {
    await render(true, false)
    ghosttyMock.selection = '│ boxed │'
    act(() => ghosttyMock.emitSelectionChange())
    act(() => vi.advanceTimersByTime(1000))
    expect(writeText).toHaveBeenCalledWith('│ boxed │')
  })

  it('manual copy (actions.copy, the Ctrl+Shift+C path) strips box glyphs when the toggle is on', async () => {
    await render(false, true)
    ghosttyMock.selection = '│ boxed │'
    expect(actionsRef.current).not.toBeNull()
    act(() => actionsRef.current!.copy())
    expect(writeText).toHaveBeenCalledWith('boxed')
  })

  it('manual copy leaves box glyphs alone when the strip toggle is off', async () => {
    await render(false, false)
    ghosttyMock.selection = '│ boxed │'
    act(() => actionsRef.current!.copy())
    expect(writeText).toHaveBeenCalledWith('│ boxed │')
  })

  it('manual copy does nothing on an empty selection', async () => {
    await render(false, true)
    ghosttyMock.selection = ''
    act(() => actionsRef.current!.copy())
    expect(writeText).not.toHaveBeenCalled()
  })
})
