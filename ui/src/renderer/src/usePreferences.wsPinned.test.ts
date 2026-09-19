// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { usePreferences } from './usePreferences'

const WS_PINNED_KEY = 'tr-ws-pinned'

describe('usePreferences — wsPinned', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('defaults to empty with nothing stored', () => {
    const { result } = renderHook(() => usePreferences())
    expect(result.current.wsPinned).toEqual([])
  })

  it('persists a pinned path to localStorage', () => {
    const { result } = renderHook(() => usePreferences())
    act(() => result.current.setWsPinned((prev) => [...prev, '/a']))
    expect(JSON.parse(localStorage.getItem(WS_PINNED_KEY) ?? '[]')).toEqual(['/a'])
  })

  it('loads a previously persisted set of pinned paths on mount', () => {
    localStorage.setItem(WS_PINNED_KEY, JSON.stringify(['/a', '/b']))
    const { result } = renderHook(() => usePreferences())
    expect(result.current.wsPinned).toEqual(['/a', '/b'])
  })

  it('unpinning removes the path rather than leaving a stale entry', () => {
    localStorage.setItem(WS_PINNED_KEY, JSON.stringify(['/a', '/b']))
    const { result } = renderHook(() => usePreferences())
    act(() => result.current.setWsPinned((prev) => prev.filter((p) => p !== '/a')))
    expect(result.current.wsPinned).toEqual(['/b'])
    expect(JSON.parse(localStorage.getItem(WS_PINNED_KEY) ?? '[]')).toEqual(['/b'])
  })

  it('falls back to empty on corrupt stored JSON', () => {
    localStorage.setItem(WS_PINNED_KEY, '{not json')
    const { result } = renderHook(() => usePreferences())
    expect(result.current.wsPinned).toEqual([])
  })
})
