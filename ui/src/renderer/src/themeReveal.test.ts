// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { revealThemeFromClick, themeRevealRadius } from './themeReveal'

const origin = { left: 12, top: 20, width: 16, height: 12 }

describe('theme reveal', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    Reflect.deleteProperty(document, 'startViewTransition')
    Reflect.deleteProperty(document.documentElement, 'animate')
  })

  it('computes a radius that reaches the farthest viewport corner', () => {
    expect(themeRevealRadius(origin, { width: 100, height: 80 })).toBe(97)
  })

  it('uses one 400 ms Panel-eased WAAPI clip on the new View Transition snapshot', async () => {
    const update = vi.fn()
    const animate = vi.fn()
    Object.defineProperty(document.documentElement, 'animate', { configurable: true, value: animate })
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => 'cubic-bezier(.32, .72, 0, 1)' }))
    vi.stubGlobal('innerWidth', 100)
    vi.stubGlobal('innerHeight', 80)
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    const startViewTransition = vi.fn((callback: () => void) => {
      callback()
      return { ready: Promise.resolve() }
    })
    Object.defineProperty(document, 'startViewTransition', { configurable: true, value: startViewTransition })
    const control = document.createElement('button')
    vi.spyOn(control, 'getBoundingClientRect').mockReturnValue({ ...origin, right: 28, bottom: 32, x: 12, y: 20, toJSON: () => ({}) })

    revealThemeFromClick(control, update)
    await Promise.resolve()

    expect(startViewTransition).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledTimes(1)
    expect(animate).toHaveBeenCalledTimes(1)
    expect(animate.mock.calls[0][1]).toMatchObject({
      duration: 400,
      easing: 'cubic-bezier(.32, .72, 0, 1)',
      pseudoElement: '::view-transition-new(root)'
    })
  })

  it.each([
    ['reduced motion', true, true],
    ['missing View Transition support', false, false]
  ])('%s switches in one step', (_case, reduced, supported) => {
    const update = vi.fn()
    const startViewTransition = vi.fn(() => ({ ready: Promise.resolve() }))
    vi.stubGlobal('matchMedia', () => ({ matches: reduced }))
    if (supported) Object.defineProperty(document, 'startViewTransition', { configurable: true, value: startViewTransition })
    else Object.defineProperty(document, 'startViewTransition', { configurable: true, value: undefined })

    revealThemeFromClick(document.createElement('button'), update)

    expect(update).toHaveBeenCalledTimes(1)
    expect(startViewTransition).not.toHaveBeenCalled()
  })

  it('switches programmatic theme changes without animation', () => {
    const update = vi.fn()
    const startViewTransition = vi.fn()
    Object.defineProperty(document, 'startViewTransition', { configurable: true, value: startViewTransition })

    revealThemeFromClick(null, update)

    expect(update).toHaveBeenCalledTimes(1)
    expect(startViewTransition).not.toHaveBeenCalled()
  })

  it('switches in one step when matchMedia is unavailable', () => {
    const update = vi.fn()
    const startViewTransition = vi.fn()
    vi.stubGlobal('matchMedia', undefined)
    Object.defineProperty(document, 'startViewTransition', { configurable: true, value: undefined })

    revealThemeFromClick(document.createElement('button'), update)

    expect(update).toHaveBeenCalledTimes(1)
    expect(startViewTransition).not.toHaveBeenCalled()
  })
})
