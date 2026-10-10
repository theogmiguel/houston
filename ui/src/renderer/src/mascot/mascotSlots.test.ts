// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MASCOT_FLIGHT_MS, registerMascotSlot } from './mascotSlots'
import { DEFAULT_PREFS, setMascotPrefsForTests } from './mascotPrefs'

const originalAnimate = HTMLElement.prototype.animate
const cleanups: (() => void)[] = []
function slot(left: number, top: number, size: number): HTMLDivElement {
  const node = document.createElement('div')
  node.getBoundingClientRect = () => ({ left, top, width: size, height: size, right: left + size, bottom: top + size, x: left, y: top, toJSON: () => ({}) })
  document.body.appendChild(node)
  return node
}
function mount(node: HTMLDivElement, priority: number, reduced = false): () => void {
  const cleanup = registerMascotSlot(node, priority, reduced)
  cleanups.push(cleanup)
  return () => { cleanups.splice(cleanups.indexOf(cleanup), 1); cleanup(); node.remove() }
}
beforeEach(() => {
  vi.useFakeTimers()
  setMascotPrefsForTests({ ...DEFAULT_PREFS })
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, writable: true, value: vi.fn(() => ({ cancel: vi.fn(), onfinish: null })) })
})
afterEach(() => {
  setMascotPrefsForTests({ ...DEFAULT_PREFS, enabled: false })
  cleanups.splice(0).reverse().forEach(cleanup => cleanup())
  document.body.replaceChildren()
  if (originalAnimate) HTMLElement.prototype.animate = originalAnimate
  else Reflect.deleteProperty(HTMLElement.prototype, 'animate')
  vi.restoreAllMocks()
  vi.useRealTimers()
  setMascotPrefsForTests({ ...DEFAULT_PREFS })
})
it('moves one visible mascot to a surface and back even if WebKit never finishes the animation', () => {
  const rail = slot(10, 600, 64), surface = slot(300, 120, 112)
  mount(rail, 0)
  const unmount = mount(surface, 1)
  expect(rail.style.visibility).toBe('hidden')
  expect(surface.style.visibility).toBe('hidden')
  expect(document.querySelectorAll('.mascot-flight')).toHaveLength(1)
  vi.advanceTimersByTime(MASCOT_FLIGHT_MS)
  expect(surface.style.visibility).toBe('visible')
  expect(rail.style.visibility).toBe('hidden')
  expect(document.querySelector('.mascot-flight')).toBeNull()
  unmount()
  expect(rail.style.visibility).toBe('hidden')
  vi.advanceTimersByTime(MASCOT_FLIGHT_MS)
  expect(rail.style.visibility).toBe('visible')
})
it('switches slots instantly under reduced motion and arbitrates overlapping surfaces', () => {
  const rail = slot(10, 600, 64), about = slot(300, 120, 112), reconnect = slot(600, 10, 112)
  mount(rail, 0, true)
  mount(about, 1, true)
  const unmount = mount(reconnect, 1, true)
  expect(rail.style.visibility).toBe('hidden')
  expect(about.style.visibility).toBe('hidden')
  expect(reconnect.style.visibility).toBe('visible')
  expect(document.querySelector('.mascot-flight')).toBeNull()
  unmount()
  expect(about.style.visibility).toBe('visible')
})
it('shows a surface without flight when the rail is collapsed and removes a flight when disabled', () => {
  const surface = slot(300, 120, 112)
  const unmount = mount(surface, 1)
  expect(surface.style.visibility).toBe('visible')
  expect(HTMLElement.prototype.animate).not.toHaveBeenCalled()
  mount(slot(10, 600, 64), 0)
  unmount()
  expect(document.querySelector('.mascot-flight')).not.toBeNull()
  setMascotPrefsForTests({ ...DEFAULT_PREFS, enabled: false })
  cleanups.splice(0).forEach(cleanup => cleanup())
  expect(document.querySelector('.mascot-flight')).toBeNull()
})
