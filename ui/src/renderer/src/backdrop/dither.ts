import type { DitherParams } from './types'

const BAYER: readonly number[][] = [
  [0, 32, 8, 40, 2, 34, 10, 42],
  [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38],
  [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41],
  [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37],
  [63, 31, 55, 23, 61, 29, 53, 21]
]

function makeImageData(
  data: Uint8ClampedArray,
  width: number,
  height: number
): ImageData {
  const ctor = (globalThis as {
    ImageData?: new (data: Uint8ClampedArray, width: number, height: number) => ImageData
  }).ImageData
  if (ctor) return new ctor(data, width, height)
  return { data, width, height } as unknown as ImageData
}

export function ditherImageData(source: ImageData, params: DitherParams): ImageData {
  const { pixelSize, colorSteps, originalColors, ceiling, dark } = params
  const n = colorSteps
  const ceil = ceiling / 100
  const width = source.width
  const height = source.height
  const out = makeImageData(new Uint8ClampedArray(width * height * 4), width, height)
  const src = source.data
  const dst = out.data

  const blocksX = Math.ceil(width / pixelSize)
  const blocksY = Math.ceil(height / pixelSize)

  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      let r = 0
      let g = 0
      let b = 0
      let cnt = 0
      for (let dy = 0; dy < pixelSize; dy++) {
        const sy = by * pixelSize + dy
        if (sy >= height) continue
        for (let dx = 0; dx < pixelSize; dx++) {
          const sx = bx * pixelSize + dx
          if (sx >= width) continue
          const i = (sy * width + sx) * 4
          r += src[i]
          g += src[i + 1]
          b += src[i + 2]
          cnt++
        }
      }
      r /= cnt
      g /= cnt
      b /= cnt

      const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
      const t = BAYER[by & 7][bx & 7] / 64 - 0.5
      const q = Math.min(1, Math.max(0, Math.floor(lum * n + t + 0.5) / n))
      // Clamp AFTER quantisation, not before: clamping the input first would
      // target the already-quantised luminance and the ceiling would do nothing.
      const outv = dark ? q * ceil : 1 - (1 - q) * ceil

      let or: number
      let og: number
      let ob: number
      if (originalColors) {
        const k = lum > 1e-3 ? outv / lum : 0
        or = Math.min(255, r * k)
        og = Math.min(255, g * k)
        ob = Math.min(255, b * k)
        const got = (0.2126 * or + 0.7152 * og + 0.0722 * ob) / 255
        if (dark) {
          if (got > ceil) {
            const s = ceil / got
            or *= s
            og *= s
            ob *= s
          }
        } else {
          const floor = 1 - ceil
          if (got < floor) {
            const a = (floor - got) / (1 - got)
            or += (255 - or) * a
            og += (255 - og) * a
            ob += (255 - ob) * a
          }
        }
      } else {
        const v = Math.round(outv * 255)
        or = og = ob = v
      }

      for (let dy = 0; dy < pixelSize; dy++) {
        const sy = by * pixelSize + dy
        if (sy >= height) continue
        for (let dx = 0; dx < pixelSize; dx++) {
          const sx = bx * pixelSize + dx
          if (sx >= width) continue
          const i = (sy * width + sx) * 4
          dst[i] = or
          dst[i + 1] = og
          dst[i + 2] = ob
          dst[i + 3] = 255
        }
      }
    }
  }

  return out
}
