import { useSyncExternalStore } from 'react'
import { onTrayEvent, TRAY_EVENT_WINDOW_HIDDEN } from './houston/tray'

// WebView2 keeps reporting `visible` while its window is hidden to the tray, so the
// native host announces the hide and the show. Focus and a `visible` visibilitychange
// also end it, in case the show event is lost.
let hiddenToTray = false
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

/** True while the window is hidden to the tray or the page reports hidden, so background polls can wait. */
export function windowParked(): boolean {
  return hiddenToTray || document.visibilityState === 'hidden'
}

export function setHiddenToTray(hidden: boolean): void {
  if (hiddenToTray === hidden) return
  hiddenToTray = hidden
  notify()
}

if (typeof window !== 'undefined') {
  window.addEventListener('focus', () => setHiddenToTray(false))
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') hiddenToTray = false
    notify()
  })
  void onTrayEvent<boolean>(TRAY_EVENT_WINDOW_HIDDEN, setHiddenToTray)
}

export function subscribeWindowParked(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useWindowParked(): boolean {
  return useSyncExternalStore(subscribeWindowParked, windowParked, () => false)
}
