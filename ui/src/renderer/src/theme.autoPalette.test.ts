// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import {
  AUTO_TERMINAL_PALETTE,
  DEFAULT_TERMINAL_PALETTE_FOR_CHROME,
  STORAGE_KEY,
  loadTheme,
  resolveTerminalPalette,
  saveTerminalPaletteChoice
} from './theme'

const AUTO_MIGRATION_GUARD_KEY = 'tr-theme-auto-migrated'

beforeEach(() => {
  localStorage.clear()
})

describe('resolveTerminalPalette', () => {
  it("resolves 'auto' through DEFAULT_TERMINAL_PALETTE_FOR_CHROME, per chrome theme", () => {
    expect(resolveTerminalPalette(AUTO_TERMINAL_PALETTE, 'graphite')).toBe(
      DEFAULT_TERMINAL_PALETTE_FOR_CHROME.graphite
    )
    expect(resolveTerminalPalette(AUTO_TERMINAL_PALETTE, 'paper')).toBe(
      DEFAULT_TERMINAL_PALETTE_FOR_CHROME.paper
    )
    expect(resolveTerminalPalette(AUTO_TERMINAL_PALETTE, 'paper')).toBe(
      DEFAULT_TERMINAL_PALETTE_FOR_CHROME['paper']
    )
  })

  it('returns a concrete pick unchanged, regardless of chrome theme', () => {
    expect(resolveTerminalPalette('dracula', 'graphite')).toBe('dracula')
    expect(resolveTerminalPalette('dracula', 'paper')).toBe('dracula')
  })
})

describe('loadTheme default', () => {
  it("defaults to 'auto' when no palette was ever saved", () => {
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    expect(loadTheme()).toBe(AUTO_TERMINAL_PALETTE)
    expect(localStorage.getItem(AUTO_MIGRATION_GUARD_KEY)).toBeNull()
  })

  it("returns a saved concrete pick that is not the old default, untouched", () => {
    localStorage.setItem(STORAGE_KEY, 'dracula')
    expect(loadTheme()).toBe('dracula')
    expect(localStorage.getItem(AUTO_MIGRATION_GUARD_KEY)).toBeNull()
  })

  it("returns a saved 'auto' as-is", () => {
    localStorage.setItem(STORAGE_KEY, AUTO_TERMINAL_PALETTE)
    expect(loadTheme()).toBe(AUTO_TERMINAL_PALETTE)
  })
})

describe("the narrow 'warm-espresso' -> 'auto' migration", () => {
  it("flips a saved 'warm-espresso' (the old global default) to 'auto' once, and marks the guard", () => {
    localStorage.setItem(STORAGE_KEY, 'warm-espresso')
    expect(loadTheme()).toBe(AUTO_TERMINAL_PALETTE)
    expect(localStorage.getItem(STORAGE_KEY)).toBe(AUTO_TERMINAL_PALETTE)
    expect(localStorage.getItem(AUTO_MIGRATION_GUARD_KEY)).toBe('1')
  })

  it('never re-flips once the guard is set — a later deliberate warm-espresso pick sticks', () => {
    localStorage.setItem(AUTO_MIGRATION_GUARD_KEY, '1')
    saveTerminalPaletteChoice('warm-espresso')
    expect(loadTheme()).toBe('warm-espresso')
  })

  it('only the exact old-default value migrates — every other saved value is left alone', () => {
    for (const untouched of ['black', 'dracula', 'marble']) {
      localStorage.clear()
      localStorage.setItem(STORAGE_KEY, untouched)
      expect(loadTheme()).toBe(untouched)
      expect(localStorage.getItem(AUTO_MIGRATION_GUARD_KEY)).toBeNull()
    }
  })
})
