import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { IMAGE_ZOOM_MAX, IMAGE_ZOOM_STEP, canvasLayout, clampScale, fitScale, toggleScale, wheelScale, zoomPercent, zoomScroll, type Point, type Size } from '../editor/imageZoom'
import { IconMinus, IconPlus } from './icons'
import { Button } from './ui/Button'
import { MediaZoomBar, MediaZoomImage, MediaZoomReadout, MediaZoomViewport } from './ui/MediaZoom'

type Drag = { pointerId: number; x: number; y: number; left: number; top: number }

/** `fit` follows the viewport as the pane resizes; a number is a scale the user chose. */
type ZoomMode = 'fit' | number

const ZERO: Size = { width: 0, height: 0 }

function useViewportSize(viewportRef: React.RefObject<HTMLDivElement | null>): Size {
  const [size, setSize] = useState<Size>(ZERO)
  useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const measure = (): void => setSize({ width: viewport.clientWidth, height: viewport.clientHeight })
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [viewportRef])
  return size
}

function wheelPixels(event: WheelEvent, pageHeight: number): number {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return event.deltaY * 16
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) return event.deltaY * pageHeight
  return event.deltaY
}

/** Fits by default and zooms from fit to 800%; keys act only while the image has focus. */
export function ZoomableImage({ src, alt, onError }: { src: string; alt: string; onError: () => void }): React.JSX.Element {
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const viewport = useViewportSize(viewportRef)
  const [natural, setNatural] = useState<Size>(ZERO)
  const [mode, setMode] = useState<ZoomMode>('fit')
  const [drag, setDrag] = useState<Drag | null>(null)
  const pendingScroll = useRef<{ left: number; top: number } | null>(null)
  const fit = fitScale(natural, viewport)
  const scale = mode === 'fit' ? fit : clampScale(mode, fit)
  const layout = canvasLayout(natural, viewport, scale)
  const scaleRef = useRef(scale)
  scaleRef.current = scale

  const zoomTo = useCallback((next: number, point?: Point) => {
    const element = viewportRef.current
    const from = scaleRef.current
    const currentFit = fitScale(natural, viewport)
    const to = clampScale(next, currentFit)
    if (!element || natural.width === 0) return
    const nextMode = to <= currentFit + 1e-6 ? 'fit' : to
    if (Math.abs(to - from) < 1e-6) {
      setMode(nextMode)
      return
    }
    const anchor = point ?? { x: viewport.width / 2, y: viewport.height / 2 }
    // A zoom React has not committed yet already moved the scroll the next one starts from.
    const start = pendingScroll.current ?? { left: element.scrollLeft, top: element.scrollTop }
    pendingScroll.current = zoomScroll(natural, viewport, from, to, anchor, start)
    scaleRef.current = to
    setMode(nextMode)
  }, [natural, viewport])

  useLayoutEffect(() => {
    const element = viewportRef.current
    const scroll = pendingScroll.current
    if (!element || !scroll) return
    element.scrollLeft = scroll.left
    element.scrollTop = scroll.top
    pendingScroll.current = null
  }, [scale])

  useEffect(() => {
    const element = viewportRef.current
    if (!element) return
    const onWheel = (event: WheelEvent): void => {
      if (event.deltaY === 0) return
      event.preventDefault()
      const bounds = element.getBoundingClientRect()
      const point = { x: event.clientX - bounds.left, y: event.clientY - bounds.top }
      zoomTo(wheelScale(scaleRef.current, wheelPixels(event, element.clientHeight), event.ctrlKey || event.metaKey), point)
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [zoomTo])

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.ctrlKey || event.metaKey || event.altKey) return
    const next = event.key === '+' || event.key === '=' ? scale * IMAGE_ZOOM_STEP
      : event.key === '-' ? scale / IMAGE_ZOOM_STEP
        : event.key === '0' ? fit
          : event.key === '1' ? 1
            : null
    if (next === null) return
    event.preventDefault()
    zoomTo(next)
  }

  const pannable = layout.canvas.width > viewport.width || layout.canvas.height > viewport.height
  const endDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (drag?.pointerId !== event.pointerId) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    setDrag(null)
  }

  return (
    <>
      <MediaZoomViewport
        ref={viewportRef}
        role="region"
        aria-label={`${alt}, zoomable image`}
        aria-description="Scroll to zoom, drag to pan, double-click to switch between fit and 100%. Plus and minus zoom, 0 fits, 1 shows actual size."
        tabIndex={0}
        data-testid="image-zoom-viewport"
        cursor={drag ? 'grabbing' : pannable ? 'grab' : 'zoom-in'}
        onKeyDown={onKeyDown}
        onDoubleClick={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect()
          zoomTo(toggleScale(scale, fit), { x: event.clientX - bounds.left, y: event.clientY - bounds.top })
        }}
        onPointerDown={(event) => {
          if (drag || !pannable || event.pointerType !== 'mouse' || event.button !== 0) return
          const element = event.currentTarget
          setDrag({ pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: element.scrollLeft, top: element.scrollTop })
          element.setPointerCapture(event.pointerId)
        }}
        onPointerMove={(event) => {
          if (drag?.pointerId !== event.pointerId) return
          event.currentTarget.scrollLeft = drag.left - (event.clientX - drag.x)
          event.currentTarget.scrollTop = drag.top - (event.clientY - drag.y)
        }}
        onPointerUp={endDrag}
        onLostPointerCapture={endDrag}
      >
        <div className="relative" style={natural.width ? { width: layout.canvas.width, height: layout.canvas.height } : undefined}>
          <MediaZoomImage
            src={src}
            alt={alt}
            pixelated={scale >= 2}
            style={natural.width ? { left: layout.offset.x, top: layout.offset.y, width: layout.image.width, height: layout.image.height } : { visibility: 'hidden' }}
            onLoad={(event) => setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
            onError={onError}
          />
        </div>
      </MediaZoomViewport>
      <MediaZoomBar data-testid="image-zoom-bar">
        <Button variant="icon" icon={IconMinus} aria-label="Zoom out" disabled={scale <= fit + 1e-6} onClick={() => zoomTo(scale / IMAGE_ZOOM_STEP)} />
        <MediaZoomReadout aria-live="polite" data-testid="image-zoom-level">{zoomPercent(scale)}</MediaZoomReadout>
        <Button variant="icon" icon={IconPlus} aria-label={`Zoom in, up to ${zoomPercent(IMAGE_ZOOM_MAX)}`} disabled={scale >= IMAGE_ZOOM_MAX - 1e-6} onClick={() => zoomTo(scale * IMAGE_ZOOM_STEP)} />
        <Button variant="ghost" size="sm" disabled={mode === 'fit'} onClick={() => zoomTo(fit)}>Fit</Button>
      </MediaZoomBar>
    </>
  )
}
