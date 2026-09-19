import type { DitherParams } from './types'
import { ditherImageData } from './dither'

export interface FieldSize {
  width: number
  height: number
  dpr: number
}

export function renderField(
  canvas: HTMLCanvasElement,
  source: ImageBitmap | HTMLImageElement,
  size: FieldSize,
  params: DitherParams
): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const sw = source.width
  const sh = source.height
  const tw = size.width
  const th = size.height
  const dpr = size.dpr
  const scale = Math.max(tw / sw, th / sh)
  const dw = sw * scale
  const dh = sh * scale

  canvas.width = Math.max(1, Math.round(tw * dpr))
  canvas.height = Math.max(1, Math.round(th * dpr))
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.drawImage(source, (tw - dw) / 2, (th - dh) / 2, dw, dh)

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const dithered = ditherImageData(imageData, params)
  ctx.putImageData(dithered, 0, 0)
}
