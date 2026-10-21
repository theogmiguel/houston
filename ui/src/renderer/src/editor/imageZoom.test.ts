import { describe, expect, it } from 'vitest'
import { IMAGE_ZOOM_GUTTER, IMAGE_ZOOM_GUTTER_Y, IMAGE_ZOOM_MAX, IMAGE_ZOOM_STEP, canvasLayout, clampScale, fitScale, toggleScale, wheelScale, zoomPercent, zoomScroll } from './imageZoom'

const viewport = { width: 448, height: 348 }

describe('fitScale', () => {
  it('shrinks a large image to the viewport inside the gutter', () => {
    expect(fitScale({ width: 1600, height: 600 }, viewport)).toBeCloseTo((448 - 2 * IMAGE_ZOOM_GUTTER) / 1600)
    expect(fitScale({ width: 600, height: 1200 }, viewport)).toBeCloseTo((348 - 2 * IMAGE_ZOOM_GUTTER_Y) / 1200)
  })

  it('never enlarges a small image', () => {
    expect(fitScale({ width: 32, height: 32 }, viewport)).toBe(1)
  })

  it('treats an image with no decoded size as 100%', () => {
    expect(fitScale({ width: 0, height: 0 }, viewport)).toBe(1)
  })
})

describe('clampScale', () => {
  it('keeps the scale between fit and the maximum', () => {
    expect(clampScale(0.1, 0.25)).toBe(0.25)
    expect(clampScale(20, 0.25)).toBe(IMAGE_ZOOM_MAX)
    expect(clampScale(2, 0.25)).toBe(2)
  })
})

describe('wheel and keyboard steps', () => {
  it('zooms in on a negative delta and out on a positive one', () => {
    expect(wheelScale(1, -100, false)).toBeGreaterThan(1)
    expect(wheelScale(1, 100, false)).toBeLessThan(1)
  })

  it('reacts more strongly to a pinch than to a wheel notch of the same delta', () => {
    expect(wheelScale(1, -10, true)).toBeGreaterThan(wheelScale(1, -10, false))
  })

  it('doubles the scale in four steps', () => {
    expect(IMAGE_ZOOM_STEP ** 4).toBeCloseTo(2)
  })
})

describe('toggleScale', () => {
  it('goes from fit to 100% and back', () => {
    expect(toggleScale(0.25, 0.25)).toBe(1)
    expect(toggleScale(1, 0.25)).toBe(0.25)
    expect(toggleScale(3, 0.25)).toBe(0.25)
  })

  it('goes to 200% when the image already fits at 100%', () => {
    expect(toggleScale(1, 1)).toBe(2)
    expect(toggleScale(2, 1)).toBe(1)
  })
})

describe('canvasLayout', () => {
  it('centres an image smaller than the viewport without scrolling', () => {
    const layout = canvasLayout({ width: 100, height: 50 }, viewport, 1)
    expect(layout.canvas).toEqual(viewport)
    expect(layout.offset).toEqual({ x: 174, y: 149 })
  })

  it('grows the canvas past the viewport with a gutter on each side', () => {
    const layout = canvasLayout({ width: 1000, height: 100 }, viewport, 1)
    expect(layout.canvas).toEqual({ width: 1000 + 2 * IMAGE_ZOOM_GUTTER, height: 348 })
    expect(layout.offset.x).toBe(IMAGE_ZOOM_GUTTER)
  })
})

describe('zoomScroll', () => {
  const natural = { width: 800, height: 600 }

  function imagePointUnder(scale: number, scroll: { left: number; top: number }, point: { x: number; y: number }): { x: number; y: number } {
    const { offset } = canvasLayout(natural, viewport, scale)
    return { x: (scroll.left + point.x - offset.x) / scale, y: (scroll.top + point.y - offset.y) / scale }
  }

  it('keeps the image pixel under the cursor in place when zooming in from fit', () => {
    const fit = fitScale(natural, viewport)
    const point = { x: 300, y: 120 }
    const before = imagePointUnder(fit, { left: 0, top: 0 }, point)
    const scroll = zoomScroll(natural, viewport, fit, 2, point, { left: 0, top: 0 })
    const after = imagePointUnder(2, scroll, point)
    expect(after.x).toBeCloseTo(before.x)
    expect(after.y).toBeCloseTo(before.y)
  })

  it('keeps the point in place between two zoomed scales', () => {
    const point = { x: 50, y: 300 }
    const start = { left: 400, top: 250 }
    const before = imagePointUnder(2, start, point)
    const scroll = zoomScroll(natural, viewport, 2, 4, point, start)
    const after = imagePointUnder(4, scroll, point)
    expect(after.x).toBeCloseTo(before.x)
    expect(after.y).toBeCloseTo(before.y)
  })

  it('clamps the scroll to the canvas when the anchor cannot stay in place', () => {
    const fit = fitScale(natural, viewport)
    expect(zoomScroll(natural, viewport, 2, fit, { x: 10, y: 10 }, { left: 900, top: 700 })).toEqual({ left: 0, top: 0 })
    const max = canvasLayout(natural, viewport, 2)
    const corner = zoomScroll(natural, viewport, 1, 2, { x: 448, y: 348 }, { left: 1000, top: 1000 })
    expect(corner.left).toBeLessThanOrEqual(max.canvas.width - viewport.width)
    expect(corner.top).toBeLessThanOrEqual(max.canvas.height - viewport.height)
  })
})

describe('zoomPercent', () => {
  it('rounds to a whole percentage', () => {
    expect(zoomPercent(0.3333)).toBe('33%')
    expect(zoomPercent(IMAGE_ZOOM_MAX)).toBe('800%')
  })
})
