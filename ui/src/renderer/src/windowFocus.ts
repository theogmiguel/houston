import { useSyncExternalStore } from 'react'

export type PaneFocusTier = 'none' | 'dim' | 'full'

let focused = typeof document !== 'undefined' ? document.hasFocus() : true
const listeners = new Set<() => void>()

function notify(): void {
  for (const l of listeners) l()
}

if (typeof window !== 'undefined') {
  window.addEventListener('focus', () => {
    focused = true
    notify()
  })
  window.addEventListener('blur', () => {
    focused = false
    notify()
  })
}

export function setWindowFocusedForTests(value: boolean): void {
  focused = value
  notify()
}

export function useWindowFocused(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange)
      return () => listeners.delete(onChange)
    },
    () => focused,
    () => true
  )
}

export function usePaneFocusTier(active: boolean): PaneFocusTier {
  const windowFocused = useWindowFocused()
  return !active ? 'none' : windowFocused ? 'full' : 'dim'
}
