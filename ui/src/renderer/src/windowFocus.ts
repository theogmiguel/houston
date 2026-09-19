import { useSyncExternalStore } from 'react'

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

export type PaneFocusTier = 'none' | 'dim' | 'full'

export const PANE_BORDER_CLS: Record<PaneFocusTier, string> = {
  none: 'border-[var(--border)]',
  dim: 'border-[color-mix(in_srgb,var(--border-focus)_45%,var(--border))]',
  full: 'border-[var(--border-focus)]'
}

export const PANE_HEAD_BG_CLS: Record<PaneFocusTier, string> = {
  none: 'bg-[var(--session-terminal-header-bg)]',
  dim: 'bg-[color-mix(in_srgb,var(--raised)_45%,var(--session-terminal-header-bg))]',
  full: 'bg-[var(--raised)]'
}

export const PANE_TITLE_INK_CLS =
  'text-[var(--text-primary)] [body:has(.pane.focus)_.pane:not(.focus)_&]:text-[var(--text-secondary)]'

export function usePaneFocusTier(active: boolean): PaneFocusTier {
  const windowFocused = useWindowFocused()
  return !active ? 'none' : windowFocused ? 'full' : 'dim'
}
