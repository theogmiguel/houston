import { useSyncExternalStore } from 'react'

// Whether the install modal is showing. One store so the About row and the rail
// chip open the same modal, and so hiding it never touches the install flight.
let open = false
const listeners = new Set<() => void>()

function commit(next: boolean): void {
  if (next === open) return
  open = next
  for (const l of listeners) l()
}

export function openUpdateModal(): void {
  commit(true)
}

export function closeUpdateModal(): void {
  commit(false)
}

export function useUpdateModalOpen(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange)
      return () => listeners.delete(onChange)
    },
    () => open,
    () => false
  )
}

export function isUpdateModalOpen(): boolean {
  return open
}
