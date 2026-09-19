// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HoustonClient, SessionInfo } from '../houston/client'
import { ExpandedContext } from '../layout/expandedContext'
import type { OutputSink, TermActions } from './TerminalPane'
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

describe('TerminalPane automatic-copy toasts', () => {
  let container: HTMLDivElement
  let root: Root
  let fakeClient: HoustonClient
  let writeText: ReturnType<typeof vi.fn>
  let actionsRef: { current: TermActions | null }
  let capturedSink: OutputSink | null

  async function render(copyOnSelect: boolean): Promise<void> {
    capturedSink = null
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
              stripBoxGlyphs={false}
              registerOutput={(_id, sink) => {
                capturedSink = sink
                return () => {}
              }}
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

  it('a settled copy-on-select selection raises the success toast', async () => {
    await render(true)
    ghosttyMock.selection = 'hello'
    act(() => ghosttyMock.emitSelectionChange())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
    })
    const toast = container.querySelector('[data-notice]')!
    expect(toast.textContent).toContain('Copied')
    expect(toast.className).toContain('color-mix(in_srgb,var(--success)_42%,transparent)')
  })

  it('a failed copy-on-select write raises the danger toast, never the success one', async () => {
    writeText.mockRejectedValue(new Error('denied'))
    await render(true)
    ghosttyMock.selection = 'hello'
    act(() => ghosttyMock.emitSelectionChange())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
    })
    const toast = container.querySelector('[data-notice]')!
    expect(toast.textContent).toContain('Copy failed')
    expect(toast.textContent).not.toContain('Copied')
    expect(container.querySelectorAll('[data-notice]').length).toBe(1)
  })

  it('a burst of quick settled selections replaces the toast in place instead of stacking', async () => {
    await render(true)
    ghosttyMock.selection = 'one'
    act(() => ghosttyMock.emitSelectionChange())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
    })
    expect(container.querySelectorAll('[data-notice]').length).toBe(1)

    ghosttyMock.selection = 'two'
    act(() => ghosttyMock.emitSelectionChange())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
    })
    expect(container.querySelectorAll('[data-notice]').length).toBe(1)
    expect(writeText).toHaveBeenCalledTimes(2)
  })

  it('OutputSink.clipboardCopied() (the OSC 52 success path, driven by App.tsx) raises the success toast', async () => {
    await render(false)
    expect(capturedSink).not.toBeNull()
    act(() => capturedSink!.clipboardCopied())
    const toast = container.querySelector('[data-notice]')!
    expect(toast.textContent).toContain('Copied')
    expect(toast.className).toContain('color-mix(in_srgb,var(--success)_42%,transparent)')
  })

  it('a burst of OSC 52 clipboardCopied() calls replaces the toast in place instead of stacking', async () => {
    await render(false)
    expect(capturedSink).not.toBeNull()
    act(() => capturedSink!.clipboardCopied())
    act(() => capturedSink!.clipboardCopied())
    act(() => capturedSink!.clipboardCopied())
    expect(container.querySelectorAll('[data-notice]').length).toBe(1)
  })

  it('OSC 52 and copy-on-select share the same replace slot — no stacking across the two paths', async () => {
    await render(true)
    expect(capturedSink).not.toBeNull()
    act(() => capturedSink!.clipboardCopied())
    expect(container.querySelectorAll('[data-notice]').length).toBe(1)

    ghosttyMock.selection = 'hello'
    act(() => ghosttyMock.emitSelectionChange())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
    })
    expect(container.querySelectorAll('[data-notice]').length).toBe(1)
  })
})
