// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

const { setBadgeCount, setOverlayIcon } = vi.hoisted(() => ({
  setBadgeCount: vi.fn(async () => {}),
  setOverlayIcon: vi.fn(async () => {})
}))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ setBadgeCount, setOverlayIcon })
}))

import { setTaskbarAttentionCount } from './taskbarCount'

const userAgent = navigator.userAgent

afterEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: userAgent })
  delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
})

function setPlatform(value: string): void {
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value })
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} })
}

describe('taskbar attention count', () => {
  it('uses Linux badge counts and clears zero', async () => {
    setPlatform('Mozilla/5.0 (X11; Linux x86_64)')
    await setTaskbarAttentionCount(3)
    await setTaskbarAttentionCount(0)
    expect(setBadgeCount).toHaveBeenNthCalledWith(1, 3)
    expect(setBadgeCount).toHaveBeenNthCalledWith(2, undefined)
    expect(setOverlayIcon).not.toHaveBeenCalled()
  })

  it('clears the Windows overlay when the count reaches zero', async () => {
    setPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')
    await setTaskbarAttentionCount(0)
    expect(setOverlayIcon).toHaveBeenCalledWith(undefined)
    expect(setBadgeCount).not.toHaveBeenCalled()
  })

  it('uses a Windows overlay icon and caps its label at 9+', async () => {
    setPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')
    const fillText = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      clearRect: vi.fn(),
      beginPath: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      fillText,
      fillStyle: '',
      font: '',
      textAlign: 'center',
      textBaseline: 'middle'
    } as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,AQID')

    await setTaskbarAttentionCount(12)

    expect(fillText).toHaveBeenCalledWith('9+', 8, 8)
    expect(setOverlayIcon).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]))
    expect(setBadgeCount).not.toHaveBeenCalled()
  })
})
