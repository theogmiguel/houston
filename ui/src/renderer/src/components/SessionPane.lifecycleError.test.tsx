// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HoustonClient, SessionInfo } from '../houston/client'
import { SessionPane } from './SessionPane'
import { ghosttySurfaceMockModule } from '../test/ghosttySurfaceMock'

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

const info = { id: 7, agent: 'claude', project_dir: '/p', cwd: '/p', state: 'running', title: 'Amber Falcon', hidden: false } as SessionInfo

describe('pane lifecycle error banner', () => {
  let container: HTMLDivElement
  let root: Root
  let handlers: Record<string, Array<(message: unknown) => void>>

  beforeEach(() => {
    handlers = {}
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    const client = {
      subscribe: (type: string, handler: (message: unknown) => void) => {
        ;(handlers[type] ??= []).push(handler)
        return () => {}
      },
      resizeSession: vi.fn(),
      attachSession: vi.fn(),
      sessionVisibility: vi.fn(),
      sendStdin: vi.fn().mockReturnValue(true),
      send: vi.fn(),
      closeSession: vi.fn(),
      sessionCwd: vi.fn().mockResolvedValue('/p')
    } as unknown as HoustonClient
    act(() => {
      root.render(
        <SessionPane
          client={client}
          info={info}
          theme="warm-espresso"
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
        />
      )
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('a session error shows in the pane and the operator can dismiss it', () => {
    const message = 'session 7: generated title has 43 characters; expected one plain line of 1–40 characters'
    act(() => handlers['error']?.forEach((h) => h({ type: 'error', message, context: 'session_title_generate' })))
    expect(container.textContent).toContain(message)
    const dismiss = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Dismiss')
    expect(dismiss).toBeDefined()
    act(() => dismiss?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(container.textContent).not.toContain(message)
  })
})
