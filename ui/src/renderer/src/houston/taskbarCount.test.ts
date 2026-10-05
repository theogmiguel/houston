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
})
