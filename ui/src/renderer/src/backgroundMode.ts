import { useSyncExternalStore } from 'react'

export type BackgroundMode = 'solid' | 'custom'
export type BackgroundOverrideReason = 'reduced-transparency' | 'contrast'

export type BackgroundState = {
  mode: BackgroundMode
  preset: string
  pixelSize: number
  colorSteps: number
  originalColors: boolean
  fieldOpacity: number
  chromeScrim: number
  paneScrim: number
  ceiling: number
  fadeStop: number
  imageVersion: number
}

const MODE_KEY = 'tr-background-mode'
const PRESET_KEY = 'tr-background-preset'
const PIXEL_KEY = 'tr-background-pixel-size'
const COLOR_STEPS_KEY = 'tr-background-color-steps'
const ORIGINAL_COLORS_KEY = 'tr-background-original-colors'
const FIELD_OPACITY_KEY = 'tr-background-field-opacity'
const CHROME_SCRIM_KEY = 'tr-background-chrome-scrim'
const PANE_SCRIM_KEY = 'tr-background-pane-scrim'
const CEILING_KEY = 'tr-background-ceiling'
const RETIRED_KEYS = ['tr-background-corner-mode', 'tr-background-corner-radius'] as const
const FADE_STOP_KEY = 'tr-background-fade-stop'

const GLASS_MODE_KEY = 'tr-glass-mode'

const DEFAULTS: BackgroundState = {
  mode: 'solid',
  preset: 'graphite',
  pixelSize: 2,
  colorSteps: 4,
  originalColors: true,
  fieldOpacity: 100,
  chromeScrim: 72,
  paneScrim: 35,
  ceiling: 35,
  fadeStop: 100,
  imageVersion: 0
}

function loadBounded(key: string, def: number, min: number, max: number): number {
  try {
    const n = Number(localStorage.getItem(key))
    return Number.isFinite(n) && n >= min && n <= max ? Math.trunc(n) : def
  } catch {
    return def
  }
}

function save(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(value))
  } catch {
  }
}

function loadMode(): BackgroundMode {
  try {
    const raw = localStorage.getItem(MODE_KEY)
    return raw === 'solid' || raw === 'custom' ? raw : DEFAULTS.mode
  } catch {
    return DEFAULTS.mode
  }
}

function loadPreset(): string {
  try {
    const raw = localStorage.getItem(PRESET_KEY)
    return raw ? raw : DEFAULTS.preset
  } catch {
    return DEFAULTS.preset
  }
}

function loadOriginalColors(): boolean {
  try {
    const raw = localStorage.getItem(ORIGINAL_COLORS_KEY)
    return raw === null ? DEFAULTS.originalColors : raw === '1'
  } catch {
    return DEFAULTS.originalColors
  }
}

function migrate(): void {
  try {
    if (localStorage.getItem(MODE_KEY) === null && localStorage.getItem(GLASS_MODE_KEY) === 'glass') {
      localStorage.setItem(MODE_KEY, 'custom')
    }
    for (const key of RETIRED_KEYS) localStorage.removeItem(key)
  } catch {
  }
}

function load(): BackgroundState {
  migrate()
  return {
    mode: loadMode(),
    preset: loadPreset(),
    pixelSize: loadBounded(PIXEL_KEY, DEFAULTS.pixelSize, 1, 4),
    colorSteps: loadBounded(COLOR_STEPS_KEY, DEFAULTS.colorSteps, 2, 8),
    originalColors: loadOriginalColors(),
    fieldOpacity: loadBounded(FIELD_OPACITY_KEY, DEFAULTS.fieldOpacity, 20, 100),
    chromeScrim: loadBounded(CHROME_SCRIM_KEY, DEFAULTS.chromeScrim, 60, 100),
    paneScrim: loadBounded(PANE_SCRIM_KEY, DEFAULTS.paneScrim, 5, 100),
    ceiling: loadBounded(CEILING_KEY, DEFAULTS.ceiling, 20, 44),
    fadeStop: loadBounded(FADE_STOP_KEY, DEFAULTS.fadeStop, 50, 100),
    imageVersion: 0
  }
}

let state: BackgroundState = typeof localStorage !== 'undefined' ? load() : DEFAULTS
const listeners = new Set<() => void>()

const REDUCED_TRANSPARENCY_QUERY = '(prefers-reduced-transparency: reduce)'
const MORE_CONTRAST_QUERY = '(prefers-contrast: more)'

export const BACKGROUND_OVERRIDE_MESSAGE: Record<BackgroundOverrideReason, string> = {
  'reduced-transparency': 'The system is set to reduce transparency. Custom returns when that changes.',
  contrast: 'The system is set to increase contrast. Custom returns when that changes.'
}

function mediaMatches(query: string): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  try {
    return window.matchMedia(query).matches
  } catch {
    return false
  }
}

export function backgroundOverrideReason(): BackgroundOverrideReason | null {
  if (mediaMatches(REDUCED_TRANSPARENCY_QUERY)) return 'reduced-transparency'
  if (mediaMatches(MORE_CONTRAST_QUERY)) return 'contrast'
  return null
}

function mask(s: BackgroundState): BackgroundState {
  return backgroundOverrideReason() ? { ...s, mode: 'solid' } : s
}

let effectiveCache: BackgroundState = mask(state)

applyCssVars(state)

function emit(): void {
  effectiveCache = mask(state)
  for (const l of listeners) l()
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange)
  return () => {
    listeners.delete(onChange)
  }
}

function subscribeToOverride(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {}
  const cleanups = [REDUCED_TRANSPARENCY_QUERY, MORE_CONTRAST_QUERY].map((query) => {
    const mql = window.matchMedia(query)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  })
  return () => {
    for (const cleanup of cleanups) cleanup()
  }
}

export function backgroundState(): BackgroundState {
  return effectiveCache
}

export function storedBackgroundMode(): BackgroundMode {
  return state.mode
}

export function useBackgroundState(): BackgroundState {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange)
      const unsubscribeOverride = subscribeToOverride(() => {
        effectiveCache = mask(state)
        onChange()
      })
      return () => {
        listeners.delete(onChange)
        unsubscribeOverride()
      }
    },
    () => effectiveCache,
    () => DEFAULTS
  )
}

export function useStoredBackgroundMode(): BackgroundMode {
  return useSyncExternalStore(subscribe, () => state.mode, () => DEFAULTS.mode)
}

export function useBackgroundOverrideReason(): BackgroundOverrideReason | null {
  return useSyncExternalStore(subscribeToOverride, backgroundOverrideReason, () => null)
}

function applyCssVars(s: BackgroundState): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.style.setProperty('--custom-chrome-alpha', String(s.chromeScrim / 100))
  root.style.setProperty('--custom-pane-alpha', String(s.paneScrim / 100))
}

function setState(patch: Partial<BackgroundState>): void {
  state = { ...state, ...patch }
  applyCssVars(state)
  emit()
}

export function setMode(next: BackgroundMode): void {
  if (next === state.mode) return
  try {
    localStorage.setItem(MODE_KEY, next)
  } catch {
  }
  setState({ mode: next })
}

export function setPreset(next: string): void {
  if (next === state.preset) return
  try {
    localStorage.setItem(PRESET_KEY, next)
  } catch {
  }
  setState({ preset: next })
}

export function setPixelSize(next: number): void {
  if (next === state.pixelSize) return
  save(PIXEL_KEY, next)
  setState({ pixelSize: next })
}

export function setColorSteps(next: number): void {
  if (next === state.colorSteps) return
  save(COLOR_STEPS_KEY, next)
  setState({ colorSteps: next })
}

export function setOriginalColors(next: boolean): void {
  if (next === state.originalColors) return
  try {
    localStorage.setItem(ORIGINAL_COLORS_KEY, next ? '1' : '0')
  } catch {
  }
  setState({ originalColors: next })
}

export function setFieldOpacity(next: number): void {
  if (next === state.fieldOpacity) return
  save(FIELD_OPACITY_KEY, next)
  setState({ fieldOpacity: next })
}

export function setChromeScrim(next: number): void {
  if (next === state.chromeScrim) return
  save(CHROME_SCRIM_KEY, next)
  setState({ chromeScrim: next })
}

export function setPaneScrim(next: number): void {
  if (next === state.paneScrim) return
  save(PANE_SCRIM_KEY, next)
  setState({ paneScrim: next })
}

export function setCeiling(next: number): void {
  if (next === state.ceiling) return
  save(CEILING_KEY, next)
  setState({ ceiling: next })
}

export function bumpImageVersion(): void {
  setState({ imageVersion: state.imageVersion + 1 })
}

export function setFadeStop(next: number): void {
  if (next === state.fadeStop) return
  save(FADE_STOP_KEY, next)
  setState({ fadeStop: next })
}

export function setBackgroundStateForTests(next: Partial<BackgroundState>): void {
  state = { ...(typeof localStorage !== 'undefined' ? load() : DEFAULTS), ...next }
  applyCssVars(state)
  emit()
}
