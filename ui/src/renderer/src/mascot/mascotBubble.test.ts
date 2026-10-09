// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { placeMascotBubble } from './mascotBubble'
const originalWidth = window.innerWidth, originalHeight = window.innerHeight
function fixture(x: number, y: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 400 })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 300 })
  const host = document.createElement('div'); host.className = 'mascot-host'; host.dataset.floating = 'true'
  const button = document.createElement('button'), bubble = document.createElement('span')
  bubble.className = 'bubble'; button.appendChild(bubble); host.appendChild(button); document.body.appendChild(host)
  button.getBoundingClientRect = () => ({ x, y, left: x, top: y, right: x + 64, bottom: y + 64, width: 64, height: 64, toJSON: () => ({}) })
  Object.defineProperty(bubble, 'offsetWidth', { value: 200 }); Object.defineProperty(bubble, 'offsetHeight', { value: 40 })
  return { button, bubble, host }
}
afterEach(() => {
  document.body.replaceChildren()
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalHeight })
})
it('flips speech to the left at the right edge and keeps it below the window margin', () => {
  const { button, bubble } = fixture(330, 12)
  placeMascotBubble(button)
  expect(bubble.dataset.side).toBe('left')
  expect(bubble.style.left).toBe('-210px')
  expect(bubble.style.top).toBe('0px')
})
it('restores the original bubble placement when docked', () => {
  const { button, bubble, host } = fixture(330, 12)
  placeMascotBubble(button)
  host.dataset.floating = 'false'
  placeMascotBubble(button)
  expect(bubble.style.left).toBe(''); expect(bubble.style.top).toBe(''); expect(bubble.style.bottom).toBe('')
  expect(bubble.dataset.side).toBeUndefined()
})
