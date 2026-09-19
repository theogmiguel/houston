import { describe, expect, it } from 'vitest'
import { ditherImageData } from './dither'
import type { DitherParams } from './types'

function flatImage(width: number, height: number, r: number, g: number, b: number): ImageData {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r
    data[i + 1] = g
    data[i + 2] = b
    data[i + 3] = 255
  }
  return { data, width, height } as unknown as ImageData
}

function baseParams(overrides: Partial<DitherParams> = {}): DitherParams {
  return {
    pixelSize: 1,
    colorSteps: 8,
    originalColors: false,
    ceiling: 35,
    dark: true,
    ...overrides
  }
}

function relativeLuminance(r: number, g: number, b: number): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
}

describe('ditherImageData', () => {
  it('is deterministic: same input and params give byte-identical output twice', () => {
    const source = flatImage(32, 24, 180, 120, 60)
    const params = baseParams({ pixelSize: 2, colorSteps: 5, originalColors: true, ceiling: 60 })
    const first = ditherImageData(source, params).data
    const second = ditherImageData(source, params).data
    expect(Array.from(first)).toEqual(Array.from(second))
  })

  it('monochrome output has r === g === b on every pixel', () => {
    const source = flatImage(16, 16, 100, 200, 40)
    const out = ditherImageData(source, baseParams({ pixelSize: 1 }))
    for (let i = 0; i < out.data.length; i += 4) {
      expect(out.data[i]).toBe(out.data[i + 1])
      expect(out.data[i]).toBe(out.data[i + 2])
    }
  })

  it('pixelSize 2 produces 2x2 blocks of identical pixels', () => {
    const width = 8
    const height = 6
    const source = new Uint8ClampedArray(width * height * 4)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4
        source[i] = (x * 37 + y * 19) % 256
        source[i + 1] = (x * 13 + y * 91) % 256
        source[i + 2] = (x * 53 + y * 7) % 256
        source[i + 3] = 255
      }
    }
    const input = { data: source, width, height } as unknown as ImageData
    const out = ditherImageData(input, baseParams({ pixelSize: 2 }))
    for (let y = 0; y < height; y += 2) {
      for (let x = 0; x < width; x += 2) {
        const a = (y * width + x) * 4
        const b = (y * width + x + 1) * 4
        const c = ((y + 1) * width + x) * 4
        const d = ((y + 1) * width + x + 1) * 4
        for (const ch of [0, 1, 2, 3]) {
          expect(out.data[a + ch]).toBe(out.data[b + ch])
          expect(out.data[a + ch]).toBe(out.data[c + ch])
          expect(out.data[a + ch]).toBe(out.data[d + ch])
        }
      }
    }
  })
})

const ROUNDING = 1.5 / 255

const BAND_SOURCES: [string, [number, number, number]][] = [
  ['flat white', [255, 255, 255]],
  ['flat black', [0, 0, 0]],
  ['saturated blue', [0, 0, 255]],
  ['saturated yellow', [255, 255, 0]],
  ['near black', [2, 1, 3]]
]

describe.each([true, false])('the luminance band, originalColors: %s', (originalColors) => {
  it.each(BAND_SOURCES)('dark: %s stays at or under the ceiling', (_name, [r, g, b]) => {
    const source = flatImage(32, 32, r, g, b)
    for (const ceiling of [35, 20]) {
      const out = ditherImageData(source, baseParams({ dark: true, originalColors, ceiling }))
      for (let i = 0; i < out.data.length; i += 4) {
        const lum = relativeLuminance(out.data[i], out.data[i + 1], out.data[i + 2])
        expect(lum).toBeLessThanOrEqual(ceiling / 100 + ROUNDING)
      }
    }
  })

  it.each(BAND_SOURCES)('paper: %s is lifted to at least 1 - ceiling', (_name, [r, g, b]) => {
    const source = flatImage(32, 32, r, g, b)
    for (const ceiling of [35, 20]) {
      const out = ditherImageData(source, baseParams({ dark: false, originalColors, ceiling }))
      for (let i = 0; i < out.data.length; i += 4) {
        const lum = relativeLuminance(out.data[i], out.data[i + 1], out.data[i + 2])
        expect(lum).toBeGreaterThanOrEqual(1 - ceiling / 100 - ROUNDING)
      }
    }
  })

  it('lowering the ceiling lowers the brightest pixel a dark theme produces', () => {
    const source = flatImage(32, 32, 255, 255, 255)
    const maxAt = (ceiling: number): number => {
      const out = ditherImageData(source, baseParams({ dark: true, originalColors, ceiling }))
      let max = 0
      for (let i = 0; i < out.data.length; i += 4) {
        max = Math.max(max, relativeLuminance(out.data[i], out.data[i + 1], out.data[i + 2]))
      }
      return max
    }
    expect(maxAt(20)).toBeLessThan(maxAt(35))
  })
})
