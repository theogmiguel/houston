// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { usePreferences } from './usePreferences'
import { CHROME_STORAGE_KEY } from './theme'

describe('usePreferences — chrome theme', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('defaults chromeTheme to graphite on a fresh install', () => {
    const { result } = renderHook(() => usePreferences())
    expect(result.current.chromeTheme).toBe('graphite')
  })

  it('setChromeTheme persists the concrete pick', () => {
    const { result } = renderHook(() => usePreferences())
    act(() => result.current.setChromeTheme('paper'))
    expect(result.current.chromeTheme).toBe('paper')
    expect(localStorage.getItem(CHROME_STORAGE_KEY)).toBe('paper')
  })

  it('a retired "system" pick in storage resolves to graphite, never paper', () => {
    localStorage.setItem(CHROME_STORAGE_KEY, 'system')
    const { result } = renderHook(() => usePreferences())
    expect(result.current.chromeTheme).toBe('graphite')
  })
})
