// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ZoomableImage } from './ZoomableImage'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const VIEWPORT = { width: 448, height: 348 }
const sizeProps = ['clientWidth', 'clientHeight'] as const

describe('ZoomableImage', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => VIEWPORT.width })
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => VIEWPORT.height })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    for (const prop of sizeProps) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop]
  })

  const viewport = (): HTMLElement => container.querySelector('[data-testid="image-zoom-viewport"]')!
  const level = (): string => container.querySelector('[data-testid="image-zoom-level"]')!.textContent ?? ''
  const button = (name: string): HTMLButtonElement => [...container.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? b.textContent ?? '').startsWith(name))!

  function mount(natural = { width: 1600, height: 1000 }): void {
    act(() => root.render(<ZoomableImage src="blob:test" alt="shot.png" onError={() => {}} />))
    const img = container.querySelector('img')!
    Object.defineProperty(img, 'naturalWidth', { value: natural.width })
    Object.defineProperty(img, 'naturalHeight', { value: natural.height })
    act(() => img.dispatchEvent(new Event('load')))
  }

  function key(target: Element, init: KeyboardEventInit): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
    act(() => target.dispatchEvent(event))
    return event
  }

  it('fits a large image and disables the controls that would leave fit', () => {
    mount()
    expect(level()).toBe('25%')
    expect(button('Zoom out').disabled).toBe(true)
    expect(button('Fit').disabled).toBe(true)
    expect(button('Zoom in').disabled).toBe(false)
  })

  it('zooms with + - 0 and 1 while the image has focus', () => {
    mount()
    expect(key(viewport(), { key: '1' }).defaultPrevented).toBe(true)
    expect(level()).toBe('100%')
    key(viewport(), { key: '+' })
    expect(level()).toBe('119%')
    key(viewport(), { key: '-' })
    expect(level()).toBe('100%')
    key(viewport(), { key: '0' })
    expect(level()).toBe('25%')
    key(viewport(), { key: '-' })
    expect(level()).toBe('25%')
  })

  it('leaves modified keys and keys aimed elsewhere alone', () => {
    mount()
    expect(key(viewport(), { key: '1', ctrlKey: true }).defaultPrevented).toBe(false)
    expect(key(button('Fit'), { key: '1' }).defaultPrevented).toBe(false)
    expect(key(document.body, { key: '+' }).defaultPrevented).toBe(false)
    expect(level()).toBe('25%')
  })

  it('toggles between fit and 100% on double-click', () => {
    mount()
    act(() => viewport().dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 100, clientY: 80 })))
    expect(level()).toBe('100%')
    expect(button('Fit').disabled).toBe(false)
    act(() => viewport().dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 100, clientY: 80 })))
    expect(level()).toBe('25%')
  })

  it('zooms in on a wheel and stops at 800%', () => {
    mount()
    const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -200, clientX: 50, clientY: 50 })
    act(() => viewport().dispatchEvent(wheel))
    expect(wheel.defaultPrevented).toBe(true)
    expect(Number.parseInt(level())).toBeGreaterThan(25)
    act(() => viewport().dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100000 })))
    expect(level()).toBe('800%')
    expect(button('Zoom in').disabled).toBe(true)
  })

  it('returns to fit from the Fit button', () => {
    mount()
    act(() => button('Zoom in').click())
    expect(level()).toBe('30%')
    act(() => button('Fit').click())
    expect(level()).toBe('25%')
    expect(button('Fit').disabled).toBe(true)
  })

  it('offers 200% on double-click when a small image already shows at full size', () => {
    mount({ width: 64, height: 32 })
    expect(level()).toBe('100%')
    act(() => viewport().dispatchEvent(new MouseEvent('dblclick', { bubbles: true })))
    expect(level()).toBe('200%')
  })
})
