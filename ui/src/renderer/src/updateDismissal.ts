import { useSyncExternalStore } from 'react'

const KEY = 'tr-update-dismissed'

// The version that was waved off, not a boolean: the daemon keeps offering the same
// release until a newer one exists, so a flag would have to be cleared by whoever
// noticed the offer changed, and nobody is watching for that.
function load(): string | null {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}

let dismissed: string | null = typeof localStorage !== 'undefined' ? load() : null
const listeners = new Set<() => void>()

function commit(next: string | null): void {
  if (next === dismissed) return
  dismissed = next
  try {
    if (next === null) localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, next)
  } catch {
  }
  for (const l of listeners) l()
}

export function dismissUpdate(version: string): void {
  commit(version)
}

export function restoreUpdate(): void {
  commit(null)
}

export function setDismissedUpdateForTests(next: string | null): void {
  dismissed = next
  for (const l of listeners) l()
}

export function useDismissedUpdate(): string | null {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange)
      return () => listeners.delete(onChange)
    },
    () => dismissed,
    () => null
  )
}
