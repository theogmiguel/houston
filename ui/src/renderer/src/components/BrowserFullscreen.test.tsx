// @vitest-environment jsdom
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { isTauriMock } = vi.hoisted(() => ({ isTauriMock: vi.fn(() => true) }))
vi.mock('../houston/host', () => ({ isTauri: () => isTauriMock() }))

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn(async () => true) }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

import {
  __resetNativeSuppressionForTests,
  isNativelySuppressed,
  setSuppressionSink,
  suppressedReasons
} from '../layout/nativeSuppression'
import { BrowserFullscreen } from './BrowserFullscreen'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  isTauriMock.mockReturnValue(true)
  __resetNativeSuppressionForTests()
  setSuppressionSink(null)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  setSuppressionSink(null)
  __resetNativeSuppressionForTests()
})

const noop = (): void => {}

let mountCount = 0
function MountProbe(): React.JSX.Element {
  useEffect(() => {
    mountCount += 1
  }, [])
  return <div data-testid="mount-probe">child</div>
}

describe('BrowserFullscreen suppression lifecycle (C10)', () => {
  it('asserts the modal reason while active and releases when active flips false', () => {
    let active = true
    const render = (): void =>
      act(() => {
        root.render(
          <BrowserFullscreen
            active={active}
            onExit={noop}
            urlLabel="https://a.example/"
            canGoBack={false}
            canGoForward={false}
            loading={false}
            onBack={noop}
            onForward={noop}
            onReload={noop}
          >
            <div />
          </BrowserFullscreen>
        )
      })
    render()
    expect(isNativelySuppressed()).toBe(true)
    expect(suppressedReasons()).toEqual(['modal'])

    active = false
    render()
    expect(isNativelySuppressed()).toBe(false)
  })

  it('releases on unmount while still active — no leaked suppression', () => {
    act(() => {
      root.render(
        <BrowserFullscreen
          active={true}
          onExit={noop}
          urlLabel="https://a.example/"
          canGoBack={false}
          canGoForward={false}
          loading={false}
          onBack={noop}
          onForward={noop}
          onReload={noop}
        >
          <div />
        </BrowserFullscreen>
      )
    })
    expect(isNativelySuppressed()).toBe(true)

    act(() => root.unmount())
    root = createRoot(container)
    expect(isNativelySuppressed()).toBe(false)
  })
})

describe('BrowserFullscreen Esc-to-exit (C10)', () => {
  it('Escape calls onExit while active', () => {
    const onExit = vi.fn()
    act(() => {
      root.render(
        <BrowserFullscreen
          active={true}
          onExit={onExit}
          urlLabel="https://a.example/"
          canGoBack={false}
          canGoForward={false}
          loading={false}
          onBack={noop}
          onForward={noop}
          onReload={noop}
        >
          <div />
        </BrowserFullscreen>
      )
    })
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(onExit).toHaveBeenCalledTimes(1)
  })

  it('does nothing while inactive — no listener installed', () => {
    const onExit = vi.fn()
    act(() => {
      root.render(
        <BrowserFullscreen
          active={false}
          onExit={onExit}
          urlLabel="https://a.example/"
          canGoBack={false}
          canGoForward={false}
          loading={false}
          onBack={noop}
          onForward={noop}
          onReload={noop}
        >
          <div />
        </BrowserFullscreen>
      )
    })
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(onExit).not.toHaveBeenCalled()
  })

  it('a non-Escape key does not exit', () => {
    const onExit = vi.fn()
    act(() => {
      root.render(
        <BrowserFullscreen
          active={true}
          onExit={onExit}
          urlLabel="https://a.example/"
          canGoBack={false}
          canGoForward={false}
          loading={false}
          onBack={noop}
          onForward={noop}
          onReload={noop}
        >
          <div />
        </BrowserFullscreen>
      )
    })
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(onExit).not.toHaveBeenCalled()
  })
})

describe('BrowserFullscreen reposition, never remount (C10)', () => {
  it('never unmounts `children` while toggling active — the same instance moves, not a fresh one', () => {
    mountCount = 0
    let active = false
    const render = (): void =>
      act(() => {
        root.render(
          <BrowserFullscreen
            active={active}
            onExit={noop}
            urlLabel="https://a.example/"
            canGoBack={false}
            canGoForward={false}
            loading={false}
            onBack={noop}
            onForward={noop}
            onReload={noop}
          >
            <MountProbe />
          </BrowserFullscreen>
        )
      })
    render()
    expect(mountCount).toBe(1)
    expect(container.querySelector('[data-testid="mount-probe"]')).not.toBeNull()

    active = true
    render()
    expect(mountCount).toBe(1)
    expect(container.querySelector('[data-testid="mount-probe"]')).toBeNull()
    expect(document.body.querySelector('[data-testid="mount-probe"]')).not.toBeNull()

    active = false
    render()
    expect(mountCount).toBe(1)
    expect(container.querySelector('[data-testid="mount-probe"]')).not.toBeNull()
  })

  it('the exit button carries the carve’s copy strings', () => {
    act(() => {
      root.render(
        <BrowserFullscreen
          active={true}
          onExit={noop}
          urlLabel="https://a.example/"
          canGoBack={false}
          canGoForward={false}
          loading={false}
          onBack={noop}
          onForward={noop}
          onReload={noop}
        >
          <div />
        </BrowserFullscreen>
      )
    })
    const exitBtn = document.body.querySelector('[data-testid="browser-fullscreen-exit"]')
    if (!(exitBtn instanceof HTMLButtonElement)) throw new Error('exit button not rendered')
    expect(exitBtn.closest('[data-tooltip]')?.getAttribute('data-tooltip')).toBe('Exit full screen (Esc)')
    expect(exitBtn.getAttribute('aria-label')).toBe('Exit full screen')
    expect(exitBtn.getAttribute('aria-pressed')).toBe('true')
  })
})

describe('BrowserFullscreen url bar (M1)', () => {
  const renderFs = (props: {
    onNavigate?: (url: string) => void
    onExit?: () => void
  }): void => {
    act(() => {
      root.render(
        <BrowserFullscreen
          active={true}
          onExit={props.onExit ?? noop}
          urlLabel="https://a.example/"
          canGoBack={false}
          canGoForward={false}
          loading={false}
          onBack={noop}
          onForward={noop}
          onReload={noop}
          onNavigate={props.onNavigate}
        >
          <MountProbe />
        </BrowserFullscreen>
      )
    })
  }

  const urlInput = (): HTMLInputElement => {
    const el = document.body.querySelector('[data-testid="browser-fullscreen-url"]')
    if (!(el instanceof HTMLInputElement)) throw new Error('fullscreen url input not rendered')
    return el
  }

  const type = (el: HTMLInputElement, value: string): void => {
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value'
      )?.set
      setter?.call(el, value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  const press = (el: HTMLInputElement, key: string): void => {
    act(() => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    })
  }

  it('is editable and commits on Enter', () => {
    const onNavigate = vi.fn()
    renderFs({ onNavigate })

    const el = urlInput()
    expect(el.readOnly).toBe(false)
    expect(el.tabIndex).toBe(0)
    expect(el.value).toBe('https://a.example/')

    type(el, 'example.test/next')
    expect(el.value).toBe('example.test/next')
    press(el, 'Enter')
    expect(onNavigate).toHaveBeenCalledWith('example.test/next')
  })

  it('asks the host for the keyboard on pointer-down, before focus', async () => {
    renderFs({ onNavigate: vi.fn() })
    invokeMock.mockClear()

    act(() => {
      urlInput().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(invokeMock).toHaveBeenCalledWith('browser_focus_host', {})
  })

  it('reverts on Escape without exiting fullscreen, while an edit is in flight', () => {
    const onExit = vi.fn()
    renderFs({ onNavigate: vi.fn(), onExit })

    const el = urlInput()
    type(el, 'half-typed')
    press(el, 'Escape')
    expect(el.value).toBe('https://a.example/')
    expect(onExit).not.toHaveBeenCalled()
  })

  it('keeps what the user typed when the page navigates underneath them', () => {
    const onNavigate = vi.fn()
    let url = 'https://a.example/'
    const render = (): void => {
      act(() => {
        root.render(
          <BrowserFullscreen
            active={true}
            onExit={noop}
            urlLabel={url}
            canGoBack={false}
            canGoForward={false}
            loading={false}
            onBack={noop}
            onForward={noop}
            onReload={noop}
            onNavigate={onNavigate}
          >
            <MountProbe />
          </BrowserFullscreen>
        )
      })
    }
    render()
    type(urlInput(), 'what-i-typed')

    url = 'https://a.example/after-a-redirect'
    render()

    expect(urlInput().value).toBe('what-i-typed')
    press(urlInput(), 'Enter')
    expect(onNavigate).toHaveBeenCalledWith('what-i-typed')
  })

  it('stays a read-only mirror when the caller has no navigation to offer', () => {
    renderFs({})
    const el = urlInput()
    expect(el.readOnly).toBe(true)
    expect(el.tabIndex).toBe(-1)
    expect(el.getAttribute('aria-label')).toBe('Current page')
  })
})
