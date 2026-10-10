// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MascotAppRoot } from './MascotAppRoot'
import { MascotMount } from './MascotMount'
import { DEFAULT_PREFS, setMascotPrefsForTests } from './mascotPrefs'
import { RAIL_POSITION, getMascotPosition, setMascotDragging, setMascotPosition } from './mascotPosition'
import { emptyLedger, persistLedger } from './mascotDirector'
import { __resetBrowserSurfaceRegistryForTests, registerBrowserSurface } from '../houston/browserSurfaceRegistry'
import { setSuppressionSink } from '../layout/nativeSuppression'

vi.mock('../components/ui/MascotRig', () => ({ MascotRig: () => <span data-testid="rig" />, MascotPixel: () => <span />, MascotParticles: () => null }))
const originalWidth = window.innerWidth, originalHeight = window.innerHeight
function windowSize(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height })
}
beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  windowSize(1000, 700)
  setMascotPrefsForTests({ ...DEFAULT_PREFS })
  setMascotPosition(RAIL_POSITION)
  persistLedger({ ...emptyLedger(Date.now()), introSeen: true })
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => window.setTimeout(() => fn(performance.now()), 16))
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id))
})
afterEach(() => {
  cleanup()
  setMascotPosition(RAIL_POSITION); setMascotDragging(false)
  __resetBrowserSurfaceRegistryForTests(); setSuppressionSink(null)
  vi.useRealTimers(); vi.unstubAllGlobals()
  windowSize(originalWidth, originalHeight)
})
const tree = (rail: boolean): React.JSX.Element => <MascotAppRoot>{rail && <aside><MascotMount existingUser={false} /></aside>}</MascotAppRoot>
it('keeps the same companion element and director mount when the rail collapses while floating', async () => {
  const view = render(tree(true))
  await act(async () => { await import('./MascotFloatingHost') })
  const companion = screen.getByTestId('mascot-companion')
  act(() => setMascotPosition({ kind: 'floating', x: .4, y: .3 }))
  const host = document.querySelector<HTMLElement>('.mascot-host')!
  expect(host.style.transform).toBe('translate(400px, 210px)')
  view.rerender(tree(false))
  expect(screen.getByTestId('mascot-companion')).toBe(companion)
  expect(document.querySelector('.mascot-dock')).toBeNull()
  expect(host.dataset.floating).toBe('true')
})
it('reclamps floating coordinates on window resize before saving their normalized position', async () => {
  setMascotPosition({ kind: 'floating', x: .95, y: .95 })
  render(tree(false))
  await act(async () => { await import('./MascotFloatingHost') })
  act(() => {
    windowSize(300, 200)
    window.dispatchEvent(new Event('resize'))
    vi.advanceTimersByTime(16)
  })
  const host = document.querySelector<HTMLElement>('.mascot-host')!
  const position = getMascotPosition()
  expect(host.style.transform).toBe('translate(224px, 124px)')
  expect(position.kind).toBe('floating')
  if (position.kind === 'floating') { expect(position.x).toBeCloseTo(224 / 300); expect(position.y).toBeCloseTo(124 / 200) }
})
it('moves a restored floating position outside a native browser before it is shown', async () => {
  registerBrowserSurface('native', async () => {}, () => false, () => ({ x: 200, y: 100, width: 500, height: 500 }))
  setMascotPosition({ kind: 'floating', x: .22, y: 300 / 700 })
  render(tree(false))
  await act(async () => { await import('./MascotFloatingHost') })
  expect(document.querySelector<HTMLElement>('.mascot-host')!.style.transform).toBe('translate(136px, 300px)')
})

it('connects pointer dragging to the floating host and exposes the empty rail drop target', async () => {
  render(tree(true))
  await act(async () => { await import('./MascotFloatingHost') })
  const companion = screen.getByTestId('mascot-companion')
  companion.getBoundingClientRect = () => ({ x: 20, y: 600, left: 20, top: 600, right: 84, bottom: 664, width: 64, height: 64, toJSON: () => ({}) })
  fireEvent(companion, new MouseEvent('pointerdown', { bubbles: true, clientX: 40, clientY: 620, button: 0 }))
  fireEvent(companion, new MouseEvent('pointermove', { bubbles: true, clientX: 500, clientY: 300 }))
  expect(document.querySelector<HTMLElement>('.mascot-dock')!.dataset.mascotDropTarget).toBe('true')
  expect(document.querySelector<HTMLElement>('.mascot-host')!.style.transform).toBe('translate(480px, 280px)')
  fireEvent(companion, new MouseEvent('pointerup', { bubbles: true, clientX: 510, clientY: 310 }))
  expect(getMascotPosition()).toEqual({ kind: 'floating', x: .49, y: 290 / 700 })
  expect(document.querySelector<HTMLElement>('.mascot-dock')!.dataset.mascotDropTarget).toBe('false')
  expect(document.querySelector<HTMLElement>('.mascot-host')!.style.transform).toBe('translate(490px, 290px)')
  expect(screen.getByTestId('mascot-companion')).toBe(companion)
})
