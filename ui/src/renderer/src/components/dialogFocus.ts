import type { KeyboardEvent, RefObject } from 'react'
import { useEffect } from 'react'

export function useFocusRestore(
  containerRef: RefObject<HTMLElement | null>,
  initialFocusRef: RefObject<HTMLElement | null>
): void {
  useEffect(() => {
    const trigger = document.activeElement
    initialFocusRef.current?.focus()
    return () => {
      const active = document.activeElement
      const stillOwned =
        active === null || active === document.body || (containerRef.current?.contains(active) ?? false)
      if (stillOwned && trigger instanceof HTMLElement && trigger.isConnected) trigger.focus()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount/unmount only, the refs are read fresh from their `.current` at each phase
  }, [])
}

export function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  focusableSelector = 'button:not([disabled])'
): (e: KeyboardEvent) => void {
  return (e: KeyboardEvent): void => {
    if (e.key !== 'Tab') return
    const focusables = containerRef.current?.querySelectorAll<HTMLElement>(focusableSelector)
    if (!focusables || focusables.length === 0) return
    const list = Array.from(focusables)
    const first = list[0]
    const last = list[list.length - 1]
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }
}
