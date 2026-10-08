// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SIDE_OPEN_EVENT } from './sidePanel'
import { useSidePanelState } from './useSidePanelState'
import type { SessionInfo } from './houston/client'

afterEach(() => {
  cleanup()
})

describe('useSidePanelState', () => {
  it('opens the side panel when a browser surface request arrives', () => {
    const setScmOpen = vi.fn()
    const { result } = renderHook(() =>
      useSidePanelState('/repo', null, new Map<number, SessionInfo>(), false, setScmOpen, vi.fn()),
    )
    act(() =>
      window.dispatchEvent(
        new CustomEvent(SIDE_OPEN_EVENT, {
          detail: { kind: 'browser', id: 'browser-1', url: 'http://localhost:5173', workspace: '/repo' },
        }),
      ),
    )
    expect(result.current.sideRequest).toMatchObject({ kind: 'browser', id: 'browser-1' })
    expect(setScmOpen).toHaveBeenCalledWith(true)
    expect(result.current.activeSurface).toBe('side')
  })
})
