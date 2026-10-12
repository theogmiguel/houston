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

it('selects the requested browser workspace even when another workspace is selected', () => {
  const selectWorkspace = vi.fn(), setOpen = vi.fn()
  renderHook(() => useSidePanelState('/first', null, new Map(), false, setOpen, selectWorkspace))
  act(() => window.dispatchEvent(new CustomEvent(SIDE_OPEN_EVENT, {detail:{kind:'browser',id:'target',url:'',workspace:'/other',action:'reveal'}})))
  expect(selectWorkspace).toHaveBeenCalledWith('/other')
  expect(setOpen).toHaveBeenCalledWith(true)
})
it('does not reveal the panel or switch workspace for a remote close request', () => {
  const selectWorkspace = vi.fn(), setOpen = vi.fn()
  renderHook(() => useSidePanelState('/first', null, new Map(), false, setOpen, selectWorkspace))
  act(() => window.dispatchEvent(new CustomEvent(SIDE_OPEN_EVENT, {detail:{kind:'browser',id:'target',url:'',workspace:'/other',action:'close'}})))
  expect(selectWorkspace).not.toHaveBeenCalled()
  expect(setOpen).not.toHaveBeenCalled()
})
