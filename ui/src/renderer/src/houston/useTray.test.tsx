// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const handlers = vi.hoisted(() => new Map<string, (payload: unknown) => void>())
const nativeStop = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('./tray', async (importOriginal) => ({
  ...await importOriginal<typeof import('./tray')>(),
  appStopDaemonsAndQuit: nativeStop,
  syncTray: vi.fn(async () => {}),
  onTrayEvent: vi.fn(async (event: string, handler: (payload: unknown) => void) => {
    handlers.set(event, handler)
    return () => handlers.delete(event)
  })
}))
import { stopDaemonThenQuit, useTrayBridge } from './useTray'
import { TRAY_EVENT_FOCUS_PANE } from './tray'

afterEach(() => {
  handlers.clear()
  nativeStop.mockClear()
})

describe('useTray', () => {
  it('hands confirmed shutdown to the native host without waiting for a renderer fetch', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected renderer fetch'))
    stopDaemonThenQuit()
    await waitFor(() => expect(nativeStop).toHaveBeenCalledTimes(1))
    expect(fetch).not.toHaveBeenCalled()
    fetch.mockRestore()
  })

  it('keeps pane focus events and needs no renderer shutdown subscription', async () => {
    const focus = vi.fn()
    const { unmount } = renderHook(() => useTrayBridge({
      connection: 'ready', sessions: new Map(), workspaces: [], onFocusPane: focus
    }))
    await waitFor(() => expect(handlers.has(TRAY_EVENT_FOCUS_PANE)).toBe(true))
    handlers.get(TRAY_EVENT_FOCUS_PANE)!(42)
    expect(focus).toHaveBeenCalledWith(42)
    expect(handlers.has('tray://stop-daemon')).toBe(false)
    unmount()
    expect(handlers.size).toBe(0)
  })
})
