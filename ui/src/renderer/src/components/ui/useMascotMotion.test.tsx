// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useMascotMotion } from './useMascotMotion'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('tracks focus and visibility when matchMedia is unavailable', () => {
  vi.stubGlobal('matchMedia', undefined)
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  const focused = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  const { result, rerender } = renderHook(({ background }) => useMascotMotion(background), {
    initialProps: { background: false }
  })
  expect(result.current).toEqual({ reduced: false, paused: false })
  focused.mockReturnValue(false)
  act(() => window.dispatchEvent(new Event('blur')))
  expect(result.current).toEqual({ reduced: false, paused: true })
  rerender({ background: true })
  expect(result.current).toEqual({ reduced: false, paused: false })
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
  act(() => document.dispatchEvent(new Event('visibilitychange')))
  expect(result.current).toEqual({ reduced: false, paused: true })
})

it('subscribes to reduced motion changes and removes the subscription on unmount', () => {
  const media = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }
  vi.stubGlobal('matchMedia', vi.fn(() => media))
  const { result, unmount } = renderHook(() => useMascotMotion())
  const update = media.addEventListener.mock.calls[0][1] as () => void
  media.matches = true
  act(update)
  expect(result.current.reduced).toBe(true)
  unmount()
  expect(media.removeEventListener).toHaveBeenCalledWith('change', update)
})
