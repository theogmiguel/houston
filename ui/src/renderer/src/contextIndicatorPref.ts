import { useSyncExternalStore } from 'react'

// Keep the existing key so an explicit visibility choice survives the move
// from the global downbar to the per-pane indicator.
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

export function getContextIndicatorVisible(): boolean {
  return visible
}

export function setContextIndicatorVisible(next: boolean): void {
  if (visible === next) return
  visible = next
  try {
    localStorage.setItem(KEY, next ? '1' : '0')
  } catch {
  }
  emit()
}

export function setContextIndicatorForTests(next: boolean): void {
  visible = next
  emit()
}

export function useContextIndicatorVisible(): boolean {
  return useSyncExternalStore(
    subscribe,
    getContextIndicatorVisible,
    () => true
  )
}
