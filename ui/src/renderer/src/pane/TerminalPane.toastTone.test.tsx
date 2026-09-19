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

describe('TerminalPane toast tone', () => {
  let container: HTMLDivElement
  let root: Root
  let fakeClient: HoustonClient
  let writeText: ReturnType<typeof vi.fn>
  let actionsRef: { current: TermActions | null }

  function render(): void {
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
              copyOnSelect={false}
              stripBoxGlyphs={false}
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
  }

  beforeEach(async () => {
    vi.useFakeTimers()
    ghosttyMock.reset()
    ghosttyMock.selection = 'selected text'
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
    render()
    await act(async () => {
      await flushGhosttyAttach()
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.useRealTimers()
  })

  it('a failed copy renders the danger affordance (icon + colored border)', async () => {
    writeText.mockRejectedValue(new Error('denied'))
    await act(async () => {
      actionsRef.current!.copy()
      await Promise.resolve()
      await Promise.resolve()
    })
    const toast = container.querySelector('[data-notice]')!
    expect(toast.textContent).toContain('Copy failed')
    expect(toast.querySelector('svg')).not.toBeNull()
    expect(toast.className).toContain('color-mix(in_srgb,var(--danger)_42%,transparent)')
  })

  it('a "copy output" toast renders the success affordance', () => {
    act(() => actionsRef.current!.copyOutput('all'))
    const toast = container.querySelector('[data-notice]')!
    expect(toast.textContent).toContain('Copied all output')
    expect(toast.querySelector('svg')).not.toBeNull()
    expect(toast.className).toContain('color-mix(in_srgb,var(--success)_42%,transparent)')
  })

  it('a toneless toast (menu-driven termActions.toast, no tone arg) is the info kind — untinted', () => {
    act(() => actionsRef.current!.toast('Plain message'))
    const toast = container.querySelector('[data-notice]')!
    expect(toast.textContent).toContain('Plain message')
    expect(toast.getAttribute('data-kind')).toBe('info')
    expect(toast.className).toContain('border-[var(--border)]')
    expect(toast.className).not.toContain('color-mix(in_srgb,var(--danger)')
    expect(toast.className).not.toContain('color-mix(in_srgb,var(--success)')
  })
})
