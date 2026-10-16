import { useCallback, useEffect, useRef } from 'react'

// A band about one row tall: close enough to the edge that reaching it is deliberate.
export const AUTO_SCROLL_EDGE_PX = 32
// Per frame; about 800 px/s at 60 Hz, so a long list crosses in a few seconds without overshooting a row.
export const AUTO_SCROLL_MAX_STEP_PX = 14

/** Scroll step for a pointer at `y`: negative near the top edge, positive near the bottom, 0 elsewhere. */
export function edgeScrollStep(y: number, top: number, bottom: number): number {
  if (y < top + AUTO_SCROLL_EDGE_PX) return -Math.round(AUTO_SCROLL_MAX_STEP_PX * Math.min(1, (top + AUTO_SCROLL_EDGE_PX - y) / AUTO_SCROLL_EDGE_PX))
  if (y > bottom - AUTO_SCROLL_EDGE_PX) return Math.round(AUTO_SCROLL_MAX_STEP_PX * Math.min(1, (y - (bottom - AUTO_SCROLL_EDGE_PX)) / AUTO_SCROLL_EDGE_PX))
  return 0
}

/** Scrolls `containerRef` while a drag holds the pointer near an edge; `onScrolled` lets the caller re-resolve its drop target. */
export function useEdgeAutoScroll(
  containerRef: React.RefObject<HTMLElement | null>,
  onScrolled: () => void,
): { track: (clientY: number) => void; stop: () => void } {
  const pointerY = useRef<number | null>(null)
  const frame = useRef<number | null>(null)
  const onScrolledRef = useRef(onScrolled)
  onScrolledRef.current = onScrolled
  const stop = useCallback((): void => {
    pointerY.current = null
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = null
  }, [])
  const tick = useCallback((): void => {
    frame.current = null
    const container = containerRef.current
    if (!container || pointerY.current === null) return
    const rect = container.getBoundingClientRect()
    const step = edgeScrollStep(pointerY.current, rect.top, rect.bottom)
    if (step !== 0) {
      const before = container.scrollTop
      container.scrollTop = before + step
      if (container.scrollTop !== before) onScrolledRef.current()
    }
    frame.current = requestAnimationFrame(tick)
  }, [containerRef])
  const track = useCallback((clientY: number): void => {
    pointerY.current = clientY
    if (frame.current === null) frame.current = requestAnimationFrame(tick)
  }, [tick])
  useEffect(() => stop, [stop])
  return { track, stop }
}

// Drop index for a pointer at `y`: before the first row whose midpoint lies below it, else the end.
// Every position maps to a slot, including over a row's grid cards.
export function workspaceDropIndex(rows: readonly { top: number; height: number }[], y: number): number {
  const index = rows.findIndex((row) => y < row.top + row.height / 2)
  return index < 0 ? rows.length : index
}
