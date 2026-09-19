import { useSyncExternalStore } from 'react'

// Visibility of the context downbar. On by default; a user who does not want a
// persistent strip turns it off here, which reclaims the row.
const KEY = 'tr-context-bar'

function load(): boolean {
  if (typeof localStorage === 'undefined') return true
  return localStorage.getItem(KEY) !== '0'
}

let visible = load()
const listeners = new Set<() => void>()

function emit(): void {
  for (const l of listeners) l()
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange)
  return () => {
    listeners.delete(onChange)
  }
}

export function getContextBarVisible(): boolean {
  return visible
}

export function setContextBarVisible(next: boolean): void {
  if (visible === next) return
  visible = next
  try {
    localStorage.setItem(KEY, next ? '1' : '0')
  } catch {
  }
  emit()
}

export function setContextBarForTests(next: boolean): void {
  visible = next
  emit()
}

export function useContextBarVisible(): boolean {
  return useSyncExternalStore(
    subscribe,
    getContextBarVisible,
    () => true
  )
}
