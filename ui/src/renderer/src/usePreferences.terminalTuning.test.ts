// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  TERMINAL_CURSOR_BLINK_KEY,
  TERMINAL_LINE_HEIGHT_DEFAULT,
  TERMINAL_LINE_HEIGHT_KEY,
  TERMINAL_LINE_HEIGHT_MAX,
  TERMINAL_LINE_HEIGHT_MIN,
  TERMINAL_SCROLLBACK_DEFAULT,
  TERMINAL_SCROLLBACK_KEY,
  TERMINAL_SCROLLBACK_MAX,
  TERMINAL_SCROLLBACK_MIN,
  usePreferences
} from './usePreferences'

describe('usePreferences — terminal tuning (settings-11/-14/-15)', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('defaults to the shipped-behaviour values when nothing was ever stored', () => {
    const { result } = renderHook(() => usePreferences())
    expect(result.current.terminalLineHeight).toBe(TERMINAL_LINE_HEIGHT_DEFAULT)
    expect(result.current.terminalCursorBlink).toBe(true)
    expect(result.current.terminalScrollbackLines).toBe(TERMINAL_SCROLLBACK_DEFAULT)
  })

  it('persists a lineHeight change and reloads it clamped to the supported range', () => {
    const { result, unmount } = renderHook(() => usePreferences())
    act(() => result.current.setTerminalLineHeight(1.7))
    expect(localStorage.getItem(TERMINAL_LINE_HEIGHT_KEY)).toBe('1.7')
    unmount()

    const { result: reloaded } = renderHook(() => usePreferences())
    expect(reloaded.current.terminalLineHeight).toBe(1.7)
  })

  it('ignores a corrupt or out-of-range stored lineHeight, falling back to the default', () => {
    localStorage.setItem(TERMINAL_LINE_HEIGHT_KEY, 'not-a-number')
    const { result: corrupt } = renderHook(() => usePreferences())
    expect(corrupt.current.terminalLineHeight).toBe(TERMINAL_LINE_HEIGHT_DEFAULT)

    localStorage.setItem(TERMINAL_LINE_HEIGHT_KEY, String(TERMINAL_LINE_HEIGHT_MAX + 5))
    const { result: outOfRange } = renderHook(() => usePreferences())
    expect(outOfRange.current.terminalLineHeight).toBe(TERMINAL_LINE_HEIGHT_DEFAULT)
  })

  it('persists a cursorBlink toggle', () => {
    const { result, unmount } = renderHook(() => usePreferences())
    act(() => result.current.setTerminalCursorBlink(false))
    expect(localStorage.getItem(TERMINAL_CURSOR_BLINK_KEY)).toBe('0')
    unmount()

    const { result: reloaded } = renderHook(() => usePreferences())
    expect(reloaded.current.terminalCursorBlink).toBe(false)
  })

  it('persists a scrollback-lines change and reloads it clamped to the supported range', () => {
    const { result, unmount } = renderHook(() => usePreferences())
    act(() => result.current.setTerminalScrollbackLines(20_000))
    expect(localStorage.getItem(TERMINAL_SCROLLBACK_KEY)).toBe('20000')
    unmount()

    const { result: reloaded } = renderHook(() => usePreferences())
    expect(reloaded.current.terminalScrollbackLines).toBe(20_000)
  })

  it('ignores a corrupt or out-of-range stored scrollback value, falling back to the default', () => {
    localStorage.setItem(TERMINAL_SCROLLBACK_KEY, '-5')
    const { result: negative } = renderHook(() => usePreferences())
    expect(negative.current.terminalScrollbackLines).toBe(TERMINAL_SCROLLBACK_DEFAULT)

    localStorage.setItem(TERMINAL_SCROLLBACK_KEY, String(TERMINAL_SCROLLBACK_MAX + 1))
    const { result: tooBig } = renderHook(() => usePreferences())
    expect(tooBig.current.terminalScrollbackLines).toBe(TERMINAL_SCROLLBACK_DEFAULT)
  })

  it('exposes the bounds every numeric row shows as its own ceiling', () => {
    expect(TERMINAL_LINE_HEIGHT_MIN).toBeLessThan(TERMINAL_LINE_HEIGHT_MAX)
    expect(TERMINAL_SCROLLBACK_MIN).toBeLessThan(TERMINAL_SCROLLBACK_MAX)
  })
})
