// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BACKGROUND_OVERRIDE_MESSAGE,
  backgroundState,
  setBackgroundStateForTests,
  setCeiling,
  setChromeScrim,
  setMode,
  setPaneScrim,
  setPreset,
  storedBackgroundMode,
  useBackgroundOverrideReason,
  useBackgroundState,
  useStoredBackgroundMode
} from './backgroundMode'

const REDUCED_TRANSPARENCY = '(prefers-reduced-transparency: reduce)'
const MORE_CONTRAST = '(prefers-contrast: more)'

const DEFAULTS = {
  mode: 'solid',
  preset: 'violet',
  pixelSize: 2,
  colorSteps: 4,
  originalColors: true,
  fieldOpacity: 100,
  chromeScrim: 72,
  paneScrim: 35,
  ceiling: 35,
  fadeStop: 100
} as const

type FakeMql = { matches: boolean; listeners: Set<(e: { matches: boolean }) => void> }

function fakeMatchMedia(initial: Record<string, boolean> = {}): {
  fire: (query: string, matches: boolean) => void
} {
  const mqls = new Map<string, FakeMql>()
  const get = (query: string): FakeMql => {
    let mql = mqls.get(query)
    if (!mql) {
      mql = { matches: initial[query] ?? false, listeners: new Set() }
      mqls.set(query, mql)
    }
    return mql
  }
  window.matchMedia = vi.fn((query: string) => {
    const state = get(query)
    return {
      get matches() {
        return state.matches
      },
      addEventListener: (_: string, cb: (e: { matches: boolean }) => void) => {
        state.listeners.add(cb)
      },
      removeEventListener: (_: string, cb: (e: { matches: boolean }) => void) => {
        state.listeners.delete(cb)
      }
    }
  }) as unknown as typeof window.matchMedia
  return {
    fire: (query: string, matches: boolean) => {
      const state = get(query)
      state.matches = matches
      for (const cb of [...state.listeners]) cb({ matches })
    }
  }
}

const savedMatchMedia = window.matchMedia

beforeEach(() => {
  localStorage.clear()
  setBackgroundStateForTests(DEFAULTS)
})

afterEach(() => {
  window.matchMedia = savedMatchMedia
})

describe('the glass -> custom migration', () => {
  it('remaps a stored glass preference to custom on first read', () => {
    localStorage.setItem('tr-glass-mode', 'glass')
    setBackgroundStateForTests({ mode: 'custom' })
    expect(backgroundState().mode).toBe('custom')
    expect(storedBackgroundMode()).toBe('custom')
  })

  it('does not fire when tr-background-mode is already set', () => {
    localStorage.setItem('tr-background-mode', 'solid')
    localStorage.setItem('tr-glass-mode', 'glass')
    setBackgroundStateForTests({ mode: 'solid' })
    expect(backgroundState().mode).toBe('solid')
    expect(storedBackgroundMode()).toBe('solid')
  })

  it('is idempotent: running it twice changes nothing', () => {
    localStorage.setItem('tr-glass-mode', 'glass')
    setBackgroundStateForTests({ mode: 'custom' })
    const afterFirst = { ...backgroundState() }
    setBackgroundStateForTests({ mode: 'custom' })
    expect(backgroundState()).toEqual(afterFirst)
    expect(localStorage.getItem('tr-background-mode')).toBe('custom')
    expect(localStorage.getItem('tr-glass-mode')).toBe('glass')
  })

  it('leaves the retired tr-glass-mode key untouched', () => {
    localStorage.setItem('tr-glass-mode', 'glass')
    setBackgroundStateForTests({ mode: 'custom' })
    expect(localStorage.getItem('tr-glass-mode')).toBe('glass')
  })
})

describe('bounded loaders fall back, never clamp', () => {
  it('pixelSize out of range falls back to the exact default 2', () => {
    localStorage.setItem('tr-background-pixel-size', '99')
    setBackgroundStateForTests({ mode: 'solid' })
    expect(backgroundState().pixelSize).toBe(2)
  })

  it('pixelSize below the floor falls back to the exact default 2', () => {
    localStorage.setItem('tr-background-pixel-size', '-3')
    setBackgroundStateForTests({ mode: 'solid' })
    expect(backgroundState().pixelSize).toBe(2)
  })

  it('ceiling out of range falls back to the exact default 35', () => {
    localStorage.setItem('tr-background-ceiling', '101')
    setBackgroundStateForTests({ mode: 'solid' })
    expect(backgroundState().ceiling).toBe(35)
  })

  it('an unparseable value falls back to the exact default', () => {
    localStorage.setItem('tr-background-fade-stop', 'not-a-number')
    setBackgroundStateForTests({ mode: 'solid' })
    expect(backgroundState().fadeStop).toBe(100)
  })
})

describe('the OS override masks the mode without touching the stored preference', () => {
  it('stored custom + reduced-transparency on -> effective solid, stored preference unchanged', () => {
    fakeMatchMedia({ [REDUCED_TRANSPARENCY]: true })
    setMode('custom')
    const effective = renderHook(() => useBackgroundState())
    const stored = renderHook(() => useStoredBackgroundMode())
    expect(effective.result.current.mode).toBe('solid')
    expect(stored.result.current).toBe('custom')
    expect(localStorage.getItem('tr-background-mode')).toBe('custom')
  })

  it('stored custom + contrast:more on -> effective solid, stored preference unchanged', () => {
    fakeMatchMedia({ [MORE_CONTRAST]: true })
    setMode('custom')
    const effective = renderHook(() => useBackgroundState())
    expect(effective.result.current.mode).toBe('solid')
    expect(useStoredBackgroundModeSnapshot()).toBe('custom')
  })

  it('stored custom + both off -> effective custom', () => {
    fakeMatchMedia({ [REDUCED_TRANSPARENCY]: false, [MORE_CONTRAST]: false })
    setMode('custom')
    const effective = renderHook(() => useBackgroundState())
    expect(effective.result.current.mode).toBe('custom')
  })

  it('the switch turning OFF mid-session restores custom without a reload', () => {
    const media = fakeMatchMedia({ [REDUCED_TRANSPARENCY]: true })
    setMode('custom')
    const effective = renderHook(() => useBackgroundState())
    expect(effective.result.current.mode).toBe('solid')

    act(() => {
      media.fire(REDUCED_TRANSPARENCY, false)
    })
    expect(effective.result.current.mode).toBe('custom')
    expect(localStorage.getItem('tr-background-mode')).toBe('custom')
  })

  it('the switch turning ON mid-session forces solid without touching storage', () => {
    const media = fakeMatchMedia({ [REDUCED_TRANSPARENCY]: false })
    setMode('custom')
    const effective = renderHook(() => useBackgroundState())
    expect(effective.result.current.mode).toBe('custom')

    act(() => {
      media.fire(REDUCED_TRANSPARENCY, true)
    })
    expect(effective.result.current.mode).toBe('solid')
    expect(localStorage.getItem('tr-background-mode')).toBe('custom')
  })
})

describe('backgroundOverrideReason names the cause for the Settings picker', () => {
  it('exposes a message for each reason', () => {
    expect(BACKGROUND_OVERRIDE_MESSAGE['reduced-transparency']).toMatch(/reduce transparency/i)
    expect(BACKGROUND_OVERRIDE_MESSAGE.contrast).toMatch(/contrast/i)
  })

  it('is reactive to the same mid-session change as useBackgroundState', () => {
    const media = fakeMatchMedia({ [MORE_CONTRAST]: true })
    const reason = renderHook(() => useBackgroundOverrideReason())
    expect(reason.result.current).toBe('contrast')

    act(() => {
      media.fire(MORE_CONTRAST, false)
    })
    expect(reason.result.current).toBeNull()
  })
})

describe('unreadable localStorage yields defaults', () => {
  it('a throwing getItem yields defaults rather than throwing', () => {
    const original = Storage.prototype.getItem
    Storage.prototype.getItem = vi.fn(() => {
      throw new Error('storage denied')
    })
    try {
      setBackgroundStateForTests(DEFAULTS)
      expect(() => backgroundState()).not.toThrow()
      expect(backgroundState().mode).toBe('solid')
      expect(backgroundState().preset).toBe('violet')
      expect(backgroundState().pixelSize).toBe(2)
      expect(backgroundState().fadeStop).toBe(100)
    } finally {
      Storage.prototype.getItem = original
    }
  })
})

describe('setters persist and mutate state', () => {
  it('setPreset persists the chosen preset', () => {
    setPreset('sunset')
    expect(localStorage.getItem('tr-background-preset')).toBe('sunset')
    expect(storedBackgroundMode()).toBe('solid')
  })

  it('setCeiling persists an in-range value', () => {
    setCeiling(60)
    expect(localStorage.getItem('tr-background-ceiling')).toBe('60')
    expect(backgroundState().ceiling).toBe(60)
  })
})

describe('the store projects the dials CSS owns', () => {
  const root = (): HTMLElement => document.documentElement

  it('writes both coat alphas as unitless numbers', () => {
    setChromeScrim(83)
    setPaneScrim(41)
    expect(root().style.getPropertyValue('--custom-chrome-alpha')).toBe('0.83')
    expect(root().style.getPropertyValue('--custom-pane-alpha')).toBe('0.41')
  })

  it('the retired corner keys are swept, so a stored "Square" cannot linger', () => {
    localStorage.setItem('tr-background-corner-mode', 'off')
    localStorage.setItem('tr-background-corner-radius', '2')
    setBackgroundStateForTests({ mode: 'solid' })
    expect(localStorage.getItem('tr-background-corner-mode')).toBeNull()
    expect(localStorage.getItem('tr-background-corner-radius')).toBeNull()
    expect(root().dataset.corner).toBeUndefined()
  })

  it('projects at load, not only on change', () => {
    root().style.removeProperty('--custom-chrome-alpha')
    setBackgroundStateForTests({ ...DEFAULTS, chromeScrim: 65 })
    expect(root().style.getPropertyValue('--custom-chrome-alpha')).toBe('0.65')
  })
})

function useStoredBackgroundModeSnapshot(): string {
  return renderHook(() => useStoredBackgroundMode()).result.current
}
