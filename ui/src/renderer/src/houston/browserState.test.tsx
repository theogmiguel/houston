// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { listenMock, importFails } = vi.hoisted(() => ({
  listenMock: vi.fn(),
  importFails: { value: false }
}))
vi.mock('@tauri-apps/api/event', () => {
  if (importFails.value) throw new Error('chunk load failed: @tauri-apps/api/event')
  return { listen: listenMock }
})

const { isTauriMock } = vi.hoisted(() => ({ isTauriMock: vi.fn(() => true) }))
vi.mock('./host', () => ({ isTauri: () => isTauriMock() }))

const { useBrowserState, useBrowserOpenUrl } = await import('./browserState')
type BrowserState = Awaited<ReturnType<typeof useBrowserState>>

function samplePayload(id: string, overrides: Partial<NonNullable<BrowserState>> = {}) {
  return {
    id,
    url: 'https://example.test/',
    title: 'Example',
    favicon: null,
    loading: false,
    progress: 1,
    canGoBack: false,
    canGoForward: false,
    error: null,
    mountFailed: false,
    ...overrides
  }
}

function captureStateHandler(): {
  fire: (payload: ReturnType<typeof samplePayload>) => void
  dispose: ReturnType<typeof vi.fn>
} {
  const dispose = vi.fn()
  let handler: ((e: { payload: unknown }) => void) | null = null
  listenMock.mockImplementation((name: string, h: (e: { payload: unknown }) => void) => {
    expect(name).toBe('browser://state')
    handler = h
    return Promise.resolve(dispose)
  })
  return {
    fire: (payload) => {
      if (!handler) throw new Error('listen() was never called')
      act(() => (handler as (e: { payload: unknown }) => void)({ payload }))
    },
    dispose
  }
}

let container: HTMLDivElement
let root: Root
let lastState: BrowserState = null

function Probe({ id }: { id: string }): null {
  lastState = useBrowserState(id)
  return null
}

async function mount(id: string): Promise<void> {
  lastState = null
  act(() => {
    root.render(<Probe id={id} />)
  })
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  isTauriMock.mockReturnValue(true)
  listenMock.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('the shared @tauri-apps/api/event loader', () => {
  function RetryProbe(): null {
    useBrowserOpenUrl('right-panel-browser', () => {})
    return null
  }

  async function mountRetryProbe(): Promise<void> {
    act(() => {
      root.render(<RetryProbe />)
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  it('retries the import on the next mount after one fails', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      importFails.value = true
      listenMock.mockImplementation(() => Promise.resolve(vi.fn()))

      await mountRetryProbe()
      expect(listenMock).not.toHaveBeenCalled()
      const own = errors.mock.calls.filter((c) => String(c[0]).includes('browser://open-url'))
      expect(own).toHaveLength(1)

      act(() => root.unmount())
      root = createRoot(container)
      importFails.value = false
      await mountRetryProbe()
      expect(listenMock).toHaveBeenCalledTimes(1)
    } finally {
      importFails.value = false
      errors.mockRestore()
    }
  })
})

describe('useBrowserState', () => {
  it('subscribes to nothing under Electron', async () => {
    isTauriMock.mockReturnValue(false)
    await mount('right-panel-browser')
    expect(listenMock).not.toHaveBeenCalled()
    expect(lastState).toBeNull()
  })

  it('starts null before the first event', async () => {
    captureStateHandler()
    await mount('right-panel-browser')
    expect(lastState).toBeNull()
  })

  it('applies an event addressed to this id', async () => {
    const { fire } = captureStateHandler()
    await mount('right-panel-browser')
    fire(samplePayload('right-panel-browser', { title: 'Loaded' }))
    expect(lastState?.title).toBe('Loaded')
  })

  it('ignores an event addressed to a different surface id', async () => {
    const { fire } = captureStateHandler()
    await mount('right-panel-browser')
    fire(samplePayload('some-grid-leaf', { title: 'Not mine' }))
    expect(lastState).toBeNull()
  })

  it('hands back a fresh object on every event, even with unchanged fields', async () => {
    const { fire } = captureStateHandler()
    await mount('right-panel-browser')
    fire(samplePayload('right-panel-browser', { mountFailed: true }))
    const first = lastState
    fire(samplePayload('right-panel-browser', { mountFailed: true }))
    const second = lastState
    expect(first).not.toBe(second)
    expect(second?.mountFailed).toBe(true)
  })

  it('unsubscribes on unmount', async () => {
    const { dispose } = captureStateHandler()
    await mount('right-panel-browser')
    act(() => root.unmount())
    root = createRoot(container)
    expect(dispose).toHaveBeenCalledTimes(1)
  })
})

describe('useBrowserOpenUrl', () => {
  function captureOpenUrlHandler(): {
    fire: (payload: unknown) => void
    dispose: ReturnType<typeof vi.fn>
  } {
    const dispose = vi.fn()
    let handler: ((e: { payload: unknown }) => void) | null = null
    listenMock.mockImplementation((name: string, h: (e: { payload: unknown }) => void) => {
      expect(name).toBe('browser://open-url')
      handler = h
      return Promise.resolve(dispose)
    })
    return {
      fire: (payload) => {
        if (!handler) throw new Error('listen() was never called')
        act(() => (handler as (e: { payload: unknown }) => void)({ payload }))
      },
      dispose
    }
  }

  let opened: string[] = []

  function OpenUrlProbe({ id }: { id: string }): null {
    useBrowserOpenUrl(id, (url) => {
      opened.push(url)
    })
    return null
  }

  async function mountProbe(id: string): Promise<void> {
    opened = []
    act(() => {
      root.render(<OpenUrlProbe id={id} />)
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  it('subscribes to nothing under Electron', async () => {
    isTauriMock.mockReturnValue(false)
    await mountProbe('right-panel-browser')
    expect(listenMock).not.toHaveBeenCalled()
  })

  it('delivers a popup addressed to this id', async () => {
    const { fire } = captureOpenUrlHandler()
    await mountProbe('right-panel-browser')
    fire({ id: 'right-panel-browser', url: 'https://popup.test/one' })
    expect(opened).toEqual(['https://popup.test/one'])
  })

  it('ignores a popup addressed to a different surface id', async () => {
    const { fire } = captureOpenUrlHandler()
    await mountProbe('right-panel-browser')
    fire({ id: 'some-grid-leaf', url: 'https://popup.test/two' })
    expect(opened).toEqual([])
  })

  it('unsubscribes on unmount', async () => {
    const { dispose } = captureOpenUrlHandler()
    await mountProbe('right-panel-browser')
    act(() => root.unmount())
    root = createRoot(container)
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('does not re-subscribe when only the callback identity changes', async () => {
    captureOpenUrlHandler()
    await mountProbe('right-panel-browser')
    act(() => {
      root.render(<OpenUrlProbe id="right-panel-browser" />)
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(listenMock).toHaveBeenCalledTimes(1)
  })
})
