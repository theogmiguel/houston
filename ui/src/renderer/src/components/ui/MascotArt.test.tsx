// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MascotArt } from './MascotArt'
import { NavigationRailHeader } from './NavigationRail'
import { DEFAULT_PREFS, setMascotPrefsForTests } from '../../mascot/mascotPrefs'
import { MASCOT_FILTERS } from '../../mascot/mascotColors'

vi.mock('./mascotPixel', () => ({ draw: vi.fn() }))
beforeEach(() => {
  setMascotPrefsForTests({ ...DEFAULT_PREFS })
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D)
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); setMascotPrefsForTests({ ...DEFAULT_PREFS }) })
it.each(['classic', 'aurora', 'sunset', 'mono'] as const)('applies %s to the brand mark and every shared art size', (colors) => {
  const { container } = render(<><NavigationRailHeader logo={{ src: 'head.png', srcSet: 'head.png 1x' }}>Houston</NavigationRailHeader>{[64, 112, 210].map(size => <MascotArt key={size} size={size} />)}</>)
  act(() => setMascotPrefsForTests({ ...DEFAULT_PREFS, colors }))
  expect(screen.getByTestId('brand-mark').style.filter).toBe(MASCOT_FILTERS[colors])
  container.querySelectorAll<HTMLElement>('.mascot-art').forEach(art => expect(art.style.filter).toBe(MASCOT_FILTERS[colors]))
})
it.each([64, 96, 112, 192, 210])('gives pixel and brand art the same %s px slot, retaining the pixel aspect ratio', (size) => {
  const { container } = render(<MascotArt size={size} />)
  expect(container.querySelector<HTMLElement>('.mascot-art')!.style.getPropertyValue('--size')).toBe(`${size}px`)
  act(() => setMascotPrefsForTests({ ...DEFAULT_PREFS, style: 'pixel' }))
  const pixel = container.querySelector<HTMLElement>('.mascot-pxwrap')!
  expect(pixel.style.width).toBe(`${size}px`)
  expect(pixel.style.height).toBe(`${size * 44 / 48}px`)
  expect(container.querySelector('canvas')!.width).toBe(48)
  expect(container.querySelector('canvas')!.height).toBe(44)
})
