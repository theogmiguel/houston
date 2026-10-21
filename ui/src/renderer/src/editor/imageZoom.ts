export type Size = { width: number; height: number }
export type Point = { x: number; y: number }
export type Scroll = { left: number; top: number }

/** Scale is image pixels per natural pixel; 8 lets a single screenshot pixel be inspected. */
export const IMAGE_ZOOM_MAX = 8
/** One keyboard or button step; four steps double the scale. */
export const IMAGE_ZOOM_STEP = 2 ** 0.25
/** Space kept beside the image, matching the preview's padding. */
export const IMAGE_ZOOM_GUTTER = 24
/** Space kept above and below the image; it holds the 34px zoom bar and its 8px inset clear of a fitted image. */
export const IMAGE_ZOOM_GUTTER_Y = 48

/** The scale that shows the whole image inside the viewport without enlarging it. */
export function fitScale(natural: Size, viewport: Size): number {
  if (natural.width <= 0 || natural.height <= 0) return 1
  const width = Math.max(1, viewport.width - 2 * IMAGE_ZOOM_GUTTER)
  const height = Math.max(1, viewport.height - 2 * IMAGE_ZOOM_GUTTER_Y)
  return Math.min(1, width / natural.width, height / natural.height)
}

export function clampScale(scale: number, fit: number): number {
  return Math.min(IMAGE_ZOOM_MAX, Math.max(fit, scale))
}

/** Pixel-mode wheel deltas; Chromium reports a trackpad pinch as a Ctrl+wheel with small deltas. */
export function wheelScale(scale: number, deltaPixels: number, pinch: boolean): number {
  return scale * Math.exp(-deltaPixels * (pinch ? 0.01 : 0.002))
}

/** Double-click alternates between fit and 100%, or 200% when the image already fits at 100%. */
export function toggleScale(scale: number, fit: number): number {
  if (scale > fit + 1e-6) return fit
  return fit < 1 ? 1 : 2
}

/** The scrollable canvas: the image centred within the gutters, never smaller than the viewport. */
export function canvasLayout(natural: Size, viewport: Size, scale: number): { canvas: Size; offset: Point; image: Size } {
  const image = { width: natural.width * scale, height: natural.height * scale }
  const canvas = {
    width: Math.max(viewport.width, image.width + 2 * IMAGE_ZOOM_GUTTER),
    height: Math.max(viewport.height, image.height + 2 * IMAGE_ZOOM_GUTTER_Y)
  }
  return { canvas, image, offset: { x: (canvas.width - image.width) / 2, y: (canvas.height - image.height) / 2 } }
}

/** The scroll position that keeps the image pixel under `point` (viewport coordinates) in place across a scale change. */
export function zoomScroll(natural: Size, viewport: Size, from: number, to: number, point: Point, scroll: Scroll): Scroll {
  const before = canvasLayout(natural, viewport, from)
  const after = canvasLayout(natural, viewport, to)
  const imageX = (scroll.left + point.x - before.offset.x) / from
  const imageY = (scroll.top + point.y - before.offset.y) / from
  const clamp = (value: number, max: number): number => Math.min(Math.max(0, max), Math.max(0, value))
  return {
    left: clamp(imageX * to + after.offset.x - point.x, after.canvas.width - viewport.width),
    top: clamp(imageY * to + after.offset.y - point.y, after.canvas.height - viewport.height)
  }
}

export function zoomPercent(scale: number): string {
  return `${Math.round(scale * 100)}%`
}
