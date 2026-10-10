import { expect, it } from 'vitest'
import { MASCOT_FILTERS, recolorMascotPixels } from './mascotColors'

it('keeps the mock colour filters verbatim', () => {
  expect(MASCOT_FILTERS).toEqual({ classic: 'none', aurora: 'hue-rotate(-70deg) saturate(1.1)', sunset: 'hue-rotate(140deg) saturate(1.15)', mono: 'grayscale(1) brightness(1.15)' })
})
it('keeps classic pixels and alpha unchanged, and bakes monochrome brightness for webviews without canvas filters', () => {
  const pixels = new Uint8ClampedArray([255, 0, 0, 128, 100, 100, 100, 255])
  recolorMascotPixels(pixels, 'classic')
  expect(Array.from(pixels)).toEqual([255, 0, 0, 128, 100, 100, 100, 255])
  recolorMascotPixels(pixels, 'mono')
  expect(Array.from(pixels)).toEqual([62, 62, 62, 128, 115, 115, 115, 255])
})
it.each(['aurora', 'sunset'] as const)('recolours the game sprite with %s while preserving alpha and neutral pixels', (colors) => {
  const pixels = new Uint8ClampedArray([255, 0, 0, 128, 100, 100, 100, 255])
  recolorMascotPixels(pixels, colors)
  expect(Array.from(pixels.slice(0, 3))).not.toEqual([255, 0, 0])
  expect(pixels[3]).toBe(128)
  expect(Array.from(pixels.slice(4))).toEqual([100, 100, 100, 255])
})
