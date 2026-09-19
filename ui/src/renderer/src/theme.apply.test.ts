// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyChromeTheme, applyTheme, CHROME_STORAGE_KEY, loadChromeTheme } from './theme'

describe('applyTheme without the Electron preload bridge (Tauri)', () => {
  it('applyTheme neither throws nor drops the failure when window.houston is undefined', async () => {
    const saved = (window as { houston?: unknown }).houston
    delete (window as { houston?: unknown }).houston
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(() => applyTheme('warm-espresso')).not.toThrow()
      await Promise.resolve()
      await Promise.resolve()
      expect(warn).toHaveBeenCalledWith(
        'houston: setBackgroundColor failed',
        expect.objectContaining({ message: expect.stringContaining('setBackgroundColor') })
      )
    } finally {
      warn.mockRestore()
      if (saved !== undefined) (window as { houston?: unknown }).houston = saved
    }
  })
})

describe('applyChromeTheme / loadChromeTheme', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
  })

  it('applyChromeTheme paints and persists a concrete theme', () => {
    applyChromeTheme('paper')
    expect(document.documentElement.getAttribute('data-theme')).toBe('paper')
    expect(localStorage.getItem(CHROME_STORAGE_KEY)).toBe('paper')
  })

  it('loadChromeTheme reports the concrete stored pick unchanged', () => {
    localStorage.setItem(CHROME_STORAGE_KEY, 'paper')
    const { theme } = loadChromeTheme()
    expect(theme).toBe('paper')
  })
})

describe('a retired chrome theme in storage', () => {
  beforeEach(() => localStorage.clear())

  it("remaps a stored 'warm-espresso' pick to Graphite rather than falling through to the default", () => {
    localStorage.setItem(CHROME_STORAGE_KEY, 'warm-espresso')
    const loaded = loadChromeTheme()
    expect(loaded.theme).toBe('graphite')
    expect(loaded.migratedFrom).toBeNull()
  })

  it('leaves the terminal palette of the same name alone — separate axis', () => {
    localStorage.setItem(CHROME_STORAGE_KEY, 'warm-espresso')
    loadChromeTheme()
    expect(() => applyTheme('warm-espresso')).not.toThrow()
  })

  it("remaps a stored 'system' pick (the retired Match-system sentinel) to Graphite, never Paper", () => {
    localStorage.setItem(CHROME_STORAGE_KEY, 'system')
    const loaded = loadChromeTheme()
    expect(loaded.theme).toBe('graphite')
    expect(loaded.migratedFrom).toBeNull()
  })
})
