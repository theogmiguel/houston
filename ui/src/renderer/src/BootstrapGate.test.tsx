// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BootstrapGate } from './BootstrapGate'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

function setTauriPresent(present: boolean): void {
  const win = window as unknown as { __TAURI_INTERNALS__?: unknown }
  if (present) {
    win.__TAURI_INTERNALS__ = {}
  } else {
    delete win.__TAURI_INTERNALS__
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

let container: HTMLDivElement
let root: Root | null

function renderGate(load: () => Promise<void>): void {
  act(() => {
    root = createRoot(container)
    root.render(
      <BootstrapGate load={load}>
        <div>APP-MOUNTED</div>
      </BootstrapGate>
    )
  })
}

function findButton(label: string): HTMLButtonElement {
  const btn = [...container.querySelectorAll('button')].find((b) => b.textContent === label)
  if (!btn) throw new Error(`no <button> with text "${label}" found; buttons: ${container.innerHTML}`)
  return btn
}

beforeEach(() => {
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = null
  invokeMock.mockReset()
})

afterEach(() => {
  if (root) {
    try {
      act(() => root?.unmount())
    } catch {
    }
  }
  container.remove()
  vi.useRealTimers()
  setTauriPresent(false)
})

describe('BootstrapGate under Electron (isTauri() false)', () => {
  it('renders children on first paint, arms no timer, never calls load', () => {
    setTauriPresent(false)
    const load = vi.fn(() => new Promise<void>(() => {}))

    renderGate(load)

    expect(container.textContent).toContain('APP-MOUNTED')
    expect(load).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(20_000)
    })
    expect(load).not.toHaveBeenCalled()
    expect(container.textContent).toContain('APP-MOUNTED')
  })
})

describe('BootstrapGate under Tauri', () => {
  it('renders the fallback while pending, then the timeout copy after 15000ms', async () => {
    setTauriPresent(true)
    const load = vi.fn(() => new Promise<void>(() => {}))

    renderGate(load)

    expect(container.textContent).not.toContain('APP-MOUNTED')
    expect(container.querySelector('.boot-spinner')).not.toBeNull()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(14_999)
    })
    expect(container.textContent).not.toContain('failed to start')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(container.textContent).toContain('Bridge Not Ready')
    expect(container.textContent).toContain('Houston failed to start')
    expect(container.textContent).toContain(
      'The desktop bridge is taking longer than 15s to load. The renderer may be wedged after a sleep/wake cycle.'
    )
  })

  it('shows the exact "Could not initialize" message for a rejecting import', async () => {
    setTauriPresent(true)
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const load = vi.fn(() => Promise.reject(new Error('module not found: tauri.js')))

    renderGate(load)
    await act(async () => {
      await flushMicrotasks()
    })

    expect(container.textContent).toContain(
      'Could not initialize the desktop bridge: module not found: tauri.js'
    )
    expect(container.textContent).not.toContain('wedged after a sleep/wake cycle')

    errSpy.mockRestore()
  })

  it('Retry re-runs the import, and a subsequent success renders children', async () => {
    setTauriPresent(true)
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    let resolveSecond: (() => void) | undefined
    const load = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => Promise.reject(new Error('first attempt failed')))
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveSecond = resolve
          })
      )

    renderGate(load)
    await act(async () => {
      await flushMicrotasks()
    })
    expect(load).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('Could not initialize the desktop bridge: first attempt failed')

    await act(async () => {
      findButton('Retry').dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flushMicrotasks()
    })

    expect(load).toHaveBeenCalledTimes(2)
    expect(container.textContent).not.toContain('failed to start')
    expect(container.textContent).not.toContain('APP-MOUNTED')

    await act(async () => {
      resolveSecond?.()
      await flushMicrotasks()
    })
    expect(container.textContent).toContain('APP-MOUNTED')

    errSpy.mockRestore()
  })

  it('unmounting before the import settles cancels cleanly: no state update, no timeout screen', async () => {
    setTauriPresent(true)
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const load = vi.fn(() => new Promise<void>(() => {}))

    renderGate(load)
    act(() => {
      root?.unmount()
      root = null
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000)
    })

    for (const call of [...errSpy.mock.calls, ...warnSpy.mock.calls]) {
      expect(String(call[0])).not.toMatch(/unmounted component/i)
    }

    errSpy.mockRestore()
    warnSpy.mockRestore()
  })

  it('mousedown on the loading strip starts a window drag (item 19)', async () => {
    setTauriPresent(true)
    const load = vi.fn(() => new Promise<void>(() => {}))

    renderGate(load)
    const strip = container.querySelector('.\\[-webkit-app-region\\:drag\\]')
    if (!strip) throw new Error('drag strip not found on LoadingFallback')

    await act(async () => {
      strip.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
      await flushMicrotasks()
    })

    expect(invokeMock).toHaveBeenCalledWith('window_start_dragging', {})
  })

  it('mousedown on the failure screen strip starts a window drag (item 19) -- the only host with no fallback path', async () => {
    setTauriPresent(true)
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const load = vi.fn(() => Promise.reject(new Error('boom')))

    renderGate(load)
    await act(async () => {
      await flushMicrotasks()
    })
    expect(container.textContent).toContain('Could not initialize the desktop bridge')

    const strip = container.querySelector('.\\[-webkit-app-region\\:drag\\]')
    if (!strip) throw new Error('drag strip not found on FailureScreen')

    await act(async () => {
      strip.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
      await flushMicrotasks()
    })

    expect(invokeMock).toHaveBeenCalledWith('window_start_dragging', {})
    errSpy.mockRestore()
  })
})
