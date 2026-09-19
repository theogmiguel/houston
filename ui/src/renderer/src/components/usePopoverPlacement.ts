import { useCallback, useEffect, useLayoutEffect, useState, type RefObject } from 'react'

export const PANEL_MIN_WIDTH = 304
const PANEL_GAP = 12
const VIEWPORT_MARGIN = 8
const ROOM_MIN = 120

export interface PopoverPlacement {
  left: number
  top: number
  width: number
  origin: 'top' | 'bottom'
  room: number
}

export function usePopoverPlacement(
  triggerRef: RefObject<HTMLElement | null>,
  panelRef: RefObject<HTMLElement | null>,
  open: boolean,
  onDismiss: () => void
): PopoverPlacement | null {
  const [placement, setPlacement] = useState<PopoverPlacement | null>(null)

  const place = useCallback(() => {
    const t = triggerRef.current
    if (!t) return
    const r = t.getBoundingClientRect()
    const width = Math.max(r.width, PANEL_MIN_WIDTH)
    const left = Math.max(
      VIEWPORT_MARGIN,
      Math.min(r.left, window.innerWidth - width - VIEWPORT_MARGIN)
    )
    const roomBelow = window.innerHeight - r.bottom - PANEL_GAP - VIEWPORT_MARGIN
    const roomAbove = r.top - PANEL_GAP - VIEWPORT_MARGIN
    const panelHeight = panelRef.current?.offsetHeight ?? 0
    const above = panelHeight > roomBelow && roomAbove > roomBelow
    setPlacement({
      left,
      top: above ? Math.max(VIEWPORT_MARGIN, r.top - PANEL_GAP - panelHeight) : r.bottom + PANEL_GAP,
      width,
      origin: above ? 'bottom' : 'top',
      room: Math.max(ROOM_MIN, above ? roomAbove : roomBelow)
    })
  }, [triggerRef, panelRef])

  useLayoutEffect(() => {
    if (open) place()
    else setPlacement(null)
  }, [open, place])

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent): void => {
      const target = e.target
      if (!(target instanceof Node)) return
      if (panelRef.current?.contains(target)) return
      if (triggerRef.current?.contains(target)) return
      onDismiss()
    }
    const onMove = (): void => place()
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('resize', onMove)
    window.addEventListener('scroll', onMove, true)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('resize', onMove)
      window.removeEventListener('scroll', onMove, true)
    }
  }, [open, onDismiss, place, panelRef, triggerRef])

  return placement
}
