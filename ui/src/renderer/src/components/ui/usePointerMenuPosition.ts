import { useLayoutEffect, useState, type RefObject } from 'react'

// The gutter keeps menu chrome clear of the viewport edge, including on small windows.
const MENU_GUTTER = 8

export function usePointerMenuPosition(ref: RefObject<HTMLElement | null>, x: number, y: number): { left: number; top: number } {
  const [position, setPosition] = useState({ left: x, top: y })
  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    const place = (): void => {
      const rect = node.getBoundingClientRect()
      const left = Math.max(MENU_GUTTER, Math.min(x, window.innerWidth - rect.width - MENU_GUTTER))
      const top = Math.max(MENU_GUTTER, Math.min(y, window.innerHeight - rect.height - MENU_GUTTER))
      setPosition((current) => current.left === left && current.top === top ? current : { left, top })
    }
    place()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place)
    observer?.observe(node)
    window.addEventListener('resize', place)
    return () => { observer?.disconnect(); window.removeEventListener('resize', place) }
  }, [ref, x, y])
  return position
}
