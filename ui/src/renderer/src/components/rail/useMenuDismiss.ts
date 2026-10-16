import { useEffect, useRef } from 'react'

// Dismisses the rail's pointer-anchored context menus on outside press, window blur, rail scroll and
// Escape. An open tag popover takes Escape first; dismissing it closes the menu that opened it.
export function useMenuDismiss(open: boolean, closeAll: () => void, closeTagPopover: () => void): void {
  const close = useRef(closeAll)
  close.current = closeAll
  const closePopover = useRef(closeTagPopover)
  closePopover.current = closeTagPopover
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      const target = e.target as HTMLElement
      if (
        !target.closest(".ctxmenu") &&
        !target.closest('[data-testid="tag-popover"]') &&
        !target.closest('[data-testid="rail-options-trigger"]')
      )
        close.current()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return
      const popover = document.querySelector('[data-testid="tag-popover"]')
      if (popover) {
        if (e.target instanceof Node && popover.contains(e.target)) return
        e.preventDefault()
        e.stopPropagation()
        closePopover.current()
        return
      }
      e.stopPropagation()
      close.current()
    }
    const onScroll = (e: Event): void => {
      if (e.target instanceof Element && e.target.closest("[data-rail-grid-list], .railscroll")) close.current()
    }
    const onBlur = (): void => close.current()
    window.addEventListener("mousedown", onDown)
    window.addEventListener("keydown", onKey, true)
    window.addEventListener("blur", onBlur)
    document.addEventListener("scroll", onScroll, true)
    return () => {
      window.removeEventListener("mousedown", onDown)
      window.removeEventListener("keydown", onKey, true)
      window.removeEventListener("blur", onBlur)
      document.removeEventListener("scroll", onScroll, true)
    }
  }, [open])
}
